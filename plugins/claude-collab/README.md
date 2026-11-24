# Claude 协作工作空间（bridge 插件 `claude-collab`）

让 Antigravity 和 Claude 共用一个文件夹：共用 Claude 的记忆，互相看对话、发消息、开会话。

- 只对服务器主机开放。需要 bridge **8.89** 以上（插件接口八期：`ctx.ops.call`、审批策略回 `'ask'` 且管到 agy、`ctx.claude.ensureProject`、turn 事件的 `via`、消息改写的 `hint`）。
- 在 Antigravity 侧栏右键（手机长按）一个文件夹 →「设为和 Claude 的协作工作空间」；设过之后两边的菜单里有「协作设置…」「取消协作」，设为 / 取消都能撤销。

## 设了之后

- **Antigravity**：在协作文件夹（含子目录、同一 git 主仓库的 worktree）里**新开**的会话，开场带一段说明：记忆总索引在哪、怎么读、照记忆库规矩写回（`last_edited_by: agy`）、怎么用 bridge 的会话操作找 Claude、「来自 Claude」的消息不是用户本人。已经挂着的会话拿不到（bridge 的限制：系统提示只在挂载时给）。
- **Claude**：同一个协作空间里的会话带一段说明：这里也是 Antigravity 的工作空间，用 `mcp__bridge__call` 带 `agent:"agy"` 看 / 发 / 开会话。
- **跨 agent 消息**：Claude 发给 Antigravity 的消息自动加「来自 Claude」抬头，不带会话 id 时新会话自动开在协作文件夹；Antigravity 经 bridge 操作发给 Claude 的，Claude 收到一段「来自 Antigravity」的旁注（hint：模型看得到，会话标题、历史气泡不带它）。
- **两边侧栏**：底板、双方标识、谁在干活（两个 agent 的 turn 事件）、对方在干什么（点了打开那个会话）、共用记忆行（篇数 + 最近谁写的，只读最近那篇的 frontmatter）、悬停卡、会话行首「谁开的」；Claude 侧栏的项目下另列 Antigravity 在这里的会话。
- **「互相发消息前先问我」**：两个方向的每条消息、每个新会话都弹审批——Claude 绕过权限、Antigravity 完全放行下也弹；后台唤醒这类没人在的轮按拒绝。

## 注意

- 设为协作空间（以及保存协作设置）时，文件夹不是 Claude 项目就自动建成项目（取消协作不删）；Antigravity 开 Claude 新会话要带项目 id，插件把它写进 Antigravity 的开场说明。
- 数据在插件的 `store.json`：协作文件夹（路径、记忆目录、开关、设定时间、对应的 Claude 项目）与「谁开的」会话表（各最多 500 条）。

## 目录

```
bridge-plugin.json   清单
index.mjs            接线：外观、菜单项与确认框、两段开场说明、钩子 / 审批策略 / 消息改写、turn 事件、状态块
lib/paths.mjs        路径归属（含 worktree，只读 .git 不跑 git）
lib/memory.mjs       记忆概况（篇数、分区、最近谁写的）
lib/prompts.mjs      两段开场说明原文、抬头
lib/live.mjs         谁在哪个文件夹干活、谁开的会话
lib/decor.mjs        一个文件夹在某个分页的外观条目（纯函数）
lib/lib.test.mjs     单测：node --test lib/lib.test.mjs
locales/en.json      英文界面
```
