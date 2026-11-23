# bridge-plugins

bridge 官方插件市场的发布端工程：插件源码 + 打包/签名/发布脚本。

产物都挂在 GitHub 仓库 `Wode44398/bridge-plugins` 的 Release 上：
- 每个插件版本一个 Release，tag `<id>-v<version>`，资产 `<id>-<version>.zip`；
- 滚动 Release `index`，资产 `index.json` + `index.json.sig`（每次发布覆盖）。

bridge 的「设置 › 扩展 › 功能扩展」读滚动 Release `index` 上的签名索引，一次列出全部插件；有新版本只提示、不自动装。

## 目录结构

```
plugins/<id>/            插件源码（bridge-plugin.json + index.mjs + web/ …）
plugins/<id>/market.json { builtin?, nameEn?, descriptionEn?, notes: { "<version>": "更新说明" } }（不进 zip）
releases.json            已发布版本台账，生成索引的唯一来源，进 git
scripts/lib.mjs          打包、哈希、索引生成、签名（publish 与测试共用）
scripts/check.mjs        校验全部插件
scripts/publish.mjs      打包新版本 -> gh release -> 更新台账 -> 生成并签名索引 -> 上传
scripts/lib.test.mjs     单测：node --test scripts/
dist/                    打包产物（不进 git）
```

## 新增插件 / 发新版本

1. 新增：在 `plugins/` 下建目录，目录名 = 清单 `id`；写 `bridge-plugin.json`（含 `version`、`engines.bridge`）与 `market.json`。
2. 发新版本：改清单 `version`，并在 `market.json` 的 `notes` 里补上该版本的更新说明。
3. `node scripts/check.mjs` 校验。
4. `node scripts/publish.mjs`（先 `--dry-run` 看会做什么）。台账里没有的版本才算新版本。
5. 发布后提交 `releases.json`。

需要 `gh` 已登录。每个版本的 zip 根上直接是 `bridge-plugin.json`，不含 `market.json`、`node_modules`、`.git`、`*.test.mjs`。
打包用 `C:\Windows\System32\tar.exe`（bsdtar），不要用 PATH 上的 tar（会命中 Git 的 GNU tar）。

## 盖内置功能的写法

- 插件 `id` 等于内置插件的 id；
- `market.json` 里写 `"builtin": true`；
- `engines.bridge` 必须有上界，如 `">=6.74 <6.75"`（下一版 bridge 会把修复并进内核，市场版自动失效），`check` 会强制检查；
- 改哪个文件就带哪个文件，其余用 `import '@bridge/core/...'` 引内核里的同一份模块；
- 市场版可自带 `web/` 面板。

## 本地测试市场

不调 gh，产出一个可由任意静态服务器提供的目录，用于 bridge 端到端测试：

```
node scripts/publish.mjs --local "%TEMP%\bridge-market-local" --base http://127.0.0.1:8899
```

输出目录里有所有版本 zip、`index.json`、`index.json.sig` 和该市场自己的 `releases.json`（不动仓库里的台账）。
zip 的 url 为 `<base>/<zip 文件名>`。bridge 侧用 `config.pluginMarket.index` 指向它的 `index.json`。

## 社区插件

同一个仓库还承载社区市场：任何 bridge 用户经拉取请求把插件投到 `community/<id>/`，**只做自动检查、不人工审**，通过就自动合并上架。
作者指南（投稿方式、目录结构、全部规则、复现 sha256）见 [community/README.md](community/README.md)。官方链路（`plugins/`、`releases.json`、`publish.mjs`）与社区互不相干。

```
community/<id>/                社区插件源码（作者提交）
community-ledger.json          社区台账（CI 写，勿手改）：owners、plugins[id].meta / versions、seq、indexHash
community-moderation.json      维护者手改：revoked [{id, versions: "*"|[...], reason, at}]、blockedAuthors、reservedIds
scripts/community-rules.mjs    检查规则，由 sync-rules.mjs 从 bridge 同步，勿手改
scripts/reserved-ids.json      保留 id（bridge 内置功能 + agent 扩展 + 界面词），sync-rules.mjs 生成
scripts/sync-rules.mjs         node scripts/sync-rules.mjs <bridge 仓库路径>
scripts/zip.mjs                纯 Node 确定性 zip（CI 在 ubuntu 上打包，不依赖 bsdtar）
scripts/community-lib.mjs      读目录、打包、台账、索引、签名
scripts/community-check.mjs    检查一个拉取请求（intake 工作流用）
scripts/community-publish.mjs  打包新版本 -> Release c-<id>-v<ver> -> 台账 -> 签名索引 -> Release「community-index」
scripts/community.test.mjs     单测：node --test scripts/community.test.mjs
.gitattributes                 community/** 按字节原样检出（复现 sha256 的前提）
.github/workflows/community-intake.yml   pull_request_target：检查 -> 评论报告 -> 按检查过的 sha 合并 -> 触发发布
.github/workflows/community-publish.yml  workflow_dispatch + push(main)：串行发布，签名私钥在 environment 里
.github/ISSUE_TEMPLATE/report-plugin.yml 举报表单
```

社区索引是 Release `community-index` 上的 `community.json` + `community.json.sig`，用**另一把**钥匙签（keyId `community-2026-11`），
私钥只在 CI 的 environment 里；官方私钥仍只在维护者本机，两边互不串用。

下架：改 `community-moderation.json` 推到 main，发布工作流会重签索引（没有新版本也会），各家 bridge 拉到后自动停用被吊销的版本。

本地测试社区市场（不调 gh，台账与产物都写进输出目录）：

```
node scripts/community-publish.mjs --local "%TEMP%\bridge-community-local" --base http://127.0.0.1:8898 --key <社区私钥 pem> --author octocat
```

### 上线前维护者要做的

1. 在仓库 Settings › Environments 建 environment `community-signing`，加 secret `COMMUNITY_SIGNING_KEY`，值为社区私钥 PEM 全文
   （`bridge-private/plugin-market/community-signing-key.pem`）；可以把这个 environment 限定只给 `main` 分支用。
2. main 的分支保护 / 规则集不能挡 `github-actions[bot]` 推送：发布工作流要把台账提交直接推到 main，intake 要用 GITHUB_TOKEN 合并拉取请求
   （若开了「必须经拉取请求」「必须通过检查」之类规则，要把 GitHub Actions 加进绕过名单）。
3. 建标签 `community-report`（举报表单会自动打上）。

## 签名私钥

- 私钥只在维护者本机（默认 `~/bridge-private/plugin-market/signing-key.pem`），**永不进 git**（`.gitignore` 已忽略 `*.pem`）。
- 可用 `--key <pem>` 或环境变量 `BRIDGE_MARKET_KEY` 指定路径。
- 公钥（SPKI DER base64，keyId `official-2026-10`）写死在 bridge 的 `src/plugins/market-keys.mjs`；publish 签完后会用它自验一次，验不过直接退出。
- `index.json.sig` 内容：`{"keyId":"official-2026-10","sig":"<base64>"}`，签的是 `index.json` 的原始 UTF-8 字节。
