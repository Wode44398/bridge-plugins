// 路径判断：一个会话目录算不算在某个协作文件夹里。
//
// 三种都算：① 就是这个文件夹；② 在它下面；③ 同一个 git 主仓库里的同一处——worktree 会话（Claude 输入栏勾 worktree 开出来的、
// `git worktree add` 出来的）目录在别处，但它们和协作文件夹是同一个主仓库，且在仓库里的相对位置落在协作文件夹之内。
// 只读 .git 文件 / 目录，不跑 git：提示函数是同步的，要在这里当场判断。结果按目录缓存一分钟。
import fs from 'node:fs';
import path from 'node:path';

const WIN_DRIVE = /^[A-Za-z]:/;

/** 比较用的键：反斜杠换正斜杠、去尾斜杠；带盘符的（Windows）不分大小写。不是绝对路径 → ''。 */
export function pathKey(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim().replace(/\\/g, '/');
  if (!s || !(WIN_DRIVE.test(s) || s.startsWith('/'))) return '';
  s = s.replace(/\/+$/, '') || '/';
  if (/^[A-Za-z]:$/.test(s)) s += '/';
  return WIN_DRIVE.test(s) || s.startsWith('//') ? s.toLowerCase() : s;
}

export const samePath = (a, b) => { const x = pathKey(a); return !!x && x === pathKey(b); };

/** child 是不是 parent 本身或在它下面。 */
export function within(child, parent) {
  const c = pathKey(child), p = pathKey(parent);
  if (!c || !p) return false;
  if (c === p) return true;
  return c.startsWith(p.endsWith('/') ? p : p + '/');
}

export const baseName = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || '');

// ── git 主仓库 ──────────────────────────────────────────────────────────
const GIT_TTL = 60_000;
const gitCache = new Map();   // pathKey → { at, info }

/**
 * dir 所在的 git 工作树：{ main: 主仓库根, top: 这个工作树的根 } | null（不在 git 里）。
 * .git 是目录 → 主仓库就是这里；.git 是文件且指向 <主仓库>/.git/worktrees/<名> → 是那个主仓库的 worktree；
 * 别的（子模块之类）当它自成一库。
 */
export function gitInfo(dir) {
  const k = pathKey(dir);
  if (!k) return null;
  const hit = gitCache.get(k);
  if (hit && Date.now() - hit.at < GIT_TTL) return hit.info;
  let info = null;
  let cur = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    const dotGit = path.join(cur, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch {}
    if (st && st.isDirectory()) { info = { main: cur, top: cur }; break; }
    if (st && st.isFile()) {
      let main = cur;
      try {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (m) {
          const gd = path.resolve(cur, m[1]);
          const w = /^(.*?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(gd);
          if (w) main = w[1];
        }
      } catch {}
      info = { main, top: cur };
      break;
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  gitCache.set(k, { at: Date.now(), info });
  if (gitCache.size > 500) gitCache.delete(gitCache.keys().next().value);
  return info;
}

/** 在仓库里的相对位置（'' = 工作树根），比较用的键。 */
function relInRepo(dir, info) {
  const t = pathKey(info.top), d = pathKey(dir);
  if (d === t) return '';
  return d.startsWith(t.endsWith('/') ? t : t + '/') ? d.slice(t.length).replace(/^\/+/, '') : null;
}

/** cwd 属不属于协作文件夹 folder（见文件头三种）。 */
export function belongsTo(cwd, folder) {
  if (!pathKey(cwd) || !pathKey(folder)) return false;
  if (within(cwd, folder)) return true;
  const a = gitInfo(cwd), b = gitInfo(folder);
  if (!a || !b || !samePath(a.main, b.main)) return false;
  const ra = relInRepo(cwd, a), rb = relInRepo(folder, b);
  if (ra == null || rb == null) return false;
  return rb === '' || ra === rb || ra.startsWith(rb + '/');
}

export function _resetGitCache() { gitCache.clear(); }
