// 发版公告：盯几个 GitHub 仓库的 Release，出了新的正式版就在指定的群里发一条更新提示 + 更新内容简介。
//
// 只读公开接口（不用 token，未登录额度 60 次/小时；带 ETag，没变化的 304 不算次数）。
// 第一次看到一个仓库时只记下现有的版本、不发——免得一加仓库就把历史版本刷一遍。
// 发布流程是 gh release create（先草稿、资产传完才公开），未登录看不到草稿，所以不会在资产没传完时就发。

const API = 'https://api.github.com';
const UA = 'claude-bridge-qqchatbot';
const REPO = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
export const MAX_AGE_MS = 3 * 86_400_000;   // 发布超过 3 天的不再当「新版本」（比如刚加进来的仓库、很久以后才从预发布转正）

// 设置里一行一个：「owner/repo 显示名」，显示名可省（= 仓库名）。也认整条 github.com 网址。
export function parseRepoLines(text) {
  const out = [];
  for (const raw of String(text || '').split(/[\r\n]+/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [first, ...rest] = line.split(/\s+/);
    const slug = first.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '').split('/').slice(0, 2).join('/');
    const m = REPO.exec(slug);
    if (!m || out.some((r) => r.repo.toLowerCase() === slug.toLowerCase())) continue;
    out.push({ repo: slug, name: rest.join(' ').trim() || m[2] });
  }
  return out;
}

// 拉最近几个 Release。返回 { notModified, etag, list }；list 只含已公开的（草稿未登录本来也看不到）
export async function fetchReleases(repo, etag = '', { timeoutMs = 20_000 } = {}) {
  const headers = { 'user-agent': UA, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (etag) headers['if-none-match'] = etag;
  const res = await fetch(`${API}/repos/${repo}/releases?per_page=10`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 304) return { notModified: true, etag, list: [] };
  if (!res.ok) {
    const left = res.headers.get('x-ratelimit-remaining');
    throw new Error(`GitHub ${res.status}${res.status === 404 ? '（仓库不存在或不是公开的）' : left === '0' ? '（这小时的查询额度用完了）' : ''}`);
  }
  const list = (await res.json()).filter((r) => r && !r.draft).map((r) => ({
    id: r.id, tag: String(r.tag_name || ''), title: String(r.name || ''), body: String(r.body || ''),
    url: String(r.html_url || ''), prerelease: !!r.prerelease, at: Date.parse(r.published_at || r.created_at || '') || 0,
  }));
  return { notModified: false, etag: res.headers.get('etag') || '', list };
}

// 哪些是要发公告的新版本（从旧到新）。seen = 已经处理过的 tag；first = 这个仓库第一次查
export function pickNew(list, seen, { prerelease = false, first = false, now = Date.now() } = {}) {
  const ok = list.filter((r) => r.tag && (prerelease || !r.prerelease));
  if (first) return { fresh: [], seen: ok.map((r) => r.tag) };
  const known = new Set(seen);
  const fresh = ok.filter((r) => !known.has(r.tag) && now - r.at < MAX_AGE_MS).sort((a, b) => a.at - b.at).slice(-3);
  return { fresh, seen: [...new Set([...ok.map((r) => r.tag), ...seen])].slice(0, 50) };
}

// 发布说明 → 纯文本，去掉安装说明 / 文件表 / 校验值这类给下载的人看的部分
export function cleanNotes(body) {
  let s = String(body || '').replace(/\r/g, '');
  const cut = s.search(/^\s*(?:\*\*(?:Windows|Android|Linux|macOS|Install|安装|下载)\b|#{1,6}\s*(?:Install|Downloads?|Assets|安装|下载|校验))/im);
  if (cut > 0) s = s.slice(0, cut);
  return s
    .replace(/^\s*\|.*\|\s*$/gm, '')                    // 表格
    .replace(/```[\s\S]*?```/g, '')                     // 代码块
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')              // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')            // 链接 → 文字
    .replace(/^#{1,6}\s*/gm, '').replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Claude 没用上时的兜底简介：说明的开头几句，截到 max 字
export function fallbackSummary(body, max = 280) {
  const s = cleanNotes(body);
  // 中英双语的说明（同一段先中文后英文）只留中文那部分：有中文时，去掉不含一个汉字的长行
  const cjk = /[一-鿿]/;
  const zh = cjk.test(s) ? s.split('\n').filter((l) => cjk.test(l) || l.trim().length < 40).join('\n').trim() : s;
  if (zh.length <= max) return zh;
  const head = zh.slice(0, max);
  const end = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf('\n'));
  return (end > max / 2 ? head.slice(0, end + 1) : head + '…').trim();
}

export const SUMMARY_PROMPT = '你在给 QQ 群写软件更新公告的「更新内容」部分。读用户给的发布说明，用简体中文写 3～5 条要点：'
  + '每条一行，用「1. 」「2. 」编号，每条不超过 45 个字，只写用户能感受到的变化（新功能、修好的问题），挑最重要的写，'
  + '不写安装包文件名、体积、校验值、版本号、内部实现。不要标题、不要开场白和结尾，只输出这几行纯文本。';

export function summaryMessage(name, rel) {
  return `软件：${name}\n版本：${rel.tag}${rel.title && rel.title !== rel.tag ? '（' + rel.title + '）' : ''}\n\n发布说明：\n${cleanNotes(rel.body).slice(0, 6000) || '（没写说明）'}`;
}

// 群里那条公告
export function composeNotice(name, rel, summary) {
  const lines = [`📢 ${name} 发布新版本 ${rel.tag}${rel.prerelease ? '（预览版）' : ''}`];
  const s = String(summary || '').trim();
  if (s) lines.push('', '更新内容：', s);
  if (rel.url) lines.push('', '完整说明与下载：' + rel.url);
  return lines.join('\n');
}
