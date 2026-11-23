// 社区插件公共库：读目录、打包、读可信台账、生成社区索引、签名 / 验签。check 与 publish 共用，纯 Node 内置模块。
// 官方链路（lib.mjs）一行不动：社区用另一把钥匙、另一份台账、另一个索引文件，互不串用。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zipEntries, sha256 } from './zip.mjs';
import { compareVersions, LIMITS, MARKET_FILE } from './community-rules.mjs';

export const KEY_ID = 'community-2026-11';
export const PUBLIC_KEY_SPKI = 'MCowBQYDK2VwAyEAONT+n/tFjGICw1EsviILLew2slQP3KJY9hOOHYDaxyM=';
export const REPO = 'Wode44398/bridge-plugins';
export const INDEX_RELEASE = 'community-index';
export const INDEX_FILE = 'community.json';
export const SIG_FILE = 'community.json.sig';
export const LEDGER_FILE = 'community-ledger.json';
export const MODERATION_FILE = 'community-moderation.json';
export const COMMUNITY_DIR = 'community';
export const MARKER = '<!-- community-intake -->';
export const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
export const VER_RE = /^\d+\.\d+\.\d+$/;

export const releaseTag = (id, ver) => `c-${id}-v${ver}`;
export const assetName = (id, ver) => `${id}-${ver}.zip`;
export const releaseUrl = (id, ver) => `https://github.com/${REPO}/releases/download/${releaseTag(id, ver)}/${assetName(id, ver)}`;
export const homepageOf = (id) => `https://github.com/${REPO}/tree/main/${COMMUNITY_DIR}/${id}`;
export const sourceOf = (id, commit) => `https://github.com/${REPO}/tree/${commit}/${COMMUNITY_DIR}/${id}`;

// 可信仓库根 = 本文件所在 scripts/ 的上一级。台账、封禁名单、官方 id 一律从这里读，绝不从 PR 内容里读。
export const TRUSTED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').trimStart());
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- 读插件目录 ----
// 读出规则要的 [{path, size, data}]。符号链接、设备文件之类不是普通文件的一律记为问题、不跟进去：
// 跟着链接读会把仓库外的文件（CI 机器上的任何东西）当成插件内容检查、打包。
// 太大的文件只记大小不读内容（规则按 size 拦），总量读到上限的两倍就不再读内容，防止被一个巨型 PR 撑爆内存。
const MAX_WALK = LIMITS.files + 200;
export function readPluginFiles(dir) {
  const root = path.resolve(dir);
  const files = [];
  const problems = [];
  let budget = LIMITS.totalBytes * 2;
  let count = 0;
  const walk = (abs, rel) => {
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { problems.push({ path: rel, message: `读不了目录 ${rel || '.'}：${e.code || e.message}` }); return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(abs, e.name);
      if (++count > MAX_WALK) { if (count === MAX_WALK + 1) problems.push({ path: r, message: `文件太多（超过 ${MAX_WALK} 个），没有读完` }); return; }
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) { problems.push({ path: r, message: `不许有符号链接：${r}` }); continue; }
      if (st.isDirectory()) { walk(p, r); continue; }
      if (!st.isFile()) { problems.push({ path: r, message: `不是普通文件：${r}` }); continue; }
      let data = Buffer.alloc(0);
      if (st.size <= LIMITS.fileBytes && st.size <= budget) { data = fs.readFileSync(p); budget -= st.size; }
      files.push({ path: r, size: st.size, data });
    }
  };
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { files, problems, missing: true };
  walk(root, '');
  return { files, problems, missing: false };
}

// 包里放什么：检查过的全部文件，去掉 market.json（市场元数据，进索引不进包）。检查的和上架的是同一批字节。
export const packPlugin = (files) => zipEntries(files.filter((f) => f.path !== MARKET_FILE).map((f) => ({ path: f.path, data: f.data })));

// ---- 可信数据 ----
export function loadTrusted(root = TRUSTED_ROOT) {
  const opt = (f, dflt) => (fs.existsSync(path.join(root, f)) ? readJson(path.join(root, f)) : dflt);
  const ledger = normLedger(opt(LEDGER_FILE, {}));
  const moderation = normModeration(opt(MODERATION_FILE, {}));
  const rsv = opt(path.join('scripts', 'reserved-ids.json'), {});
  const reserved = Object.values(isObj(rsv) ? rsv : {}).flat().filter((x) => typeof x === 'string');
  // 官方市场的 id：已发布台账 + plugins/ 下的源码目录（还没发版的官方插件也不给社区抢注）
  const rel = opt('releases.json', {});
  const official = new Set(Object.keys(isObj(rel.plugins) ? rel.plugins : {}));
  const pdir = path.join(root, 'plugins');
  if (fs.existsSync(pdir)) for (const d of fs.readdirSync(pdir, { withFileTypes: true })) if (d.isDirectory()) official.add(d.name);
  return { ledger, moderation, reserved, official: [...official].sort() };
}

export function normLedger(l) {
  const o = isObj(l) ? l : {};
  return { ...o, seq: Number.isInteger(o.seq) ? o.seq : 0, owners: isObj(o.owners) ? o.owners : {}, plugins: isObj(o.plugins) ? o.plugins : {} };
}
export function normModeration(m) {
  const o = isObj(m) ? m : {};
  return {
    revoked: Array.isArray(o.revoked) ? o.revoked.filter((r) => isObj(r) && typeof r.id === 'string') : [],
    blockedAuthors: Array.isArray(o.blockedAuthors) ? o.blockedAuthors.filter((x) => typeof x === 'string') : [],
    reservedIds: Array.isArray(o.reservedIds) ? o.reservedIds.filter((x) => typeof x === 'string') : [],
  };
}

// ---- 社区索引 ----
// 由台账 + 下架名单算出来：被吊销的版本不进 versions、进 revoked；整个下架或作者被封的插件不进 plugins、进 revoked（versions:"*"）。
// 返回不含 seq / generatedAt 的主体，便于算「内容有没有变」。
export function buildCommunityBody(ledger, moderation) {
  const blocked = new Set(moderation.blockedAuthors.map((s) => s.toLowerCase()));
  const rv = new Map(); // id -> { versions: '*' | Set, reason }
  for (const r of moderation.revoked) {
    const cur = rv.get(r.id) || { versions: new Set(), reason: '' };
    if (r.versions === '*') cur.versions = '*';
    else if (cur.versions !== '*' && Array.isArray(r.versions)) for (const v of r.versions) if (typeof v === 'string') cur.versions.add(v);
    if (!cur.reason && typeof r.reason === 'string') cur.reason = r.reason;
    rv.set(r.id, cur);
  }
  for (const [id, owner] of Object.entries(ledger.owners)) {
    if (blocked.has(String(owner).toLowerCase())) rv.set(id, { versions: '*', reason: rv.get(id)?.reason || '作者已被封禁' });
  }
  const plugins = [];
  for (const id of Object.keys(ledger.plugins).sort()) {
    const p = ledger.plugins[id];
    const r = rv.get(id);
    if (r && r.versions === '*') continue;
    const versions = (Array.isArray(p.versions) ? p.versions : [])
      .filter((v) => !(r && r.versions.has(v.version)))
      .sort((a, b) => compareVersions(b.version, a.version))
      .map((v) => ({
        version: v.version, engines: v.engines, restart: !!v.restart, url: v.url, sha256: v.sha256, size: v.size,
        date: v.date, notes: v.notes, kind: v.kind, caps: v.caps || [], permissions: v.permissions || [],
        commit: v.commit, source: v.source,
      }));
    if (!versions.length) continue;
    const meta = isObj(p.meta) ? p.meta : {};
    plugins.push({
      id,
      name: meta.name || id,
      nameEn: meta.nameEn || '',
      description: meta.description || '',
      descriptionEn: meta.descriptionEn || '',
      category: meta.category || 'third-party',
      publisher: ledger.owners[id] || '',
      homepage: homepageOf(id),
      versions,
    });
  }
  const revoked = [...rv.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([id, r]) => ({
    id, versions: r.versions === '*' ? '*' : [...r.versions].sort((a, b) => compareVersions(a, b)), reason: r.reason || '',
  }));
  return { plugins, revoked };
}

export const bodyHash = (body) => sha256(Buffer.from(JSON.stringify(body), 'utf8'));
export const EMPTY_BODY_HASH = bodyHash({ plugins: [], revoked: [] });

export function buildCommunityIndex(body, { seq, generatedAt }) {
  return { format: 1, market: 'community', seq, generatedAt, plugins: body.plugins, revoked: body.revoked };
}

export const serializeIndex = (obj) => Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');

// ---- 签名（格式同官方：{"keyId","sig"}，签 community.json 的原始字节）----
export function signIndex(bytes, privateKeyPem, keyId = KEY_ID) {
  const sig = crypto.sign(null, Buffer.from(bytes), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return JSON.stringify({ keyId, sig });
}

export function verifyIndex(bytes, sigText, spkiBase64 = PUBLIC_KEY_SPKI, keyId = KEY_ID) {
  try {
    const s = JSON.parse(sigText);
    if (s.keyId !== keyId) return false;
    const pub = crypto.createPublicKey({ key: Buffer.from(spkiBase64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(bytes), pub, Buffer.from(s.sig, 'base64'));
  } catch { return false; }
}
