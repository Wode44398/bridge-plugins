// 从 bridge 工程同步社区检查规则与保留 id。规则必须和 bridge「发布到社区」的本地预检是同一份，否则作者本地过了、CI 却拦下。
// 用法：node scripts/sync-rules.mjs <bridge 仓库路径>
//   · 拷 src/plugins/market/community-rules.mjs -> scripts/community-rules.mjs（首行加「勿手改」注释，其余原样）
//   · 重新生成 scripts/reserved-ids.json：内置功能（src/plugins/catalog.mjs 的 BUILTIN_PLUGINS）、
//     agent 扩展（src/modules/registry.mjs 的 MODULE_CATALOG），再加上固定的界面 / 品牌词
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const fail = (m) => { console.error(`错误：${m}`); process.exit(1); };
const bridge = process.argv[2] && path.resolve(process.argv[2]);
if (!bridge) fail('用法：node scripts/sync-rules.mjs <bridge 仓库路径>');

const HEADER = '// 由 scripts/sync-rules.mjs 从 bridge 的 src/plugins/market/community-rules.mjs 同步，勿手改\n';
// 不是插件 id、但被别人占了会造成冒充或混淆的名字（分页名、界面区块名、市场自己的名字）
const FIXED = ['claude', 'settings', 'home', 'workspace', 'bridge', 'official', 'community', 'market', 'plugins', 'admin'];

const src = path.join(bridge, 'src', 'plugins', 'market', 'community-rules.mjs');
const catalog = path.join(bridge, 'src', 'plugins', 'catalog.mjs');
const registry = path.join(bridge, 'src', 'modules', 'registry.mjs');
for (const f of [src, catalog, registry]) if (!fs.existsSync(f)) fail(`找不到 ${f}`);

fs.writeFileSync(path.join(here, 'community-rules.mjs'), HEADER + fs.readFileSync(src, 'utf8'));
console.log('已同步 scripts/community-rules.mjs');

// 在子进程里导入 bridge 的目录模块：它们会顺带加载 bridge 的配置，首次加载会在数据根生成带访问令牌的 config.json，
// 所以把数据根指到一次性临时目录、跑完删掉，不在 bridge 工程里留下任何东西。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-sync-'));
try {
  const out = path.join(tmp, 'ids.json');
  const code = [
    `import fs from 'node:fs';`,
    `const c = await import(${JSON.stringify(pathToFileURL(catalog).href)});`,
    `const r = await import(${JSON.stringify(pathToFileURL(registry).href)});`,
    `fs.writeFileSync(process.env.BP_SYNC_OUT, JSON.stringify({ builtin: c.BUILTIN_PLUGINS.map((p) => p.id), modules: r.MODULE_CATALOG.map((m) => m.id) }));`,
    // bridge 模块加载后可能挂着定时器 / 句柄，显式退出
    `process.exit(0);`,
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: tmp,
    env: { ...process.env, BRIDGE_DATA_ROOT: tmp, BP_SYNC_OUT: out },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.status !== 0 || !fs.existsSync(out)) fail(`导入 bridge 目录模块失败（退出码 ${r.status}）：${String(r.stderr || r.error || '').slice(0, 800)}`);
  const ids = JSON.parse(fs.readFileSync(out, 'utf8'));
  const uniq = (a) => [...new Set(a.map(String))];
  const data = { builtin: uniq(ids.builtin), modules: uniq(ids.modules), fixed: FIXED };
  if (!data.builtin.length || !data.modules.length) fail('bridge 目录模块里没读到 id，结构可能变了');
  fs.writeFileSync(path.join(here, 'reserved-ids.json'), JSON.stringify(data, null, 2) + '\n');
  console.log(`已生成 scripts/reserved-ids.json：内置 ${data.builtin.length} 个、扩展 ${data.modules.length} 个、固定 ${FIXED.length} 个`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
