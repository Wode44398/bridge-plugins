# Gemini 网页版（bridge 插件）

把 gemini.google.com 网页端的订阅额度变成模型服务，按勾选出现在 **Claude** 和 **dimensio** 的模型列表里。

- `server/`：Gemini Proxy 源码（FastAPI + gemini-webapi，复刻网页端 StreamGenerate；`/v1/messages` 模拟工具调用）。
  插件「由 bridge 拉起」时在 `<数据根>/plugin-data/gemini-web/venv` 建虚拟环境，`main.py --headless --port <端口>` 托管运行，
  账号与设置在 `plugin-data/gemini-web/home/state.json`（`GEMINI_PROXY_HOME`）。
- `index.mjs`：托管进程、`ctx.models.provide` 登记模型服务（bridge ≥ 7.05 的插件能力 `models.provide`）、面板接口。
- `web/index.html`：控制面板（账号增删改测、提供给哪些 agent、最近请求、运行设置）。

推理强度两档：标准 / 深度思考（请求体 `gemini_thinking`）。图片附件暂不支持。仅限个人自用，非官方接口，网页端改版时在面板里「重装 Python 环境」升级 gemini-webapi。

2026-11-01 改了 `server/app/anthropic.py` 的工具调用提示词：原来的 `[System]` 伪角色标记 + `<tool_call>` 标签被 Gemini 判成注入、整轮拒答；
现在如实说明「本地编程助手软件代为执行操作」，调用写成 ```` ```tool_call ```` 代码块。
