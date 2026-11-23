// 检查一个社区投稿（拉取请求）。由 community-intake 工作流在可信的 main 上运行；PR 的内容只当数据读，绝不执行。
// 用法：
//   node scripts/community-check.mjs --dir <PR 内容目录> --files <改动文件清单 JSON> --author <登录名>
//                                    [--sha <head sha>] [--expect <PR 的 changed_files>] [--out report.json] [--md report.md]
//   node scripts/community-check.mjs --files <改动文件清单 JSON> --id-only     只打印投稿的插件 id（不合规就打印空行），给工作流决定取哪个目录
// --dir 是 PR 内容的根（里面有 community/<id>/，即 git archive 解出来的那棵树）。
// --files 是 GitHub「pulls/N/files」的结果（filename / status / previous_filename）；也接受 gh api --paginate --slurp 的按页数组。
// 台账、下架名单、官方 id、保留名都从本脚本所在的可信仓库读，不从 PR 目录读。
// 退出码恒为 0（脚本自己出错也写一份不通过的报告），由工作流读报告里的 ok 决定后续。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSubmission, formatReport } from './community-rules.mjs';
import { COMMUNITY_DIR, ID_RE, VER_RE, MARKER, loadTrusted, readPluginFiles } from './community-lib.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const flag = (n) => args.includes(n);

// 改动清单 -> 唯一的插件 id 与越界问题
export function scopeOf(changes) {
  const errors = [];
  const ids = new Set();
  for (const c of changes) {
    for (const p of [c && c.filename, c && c.previous_filename]) {
      if (p == null) continue;
      const m = /^community\/([^/]+)\/(.+)$/.exec(String(p));
      if (!m) { errors.push({ code: 'scope', message: `只能改 community/<插件 id>/ 下的文件，这个不行：${String(p).slice(0, 200)}` }); continue; }
      ids.add(m[1]);
    }
  }
  if (!changes.length) errors.push({ code: 'scope', message: '这个拉取请求没有改动任何文件' });
  // GitHub 的改动清单接口最多列 3000 个文件，超出的部分看不见——看不见的文件可能就在 community/ 外面
  if (changes.length >= API_FILE_CAP) errors.push({ code: 'scope', message: `改动的文件太多（${changes.length} 个以上），一个插件最多 300 个文件` });
  if (ids.size > 1) errors.push({ code: 'scope', message: `一个拉取请求只能投一个插件，这里涉及 ${ids.size} 个：${[...ids].slice(0, 10).join('、')}` });
  const id = ids.size === 1 ? [...ids][0] : '';
  if (id && !ID_RE.test(id)) errors.push({ code: 'id', message: `插件目录名「${id.slice(0, 60)}」不合法：小写字母开头，只用小写字母、数字、连字符，最长 48 字` });
  // 只要能认出唯一一个合法 id 就照样给出：越界改动已记为错误、整体不会通过，但作者能一次看到插件本身的全部问题；
  // 工作流也只会按这个 id 取 community/<id>/，越界的文件根本不会被取出来
  return { id: id && ID_RE.test(id) ? id : '', rawId: id, errors };
}

const API_FILE_CAP = 3000;
const flatten = (j) => (Array.isArray(j) ? j.flatMap((x) => (Array.isArray(x) ? x : [x])) : []);

// 给 GitHub 评论用：formatReport 是纯文本，相邻的非列表行在 Markdown 里会挤成一段，中间补空行
function toMarkdown(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const cur = lines[i], next = lines[i + 1];
    if (next != null && cur.trim() && next.trim() && !next.startsWith('- ')) out.push('');
  }
  return out.join('\n');
}

export function runCheck({ dir, changes, author, sha = '', expect = null, trusted = loadTrusted() }) {
  const scope = scopeOf(changes);
  const extra = [...scope.errors];
  // 和事件里的 changed_files 对一下数：清单没取全就不能断定没有越界改动
  if (Number.isInteger(expect) && expect !== changes.length) extra.push({ code: 'scope', message: `改动清单取到 ${changes.length} 个文件，拉取请求说改了 ${expect} 个，对不上（清单没取全时不能断定没有越界改动）；再推一次提交会重新检查` });
  const id = scope.id;
  let r = null;
  if (id) {
    const pluginDir = path.join(dir, COMMUNITY_DIR, id);
    const { files, problems, missing } = readPluginFiles(pluginDir);
    if (missing || !files.length) {
      const allRemoved = changes.every((c) => c.status === 'removed');
      extra.push({ code: 'delete', message: allRemoved
        ? `不能用拉取请求整个删除「${id}」：要下架请开 issue 联系维护者`
        : `取不到 community/${id}/ 的内容` });
    } else {
      for (const p of problems) extra.push({ code: 'path', file: p.path, message: p.message });
      // 改动清单里新增 / 修改的文件必须真的出现在取出的内容里：git archive 会听 .gitattributes 的 export-ignore，
      // 不核对的话，被排除的文件能躲过检查、却照样合并进 main
      const have = new Set(files.map((f) => f.path));
      const prefix = `${COMMUNITY_DIR}/${id}/`;
      for (const c of changes) {
        if (c.status === 'removed' || !String(c.filename).startsWith(prefix)) continue;
        const rel = String(c.filename).slice(prefix.length);
        if (!have.has(rel)) extra.push({ code: 'scope', file: rel, message: `改动清单里的 ${c.filename} 没出现在取出的内容里（不许用 .gitattributes 之类的手段排除文件）` });
      }
      r = checkSubmission({ id, files, author, ledger: trusted.ledger, moderation: trusted.moderation, reserved: trusted.reserved, official: trusted.official });
    }
  }
  if (!r) r = { ok: false, errors: [], warnings: [], kind: '', caps: [], capsAt: {}, permissions: [], version: '' };
  const errors = [...extra, ...r.errors];
  const ok = errors.length === 0 && r.ok;
  const full = { ...r, ok, errors };
  // 版本号只在合规时带出去：工作流会把它拼进合并标题，不合规的字符串（换行之类）不能流出去
  const version = VER_RE.test(String(r.version || '')) ? r.version : '';
  const showId = id || scope.rawId.replace(/[^a-z0-9-]/g, '').slice(0, 48);
  const tail = [];
  if (sha) tail.push(`检查的提交：\`${String(sha).replace(/[^0-9a-f]/gi, '').slice(0, 40)}\``);
  tail.push(ok
    ? '通过后会自动合并并上架；装的人会看到「未经人工审核」与检测到的能力。'
    : '改好后推送到同一个分支，会自动重新检查。规则说明见 community/README.md。');
  const markdown = `${MARKER}\n${toMarkdown(formatReport({ ...full, version }, { id: showId, author }))}\n\n${tail.join('\n\n')}\n`;
  return { ok, id, version, kind: r.kind || '', caps: r.caps || [], errors, warnings: r.warnings || [], markdown };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let changes = null;
  let loadErr = null;
  try { changes = flatten(JSON.parse(fs.readFileSync(opt('--files'), 'utf8').replace(/^\uFEFF/, ''))); } catch (e) { loadErr = e; }
  if (flag('--id-only')) {
    // 打印出去的 id 会被工作流写进 $GITHUB_ENV、拼进 git 路径：scopeOf 已按 ID_RE 校验过，不合规就是空行
    process.stdout.write((changes ? scopeOf(changes).id : '') + '\n');
    process.exit(0);
  }
  const author = String(opt('--author') || '');
  let report;
  try {
    if (!changes) throw new Error(`读不了改动清单：${loadErr?.message || loadErr}`);
    const expect = /^\d+$/.test(String(opt('--expect') || '')) ? Number(opt('--expect')) : null;
    report = runCheck({ dir: path.resolve(opt('--dir') || 'pr'), changes, author, sha: opt('--sha') || '', expect });
  } catch (e) {
    const msg = `检查脚本出错：${String(e?.message || e).slice(0, 300)}`;
    report = { ok: false, id: '', version: '', kind: '', caps: [], errors: [{ code: 'internal', message: msg }], warnings: [], markdown: `${MARKER}\n❌ 自动检查没能完成\n\n- ${msg}\n\n请联系维护者。\n` };
  }
  if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify(report, null, 2) + '\n');
  if (opt('--md')) fs.writeFileSync(opt('--md'), report.markdown);
  if (!opt('--out') && !opt('--md')) process.stdout.write(report.markdown);
  else console.log(report.ok ? `通过：${report.id} v${report.version}` : `没通过：${report.errors.map((e) => e.message).join('；').slice(0, 1000)}`);
  process.exit(0);
}
