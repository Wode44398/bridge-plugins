// 共用记忆的概况：多少篇、几个分区索引、最近一次谁写的。
// 「谁写的」只看最近改过的那一篇：按修改时间挑出来，读它开头一小段 frontmatter 里的 last_edited_by——不全量读文件。
// 总索引 MEMORY.md 与分区索引 MEMORY-*.md 不算「最近写的那篇」（它们跟着正文一起改，挑它们看不出写了什么）。
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const TTL = 4000;
const HEAD_BYTES = 2048;
const cache = new Map();   // dir → { at, stats }

const isIndex = (n) => n === 'MEMORY.md' || /^MEMORY-.+\.md$/i.test(n);

/** frontmatter 里的 last_edited_by（顶层或 metadata 下都认）；没有 → ''。 */
export function editedByOf(head) {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(String(head || ''));
  if (!m) return '';
  const v = /^[ \t]*last_edited_by:[ \t]*["']?([A-Za-z0-9_.-]{1,32})/m.exec(m[1]);
  return v ? v[1].toLowerCase() : '';
}

async function readHead(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; } finally { try { await fh?.close(); } catch {} }
}

/**
 * → { exists, files（第一层 .md 篇数）, parts（分区索引 MEMORY-*.md 个数）, index（有没有 MEMORY.md）,
 *     latest: { name, mtime, by } | null }
 */
export async function memoryStats(dir, { now = Date.now() } = {}) {
  if (!dir) return { exists: false, files: 0, parts: 0, index: false, latest: null };
  const hit = cache.get(dir);
  if (hit && now - hit.at < TTL) return hit.stats;
  let ents = null;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch {}
  let stats;
  if (!ents) stats = { exists: false, files: 0, parts: 0, index: false, latest: null };
  else {
    const mds = ents.filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => e.name);
    let best = null;
    await Promise.all(mds.filter((n) => !isIndex(n)).map(async (n) => {
      try {
        const st = await fsp.stat(path.join(dir, n));
        if (!best || st.mtimeMs > best.mtime) best = { name: n, mtime: Math.floor(st.mtimeMs) };
      } catch {}
    }));
    if (best) best.by = editedByOf(await readHead(path.join(dir, best.name)));
    stats = {
      exists: true, files: mds.length, parts: mds.filter((n) => /^MEMORY-.+\.md$/i.test(n)).length,
      index: mds.includes('MEMORY.md'), latest: best,
    };
  }
  cache.set(dir, { at: now, stats });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return stats;
}

export function forgetMemoryStats(dir) { if (dir) cache.delete(dir); else cache.clear(); }

const WHO = { claude: 'Claude', agy: 'agy', codex: 'Codex', kimi: 'Kimi', dimensio: 'dimensio' };
export const editorName = (by) => WHO[by] || by || '';

/** 「3 分钟前」之类；太久的写日期。 */
export function ago(ms, now = Date.now()) {
  const d = Math.max(0, now - Number(ms || 0));
  if (!ms) return '';
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  const t = new Date(Number(ms));
  return `${t.getMonth() + 1}-${String(t.getDate()).padStart(2, '0')}`;
}

/** 「agy 3 分钟前写入」；不知道谁写的就只写时间。 */
export function lastWriteText(latest, now = Date.now()) {
  if (!latest) return '';
  const who = editorName(latest.by);
  const when = ago(latest.mtime, now);
  return who ? `${who} ${when}写入` : `${when}有改动`;
}
