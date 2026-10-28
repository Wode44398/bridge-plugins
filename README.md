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

## 签名私钥

- 私钥只在维护者本机（默认 `~/bridge-private/plugin-market/signing-key.pem`），**永不进 git**（`.gitignore` 已忽略 `*.pem`）。
- 可用 `--key <pem>` 或环境变量 `BRIDGE_MARKET_KEY` 指定路径。
- 公钥（SPKI DER base64，keyId `official-2026-10`）写死在 bridge 的 `src/plugins/market-keys.mjs`；publish 签完后会用它自验一次，验不过直接退出。
- `index.json.sig` 内容：`{"keyId":"official-2026-10","sig":"<base64>"}`，签的是 `index.json` 的原始 UTF-8 字节。
