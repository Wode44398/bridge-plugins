// 社区插件发布：在可信的 main 上运行（community-publish 工作流）。
//   找出 community/<id>/ 里台账还没有的版本 -> 再跑一遍检查兜底 -> 确定性打包 -> 建 Release c-<id>-v<ver> -> 更新台账
//   -> 按台账 + 下架名单生成社区索引 -> 签名 -> 提交推送台账 -> 覆盖上传 Release「community-index」。
// 用法：node scripts/community-publish.mjs [--dry-run] [--local <输出目录> --base <url>] [--key <pem 路径>]
//                                         [--id <id> --author <登录名> --pr <编号>] [--pub <SPKI base64>]
//   --author / --pr：这次合并的投稿人与拉取请求。给了 --id 就只用于那个插件（别的待发插件不会误认主人）。
//   私钥：--key <pem 路径>，或环境变量 COMMUNITY_SIGNING_KEY（PEM 文本，CI 用）。
//   --pub：只给 --local 用的自验公钥（测试钥匙）；真实发布一律用内置的社区公钥自验。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkSubmission } from './community-rules.mjs';
import {
  KEY_ID, PUBLIC_KEY_SPKI, REPO, INDEX_RELEASE, INDEX_FILE, SIG_FILE, LEDGER_FILE, COMMUNITY_DIR, ID_RE, VER_RE,
  TRUSTED_ROOT, releaseTag, assetName, releaseUrl, homepageOf, sourceOf, loadTrusted, normLedger, readPluginFiles, packPlugin,
  buildCommunityBody, bodyHash, EMPTY_BODY_HASH, buildCommunityIndex, serializeIndex, signIndex, verifyIndex,
} from './community-lib.mjs';
import { sha256 } from './zip.mjs';

const root = TRUSTED_ROOT;
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error(`错误：${m}`); process.exit(1); };
const warn = (m) => console.warn(process.env.GITHUB_ACTIONS ? `::warning::${m}` : `警告：${m}`);

const dryRun = flag('--dry-run');
const localDir = opt('--local');
const base = opt('--base');
if (flag('--local') && (!localDir || !base)) fail('--local <输出目录> 必须同时给 --base <url>');
const real = !localDir && !dryRun;
const onlyId = opt('--id') || '';
const argAuthor = String(opt('--author') || '').trim();
const argPr = /^\d+$/.test(String(opt('--pr') || '')) ? Number(opt('--pr')) : null;
if (onlyId && !ID_RE.test(onlyId)) fail(`--id「${onlyId}」不合法`);
if (argAuthor && !/^[A-Za-z0-9-]{1,39}$/.test(argAuthor)) fail(`--author「${argAuthor}」不像 GitHub 登录名`);
const pubKey = opt('--pub') || PUBLIC_KEY_SPKI;
if (opt('--pub') && !localDir) fail('--pub 只能和 --local 一起用（真实发布必须用内置的社区公钥自验）');

// ---- 外部命令 ----
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: root, encoding: 'utf8', ...o });
const gh = (...a) => {
  const r = run('gh', a, { stdio: ['ignore', 'pipe', 'inherit'] });
  if (r.status !== 0) fail(`gh ${a.slice(0, 3).join(' ')} 失败（退出码 ${r.status}）`);
  return r.stdout;
};
const ghOk = (...a) => run('gh', a, { stdio: 'ignore' }).status === 0;
const git = (...a) => run('git', a);

// 当前提交：只认本仓库根自己的 git（临时拷贝不是 git 仓库时，不能误取外层某个仓库的 HEAD）
function headCommit() {
  const top = git('rev-parse', '--show-toplevel');
  if (top.status === 0 && path.resolve(top.stdout.trim()) === path.resolve(root)) {
    const h = git('rev-parse', 'HEAD');
    if (h.status === 0 && /^[0-9a-f]{40}$/.test(h.stdout.trim())) return h.stdout.trim();
  }
  if (real) fail('取不到当前提交（git rev-parse HEAD）');
  return '0'.repeat(40);
}

// 维护者手工合并（不经 intake 工作流）时没有 --author：按「最后一次改这个目录的提交」反查它属于哪个拉取请求
function lookupPr(id) {
  if (localDir) return null;
  const sha = git('log', '-1', '--format=%H', '--', `${COMMUNITY_DIR}/${id}`).stdout?.trim();
  if (!/^[0-9a-f]{40}$/.test(sha || '')) return null;
  const r = run('gh', ['api', `repos/${REPO}/commits/${sha}/pulls`, '--jq', '.[0] | "\\(.user.login) \\(.number)"'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const m = r.status === 0 ? /^([A-Za-z0-9-]{1,39}) (\d+)$/.exec(r.stdout.trim()) : null;
  return m ? { author: m[1], pr: Number(m[2]) } : null;
}

// ---- 读状态 ----
const trusted = loadTrusted(root);
const outDir = localDir ? path.resolve(localDir) : path.join(root, 'dist', 'community');
// 本地模式：台账放在输出目录（不存在就从空台账起），仓库里的那份不读也不动；下架名单照样读仓库里的
const ledgerFile = localDir ? path.join(outDir, LEDGER_FILE) : path.join(root, LEDGER_FILE);
const ledger = localDir
  ? normLedger(fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, 'utf8').trimStart()) : {})
  : trusted.ledger;
const moderation = trusted.moderation;

const commit = headCommit();
const today = new Date().toISOString().slice(0, 10);
const cdir = path.join(root, COMMUNITY_DIR);
const ids = fs.existsSync(cdir) ? fs.readdirSync(cdir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];

const fresh = [];
for (const id of ids) {
  if (!ID_RE.test(id)) { warn(`跳过目录 community/${id}：名字不是合法的插件 id`); continue; }
  const { files, problems } = readPluginFiles(path.join(cdir, id));
  const mfile = files.find((f) => f.path === 'bridge-plugin.json');
  let version = '';
  try { version = String(JSON.parse(mfile.data.toString('utf8').trimStart()).version || ''); } catch {}
  const known = (ledger.plugins[id]?.versions || []).some((v) => v.version === version);
  if (known) { console.log(`- ${id} v${version} 已在台账，跳过`); continue; }
  if (!VER_RE.test(version)) { warn(`跳过 ${id}：读不出合法的版本号`); continue; }

  // 主人：台账里有就是台账里的（先到先得、只认首个投稿人）；没有才用这次的投稿人
  const direct = !onlyId || onlyId === id;
  let author = ledger.owners[id] || (direct ? argAuthor : '');
  let pr = direct ? argPr : null;
  if (!author || pr == null) {
    const hit = lookupPr(id);
    if (hit) { author ||= hit.author; pr ??= hit.pr; }
  }
  if (!author) { warn(`跳过 ${id} v${version}：不知道投稿人（台账里没有主人，也没给 --author）`); continue; }

  if (problems.length) { warn(`跳过 ${id} v${version}：${problems.map((p) => p.message).join('；')}`); continue; }
  const r = checkSubmission({ id, files, author, ledger, moderation, reserved: trusted.reserved, official: trusted.official });
  if (!r.ok) { warn(`跳过 ${id} v${version}：检查没通过：${r.errors.map((e) => e.message).join('；')}`); continue; }

  const zip = packPlugin(files);
  const m = r.manifest, mk = r.market || {};
  const entry = {
    version,
    engines: m.engines,
    restart: !!(m.restart || (m.runtime && m.runtime.restart)),
    url: localDir ? `${base.replace(/\/+$/, '')}/${assetName(id, version)}` : releaseUrl(id, version),
    sha256: sha256(zip),
    size: zip.length,
    date: today,
    notes: mk.notes[version],
    kind: r.kind,
    caps: r.caps,
    permissions: r.permissions,
    commit,
    source: sourceOf(id, commit),
    pr,
  };
  const meta = {
    name: m.name, nameEn: mk.nameEn || '', description: m.description || '', descriptionEn: mk.descriptionEn || '',
    category: m.category || 'third-party', author: typeof m.author === 'string' ? m.author : '',
  };
  fresh.push({ id, author, zip, entry, meta, title: `${m.name} v${version}` });
  console.log(`+ 新版本 ${id} v${version}（@${author}，${r.kind === 'server' ? '含服务端代码' : '纯页面'}${r.caps.length ? '，能力 ' + r.caps.join('/') : ''}）  ${zip.length} 字节  sha256=${entry.sha256.slice(0, 16)}...`);
}

// ---- 有没有要做的 ----
// 内容（插件与吊销名单）比上次发布时变了才发新索引：没有新版本、但维护者改了下架名单，也要重签
const applyFresh = (l) => {
  for (const f of fresh) {
    l.owners[f.id] ||= f.author;
    const p = (l.plugins[f.id] ||= { meta: {}, versions: [] });
    p.meta = f.meta;
    (p.versions ||= []).push(f.entry);
  }
};
const next = structuredClone(ledger);
applyFresh(next);
const body = buildCommunityBody(next, moderation);
const hash = bodyHash(body);
const prevHash = ledger.indexHash || EMPTY_BODY_HASH;
let changed = fresh.length > 0 || hash !== prevHash;

// 真实模式另查一次远端索引：上次若是台账已推送、索引却没传上去，这次补传（seq 不再加）
let reupload = false;
if (real && !changed && ledger.seq > 0) {
  const r = run('gh', ['release', 'download', INDEX_RELEASE, '--repo', REPO, '-p', INDEX_FILE, '-O', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let remoteSeq = -1;
  try { remoteSeq = JSON.parse(r.stdout).seq; } catch {}
  if (r.status !== 0 || remoteSeq !== ledger.seq) { reupload = true; console.log(`远端索引 seq ${remoteSeq} 与台账 seq ${ledger.seq} 不一致，补传`); }
}

if (dryRun) {
  for (const f of fresh) console.log(`  [dry-run] 会执行：gh release create ${releaseTag(f.id, f.entry.version)} ${assetName(f.id, f.entry.version)} --repo ${REPO}`);
  console.log(changed
    ? `[dry-run] 共 ${fresh.length} 个新版本；索引内容${hash !== prevHash ? '有' : '没有'}变化；会写回台账、seq ${ledger.seq} -> ${ledger.seq + 1}，生成并签名 ${INDEX_FILE}，上传 Release ${INDEX_RELEASE}。没有写任何文件、没有动远端。`
    : '[dry-run] 没有新版本、索引内容也没变，不会做任何事');
  process.exit(0);
}
if (!changed && !reupload) { console.log('没有新版本、索引内容也没变，无需发布'); process.exit(0); }

// 私钥先到手、先自验，再动任何远端：签不了就别建 Release、别推台账
const pem = process.env.COMMUNITY_SIGNING_KEY || (opt('--key') && fs.existsSync(opt('--key')) ? fs.readFileSync(opt('--key'), 'utf8') : '');
if (!pem) fail('没有签名私钥：用 --key <pem 路径> 或环境变量 COMMUNITY_SIGNING_KEY');
{
  const probe = Buffer.from('probe');
  let s = '';
  try { s = signIndex(probe, pem, KEY_ID); } catch (e) { fail(`私钥读不了：${e.message}`); }
  if (!verifyIndex(probe, s, pubKey, KEY_ID)) fail('私钥与社区公钥不匹配，已中止');
}

fs.mkdirSync(outDir, { recursive: true });

// ---- 包：写进输出目录；真实模式建 Release ----
for (const f of fresh) {
  const name = assetName(f.id, f.entry.version);
  const file = path.join(outDir, name);
  fs.writeFileSync(file, f.zip);
  if (!real) continue;
  const tag = releaseTag(f.id, f.entry.version);
  if (ghOk('release', 'view', tag, '--repo', REPO)) {
    // 上次跑到一半（Release 建了、台账没推上去）：包是确定性的，远端那份和这次一样就直接沿用，不一样就拒绝覆盖
    const r = run('gh', ['release', 'download', tag, '--repo', REPO, '-p', name, '-O', '-'], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status !== 0 || sha256(r.stdout) !== f.entry.sha256) fail(`Release ${tag} 已存在且里面的包和这次打出来的不一样，不覆盖已上架的包`);
    console.log(`  Release ${tag} 已存在且内容一致，沿用`);
  } else {
    gh('release', 'create', tag, file, '--repo', REPO, '--target', commit, '--title', `[社区] ${f.title}`, '--notes', `${f.entry.notes}\n\n投稿人 @${f.author} · 源码 ${f.entry.source}\n\n社区插件只经过自动检查、未经人工审核。sha256 \`${f.entry.sha256}\``);
  }
}

// ---- 台账 + 索引 ----
if (changed) {
  applyFresh(ledger);
  ledger.seq += 1;
  ledger.indexHash = hash;
}
const index = buildCommunityIndex(body, { seq: ledger.seq, generatedAt: new Date().toISOString() });
const bytes = serializeIndex(index);
const sigText = signIndex(bytes, pem, KEY_ID);
if (!verifyIndex(bytes, sigText, pubKey, KEY_ID)) fail('签名自验失败，已中止');
const indexFile = path.join(outDir, INDEX_FILE), sigFile = path.join(outDir, SIG_FILE);
fs.writeFileSync(indexFile, bytes);
fs.writeFileSync(sigFile, sigText);
fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');
console.log(`已生成 ${indexFile}（seq ${ledger.seq}，${index.plugins.length} 个插件、${index.revoked.length} 条下架）并自验签名通过`);

if (!real) { console.log(`本地测试市场已就绪：${outDir}（台账在 ${ledgerFile}）`); process.exit(0); }

// 先推台账、再传索引：推不上去（main 上有冲突）就别让索引先于台账生效；索引没传上去，下次运行按远端 seq 补传
if (changed) {
  const who = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
  const what = fresh.map((f) => `${f.id} v${f.entry.version}`).join('、') || '下架名单更新';
  let r = git(...who, 'add', LEDGER_FILE);
  if (r.status === 0) r = git(...who, 'commit', '-m', `社区台账 seq ${ledger.seq}：${what}`);
  if (r.status !== 0) fail(`提交台账失败：${r.stderr || r.stdout}`);
  let pushed = false;
  for (let i = 0; i < 3 && !pushed; i++) {
    pushed = git('push', 'origin', 'HEAD:main').status === 0;
    if (!pushed) {
      const p = git(...who, 'pull', '--rebase', 'origin', 'main');
      if (p.status !== 0) fail(`推送台账前同步 main 失败：${p.stderr || p.stdout}`);
    }
  }
  if (!pushed) fail('台账推不上 main（检查分支保护是否允许 github-actions 推送）；Release 已建好，重跑本工作流会沿用');
  console.log('已提交并推送台账');
}
if (!ghOk('release', 'view', INDEX_RELEASE, '--repo', REPO)) gh('release', 'create', INDEX_RELEASE, '--repo', REPO, '--title', '社区市场索引', '--notes', '滚动 Release：每次社区发布覆盖 community.json 与 community.json.sig（社区签名钥匙）');
gh('release', 'upload', INDEX_RELEASE, indexFile, sigFile, '--clobber', '--repo', REPO);
console.log(`已上传社区索引 seq ${ledger.seq}`);
