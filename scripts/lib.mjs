// 市场发布端公共库：读清单、校验、打包、哈希、生成索引、签名/验签。纯 Node 内置模块。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const KEY_ID = 'official-2026-10';
export const PUBLIC_KEY_SPKI = 'MCowBQYDK2VwAyEA0SpZtklGaAb+2OgItiA1p/elrZFTwtkH6Zob9MSpx6o=';
export const REPO = 'Wode44398/bridge-plugins';
// 必须用系统 bsdtar；PATH 上的 tar 会命中 Git 自带的 GNU tar（不支持 -a 出 zip）
export const BSDTAR = 'C:\\Windows\\System32\\tar.exe';

// ---- 版本比较 / satisfies：与 bridge src/plugins/engines.mjs 同语义（复制而来，不 import）----
const parse = (v) => {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
};
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
function one(ver, cond) {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(cond.trim());
  if (!m) return false;
  const op = m[1] || '=';
  if (m[2] === '*' || m[2] === 'x') return true;
  const c = compareVersions(ver, m[2]);
  if (Number.isNaN(c)) return false;
  const want = parse(m[2]);
  const have = parse(ver);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '=': return c === 0;
    case '^': return c >= 0 && have[0] === want[0];
    case '~': return c >= 0 && have[0] === want[0] && have[1] === want[1];
    default: return false;
  }
}
export function satisfies(ver, range) {
  const r = String(range || '').trim();
  if (!r || r === '*') return true;
  return r.split('||').some((alt) => alt.trim().split(/\s+/).filter(Boolean).every((c) => one(ver, c)));
}

// ---- 读取 / 校验 ----
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));

export function readPlugin(dir) {
  const abs = path.resolve(dir);
  const p = { dir: abs, dirName: path.basename(abs), manifest: null, market: null, errors: [] };
  try { p.manifest = readJson(path.join(abs, 'bridge-plugin.json')); }
  catch (e) { p.errors.push(`bridge-plugin.json 读取失败：${e.message}`); }
  const mf = path.join(abs, 'market.json');
  if (fs.existsSync(mf)) {
    try { p.market = readJson(mf); } catch (e) { p.errors.push(`market.json 读取失败：${e.message}`); }
  } else p.errors.push('缺少 market.json');
  return p;
}

export function checkPlugin(p) {
  const issues = [...(p.errors || [])];
  const m = p.manifest;
  if (!m) return issues;
  const mk = p.market || {};
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(String(m.id || ''))) issues.push(`id "${m.id}" 不合法（要求 ^[a-z][a-z0-9-]{0,47}$）`);
  else if (m.id !== p.dirName) issues.push(`id "${m.id}" 与目录名 "${p.dirName}" 不一致`);
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version || ''))) issues.push(`version "${m.version}" 不是 x.y.z`);
  const range = m.engines && m.engines.bridge;
  if (!range) issues.push('engines.bridge 必填');
  else if (mk.builtin === true && satisfies('999.0', range)) issues.push(`builtin 插件的 engines.bridge "${range}" 必须有上界（如 ">=6.74 <6.75"）`);
  if (p.market) {
    const notes = mk.notes && mk.notes[m.version];
    if (!notes || !String(notes).trim()) issues.push(`market.json 的 notes["${m.version}"] 缺失`);
  }
  return issues;
}

export function listPlugins(root) {
  const base = path.join(root, 'plugins');
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => readPlugin(path.join(base, d.name)));
}

// ---- 打包 / 哈希 ----
const EXCLUDE = (n) => n === 'market.json' || n === 'node_modules' || n === '.git' || /\.test\.mjs$/.test(n);

export function zipPlugin(dir, outFile) {
  const entries = fs.readdirSync(dir).filter((n) => !EXCLUDE(n));
  if (!entries.includes('bridge-plugin.json')) throw new Error(`${dir} 缺少 bridge-plugin.json`);
  const out = path.resolve(outFile);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out)) fs.rmSync(out);
  execFileSync(BSDTAR, ['-a', '-c', '-f', out, '--options', 'hdrcharset=UTF-8', '-C', dir, ...entries], { stdio: 'pipe' });
  return out;
}

export function listZip(zipFile) {
  return execFileSync(BSDTAR, ['-tf', zipFile], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
}

export const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ---- 索引 ----
// releases: { "<id>": [ {version, engines, restart, url, sha256, size, date, notes} ] }（台账的 plugins 段）
// pluginsMeta: { "<id>": { name, nameEn, description, descriptionEn, category, author, homepage, builtin } }
export function buildIndex(releases, { seq, generatedAt, pluginsMeta = {} }) {
  const plugins = Object.keys(releases).sort().map((id) => {
    const meta = pluginsMeta[id] || {};
    const versions = [...releases[id]].sort((a, b) => compareVersions(b.version, a.version)).map((v) => ({
      version: v.version,
      engines: v.engines,
      restart: !!v.restart,
      url: v.url,
      sha256: v.sha256,
      size: v.size,
      date: v.date,
      notes: v.notes,
    }));
    return {
      id,
      name: meta.name || id,
      nameEn: meta.nameEn || '',   // 没写英文名就留空：bridge 英文界面回落到中文名
      description: meta.description || '',
      descriptionEn: meta.descriptionEn || '',
      category: meta.category || 'third-party',
      author: meta.author || 'bridge',
      homepage: meta.homepage || `https://github.com/${REPO}/tree/main/plugins/${id}`,
      builtin: !!meta.builtin,
      versions,
    };
  });
  return { format: 1, market: 'official', seq, generatedAt, plugins };
}

export const serializeIndex = (obj) => Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');

// ---- 签名 ----
export function signIndex(indexBytes, privateKeyPem, keyId = KEY_ID) {
  const sig = crypto.sign(null, Buffer.from(indexBytes), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return JSON.stringify({ keyId, sig });
}

export function verifyIndex(bytes, sigText, spkiBase64 = PUBLIC_KEY_SPKI) {
  try {
    const { sig } = JSON.parse(sigText);
    const pub = crypto.createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(bytes), pub, Buffer.from(sig, 'base64'));
  } catch { return false; }
}
