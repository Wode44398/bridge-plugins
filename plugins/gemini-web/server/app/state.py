"""本地状态持久化：配置 + 账号池。

数据存放在 %LOCALAPPDATA%\\GeminiProxy\\state.json
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

APP_NAME = "GeminiProxy"
APP_TITLE = "Gemini Proxy"


def data_dir() -> Path:
    override = os.environ.get("GEMINI_PROXY_HOME")
    if override:
        d = Path(override)
        d.mkdir(parents=True, exist_ok=True)
        return d
    base = (
        os.environ.get("LOCALAPPDATA")
        or os.environ.get("APPDATA")
        or str(Path.home())
    )
    d = Path(base) / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


STATE_FILE = data_dir() / "state.json"

DEFAULT_SETTINGS: dict[str, Any] = {
    "host": "127.0.0.1",
    "port": 8765,
    "api_key": "",
    "proxy": "",
    "default_model": "gemini-pro",
    "thinking": False,
    "cooldown_seconds": 90,
    "request_timeout": 180,
    "theme": "auto",
    "auto_start": False,
}


def _new_account(name: str, psid: str, psidts: str = "") -> dict[str, Any]:
    return {
        "id": uuid.uuid4().hex[:12],
        "name": name or "未命名账号",
        "psid": psid.strip(),
        "psidts": psidts.strip(),
        "enabled": True,
        "created_at": time.time(),
        "note": "",
    }


class State:
    """线程安全的 JSON 状态容器。"""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or STATE_FILE
        self._lock = threading.RLock()
        self.data: dict[str, Any] = {"settings": dict(DEFAULT_SETTINGS), "accounts": []}
        # 仅本次运行生效的覆盖项 → 磁盘上的原值，保存时还原
        self._runtime_shadow: dict[str, Any] = {}
        self.load()

    # ---------- 读写 ----------
    def load(self) -> None:
        with self._lock:
            if not self.path.exists():
                self.save()
                return
            try:
                raw = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception:
                # 文件损坏时备份后重置，避免直接崩掉
                try:
                    self.path.rename(self.path.with_suffix(".broken.json"))
                except OSError:
                    pass
                self.save()
                return

            settings = dict(DEFAULT_SETTINGS)
            settings.update(raw.get("settings") or {})
            accounts = [a for a in (raw.get("accounts") or []) if a.get("psid")]
            self.data = {"settings": settings, "accounts": accounts}

    def save(self) -> None:
        with self._lock:
            data = self.data
            if self._runtime_shadow:
                data = {**self.data, "settings": {**self.settings, **self._runtime_shadow}}
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            tmp.replace(self.path)

    # ---------- 配置 ----------
    @property
    def settings(self) -> dict[str, Any]:
        return self.data["settings"]

    def override_runtime(self, key: str, value: Any) -> None:
        """只在内存里覆盖某项设置（如命令行指定的端口），不写回磁盘。"""
        with self._lock:
            if key not in self._runtime_shadow:
                self._runtime_shadow[key] = self.settings.get(key)
            self.settings[key] = value

    def update_settings(self, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            for k, v in patch.items():
                if k in DEFAULT_SETTINGS:
                    self.settings[k] = v
            self.save()
            return dict(self.settings)

    # ---------- 账号 ----------
    @property
    def accounts(self) -> list[dict[str, Any]]:
        return self.data["accounts"]

    def get_account(self, account_id: str) -> dict[str, Any] | None:
        for a in self.accounts:
            if a["id"] == account_id:
                return a
        return None

    def add_account(self, name: str, psid: str, psidts: str = "") -> dict[str, Any]:
        with self._lock:
            psid = (psid or "").strip()
            if not psid:
                raise ValueError("__Secure-1PSID 不能为空")
            # 同一 PSID 不重复添加
            for a in self.accounts:
                if a.get("psid") == psid:
                    raise ValueError("该账号已存在")
            acc = _new_account(name, psid, psidts)
            self.accounts.append(acc)
            self.save()
            return acc

    def update_account(self, account_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            acc = self.get_account(account_id)
            if not acc:
                raise KeyError(account_id)
            for k in ("name", "psid", "psidts", "enabled", "note"):
                if k in patch and patch[k] is not None:
                    acc[k] = patch[k]
            self.save()
            return acc

    def delete_account(self, account_id: str) -> None:
        with self._lock:
            self.data["accounts"] = [
                a for a in self.accounts if a["id"] != account_id
            ]
            self.save()

    def save_rotated_cookie(self, account_id: str, psidts: str) -> None:
        """Cookie 自动轮转后回写，避免重启后失效。"""
        with self._lock:
            acc = self.get_account(account_id)
            if acc and psidts and acc.get("psidts") != psidts:
                acc["psidts"] = psidts
                self.save()
