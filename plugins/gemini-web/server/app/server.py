"""FastAPI 服务：OpenAI / Anthropic 兼容接口 + 本地管理 API。"""
from __future__ import annotations

import asyncio
import json
import sys
import time
import uuid
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Iterable

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import anthropic
from .engine import AccountPool, EngineError, FALLBACK_MODELS
from .state import APP_TITLE, State, data_dir

VERSION = "1.1.0"
# 网页端思考块没有 Anthropic 官方签名，给一个固定占位（客户端只原样回传）
THINKING_SIGNATURE = "gemini-web-thinking"


def resource_dir() -> Path:
    """兼容 PyInstaller 打包后的资源路径。"""
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
        candidate = base / "app"
        if candidate.exists():
            return candidate
    return Path(__file__).parent


STATIC_DIR = resource_dir() / "static"

# ----------------------------------------------------------------- 运行期数据


class Hub:
    """进程内共享的运行期数据：日志、请求记录、计数器。"""

    def __init__(self, state: State) -> None:
        self.state = state
        self.pool = AccountPool(state)
        self.pool.on_log = self.log
        self.logs: deque[dict[str, Any]] = deque(maxlen=800)
        self.requests: deque[dict[str, Any]] = deque(maxlen=200)
        self.started_at = time.time()
        self.total = 0
        self.failed = 0
        self.tokens_in = 0
        self.tokens_out = 0
        self._log_id = 0
        self._req_id = 0
        self._lock = asyncio.Lock()

    def log(self, level: str, msg: str) -> None:
        self._log_id += 1
        self.logs.append(
            {"id": self._log_id, "ts": time.time(), "level": level, "msg": msg}
        )

    def record(self, **kw: Any) -> None:
        self._req_id += 1
        kw["id"] = self._req_id
        kw["ts"] = time.time()
        self.requests.appendleft(kw)

    def counters(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "failed": self.failed,
            "tokens_in": self.tokens_in,
            "tokens_out": self.tokens_out,
            "uptime": int(time.time() - self.started_at),
        }


# ----------------------------------------------------------------- 工具函数


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    cjk = 0
    for ch in text:
        o = ord(ch)
        if 0x4E00 <= o <= 0x9FFF or 0x3040 <= o <= 0x30FF or 0xAC00 <= o <= 0xD7AF:
            cjk += 1
    rest = max(0, len(text) - cjk)
    return max(1, cjk + rest // 4)


def extract_text(content: Any) -> str:
    """兼容 OpenAI 的 content 字符串 / 多段数组。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        chunks = []
        for part in content:
            if isinstance(part, str):
                chunks.append(part)
            elif isinstance(part, dict):
                if part.get("type") in ("text", "input_text") and part.get("text"):
                    chunks.append(str(part["text"]))
                elif part.get("type") == "image_url":
                    chunks.append("[图片已省略]")
        return "\n".join(chunks)
    return str(content)


def build_prompt(messages: Iterable[dict[str, Any]]) -> str:
    """把多轮对话压平成一段提示词，交给网页端模型。"""
    msgs = [m for m in messages if isinstance(m, dict)]
    if not msgs:
        raise EngineError("messages 不能为空", code="bad_request", status=400)

    # 单轮纯文本：原样发送，质量最好
    if len(msgs) == 1 and msgs[0].get("role") == "user":
        text = extract_text(msgs[0].get("content")).strip()
        if text:
            return text

    system_parts: list[str] = []
    turns: list[tuple[str, str]] = []
    for m in msgs:
        role = str(m.get("role") or "user")
        text = extract_text(m.get("content")).strip()
        if not text:
            continue
        if role in ("system", "developer"):
            system_parts.append(text)
        elif role == "assistant":
            turns.append(("Assistant", text))
        elif role in ("tool", "function"):
            turns.append(("Tool", text))
        else:
            turns.append(("User", text))

    blocks: list[str] = []
    if system_parts:
        blocks.append("[System]\n" + "\n\n".join(system_parts))
    for role, text in turns:
        blocks.append(f"[{role}]\n{text}")
    if not turns:
        return "\n\n".join(blocks) or "你好"
    blocks.append("[Assistant]\n请直接给出你的回复，不要复述上面的角色标记。")
    return "\n\n".join(blocks)


def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return key[:4] + "*" * (len(key) - 8) + key[-4:]


def parse_cookie_input(raw: str) -> tuple[str, str]:
    """支持三种输入：纯 PSID、`name=value; name=value` 整段 Cookie、带换行的多行。

    返回 (psid, psidts)；解析不到时把原文当作 PSID。
    """
    import re

    text = (raw or "").strip()
    if not text:
        return "", ""

    def grab(name: str) -> str:
        m = re.search(rf"{re.escape(name)}\s*=\s*([^;\s]+)", text)
        return m.group(1) if m else ""

    psid = grab("__Secure-1PSID")
    psidts = grab("__Secure-1PSIDTS")
    if psid:
        return psid, psidts
    # 没有 name= 结构，说明用户只贴了值本身
    return text.split()[0].strip().strip('"'), psidts


def public_settings(state: State) -> dict[str, Any]:
    s = dict(state.settings)
    s["api_key_masked"] = mask_key(str(s.get("api_key") or ""))
    s["has_api_key"] = bool(s.get("api_key"))
    s["api_key"] = ""  # 不回传明文
    return s


def collect_models(hub: "Hub", state: State) -> list[dict[str, Any]]:
    """汇总各账号真实可用模型；一个都没读到时才退回内置列表。"""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for acc in state.accounts:
        rt = hub.pool.runtimes.get(acc["id"])
        if not rt:
            continue
        for m in rt.models:
            mid = m.get("id")
            if mid and mid not in seen:
                seen.add(mid)
                out.append(dict(m))
    return out or [dict(x) for x in FALLBACK_MODELS]


# ----------------------------------------------------------------- 应用工厂


def create_app(runtime_port: int | None = None) -> FastAPI:
    state = State()
    if runtime_port:
        # 仅在内存中覆盖，保证界面显示的是真实监听端口
        state.override_runtime("port", int(runtime_port))
    hub = Hub(state)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        hub.log("info", f"{APP_TITLE} 已启动，监听 {state.settings['host']}:{state.settings['port']}")
        hub.log("info", f"已加载 {len(state.accounts)} 个账号")
        if not state.accounts:
            hub.log("warn", "账号池为空，请先添加 Google 账号 Cookie")
        try:
            yield
        finally:
            await hub.pool.close_all()

    app = FastAPI(title=APP_TITLE, version=VERSION, docs_url="/docs", lifespan=lifespan)
    app.state.hub = hub
    app.state.state = state

    # ---------- 鉴权 ----------
    async def require_key(authorization: str = Header(default="")) -> None:
        key = str(state.settings.get("api_key") or "").strip()
        if not key:
            return
        token = ""
        if authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()
        elif authorization.lower().startswith("sk-"):
            token = authorization.strip()
        if token != key:
            raise HTTPException(status_code=401, detail="API Key 无效")

    # ---------- 页面 ----------
    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/ping")
    async def ping() -> dict[str, Any]:
        return {"app": APP_TITLE, "version": VERSION, "ok": True}

    # ---------- 管理 API ----------
    @app.get("/api/overview")
    async def overview() -> dict[str, Any]:
        hub.pool.sync()
        return {
            "version": VERSION,
            "settings": public_settings(state),
            "accounts": hub.pool.snapshot(),
            "counters": hub.counters(),
            "requests": list(hub.requests)[:50],
            "models": collect_models(hub, state),
            "data_dir": str(data_dir()),
            "endpoints": {
                "openai": "/v1/chat/completions",
                "anthropic": "/v1/messages",
                "models": "/v1/models",
            },
        }

    @app.post("/api/settings")
    async def update_settings(payload: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "api_key",
            "proxy",
            "default_model",
            "thinking",
            "cooldown_seconds",
            "request_timeout",
            "theme",
            "auto_start",
        }
        patch = {k: v for k, v in payload.items() if k in allowed}
        if "api_key" in patch and patch["api_key"] == "":
            patch.pop("api_key")  # 空表示不改
        state.update_settings(patch)
        hub.pool.sync()
        hub.log("info", "设置已更新")
        return {"ok": True, "settings": public_settings(state)}

    @app.post("/api/accounts")
    async def add_account(payload: dict[str, Any]) -> dict[str, Any]:
        psid, psidts = parse_cookie_input(str(payload.get("psid") or ""))
        extra_ts = str(payload.get("psidts") or "").strip()
        if extra_ts:
            psidts = extra_ts
        if not psid:
            raise HTTPException(status_code=400, detail="请填写 __Secure-1PSID")
        try:
            acc = state.add_account(str(payload.get("name") or ""), psid, psidts)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        hub.pool.sync()
        hub.log("info", f"新增账号：{acc['name']}")
        return {"ok": True, "account": acc}

    @app.patch("/api/accounts/{account_id}")
    async def patch_account(account_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            acc = state.update_account(account_id, payload)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="账号不存在") from exc
        hub.pool.sync()
        rt = hub.pool.runtimes.get(account_id)
        if rt:
            rt.status = "unknown"
            rt.last_error = ""
        return {"ok": True, "account": acc}

    @app.delete("/api/accounts/{account_id}")
    async def remove_account(account_id: str) -> dict[str, Any]:
        rt = hub.pool.runtimes.get(account_id)
        if rt:
            await rt.close()
            hub.pool.runtimes.pop(account_id, None)
        state.delete_account(account_id)
        hub.log("info", "已删除账号")
        return {"ok": True}

    @app.post("/api/accounts/{account_id}/test")
    async def test_account(account_id: str) -> dict[str, Any]:
        rt = hub.pool.runtimes.get(account_id)
        if not rt:
            raise HTTPException(status_code=404, detail="账号不存在")
        try:
            info = await asyncio.wait_for(rt.probe(), timeout=75)
        except asyncio.TimeoutError:
            rt.status = "error"
            rt.last_error = "连接超时，请检查网络或代理设置"
            rt.last_checked = time.time()
            raise HTTPException(status_code=504, detail=rt.last_error) from None
        except EngineError as exc:
            rt.mark_error(exc)
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
        except Exception as exc:  # pragma: no cover
            rt.status = "error"
            rt.last_error = str(exc)
            rt.last_checked = time.time()
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        rt.mark_ok(info["elapsed"])
        hub.log("info", f"账号 {rt.name} 连接正常，可用模型 {len(info['models'])} 个")
        return info

    @app.post("/api/accounts/import-browser")
    async def import_from_browser(payload: dict[str, Any] | None = None) -> dict[str, Any]:
        """从本机浏览器读取 Gemini 的登录 Cookie。"""
        payload = payload or {}
        browser = str(payload.get("browser") or "auto").lower()
        try:
            import browser_cookie3 as bc3
        except Exception:
            raise HTTPException(
                status_code=500, detail="缺少 browser-cookie3 依赖"
            ) from None

        loaders = {
            "chrome": bc3.chrome,
            "edge": bc3.edge,
            "brave": bc3.brave,
            "firefox": bc3.firefox,
            "opera": bc3.opera,
            "vivaldi": bc3.vivaldi,
        }
        order = (
            [browser] if browser in loaders else ["chrome", "edge", "brave", "firefox"]
        )
        found: dict[str, str] = {}
        used = ""
        for name in order:
            fn = loaders.get(name)
            if not fn:
                continue
            try:
                jar = await asyncio.to_thread(fn, domain_name="google.com")
            except Exception:
                continue
            psid = psidts = ""
            for c in jar:
                if c.name == "__Secure-1PSID" and c.value:
                    psid = c.value
                elif c.name == "__Secure-1PSIDTS" and c.value:
                    psidts = c.value
            if psid:
                found = {"psid": psid, "psidts": psidts}
                used = name
                break

        if not found:
            raise HTTPException(
                status_code=404,
                detail="没有读到 Gemini 的登录 Cookie。请确认已在浏览器登录 gemini.google.com，"
                "并关闭该浏览器后重试（Chrome 会锁定 Cookie 数据库）。",
            )
        acc = state.add_account(used.capitalize(), found["psid"], found["psidts"])
        hub.pool.sync()
        hub.log("info", f"已从 {used} 导入账号")
        return {"ok": True, "account": acc, "browser": used}

    @app.get("/api/logs")
    async def logs(after: int = 0) -> dict[str, Any]:
        items = [x for x in hub.logs if x["id"] > after]
        return {"logs": items[-300:], "last": hub.logs[-1]["id"] if hub.logs else 0}

    @app.post("/api/logs/clear")
    async def clear_logs() -> dict[str, Any]:
        hub.logs.clear()
        return {"ok": True}

    @app.post("/api/requests/clear")
    async def clear_requests() -> dict[str, Any]:
        hub.requests.clear()
        return {"ok": True}

    @app.post("/api/playground")
    async def playground(payload: dict[str, Any]) -> dict[str, Any]:
        prompt = str(payload.get("prompt") or "").strip()
        if not prompt:
            raise HTTPException(status_code=400, detail="prompt 不能为空")
        model = str(payload.get("model") or state.settings.get("default_model") or "")
        thinking = bool(payload.get("thinking", state.settings.get("thinking")))
        started = time.perf_counter()
        try:
            rt = hub.pool.pick()
            async with rt.slot():
                res = await rt.generate(prompt, model, thinking)
        except EngineError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc
        rt.mark_ok(time.perf_counter() - started)
        return {
            "ok": True,
            "text": res.text,
            "thoughts": res.thoughts,
            "account": rt.name,
            "elapsed": round(res.elapsed, 2),
        }

    # ---------- OpenAI 兼容 ----------
    @app.get("/v1/models", dependencies=[Depends(require_key)])
    async def list_models() -> dict[str, Any]:
        hub.pool.sync()
        models = collect_models(hub, state)
        return {
            "object": "list",
            "data": [
                {
                    "id": m["id"],
                    "object": "model",
                    "created": int(hub.started_at),
                    "owned_by": "google-gemini-web",
                    "display_name": m.get("name") or m["id"],
                }
                for m in models
            ],
        }

    @app.post("/v1/chat/completions", dependencies=[Depends(require_key)])
    async def chat_completions(payload: dict[str, Any], request: Request):
        messages = payload.get("messages") or []
        model = str(payload.get("model") or state.settings.get("default_model") or "")
        stream = bool(payload.get("stream"))
        thinking = bool(
            payload.get("thinking", payload.get("reasoning", state.settings.get("thinking")))
        )
        try:
            prompt = build_prompt(messages)
        except EngineError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message) from exc

        hub.total += 1
        in_tokens = estimate_tokens(prompt)
        hub.tokens_in += in_tokens
        cid = "chatcmpl-" + uuid.uuid4().hex[:24]
        created = int(time.time())
        started = time.perf_counter()

        async def run() -> tuple[str, str, str, float]:
            last_exc: EngineError | None = None
            for attempt in range(2):
                try:
                    rt = hub.pool.pick()
                except EngineError as exc:
                    last_exc = last_exc or exc
                    break
                try:
                    async with rt.slot():
                        res = await rt.generate(prompt, model, thinking)
                    rt.mark_ok(time.perf_counter() - started)
                    return res.text, res.thoughts, rt.name, res.elapsed
                except EngineError as exc:
                    last_exc = exc
                    rt.mark_error(exc)
                    if not exc.retryable or attempt == 1:
                        break
            raise last_exc or EngineError("未知错误")

        if not stream:
            try:
                text, thoughts, acc_name, elapsed = await run()
            except EngineError as exc:
                hub.failed += 1
                hub.record(
                    model=model,
                    status=exc.status,
                    ms=int((time.perf_counter() - started) * 1000),
                    account="",
                    error=exc.message,
                    preview="",
                    stream=False,
                )
                hub.log("error", f"请求失败：{exc.message}")
                return JSONResponse(
                    status_code=exc.status,
                    content={
                        "error": {
                            "message": exc.message,
                            "type": exc.code,
                            "code": exc.code,
                        }
                    },
                )
            out_tokens = estimate_tokens(text)
            hub.tokens_out += out_tokens
            ms = int((time.perf_counter() - started) * 1000)
            hub.record(
                model=model,
                status=200,
                ms=ms,
                account=acc_name,
                error="",
                preview=text[:120].replace("\n", " "),
                stream=False,
            )
            hub.log("ok", f"{model} ← {acc_name} · {ms}ms · {out_tokens} tokens")
            return JSONResponse(
                {
                    "id": cid,
                    "object": "chat.completion",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": text},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {
                        "prompt_tokens": in_tokens,
                        "completion_tokens": out_tokens,
                        "total_tokens": in_tokens + out_tokens,
                    },
                }
            )

        # --- 流式（真流式，逐块转发上游增量） ---
        async def sse() -> Any:
            def chunk(delta: dict[str, Any], finish: str | None = None) -> str:
                body = {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                }
                return f"data: {json.dumps(body, ensure_ascii=False)}\n\n"

            stream_started = time.perf_counter()
            full_text = ""
            acc_name = ""
            emitted = False
            success = False
            last_exc: EngineError | None = None

            for attempt in range(2):
                try:
                    rt = hub.pool.pick()
                except EngineError as exc:
                    last_exc = last_exc or exc
                    break
                acc_name = rt.name
                retry = False
                try:
                    async with rt.slot():
                        async for ev in rt.generate_stream(prompt, model, thinking):
                            if ev["type"] == "text":
                                if not emitted:
                                    yield chunk({"role": "assistant", "content": ""})
                                    emitted = True
                                full_text += ev["delta"]
                                yield chunk({"content": ev["delta"]})
                            elif ev["type"] == "done":
                                full_text = ev.get("text") or full_text
                    rt.mark_ok(time.perf_counter() - stream_started)
                    success = True
                except EngineError as exc:
                    last_exc = exc
                    rt.mark_error(exc)
                    if not emitted and exc.retryable and attempt == 0:
                        retry = True
                    else:
                        break
                if retry:
                    continue
                break

            if not success:
                err = last_exc or EngineError("未知错误")
                hub.failed += 1
                hub.record(
                    model=model,
                    status=err.status,
                    ms=int((time.perf_counter() - stream_started) * 1000),
                    account=acc_name,
                    error=err.message,
                    preview="",
                    stream=True,
                )
                hub.log("error", f"流式请求失败：{err.message}")
                body = {"error": {"message": err.message, "type": err.code}}
                yield f"data: {json.dumps(body, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"
                return

            yield chunk({}, "stop")
            yield "data: [DONE]\n\n"
            out_tokens = estimate_tokens(full_text)
            hub.tokens_out += out_tokens
            ms = int((time.perf_counter() - stream_started) * 1000)
            hub.record(
                model=model,
                status=200,
                ms=ms,
                account=acc_name,
                error="",
                preview=full_text[:120].replace("\n", " "),
                stream=True,
            )
            hub.log("ok", f"{model} ← {acc_name} · {ms}ms · 流式 · {out_tokens} tokens")

        return StreamingResponse(
            sse(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    # ---------- Anthropic 兼容（含工具调用模拟） ----------
    @app.post("/v1/messages/count_tokens", dependencies=[Depends(require_key)])
    async def anthropic_count_tokens(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            prompt = anthropic.build_prompt(payload)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"input_tokens": estimate_tokens(prompt)}

    @app.post("/v1/messages", dependencies=[Depends(require_key)])
    async def anthropic_messages(payload: dict[str, Any], request: Request):
        model = str(payload.get("model") or state.settings.get("default_model") or "")
        stream = bool(payload.get("stream"))
        thinking = anthropic.resolve_thinking(payload, bool(state.settings.get("thinking")))
        tool_names = {
            str(t.get("name")) for t in (payload.get("tools") or []) if isinstance(t, dict) and t.get("name")
        }
        # 带工具的都是 agent 客户端的自动请求，不写进网页端的对话历史
        temporary = bool(tool_names) or bool(payload.get("gemini_temporary"))
        try:
            prompt = anthropic.build_prompt(payload)
        except ValueError as exc:
            return JSONResponse(
                status_code=400,
                content={"type": "error", "error": {"type": "invalid_request_error", "message": str(exc)}},
            )

        hub.total += 1
        in_tokens = estimate_tokens(prompt)
        hub.tokens_in += in_tokens
        mid = "msg_" + uuid.uuid4().hex[:20]
        t0 = time.perf_counter()
        tag = " · ".join(
            x for x in ("深度思考" if thinking else "", f"{len(tool_names)} 个工具" if tool_names else "") if x
        )

        def finish_log(acc_name: str, text: str, calls: list[dict[str, Any]], streamed: bool) -> int:
            out_tokens = estimate_tokens(text + json.dumps([c["input"] for c in calls], ensure_ascii=False))
            hub.tokens_out += out_tokens
            ms = int((time.perf_counter() - t0) * 1000)
            preview = text[:120].replace("\n", " ")
            if calls:
                preview = ("调用 " + ", ".join(c["name"] for c in calls) + " · " + preview)[:120]
            hub.record(model=model, status=200, ms=ms, account=acc_name, error="", preview=preview, stream=streamed)
            msg = f"{model} ← {acc_name} · {ms}ms · Anthropic{' 流式' if streamed else ''}"
            if tag:
                msg += f" · {tag}"
            if calls:
                msg += f" · 调用 {len(calls)} 个工具"
            hub.log("ok", msg)
            return out_tokens

        def fail(err: EngineError) -> None:
            hub.failed += 1
            hub.record(model=model, status=err.status, ms=int((time.perf_counter() - t0) * 1000),
                       account="", error=err.message, preview="", stream=stream)
            hub.log("error", f"请求失败：{err.message}")

        if not stream:
            last_exc: EngineError | None = None
            res = None
            acc_name = ""
            for attempt in range(2):
                try:
                    rt = hub.pool.pick()
                except EngineError as exc:
                    last_exc = last_exc or exc
                    break
                try:
                    async with rt.slot():
                        res = await rt.generate(prompt, model, thinking, temporary)
                    rt.mark_ok(res.elapsed)
                    acc_name = rt.name
                    break
                except EngineError as exc:
                    last_exc = exc
                    rt.mark_error(exc)
                    if not exc.retryable or attempt == 1:
                        break
            if res is None:
                err = last_exc or EngineError("未知错误")
                fail(err)
                return JSONResponse(
                    status_code=err.status,
                    content={"type": "error", "error": {"type": err.code, "message": err.message}},
                )
            text, calls = anthropic.split_output(res.text, tool_names)
            content: list[dict[str, Any]] = []
            if res.thoughts.strip():
                content.append({"type": "thinking", "thinking": res.thoughts, "signature": THINKING_SIGNATURE})
            if text:
                content.append({"type": "text", "text": text})
            content.extend(calls)
            if not content:
                content.append({"type": "text", "text": ""})
            out_tokens = finish_log(acc_name, text, calls, False)
            return JSONResponse(
                {
                    "id": mid,
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": content,
                    "stop_reason": "tool_use" if calls else "end_turn",
                    "stop_sequence": None,
                    "usage": {"input_tokens": in_tokens, "output_tokens": out_tokens},
                }
            )

        async def sse() -> Any:
            def ev(name: str, data: dict[str, Any]) -> str:
                return f"event: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

            yield ev(
                "message_start",
                {
                    "type": "message_start",
                    "message": {
                        "id": mid,
                        "type": "message",
                        "role": "assistant",
                        "model": model,
                        "content": [],
                        "stop_reason": None,
                        "stop_sequence": None,
                        "usage": {"input_tokens": in_tokens, "output_tokens": 0},
                    },
                },
            )

            blk = {"idx": -1, "kind": ""}  # 当前打开的内容块：thinking / text

            def close_block() -> list[str]:
                if not blk["kind"]:
                    return []
                out = []
                if blk["kind"] == "thinking":
                    out.append(ev("content_block_delta", {
                        "type": "content_block_delta", "index": blk["idx"],
                        "delta": {"type": "signature_delta", "signature": THINKING_SIGNATURE}}))
                out.append(ev("content_block_stop", {"type": "content_block_stop", "index": blk["idx"]}))
                blk["kind"] = ""
                return out

            def open_block(kind: str) -> list[str]:
                out = close_block()
                blk["idx"] += 1
                blk["kind"] = kind
                block = {"type": "thinking", "thinking": ""} if kind == "thinking" else {"type": "text", "text": ""}
                out.append(ev("content_block_start", {
                    "type": "content_block_start", "index": blk["idx"], "content_block": block}))
                return out

            def delta_out(kind: str, s: str) -> list[str]:
                if not s:
                    return []
                out = open_block(kind) if blk["kind"] != kind else []
                d = {"type": "thinking_delta", "thinking": s} if kind == "thinking" else {"type": "text_delta", "text": s}
                out.append(ev("content_block_delta", {"type": "content_block_delta", "index": blk["idx"], "delta": d}))
                return out

            splitter = anthropic.StreamSplitter()
            saw_text = False
            acc_name = ""
            emitted = False
            success = False
            last_exc: EngineError | None = None

            for attempt in range(2):
                try:
                    rt = hub.pool.pick()
                except EngineError as exc:
                    last_exc = last_exc or exc
                    break
                acc_name = rt.name
                retry = False
                try:
                    async with rt.slot():
                        async for e in rt.generate_stream(prompt, model, thinking, temporary):
                            if e["type"] == "thoughts" and not saw_text:
                                emitted = True
                                for x in delta_out("thinking", e["delta"]):
                                    yield x
                            elif e["type"] == "text":
                                emitted = True
                                saw_text = True
                                for x in delta_out("text", splitter.feed(e["delta"])):
                                    yield x
                    rt.mark_ok(time.perf_counter() - t0)
                    success = True
                except EngineError as exc:
                    last_exc = exc
                    rt.mark_error(exc)
                    if not emitted and exc.retryable and attempt == 0:
                        retry = True
                    else:
                        break
                if retry:
                    continue
                break

            if not success:
                err = last_exc or EngineError("未知错误")
                fail(err)
                for x in close_block():
                    yield x
                yield ev("error", {"type": "error", "error": {"type": err.code, "message": err.message}})
                return

            for x in delta_out("text", splitter.flush()):
                yield x
            text, calls = anthropic.split_output(splitter.full, tool_names)
            if not calls and splitter.stopped:
                # 有 <tool_call> 却解析不出合法调用：把扣下的原文补发出去，别吞内容
                for x in delta_out("text", splitter.full[splitter.full.find(anthropic.OPEN_TAG):]):
                    yield x
            for x in close_block():
                yield x
            for call in calls:
                blk["idx"] += 1
                yield ev("content_block_start", {
                    "type": "content_block_start", "index": blk["idx"],
                    "content_block": {"type": "tool_use", "id": call["id"], "name": call["name"], "input": {}}})
                yield ev("content_block_delta", {
                    "type": "content_block_delta", "index": blk["idx"],
                    "delta": {"type": "input_json_delta", "partial_json": json.dumps(call["input"], ensure_ascii=False)}})
                yield ev("content_block_stop", {"type": "content_block_stop", "index": blk["idx"]})
            if blk["idx"] < 0:
                # 一个块都没有时补一个空文本块，保证客户端解析不出错
                for x in open_block("text") + close_block():
                    yield x
            out_tokens = finish_log(acc_name, text, calls, True)
            yield ev(
                "message_delta",
                {
                    "type": "message_delta",
                    "delta": {"stop_reason": "tool_use" if calls else "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": out_tokens},
                },
            )
            yield ev("message_stop", {"type": "message_stop"})

        return StreamingResponse(
            sse(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {"ok": True, "uptime": int(time.time() - hub.started_at)}

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
    return app
