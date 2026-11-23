# 社区插件：作者指南

任何 bridge 用户都可以把自己写的插件发到社区市场，别的 bridge 用户能在「设置 › 扩展 › 功能扩展 › 社区」里看到并安装。

**社区插件只经过自动检查，没有人工审核。** 检查通过就自动合并、自动上架；装的人会看到「未经人工审核」和检查器检测到的能力，
风险由安装者自担。所以下面的规则是唯一的门槛，请照着写，检查报告会一条条告诉你哪里要改。

## 两种投稿方式

### 一、在 bridge 里一键发布（推荐）

第三方插件的详情里点「发布到社区」：登录 GitHub 账号（这台电脑已登录 `gh` 就直接用；也可以用设备码登录或粘贴令牌），
bridge 先在本地跑一遍同样的检查，再替你 fork 仓库、提交 `community/<id>/`、开拉取请求，之后在面板里实时显示检查与上架状态。
发新版本：改版本号、写更新说明，再点一次发布，会更新同一个拉取请求或开新的。

### 二、手工提拉取请求

1. fork `Wode44398/bridge-plugins`，在 fork 里新建分支；
2. 把插件放到 `community/<id>/`（目录名 = 清单里的 `id`）；
3. 向 `main` 开拉取请求。一个拉取请求只能改**一个** `community/<id>/` 目录，碰了别的路径（包括本说明、`.github/`、`scripts/`、台账、别人的插件）一律不通过；
4. 机器人会在拉取请求里评论检查报告。没通过就改好再推到同一个分支，会自动重查；通过了（且不是草稿）会自动合并、几分钟后上架。

草稿状态的拉取请求只检查、不合并，转成「可审阅」后自动合并。

## 目录结构

```
community/<id>/
  bridge-plugin.json   插件清单（必需）
  market.json          市场信息：每个版本的更新说明、英文名（必需，不进安装包）
  README.md            用法说明（建议写：装之前别人只能靠它了解你的插件）
  index.mjs            服务端代码（可选；没有就是纯页面插件）
  web/                 页面、图标、样式
  locales/en.json      英文界面词条（可选）
```

除了 `market.json`，目录里的**全部文件**都会原样进安装包（检查的就是上架的）。不要放测试文件、日志、构建产物。

## bridge-plugin.json

和本机插件的清单是同一种写法。纯页面插件的最小例子：

```json
{
  "id": "memo-pad",
  "name": "便签",
  "version": "1.0.0",
  "description": "主页多一个便签应用，写下的内容存在服务器上。",
  "author": "你的名字",
  "category": "third-party",
  "ui": { "apps": [{ "id": "main", "title": "便签", "page": "web/app.html" }] },
  "engines": { "pluginApi": 3 },
  "permissions": ["ui"]
}
```

含服务端代码的插件在根上放 `index.mjs`（或用 `entry` 指定入口），导出 `apply(ctx)`。

## market.json

```json
{
  "nameEn": "Memo pad",
  "descriptionEn": "A memo app on Home; notes are saved on the server.",
  "notes": {
    "1.0.0": "首个版本",
    "1.1.0": "支持多条便签"
  }
}
```

- `notes` 里**必须**有清单当前 `version` 的更新说明（最长 2000 字），旧版本的说明留着即可；
- `nameEn`（≤60 字）/ `descriptionEn`（≤500 字）可选，不写英文界面就显示中文；
- 不能写 `builtin`（覆盖 bridge 内置功能只有官方市场能做）。

## 规则（人话版）

**文件**

- 最多 300 个文件，单个不超过 2 MB，合计不超过 8 MB；
- 只收这些类型：`mjs js cjs json md txt html css svg png jpg jpeg gif webp ico woff woff2 ttf otf`；
- 不许有 `node_modules`（依赖请写成纯 JS 放进插件目录）、点开头的文件或目录（`.env`、`.git`……）、符号链接；
- 路径不许有 `..`、反斜杠、控制字符，不超过 200 字；不许有只差大小写的两个文件（Windows 上会冲突）。

**清单**

- 合法的 JSON；`id` 小写字母开头、只用小写字母 / 数字 / 连字符、最长 48 字，且等于目录名；
- `name` 1–60 字；`version` 写成 `x.y.z`，并且要比已上架的最新版大；`description` 最长 500 字；
- `engines.pluginApi` 是整数（现在写 3）；`engines.bridge` 可选，写了就要是合法范围，如 `">=8.50"`；
- 不许写 `replaces`（社区插件不能接管 bridge 自带的入口）；
- 没有服务端代码的插件至少要声明一个页面（`ui.apps` / `ui.panel` / `ui.settings`）。

**名字与归属**

- id 先到先得：第一个成功上架的人就是这个 id 的主人，以后只有本人（同一个 GitHub 账号）能发新版本；
- 不能用 bridge 内置功能和 agent 扩展的名字、官方插件的名字、几个界面词（如 `claude`、`settings`、`market`），也不能以 `bridge-`、`official-` 开头；
- 被封禁的账号不能投稿；被整个下架的插件不再接受新版本。

**服务端代码**（`web/` 以外的 `.mjs` / `.js` / `.cjs`）

- 要能读：不许压缩、混淆；单行不超过 1000 字；5 KB 以上的文件平均行长不超过 300；不许内嵌 2000 字以上连续的 base64 / 十六进制数据；
- 不许动态执行：`eval`、`new Function`、`Function("…")`、`vm` 模块、`createRequire`、`process.binding` / `dlopen`、`WebAssembly`、
  Worker 的 `eval: true`、参数不是写死字符串的 `import()` / `require()`。
  原因：没有人工审核，这些写法能让插件过了检查再去网上拉代码执行，钉死的 sha256 就失去意义了。

`web/` 下的前端文件只在沙箱页面里跑，不做上面这些代码检查（可以放压缩过的前端库）。

## 装的人会看到什么

- 卡片和详情上：名称、`@你的 GitHub 账号`、「纯页面」或「含服务端代码」、检测到的能力、一行「未经人工审核」；
- 检测到的能力（只标注、不拦）：

  | 能力 | 触发条件 |
  | --- | --- |
  | 运行外部程序 | 引用 `child_process` / `worker_threads` / `cluster` |
  | 访问网络 | `fetch(`、`http` / `https` / `net` / `tls` / `dgram` / `dns`、`WebSocket`、`ctx.net` |
  | 读写服务器上的文件 | 引用 `fs`、`ctx.files` |
  | 读环境变量 | `process.env` |
  | 调用 bridge 内部模块 | 引用 `@bridge/core/…` |

- 纯页面插件只在不透明源的沙箱页面里运行，用到对话、文件时要使用者逐项同意，安装是普通确认；
- **含服务端代码的插件在安装者的服务器上以 bridge 的全部权限运行**（清单里的 `permissions` 只展示、不强制），安装时是醒目的危险确认，并列出检测到的能力；
- 详情里有「源码」链接，钉在上架那一刻的提交上，任何人都能对照着看。

## 版本钉死与复现

每个版本的安装包由 CI 从源码确定性打包，sha256 写进签名过的社区索引，作者事后改不了已上架的包。任何人都能复现同一个 sha256：

```
git clone https://github.com/Wode44398/bridge-plugins
cd bridge-plugins
git checkout <索引里该版本的 commit>
node scripts/zip.mjs community/<id> <id>-<版本>.zip
```

会打印 `sha256` 与字节数，应与索引里的一致。打包规则：目录下全部文件去掉 `market.json`，按路径排序、固定时间戳、deflate 压缩。
deflate 的输出依赖 Node 自带的 zlib，复现请用和 CI 相同的 Node 22。仓库的 `.gitattributes` 让 `community/` 下的文件按字节原样检出
（Windows 上不会被换成 CRLF），所以在哪个系统上 clone 都一样。

## 下架与举报

- 发现恶意或严重问题：在插件详情里点「举报」，或直接用[举报表单](https://github.com/Wode44398/bridge-plugins/issues/new?template=report-plugin.yml)；
- 维护者核实后改 `community-moderation.json`：吊销某些版本、整个下架、或封禁作者；索引随即重签。
  已装的 bridge 刷新社区索引后，会自动停用被吊销的版本并通知主机，且不能再启用；
- 作者想下架自己的插件：开 issue 说明（不能用拉取请求删除整个目录）。
