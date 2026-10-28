// 发布：打包新版本 → (gh release) → 更新台账 → 生成并签名索引 → 上传。
// 用法：node scripts/publish.mjs [--dry-run] [--local <输出目录> --base <url>] [--key <pem>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  KEY_ID, PUBLIC_KEY_SPKI, REPO, listPlugins, checkPlugin, zipPlugin, sha256File,
  buildIndex, serializeIndex, signIndex, verifyIndex,
} from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error(`错误：${m}`); process.exit(1); };

const dryRun = flag('--dry-run');
const localDir = opt('--local');
const base = opt('--base');
if (flag('--local') && (!localDir || !base)) fail('--local <输出目录> 必须同时给 --base <url>');
const keyPath = opt('--key') || process.env.BRIDGE_MARKET_KEY || path.join(os.homedir(), 'bridge-private', 'plugin-market', 'signing-key.pem');

const plugins = listPlugins(root);
let bad = false;
for (const p of plugins) {
  const issues = checkPlugin(p);
  if (issues.length) { bad = true; console.error(`[失败] ${p.dirName}`); issues.forEach((i) => console.error(`  - ${i}`)); }
}
if (bad) fail('校验未通过，先修好再发布');

const outDir = localDir ? path.resolve(localDir) : path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
// 本地模式：台账放输出目录，不读也不动仓库里的那份
const ledgerFile = localDir ? path.join(outDir, 'releases.json') : path.join(root, 'releases.json');
const ledger = fs.existsSync(ledgerFile)
  ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8').replace(/^\uFEFF/, ''))
  : { seq: 0, plugins: {} };
ledger.plugins ||= {};

const gh = (...a) => {
  const r = spawnSync('gh', a, { stdio: 'inherit' });
  if (r.status !== 0) fail(`gh ${a.slice(0, 3).join(' ')} 失败（退出码 ${r.status}）`);
};
const ghOk = (...a) => spawnSync('gh', a, { stdio: 'ignore' }).status === 0;

const today = new Date().toISOString().slice(0, 10);
const pluginsMeta = {};
let fresh = 0;
for (const p of plugins) {
  const m = p.manifest, mk = p.market || {}, id = m.id;
  pluginsMeta[id] = {
    name: m.name, nameEn: mk.nameEn, description: m.description, descriptionEn: mk.descriptionEn,
    category: m.category, author: m.author, homepage: mk.homepage || m.homepage, builtin: mk.builtin === true,
  };
  const list = ledger.plugins[id] ||= [];
  if (list.some((v) => v.version === m.version)) { console.log(`- ${id} v${m.version} 已在台账，跳过`); continue; }
  const zipName = `${id}-${m.version}.zip`;
  const zipPath = path.join(outDir, zipName);
  zipPlugin(p.dir, zipPath);
  const entry = {
    version: m.version,
    engines: m.engines,
    restart: !!(m.restart || (m.runtime && m.runtime.restart)),
    url: localDir ? `${base.replace(/\/+$/, '')}/${zipName}` : `https://github.com/${REPO}/releases/download/${id}-v${m.version}/${zipName}`,
    sha256: sha256File(zipPath),
    size: fs.statSync(zipPath).size,
    date: today,
    notes: mk.notes[m.version],
  };
  fresh++;
  console.log(`+ 新版本 ${id} v${m.version}  ${zipName}  ${entry.size} 字节  sha256=${entry.sha256.slice(0, 16)}...`);
  if (dryRun) { console.log(`  [dry-run] 会执行：gh release create ${id}-v${m.version} ${zipPath} --repo ${REPO}`); continue; }
  if (!localDir) gh('release', 'create', `${id}-v${m.version}`, zipPath, '--repo', REPO, '--title', `${m.name} v${m.version}`, '--notes', entry.notes);
  list.push(entry);
}

if (dryRun) {
  console.log(`[dry-run] 共 ${fresh} 个新版本；会写回台账、seq ${ledger.seq} -> ${ledger.seq + 1}，生成并签名 index，上传 index Release。未改动任何台账与远端。`);
  process.exit(0);
}
if (!fresh) { console.log('没有新版本，无需发布'); process.exit(0); }

ledger.seq = (ledger.seq || 0) + 1;
fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');

const index = buildIndex(ledger.plugins, { seq: ledger.seq, generatedAt: new Date().toISOString(), pluginsMeta });
const bytes = serializeIndex(index);
if (!fs.existsSync(keyPath)) fail(`找不到私钥：${keyPath}（可用 --key 或 BRIDGE_MARKET_KEY 指定）`);
const sigText = signIndex(bytes, fs.readFileSync(keyPath, 'utf8'), KEY_ID);
if (!verifyIndex(bytes, sigText, PUBLIC_KEY_SPKI)) fail('签名自验失败：私钥与内置公钥不匹配，已中止上传');
const indexFile = path.join(outDir, 'index.json'), sigFile = path.join(outDir, 'index.json.sig');
fs.writeFileSync(indexFile, bytes);
fs.writeFileSync(sigFile, sigText);
console.log(`已生成 ${indexFile}（seq ${ledger.seq}）并自验签名通过`);

if (!localDir) {
  if (!ghOk('release', 'view', 'index', '--repo', REPO)) gh('release', 'create', 'index', '--repo', REPO, '--title', '市场索引', '--notes', '滚动 Release：每次发布覆盖 index.json 与 index.json.sig');
  gh('release', 'upload', 'index', indexFile, sigFile, '--clobber', '--repo', REPO);
  console.log(`已上传索引。别忘了提交 releases.json：git add releases.json && git commit -m "发布插件 seq ${ledger.seq}"`);
} else console.log(`本地测试市场已就绪：${outDir}（台账在 ${ledgerFile}）`);
