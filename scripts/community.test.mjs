// 社区链路单测：node --test scripts/community.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import { zipEntries, crc32, sha256 } from './zip.mjs';
import { verifyIndex, KEY_ID, MARKER } from './community-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const node = process.execPath;
const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'bsdtar';
const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// ---- 小工具：在磁盘上摆一个插件目录 ----
function writeTree(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2));
  }
}
const pagePlugin = (id, version = '1.0.0', notes = {}) => ({
  'bridge-plugin.json': { id, name: '待办', version, description: '一个待办', engines: { pluginApi: 3 }, ui: { apps: [{ id: 'main', title: '待办', page: 'web/app.html' }] }, permissions: ['ui'] },
  'market.json': { nameEn: 'Todo', notes: { [version]: `第 ${version} 版`, ...notes } },
  'README.md': '# 待办\n',
  'web/app.html': `<!doctype html><title>${id}</title>`,
});
const serverPlugin = (id, version = '1.0.0', code = "export function apply(ctx) {}\nexport const ping = () => fetch('https://example.com');\n") => ({
  'bridge-plugin.json': { id, name: '服务端', version, description: '服务端插件', engines: { pluginApi: 3 } },
  'market.json': { nameEn: 'Server', notes: { [version]: '第一版' } },
  'README.md': '# 服务端\n',
  'index.mjs': code,
});

// ---- zip ----
test('crc32 标准向量', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('zip 确定性：输入顺序不同也逐字节相同；固定时间戳、UTF-8 标志、无额外字段', () => {
  const bin = crypto.createHash('sha512').update('seed').digest();
  const entries = [
    { path: 'web/app.html', data: '<p>你好</p>' },
    { path: 'bridge-plugin.json', data: '{"id":"x"}' },
    { path: '中文目录/说明.md', data: '# 中文名也要能解开\n' },
    { path: 'empty.txt', data: '' },
    { path: 'web/img/a.png', data: Buffer.concat([bin, bin, bin]) },
    { path: 'big.txt', data: 'line\n'.repeat(5000) },
  ];
  const a = zipEntries(entries);
  const b = zipEntries([...entries].reverse());
  assert.ok(a.equals(b));
  assert.equal(sha256(a), sha256(b));
  // 第一个本地头：版本 20、标志 0x0800、deflate、时间 0、日期 1980-01-01、额外字段长度 0
  assert.equal(a.readUInt32LE(0), 0x04034b50);
  assert.equal(a.readUInt16LE(6), 0x0800);
  assert.equal(a.readUInt16LE(8), 8);
  assert.equal(a.readUInt16LE(10), 0);
  assert.equal(a.readUInt16LE(12), 0x21);
  assert.equal(a.readUInt16LE(28), 0);
  // 内容变一个字节，包就变
  assert.notEqual(sha256(zipEntries([...entries, { path: 'z.txt', data: 'x' }])), sha256(a));
  assert.throws(() => zipEntries([{ path: '../x', data: '' }]));
  assert.throws(() => zipEntries([{ path: 'a', data: '' }, { path: 'a', data: '' }]));
});

test('zip 能被 bsdtar（Windows tar.exe）正确解开，内容逐个一致', (t) => {
  if (spawnSync(TAR, ['--version']).status !== 0) { t.skip(`没有 ${TAR}`); return; }
  const dir = tmpdir('bp-zip-');
  try {
    const entries = [
      { path: 'bridge-plugin.json', data: Buffer.from('{"id":"x","name":"中文"}') },
      { path: 'web/app.html', data: Buffer.from('<p>你好</p>\n') },
      { path: '中文目录/说明.md', data: Buffer.from('# 说明\n'.repeat(100)) },
      { path: 'empty.txt', data: Buffer.alloc(0) },
      { path: 'web/img/a.bin', data: crypto.randomBytes(4096) },
    ];
    const zf = path.join(dir, 'p.zip');
    fs.writeFileSync(zf, zipEntries(entries));
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    execFileSync(TAR, ['-xf', zf, '-C', out]); // 与 bridge 安装时的解法相同（不加 hdrcharset）
    for (const e of entries) assert.ok(fs.readFileSync(path.join(out, ...e.path.split('/'))).equals(e.data), e.path);
    // tar -tf 按控制台代码页输出文件名（中文 Windows 是 GBK），解开比对已经证明包里是 UTF-8
    const raw = execFileSync(TAR, ['-tf', zf]);
    const listed = new TextDecoder(process.platform === 'win32' ? 'gbk' : 'utf-8').decode(raw).split(/\r?\n/).filter(Boolean).sort();
    assert.deepEqual(listed, entries.map((e) => e.path).sort());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- check ----
function runCheck(files, changes, author = 'octocat', extra = []) {
  const dir = tmpdir('bp-chk-');
  try {
    writeTree(path.join(dir, 'pr'), files);
    const fl = path.join(dir, 'files.json');
    fs.writeFileSync(fl, JSON.stringify(changes));
    const out = path.join(dir, 'report.json'), md = path.join(dir, 'report.md');
    const r = spawnSync(node, [path.join(here, 'community-check.mjs'), '--dir', path.join(dir, 'pr'), '--files', fl, '--author', author, '--sha', 'abc123', '--out', out, '--md', md, ...extra], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const report = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(fs.readFileSync(md, 'utf8'), report.markdown);
    return report;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const under = (id, tree) => Object.fromEntries(Object.entries(tree).map(([k, v]) => [`community/${id}/${k}`, v]));
const added = (id, tree) => Object.keys(tree).map((k) => ({ filename: `community/${id}/${k}`, status: 'added' }));
const codes = (r) => r.errors.map((e) => e.code);

test('check：正常投稿通过，报告带隐藏标记', () => {
  const t = pagePlugin('todo-lite');
  const r = runCheck(under('todo-lite', t), added('todo-lite', t));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.id, 'todo-lite');
  assert.equal(r.version, '1.0.0');
  assert.equal(r.kind, 'page');
  assert.ok(r.markdown.startsWith(MARKER + '\n'));
  assert.match(r.markdown, /自动检查通过/);
  assert.match(r.markdown, /abc123/);
});

test('check：服务端插件标出能力；改动清单是按页数组也认', () => {
  const t = serverPlugin('net-tool');
  const ch = added('net-tool', t);
  const r = runCheck(under('net-tool', t), [ch.slice(0, 2), ch.slice(2)]);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.kind, 'server');
  assert.deepEqual(r.caps, ['network']);
});

test('check：越界路径不通过（.github、scripts、台账、改名来源在外面）', () => {
  const t = pagePlugin('todo-lite');
  for (const bad of [
    { filename: '.github/workflows/x.yml', status: 'added' },
    { filename: 'scripts/community-rules.mjs', status: 'modified' },
    { filename: 'community-ledger.json', status: 'modified' },
    { filename: 'community/README.md', status: 'modified' },
    { filename: 'community/todo-lite/web/b.html', status: 'renamed', previous_filename: 'plugins/hello-world/web/b.html' },
  ]) {
    const r = runCheck(under('todo-lite', { ...t, 'web/b.html': 'x' }), [...added('todo-lite', t), bad]);
    assert.equal(r.ok, false, bad.filename);
    assert.ok(codes(r).includes('scope'), bad.filename);
  }
});

test('check：改动清单条数和拉取请求的 changed_files 对不上不通过', () => {
  const t = pagePlugin('todo-lite');
  const ch = added('todo-lite', t);
  assert.equal(runCheck(under('todo-lite', t), ch, 'octocat', ['--expect', String(ch.length)]).ok, true);
  const r = runCheck(under('todo-lite', t), ch, 'octocat', ['--expect', String(ch.length + 1)]);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('scope'));
});

test('check：一个拉取请求涉及两个插件不通过', () => {
  const a = pagePlugin('aaa'), b = pagePlugin('bbb');
  const r = runCheck({ ...under('aaa', a), ...under('bbb', b) }, [...added('aaa', a), ...added('bbb', b)]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'scope' && /两|2 个/.test(e.message)));
});

test('check：整目录删除不通过', () => {
  const r = runCheck({}, Object.keys(pagePlugin('todo-lite')).map((k) => ({ filename: `community/todo-lite/${k}`, status: 'removed' })));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('delete'));
});

test('check：改动清单里的文件没出现在取出的内容里（export-ignore 之类）不通过', () => {
  const t = pagePlugin('todo-lite');
  const r = runCheck(under('todo-lite', t), [...added('todo-lite', t), { filename: 'community/todo-lite/lib/hidden.mjs', status: 'added' }]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'scope' && /hidden\.mjs/.test(e.message)));
});

test('check：官方插件名、保留名不给占；id-only 只吐合规 id', () => {
  const off = pagePlugin('hello-world');
  assert.ok(codes(runCheck(under('hello-world', off), added('hello-world', off))).includes('reserved'));
  const rs = pagePlugin('terminal');
  assert.ok(codes(runCheck(under('terminal', rs), added('terminal', rs))).includes('reserved'));
  const dir = tmpdir('bp-id-');
  try {
    const f = path.join(dir, 'f.json');
    const idOf = (changes) => { fs.writeFileSync(f, JSON.stringify(changes)); return execFileSync(node, [path.join(here, 'community-check.mjs'), '--files', f, '--id-only'], { encoding: 'utf8' }).trim(); };
    assert.equal(idOf(added('todo-lite', pagePlugin('todo-lite'))), 'todo-lite');
    assert.equal(idOf([{ filename: 'community/Bad$(x)/a.md', status: 'added' }]), '');
    assert.equal(idOf([...added('aaa', { a: 1 }), ...added('bbb', { a: 1 })]), '');
    assert.equal(idOf([{ filename: 'README.md', status: 'modified' }]), '');
    // 带越界改动时仍给出唯一 id：工作流只取这个目录，越界部分在检查里报错
    assert.equal(idOf([...added('todo-lite', { a: 1 }), { filename: '.github/x.yml', status: 'added' }]), 'todo-lite');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- publish --local 端到端 ----
function makeRepo() {
  const root = tmpdir('bp-pub-');
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['community-lib.mjs', 'community-rules.mjs', 'community-publish.mjs', 'community-check.mjs', 'zip.mjs', 'reserved-ids.json']) {
    fs.copyFileSync(path.join(here, f), path.join(root, 'scripts', f));
  }
  fs.copyFileSync(path.join(repo, 'releases.json'), path.join(root, 'releases.json'));
  fs.writeFileSync(path.join(root, 'community-ledger.json'), '{"seq":0,"owners":{},"plugins":{}}\n');
  fs.writeFileSync(path.join(root, 'community-moderation.json'), '{"revoked":[],"blockedAuthors":[],"reservedIds":[]}\n');
  return root;
}

test('publish --local：签名、台账主人、第二版追加、吊销与封禁', () => {
  const root = makeRepo();
  const out = path.join(root, 'market');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = path.join(root, 'test-key.pem');
  fs.writeFileSync(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const publish = (...a) => {
    const r = spawnSync(node, [path.join(root, 'scripts', 'community-publish.mjs'), '--local', out, '--base', 'http://127.0.0.1:9/m/', '--key', pem, '--pub', spki, ...a], { encoding: 'utf8', env: { ...process.env, COMMUNITY_SIGNING_KEY: '' } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r;
  };
  const readIdx = () => {
    const bytes = fs.readFileSync(path.join(out, 'community.json'));
    const sig = fs.readFileSync(path.join(out, 'community.json.sig'), 'utf8');
    assert.equal(JSON.parse(sig).keyId, KEY_ID);
    assert.ok(verifyIndex(bytes, sig, spki), '索引签名应能用测试公钥验过');
    assert.ok(!verifyIndex(Buffer.concat([bytes, Buffer.from(' ')]), sig, spki));
    return JSON.parse(bytes);
  };
  const ledger = () => JSON.parse(fs.readFileSync(path.join(out, 'community-ledger.json'), 'utf8'));
  const cdir = (id) => path.join(root, 'community', id);
  try {
    // 1. 首版：主人登记为投稿人
    writeTree(cdir('todo-lite'), pagePlugin('todo-lite', '1.0.0'));
    // dry-run 什么都不写
    const dr = spawnSync(node, [path.join(root, 'scripts', 'community-publish.mjs'), '--local', out, '--base', 'http://x', '--dry-run', '--author', 'Alice'], { encoding: 'utf8' });
    assert.equal(dr.status, 0, dr.stderr);
    assert.ok(!fs.existsSync(out));
    publish('--author', 'Alice');
    let idx = readIdx();
    assert.equal(idx.format, 1);
    assert.equal(idx.market, 'community');
    assert.equal(idx.seq, 1);
    assert.equal(idx.plugins.length, 1);
    const p1 = idx.plugins[0];
    assert.equal(p1.publisher, 'Alice');
    assert.equal(p1.nameEn, 'Todo');
    assert.match(p1.homepage, /tree\/main\/community\/todo-lite$/);
    const v1 = p1.versions[0];
    assert.equal(v1.url, 'http://127.0.0.1:9/m/todo-lite-1.0.0.zip');
    assert.equal(v1.kind, 'page');
    assert.deepEqual(v1.permissions, ['ui']);
    assert.match(v1.commit, /^[0-9a-f]{40}$/);
    assert.match(v1.source, new RegExp(`tree/${v1.commit}/community/todo-lite$`));
    const zip1 = fs.readFileSync(path.join(out, 'todo-lite-1.0.0.zip'));
    assert.equal(sha256(zip1), v1.sha256);
    assert.equal(zip1.length, v1.size);
    // 任何人都能用 zip.mjs 从源码复现同一个 sha256
    const rep = execFileSync(node, [path.join(root, 'scripts', 'zip.mjs'), cdir('todo-lite')], { encoding: 'utf8' });
    assert.match(rep, new RegExp(`sha256 ${v1.sha256}`));
    assert.deepEqual(ledger().owners, { 'todo-lite': 'Alice' });

    // 2. 什么都没变：不发新索引
    publish();
    assert.equal(readIdx().seq, 1);

    // 3. 第二版：换了 --author 也不改主人（台账里的主人说了算），版本追加、新的在前
    writeTree(cdir('todo-lite'), pagePlugin('todo-lite', '1.1.0', { '1.0.0': '第 1.0.0 版' }));
    publish('--author', 'mallory', '--pr', '12');
    idx = readIdx();
    assert.equal(idx.seq, 2);
    assert.equal(idx.plugins[0].publisher, 'Alice');
    assert.deepEqual(idx.plugins[0].versions.map((v) => v.version), ['1.1.0', '1.0.0']);
    const lg = ledger();
    assert.equal(lg.owners['todo-lite'], 'Alice');
    assert.equal(lg.plugins['todo-lite'].versions.length, 2);
    assert.equal(lg.plugins['todo-lite'].versions[1].pr, 12);
    assert.ok(!('pr' in idx.plugins[0].versions[0]), '索引里不带 pr');

    // 4. 新的服务端插件：--id 指定时 --author 只给那个插件；另一个没有主人的待发插件跳过
    writeTree(cdir('net-tool'), serverPlugin('net-tool'));
    writeTree(cdir('orphan'), pagePlugin('orphan'));
    const r4 = publish('--id', 'net-tool', '--author', 'carol');
    assert.match(r4.stderr, /orphan/);
    idx = readIdx();
    assert.equal(idx.seq, 3);
    assert.deepEqual(idx.plugins.map((p) => p.id), ['net-tool', 'todo-lite']);
    const nt = idx.plugins[0];
    assert.equal(nt.publisher, 'carol');
    assert.equal(nt.versions[0].kind, 'server');
    assert.deepEqual(nt.versions[0].caps, ['network']);
    assert.ok(!('orphan' in ledger().owners));
    fs.rmSync(cdir('orphan'), { recursive: true });

    // 5. 吊销 todo-lite 1.0.0：versions 去掉、进 revoked；只改下架名单也会重签
    fs.writeFileSync(path.join(root, 'community-moderation.json'), JSON.stringify({ revoked: [{ id: 'todo-lite', versions: ['1.0.0'], reason: '有漏洞', at: '2026-11-23' }], blockedAuthors: [], reservedIds: [] }));
    publish();
    idx = readIdx();
    assert.equal(idx.seq, 4);
    assert.deepEqual(idx.plugins.find((p) => p.id === 'todo-lite').versions.map((v) => v.version), ['1.1.0']);
    assert.deepEqual(idx.revoked, [{ id: 'todo-lite', versions: ['1.0.0'], reason: '有漏洞' }]);
    assert.equal(ledger().plugins['todo-lite'].versions.length, 2, '台账保留全部历史');

    // 6. 封禁作者：整个插件不进 plugins、进 revoked versions:"*"；他也发不了新版
    fs.writeFileSync(path.join(root, 'community-moderation.json'), JSON.stringify({ revoked: [{ id: 'todo-lite', versions: ['1.0.0'], reason: '有漏洞' }], blockedAuthors: ['CAROL'], reservedIds: [] }));
    writeTree(cdir('net-tool'), serverPlugin('net-tool', '1.0.1'));
    const r6 = publish();
    assert.match(r6.stderr, /net-tool/);
    idx = readIdx();
    assert.equal(idx.seq, 5);
    assert.deepEqual(idx.plugins.map((p) => p.id), ['todo-lite']);
    assert.deepEqual(idx.revoked.find((r) => r.id === 'net-tool'), { id: 'net-tool', versions: '*', reason: '作者已被封禁' });
    assert.equal(ledger().plugins['net-tool'].versions.length, 1);

    // 7. 整个吊销
    fs.writeFileSync(path.join(root, 'community-moderation.json'), JSON.stringify({ revoked: [{ id: 'todo-lite', versions: '*', reason: '测试下架' }], blockedAuthors: ['carol'], reservedIds: [] }));
    publish();
    idx = readIdx();
    assert.equal(idx.seq, 6);
    assert.deepEqual(idx.plugins, []);
    assert.deepEqual(idx.revoked.map((r) => [r.id, r.versions]), [['net-tool', '*'], ['todo-lite', '*']]);

    // 仓库里的台账没被本地模式动过
    assert.equal(fs.readFileSync(path.join(root, 'community-ledger.json'), 'utf8'), '{"seq":0,"owners":{},"plugins":{}}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('publish：私钥和公钥对不上就中止，什么都不写', () => {
  const root = makeRepo();
  const out = path.join(root, 'market');
  try {
    const a = crypto.generateKeyPairSync('ed25519'), b = crypto.generateKeyPairSync('ed25519');
    const pem = path.join(root, 'k.pem');
    fs.writeFileSync(pem, a.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeTree(path.join(root, 'community', 'todo-lite'), pagePlugin('todo-lite'));
    const r = spawnSync(node, [path.join(root, 'scripts', 'community-publish.mjs'), '--local', out, '--base', 'http://x', '--key', pem, '--pub', b.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), '--author', 'a'], { encoding: 'utf8', env: { ...process.env, COMMUNITY_SIGNING_KEY: '' } });
    assert.notEqual(r.status, 0);
    assert.ok(!fs.existsSync(out));
    // 真实模式不许换自验公钥
    const r2 = spawnSync(node, [path.join(root, 'scripts', 'community-publish.mjs'), '--pub', 'x'], { encoding: 'utf8' });
    assert.notEqual(r2.status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
