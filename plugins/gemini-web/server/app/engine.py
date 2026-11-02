"""Gemini 网页版引擎适配层。

底层使用社区维护的 `gemini-webapi`（复刻 gemini.google.com 的 StreamGenerate 私有接口），
本层负责：客户端构建、错误归一化、结果抽取、账号健康度。
"""
from __future__ import annotations

import asyncio
import inspect
from contextlib import asynccontextmanager
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator

COOKIE_PSID = "__Secure-1PSID"
COOKIE_PSIDTS = "__Secure-1PSIDTS"

# 网页端模型别名兜底（真实列表在账号初始化后由 Google 返回）
FALLBACK_MODELS = [
    {"id": "gemini-pro", "name": "Gemini Pro", "desc": "网页端 Pro 模型", "advanced": False},
    {"id": "gemini-flash", "name": "Gemini Flash", "desc": "速度优先", "advanced": False},
    {"id": "gemini-flash-lite", "name": "Gemini Flash Lite", "desc": "最轻量", "advanced": False},
]

# 首个输出的等待上限（秒）：网页端正常首字 2~30 秒，超过即判定该模型卡死
FIRST_OUTPUT_TIMEOUT = 60.0
THINKING_FIRST_OUTPUT_TIMEOUT = 150.0
# 卡死模型的回避时长（秒）
STALLED_MODEL_TTL = 1800
# 单账号同时在跑的请求上限
ACCOUNT_CONCURRENCY = 3


class EngineError(Exception):
    """归一化后的上游错误。"""

    def __init__(
        self,
        message: str,
        code: str = "upstream_error",
        status: int = 502,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.retryable = retryable


@dataclass
class GenResult:
    text: str
    thoughts: str = ""
    model: str = ""
    elapsed: float = 0.0
    meta: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------- 客户端


def _import_lib():
    try:
        from gemini_webapi import GeminiClient
    except Exception as exc:  # pragma: no cover
        raise EngineError(
            "缺少依赖 gemini-webapi，请执行 pip install gemini-webapi",
            code="dependency_missing",
            status=500,
        ) from exc
    return GeminiClient


def _build_client(psid: str, psidts: str, proxy: str | None):
    GeminiClient = _import_lib()
    proxy = (proxy or "").strip() or None
    try:
        return GeminiClient(psid, psidts or None, proxy=proxy)
    except TypeError:
        # 老版本只接受 cookies 字典
        return GeminiClient(
            cookies={COOKIE_PSID: psid, COOKIE_PSIDTS: psidts}, proxy=proxy
        )


async def _init_client(client, timeout: float = 60.0) -> None:
    try:
        result = client.init(
            timeout=timeout,
            auto_close=False,
            auto_refresh=True,
            verbose=False,
        )
        if inspect.isawaitable(result):
            await result
    except TypeError:
        result = client.init(auto_close=False, auto_refresh=True)
        if inspect.isawaitable(result):
            await result
    except Exception as exc:
        raise _normalize_error(exc) from exc


def _normalize_error(exc: Exception) -> EngineError:
    text = str(exc)
    low = text.lower()
    name = type(exc).__name__

    if "unknown model" in low:
        return EngineError(
            "该账号没有请求的模型，已自动回退到账号默认模型",
            code="model_unavailable",
            status=400,
            retryable=True,
        )
    if "unauth" in low or "cookie" in low or "1016" in low:
        return EngineError(
            "Cookie 已失效，请重新登录 gemini.google.com 并更新账号 Cookie",
            code="unauthorized",
            status=401,
        )
    if "usage limit" in low or "1037" in low:
        return EngineError("该账号额度已用尽", code="usage_limit", status=429)
    if "429" in low or "too many" in low:
        return EngineError("触发频率限制，请稍后重试", code="rate_limited", status=429, retryable=True)
    if "timeout" in low or "timed out" in low or name in ("TimeoutError", "Timeout"):
        return EngineError("上游响应超时", code="timeout", status=504, retryable=True)
    if "1060" in low or "location" in low or "region" in low:
        return EngineError("当前网络所在地区不被 Gemini 支持，请配置代理", code="region_blocked", status=403)
    if "temporar" in low or "503" in low or "1013" in low:
        return EngineError("上游暂时不可用，请重试", code="temporarily_unavailable", status=503, retryable=True)
    if any(k in low for k in ("ssl", "connection", "proxy", "resolve", "dns", "curl:", "network")):
        return EngineError(
            "无法连接 gemini.google.com。若在中国大陆，请在「设置 → 网络」里填写代理地址",
            code="network_error",
            status=502,
            retryable=True,
        )
    return EngineError(f"上游错误：{text}", code="upstream_error", status=502, retryable=True)


def _status_code(client: Any) -> int:
    st = getattr(client, "account_status", None)
    if st is None:
        return 1000
    val = getattr(st, "value", st)
    try:
        return int(val)
    except Exception:
        return 1000


def _attr(obj: Any, *names: str, default: Any = None) -> Any:
    for n in names:
        if obj is None:
            break
        v = getattr(obj, n, None)
        if v is not None:
            return v
    return default


def list_models(client: Any) -> list[dict[str, Any]]:
    """读取账号真实可用模型。"""
    out: list[dict[str, Any]] = []
    try:
        raw = client.list_models() or []
    except Exception:
        raw = []
    for m in raw:
        name = str(_attr(m, "model_name", default="") or "")
        if not name:
            continue
        out.append(
            {
                "id": name,
                "name": str(_attr(m, "display_name", default=name) or name),
                "desc": str(_attr(m, "description", default="") or ""),
                "advanced": bool(_attr(m, "advanced_only", default=False)),
            }
        )
    return out


def extract_quota(client: Any) -> list[dict[str, Any]]:
    """尽量从额度信息里抽出可用百分比，抽不到就返回空列表。"""
    out: list[dict[str, Any]] = []
    try:
        quotas = getattr(client, "quotas", None) or {}
        if not isinstance(quotas, dict):
            return out
        for key, bucket in quotas.items():
            if not isinstance(bucket, dict):
                continue
            total = bucket.get("total") or bucket.get("limit")
            remaining = bucket.get("remaining")
            used = bucket.get("used") or bucket.get("usage")
            if total and remaining is not None:
                used = float(total) - float(remaining)
            if total and used is not None and float(total) > 0:
                pct = max(0, min(100, round(float(used) / float(total) * 100)))
                out.append(
                    {
                        "label": str(bucket.get("label") or key),
                        "used": used,
                        "total": total,
                        "pct": pct,
                        "reset": bucket.get("reset") or bucket.get("reset_at") or "",
                    }
                )
    except Exception:
        pass
    return out


def mask_psid(value: str) -> str:
    """脱敏展示 Cookie，任何长度都不暴露完整值。"""
    v = value or ""
    if not v:
        return ""
    if len(v) <= 6:
        return v[0] + "…" * 2
    if len(v) <= 16:
        return v[:2] + "…" + v[-2:]
    return v[:8] + "…" + v[-4:]


# ---------------------------------------------------------------- 运行时账号


class AccountRuntime:
    """一个账号对应的客户端 + 并发控制 + 健康状态。"""

    def __init__(self, account: dict[str, Any], settings: dict[str, Any]) -> None:
        self.id: str = account["id"]
        self.name: str = account.get("name") or account["id"]
        self.psid: str = account["psid"]
        self.psidts: str = account.get("psidts") or ""
        self.settings = settings
        self.client: Any = None
        # 同一账号允许少量并发：agent 客户端会同时发主请求和标题/摘要这类小请求
        self.lock = asyncio.Semaphore(ACCOUNT_CONCURRENCY)
        self.status: str = "unknown"
        self.last_error: str = ""
        self.last_ok: float = 0.0
        self.last_checked: float = 0.0
        self.cooldown_until: float = 0.0
        self.models: list[dict[str, Any]] = []
        self.quota: list[dict[str, Any]] = []
        self.requests: int = 0
        self.successes: int = 0
        self.failures: int = 0
        self.avg_ms: float = 0.0
        self._init_lock = asyncio.Lock()
        self.on_cookie_rotated = lambda aid, val: None
        self.on_log = lambda level, msg: None
        # 首字超时的模型 → 解除时间戳
        self.stalled_models: dict[str, float] = {}

    # -- 生命周期 --
    def update_credentials(self, psid: str, psidts: str) -> None:
        self.psid = psid
        self.psidts = psidts
        self.client = None
        self.status = "unknown"

    async def ensure_client(self) -> Any:
        if self.client is not None:
            return self.client
        async with self._init_lock:
            if self.client is not None:
                return self.client
            client = _build_client(self.psid, self.psidts, self.settings.get("proxy"))
            try:
                await _init_client(client, timeout=60.0)
            except Exception:
                try:
                    await self._close_client(client)
                except Exception:
                    pass
                raise
            self.client = client
            self.models = list_models(client)
            self.quota = extract_quota(client)

            # 未登录时库会静默退化成「游客模式」（只有 flash-lite），必须显式拦掉
            code = _status_code(client)
            guest = not str(getattr(client, "access_token", None) or "").strip()
            if guest or code in (1016, 1021, 1033):
                self.client = None
                try:
                    await self._close_client(client)
                except Exception:
                    pass
                raise EngineError(
                    "Cookie 无效或已过期，账号处于未登录状态。"
                    "请在浏览器重新登录 gemini.google.com 后更新 Cookie",
                    code="unauthorized",
                    status=401,
                )
            if code != 1000:
                desc = str(
                    getattr(getattr(client, "account_status", None), "description", "") or ""
                )
                self.client = None
                try:
                    await self._close_client(client)
                except Exception:
                    pass
                raise EngineError(
                    f"账号不可用：{desc or code}", code="account_unavailable", status=403
                )

            self.status = "ok"
            self.last_ok = time.time()
            self.last_checked = time.time()
            self._sync_rotated_cookie()
            return client

    def _sync_rotated_cookie(self) -> None:
        """库在后台轮转 __Secure-1PSIDTS，这里读回来持久化，避免重启失效。"""
        try:
            cookies = getattr(self.client, "cookies", None)
            if cookies is None:
                return
            val = None
            try:
                val = cookies.get(COOKIE_PSIDTS)
            except Exception:
                getter = getattr(cookies, "get_dict", None)
                if callable(getter):
                    val = (getter() or {}).get(COOKIE_PSIDTS)
            if val and val != self.psidts:
                self.psidts = val
                self.on_cookie_rotated(self.id, val)
        except Exception:
            pass

    async def _close_client(self, client: Any) -> None:
        closer = getattr(client, "close", None)
        if closer:
            r = closer()
            if inspect.isawaitable(r):
                await r

    async def close(self) -> None:
        if self.client is not None:
            try:
                await self._close_client(self.client)
            except Exception:
                pass
            self.client = None

    async def reset(self) -> None:
        """丢弃客户端，下次请求重新初始化（Cookie 更新后调用）。"""
        await self.close()
        self.status = "unknown"
        self.last_error = ""
        self.cooldown_until = 0.0

    # -- 状态 --
    @property
    def healthy(self) -> bool:
        return self.status in ("ok", "unknown") and time.time() >= self.cooldown_until

    def mark_error(self, err: EngineError) -> None:
        if err.code == "account_busy":
            # 只是排队超时，账号本身没问题，不能因此冷却
            return
        self.failures += 1
        self.last_error = err.message
        self.last_checked = time.time()
        if err.code in ("unauthorized", "usage_limit", "region_blocked"):
            self.status = "error"
            self._drop_client()
        else:
            self.status = "cooldown"
            self.cooldown_until = time.time() + int(
                self.settings.get("cooldown_seconds") or 90
            )
            # 超时/网络类错误往往意味着连接已经不可用，直接丢弃，下次请求重建
            if err.code in (
                "timeout",
                "model_stalled",
                "network_error",
                "upstream_error",
                "empty_response",
                "temporarily_unavailable",
            ):
                self._drop_client()

    def _drop_client(self) -> None:
        old = self.client
        self.client = None
        if old is None:
            return
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self._close_client(old))
        except RuntimeError:
            pass

    def mark_ok(self, elapsed: float) -> None:
        self.successes += 1
        self.last_ok = time.time()
        self.last_checked = time.time()
        self.last_error = ""
        self.status = "ok"
        self.cooldown_until = 0.0
        self.avg_ms = elapsed * 1000 if not self.avg_ms else self.avg_ms * 0.75 + elapsed * 250

    # -- 生成 --
    def _timeout(self) -> float:
        return float(self.settings.get("request_timeout") or 180)

    @asynccontextmanager
    async def slot(self, wait: float = 120.0) -> AsyncIterator[None]:
        """占用账号执行位；排队超时则快速失败，避免请求无限堆积。"""
        try:
            await asyncio.wait_for(self.lock.acquire(), timeout=wait)
        except (TimeoutError, asyncio.TimeoutError):
            raise EngineError(
                "该账号正忙（上一个请求尚未结束），请稍后重试",
                code="account_busy",
                status=429,
                retryable=True,
            ) from None
        try:
            yield
        finally:
            self.lock.release()

    def _match_model(self, model: str) -> str | None:
        """把用户请求的模型名映射到账号真实可用的模型，匹配不到就返回 None（用账号默认）。"""
        if not model:
            return None
        ids = [m["id"] for m in self.models if m.get("id")]
        if model in ids:
            return model
        low = model.lower()
        for mid in ids:
            if mid.lower() == low:
                return mid
        for key in ("lite", "flash", "pro"):
            if key in low:
                for mid in ids:
                    if key in mid.lower():
                        return mid
        return None

    def _resolve_model(self, model: str) -> str | None:
        """匹配模型，并跳过近期被判定为「不出字」的模型。"""
        matched = self._match_model(model)
        if matched and self.stalled_models.get(matched, 0) > time.time():
            return None
        return matched

    def _first_output_timeout(self, thinking: bool) -> float:
        return min(self._timeout(), THINKING_FIRST_OUTPUT_TIMEOUT if thinking else FIRST_OUTPUT_TIMEOUT)

    async def _stream_once(
        self, prompt: str, model: str | None, thinking: bool, temporary: bool = False
    ) -> AsyncIterator[Any]:
        """单次上游调用，带两层超时：首个输出超时（判定模型卡死）+ 总超时。

        上游放在独立任务里跑、经队列转发：库底层连接被取消时可能迟迟不退出，
        直接 wait_for 会连带卡住，这里超时后只发取消、不等它收尾。
        """
        client = await self.ensure_client()
        kwargs: dict[str, Any] = {}
        if model:
            kwargs["model"] = model
        if thinking:
            kwargs["extended_thinking"] = True
        if temporary:
            kwargs["temporary"] = True
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._timeout()
        first_limit = self._first_output_timeout(thinking)
        queue: asyncio.Queue = asyncio.Queue()
        done = object()

        async def pump() -> None:
            try:
                async for out in client.generate_content_stream(prompt, **kwargs):
                    queue.put_nowait(out)
            except Exception as exc:  # 交给消费方处理
                queue.put_nowait(exc)
            finally:
                queue.put_nowait(done)

        task = loop.create_task(pump())
        task.add_done_callback(lambda t: t.cancelled() or t.exception())
        got_output = False
        try:
            while True:
                left = deadline - loop.time()
                limit = left if got_output else min(left, first_limit)
                if limit <= 0:
                    raise TimeoutError
                item = await asyncio.wait_for(queue.get(), timeout=limit)
                if item is done:
                    break
                if isinstance(item, Exception):
                    raise _normalize_error(item) from item
                got_output = True
                yield item
        except TimeoutError as exc:
            if not got_output and first_limit < self._timeout():
                raise EngineError(
                    f"模型 {model or '默认'} {first_limit:.0f} 秒内没有任何输出，已中断",
                    code="model_stalled",
                    status=504,
                    retryable=True,
                ) from exc
            raise EngineError(
                f"上游 {self._timeout():.0f} 秒无响应，已中断", code="timeout", status=504, retryable=True
            ) from exc
        finally:
            if not task.done():
                task.cancel()

    async def generate(
        self, prompt: str, model: str, thinking: bool, temporary: bool = False
    ) -> GenResult:
        text = ""
        thoughts = ""
        elapsed = 0.0
        async for ev in self.generate_stream(prompt, model, thinking, temporary):
            if ev["type"] == "done":
                text = ev["text"]
                thoughts = ev["thoughts"]
                elapsed = float(ev["elapsed"])
        return GenResult(text=text, thoughts=thoughts, model=model, elapsed=elapsed)

    async def generate_stream(
        self, prompt: str, model: str, thinking: bool, temporary: bool = False
    ) -> AsyncIterator[dict[str, str]]:
        """真流式：逐块产出 {type: text|thoughts, delta}，最后产出 {type: done}。

        某个模型首字超时（网页端偶有模型选择器失灵、上游接了请求却一直不回）时，
        把该模型在本账号上标记一段时间，并立即改用账号默认模型重试一次。
        """
        self.requests += 1
        started = time.perf_counter()
        text_parts: list[str] = []
        thoughts_parts: list[str] = []
        await self.ensure_client()  # 模型列表在初始化时才拿到，必须先于匹配
        target = self._resolve_model(model)
        while True:
            try:
                async for out in self._stream_once(prompt, target, thinking, temporary):
                    delta = _attr(out, "text_delta", default=None)
                    if delta:
                        text_parts.append(str(delta))
                        yield {"type": "text", "delta": str(delta)}
                    tdelta = _attr(out, "thoughts_delta", default=None)
                    if tdelta:
                        thoughts_parts.append(str(tdelta))
                        yield {"type": "thoughts", "delta": str(tdelta)}
                break
            except EngineError as err:
                if err.code != "model_stalled" or not target:
                    raise
                self.stalled_models[target] = time.time() + STALLED_MODEL_TTL
                self.on_log(
                    "warn",
                    f"账号 {self.name} 的模型 {target} 无输出，"
                    f"{STALLED_MODEL_TTL // 60} 分钟内改用账号默认模型",
                )
                self._drop_client()
                target = None

        full = "".join(text_parts).strip()
        if not full:
            raise EngineError("上游返回了空内容", code="empty_response", status=502, retryable=True)
        self._sync_rotated_cookie()
        yield {
            "type": "done",
            "text": full,
            "thoughts": "".join(thoughts_parts),
            "elapsed": f"{time.perf_counter() - started:.3f}",
        }

    async def probe(self) -> dict[str, Any]:
        """初始化客户端并返回账号概况（不做对话）。"""
        started = time.perf_counter()
        client = await self.ensure_client()
        status = _attr(client, "account_status", default=None)
        desc = str(_attr(status, "description", default="") or "")
        return {
            "ok": True,
            "elapsed": round(time.perf_counter() - started, 2),
            "models": self.models,
            "quota": self.quota,
            "account_status": desc or "正常",
        }


# ---------------------------------------------------------------- 账号池


class AccountPool:
    def __init__(self, state) -> None:
        self.state = state
        self.runtimes: dict[str, AccountRuntime] = {}
        self._rr = 0
        self.on_log = lambda level, msg: None
        self.sync()

    def sync(self) -> None:
        settings = self.state.settings
        wanted = {a["id"]: a for a in self.state.accounts}
        for aid in list(self.runtimes):
            if aid not in wanted:
                self.runtimes.pop(aid, None)
        for aid, acc in wanted.items():
            rt = self.runtimes.get(aid)
            if rt is None:
                rt = AccountRuntime(acc, settings)
                rt.on_cookie_rotated = self.state.save_rotated_cookie
                # 经池转发：池的 on_log 在构造后才由 Hub 挂上
                rt.on_log = lambda level, msg: self.on_log(level, msg)
                self.runtimes[aid] = rt
            else:
                rt.name = acc.get("name") or aid
                rt.settings = settings
                if rt.psid != acc["psid"] or rt.psidts != (acc.get("psidts") or ""):
                    rt.update_credentials(acc["psid"], acc.get("psidts") or "")

    def active(self) -> list[AccountRuntime]:
        out = []
        for acc in self.state.accounts:
            if not acc.get("enabled", True):
                continue
            rt = self.runtimes.get(acc["id"])
            if rt:
                out.append(rt)
        return out

    def pick(self) -> AccountRuntime:
        pool = self.active()
        if not pool:
            raise EngineError(
                "账号池为空，请先在「账号池」里添加 Google 账号 Cookie",
                code="no_account",
                status=503,
            )
        n = len(pool)
        for i in range(n):
            rt = pool[(self._rr + i) % n]
            if rt.healthy:
                self._rr = (self._rr + i + 1) % n
                return rt
        rt = min(pool, key=lambda r: r.cooldown_until)
        left = max(0, int(rt.cooldown_until - time.time()))
        detail = rt.last_error or "上次请求失败"
        raise EngineError(
            f"账号「{rt.name}」冷却中，约 {left} 秒后自动恢复（{detail}）",
            code="all_accounts_busy",
            status=429,
            retryable=True,
        )

    async def close_all(self) -> None:
        for rt in list(self.runtimes.values()):
            await rt.close()

    def snapshot(self) -> list[dict[str, Any]]:
        items = []
        for acc in self.state.accounts:
            rt = self.runtimes.get(acc["id"])
            items.append(
                {
                    "id": acc["id"],
                    "name": acc.get("name") or acc["id"],
                    "enabled": acc.get("enabled", True),
                    "has_psidts": bool(acc.get("psidts")),
                    "psid_masked": mask_psid(acc.get("psid") or ""),
                    "note": acc.get("note", ""),
                    "status": rt.status if rt else "unknown",
                    "last_error": rt.last_error if rt else "",
                    "last_ok": rt.last_ok if rt else 0,
                    "last_checked": rt.last_checked if rt else 0,
                    "requests": rt.requests if rt else 0,
                    "successes": rt.successes if rt else 0,
                    "failures": rt.failures if rt else 0,
                    "avg_ms": round(rt.avg_ms) if rt else 0,
                    "models": rt.models if rt else FALLBACK_MODELS,
                    "quota": rt.quota if rt else [],
                    "cooldown_until": rt.cooldown_until if rt else 0,
                }
            )
        return items
