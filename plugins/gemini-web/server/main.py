"""Gemini Proxy — 桌面端启动入口。

窗口方案：使用系统 Edge 的「应用模式」(`--app=`) 承载界面。
相比内嵌 WebView2 控件，这种方式不受部分机器上 WebView2 合成异常的影响，
窗口本身没有地址栏和标签页，观感与原生应用一致；同时使用独立 profile，
不会碰到用户日常浏览器的书签、扩展和登录态。
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

APP_TITLE = "Gemini Proxy"
DEFAULT_PORT = 8765
WINDOW_SIZE = (1240, 830)


# ---------------------------------------------------------------- 网络工具


def is_ours(port: int, timeout: float = 0.7) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/ping", timeout=timeout
        ) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("app") == APP_TITLE
    except Exception:
        return False


def port_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def pick_port(preferred: int) -> int:
    if port_free(preferred):
        return preferred
    for offset in range(1, 30):
        candidate = preferred + offset
        if port_free(candidate):
            return candidate
    raise SystemExit(f"端口 {preferred} 及后续 29 个端口都被占用，请先释放端口")


def wait_ready(port: int, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_ours(port, timeout=0.5):
            return True
        time.sleep(0.15)
    return False


# ---------------------------------------------------------------- 浏览器窗口


def find_edge() -> str | None:
    roots = [
        os.environ.get("PROGRAMFILES(X86)") or r"C:\Program Files (x86)",
        os.environ.get("PROGRAMFILES") or r"C:\Program Files",
        os.environ.get("LOCALAPPDATA") or "",
    ]
    for root in roots:
        if not root:
            continue
        p = Path(root) / "Microsoft" / "Edge" / "Application" / "msedge.exe"
        if p.exists():
            return str(p)
    return None


def open_app_window(url: str) -> subprocess.Popen | None:
    """以独立 profile 打开一个无地址栏的应用窗口。"""
    from app.state import data_dir

    edge = find_edge()
    if not edge:
        return None
    profile = data_dir() / "browser"
    profile.mkdir(parents=True, exist_ok=True)
    w, h = WINDOW_SIZE
    cmd = [
        edge,
        f"--app={url}",
        f"--user-data-dir={profile}",
        f"--window-size={w},{h}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=msEdgeSidebarV2,msEdgeIdentityFeatures",
        "--disable-sync",
        "--no-service-autorun",
    ]
    try:
        return subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        return None


def open_default_browser(url: str) -> None:
    import webbrowser

    webbrowser.open(url)


def window_alive(title: str) -> bool:
    """按标题检测应用窗口是否还在（Edge 启动器进程会提前退出，不能靠它判断）。"""
    if sys.platform != "win32":
        return True
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    hits: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd, _lparam):  # noqa: ANN001
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            if buf.value.strip() == title:
                hits.append(hwnd)
        except Exception:
            pass
        return True

    try:
        user32.EnumWindows(_cb, 0)
    except Exception:
        return True
    return bool(hits)


def wait_window(title: str, appear_timeout: float = 25.0) -> bool:
    """等窗口出现，返回是否出现。"""
    deadline = time.time() + appear_timeout
    while time.time() < deadline:
        if window_alive(title):
            return True
        time.sleep(0.3)
    return False


def wait_window_closed(title: str, grace: float = 8.0) -> None:
    """窗口连续消失 grace 秒后返回（宽限期避免误判）。"""
    missing = 0.0
    while True:
        time.sleep(1.0)
        if window_alive(title):
            missing = 0.0
        else:
            missing += 1.0
            if missing >= grace:
                print("[Gemini Proxy] 窗口已关闭，正在退出", flush=True)
                return


# ---------------------------------------------------------------- 主流程


def _ensure_stdio() -> None:
    """打包成无控制台程序后 sys.stdout 为 None，uvicorn 日志会因此崩溃。"""
    if sys.stdout is not None and sys.stderr is not None:
        return
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or "."
    log_path = Path(base) / "GeminiProxy" / "app.log"
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        f = open(log_path, "a", encoding="utf-8", buffering=1)
    except Exception:
        f = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = f
    if sys.stderr is None:
        sys.stderr = f


def main() -> None:
    _ensure_stdio()
    parser = argparse.ArgumentParser(description="Gemini Proxy 桌面版")
    parser.add_argument("--port", type=int, default=0, help="强制指定端口")
    parser.add_argument("--headless", action="store_true", help="只启动服务，不开窗口")
    parser.add_argument("--browser", action="store_true", help="用系统默认浏览器打开界面")
    args = parser.parse_args()

    from app.state import State

    state = State()
    settings = state.settings
    host = str(settings.get("host") or "127.0.0.1")
    preferred = args.port or int(settings.get("port") or DEFAULT_PORT)

    server = None
    if is_ours(preferred):
        # 已有实例在跑，复用它的服务，只补一个窗口
        port = preferred
        print(f"[Gemini Proxy] 复用已运行的实例 http://127.0.0.1:{port}", flush=True)
    else:
        port = pick_port(preferred)
        if port != preferred:
            print(f"[Gemini Proxy] 端口 {preferred} 被占用，改用 {port}", flush=True)

        from app.server import create_app
        import uvicorn

        app = create_app(runtime_port=port)
        config = uvicorn.Config(
            app,
            host=host,
            port=port,
            log_level="warning",
            access_log=False,
            lifespan="on",
            log_config=None,
        )
        server = uvicorn.Server(config)
        import threading

        threading.Thread(target=server.run, daemon=True, name="uvicorn").start()
        if not wait_ready(port):
            print("[Gemini Proxy] 服务启动失败，请检查端口占用或安全软件拦截", flush=True)
            sys.exit(1)
        print(f"[Gemini Proxy] 服务已就绪 http://127.0.0.1:{port}", flush=True)

    url = f"http://127.0.0.1:{port}"

    def shutdown() -> None:
        if server:
            server.should_exit = True
            time.sleep(0.3)

    if args.headless:
        print(f"[Gemini Proxy] 无窗口模式运行中：{url}", flush=True)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        finally:
            shutdown()
        return

    if args.browser:
        open_default_browser(url)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        finally:
            shutdown()
        return

    proc = open_app_window(url)
    if proc is None:
        print("[Gemini Proxy] 未找到 Edge，改用系统默认浏览器", flush=True)
        open_default_browser(url)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
        finally:
            shutdown()
        return

    print(f"[Gemini Proxy] 窗口已打开：{url}", flush=True)
    try:
        if wait_window(APP_TITLE):
            wait_window_closed(APP_TITLE)
        else:
            print("[Gemini Proxy] 窗口未能打开，改用系统默认浏览器", flush=True)
            open_default_browser(url)
            while True:
                time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if proc.poll() is None:
                proc.terminate()
        except Exception:
            pass
        shutdown()


if __name__ == "__main__":
    main()
