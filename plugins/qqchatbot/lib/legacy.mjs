// 从旧版 qq-bot（独立进程版，管理台在 :5700）导入：设置 → 插件配置；各群的「群聊记录」（含图片）→ 对应群的沙箱。
// 旧的 Claude 会话不迁：旧版用的是 bridge 账号 qqchatbot 的身份，插件用自己的沙箱，会话接不上。

import { readFile, readdir, cp, stat } from 'node:fs/promises';
import path from 'node:path';

const readJson = async (f) => { try { const raw = await readFile(f, 'utf8'); return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { return null; } };
const isDir = async (p) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };

// 旧设置 → 插件配置的补丁（只放插件 schema 里有的字段）
export function mapSettings(s, efforts = null) {
  const out = {};
  const bool = (k, to = k) => { if (typeof s[k] === 'boolean') out[to] = s[k]; };
  bool('paused'); bool('replyAt'); bool('privateReply'); bool('atSender'); bool('plainReply'); bool('readImages'); bool('chatLog');
  bool('fileLink', 'sendFiles'); bool('fastMode', 'fast');
  if (typeof s.prefix === 'string') out.prefix = s.prefix.slice(0, 20);
  if (Number.isFinite(s.cooldownMs)) out.cooldownSec = Math.max(0, Math.min(120, Math.round(s.cooldownMs / 1000)));
  if (Number.isFinite(s.maxSeg)) out.maxSeg = Math.max(200, Math.min(4500, s.maxSeg));
  if (Number.isFinite(s.chatImgDays)) out.chatImgDays = Math.max(0, Math.min(3650, s.chatImgDays));
  if (typeof s.model === 'string') out.model = s.model;
  if (typeof s.effort === 'string' && (!efforts || !s.effort || efforts.includes(s.effort))) out.effort = s.effort;
  // 旧版的合并转发是「开了就整条回答都折成聊天记录」
  if (typeof s.forwardReply === 'boolean') out.forward = s.forwardReply ? 'always' : 'never';
  if (Array.isArray(s.allowGroups)) out.allowGroups = s.allowGroups.map(String).filter((g) => /^\d+$/.test(g));
  if (s.groups && typeof s.groups === 'object') {
    const groups = {};
    for (const [gid, g] of Object.entries(s.groups)) {
      if (!/^\d+$/.test(gid) || !g || typeof g !== 'object') continue;
      const v = {};
      if (typeof g.enabled === 'boolean') v.enabled = g.enabled;
      if (typeof g.model === 'string' && g.model) v.model = g.model;
      if (typeof g.effort === 'string' && g.effort && (!efforts || efforts.includes(g.effort))) v.effort = g.effort;
      if (typeof g.forward === 'boolean') v.forward = g.forward ? 'always' : 'never';
      if (Object.keys(v).length) groups[gid] = v;
    }
    out.groups = groups;
  }
  return out;
}

// 旧版群聊记录的根：<bridge usersRoot>/<机器人账号目录>/群聊记录/<群号>/…
async function findChatLogRoot(dataRoot) {
  const conf = await readJson(path.join(dataRoot, 'config.json'));
  const usersRoot = conf && typeof conf.usersRoot === 'string' ? conf.usersRoot : '';
  if (!usersRoot) return '';
  let best = '', bestN = -1;
  let names = [];
  try { names = await readdir(usersRoot); } catch { return ''; }
  for (const n of names) {
    const p = path.join(usersRoot, n, '群聊记录');
    if (!(await isDir(p))) continue;
    let k = 0;
    try { k = (await readdir(p)).filter((x) => /^\d+$/.test(x)).length; } catch {}
    if (k > bestN) { best = p; bestN = k; }
  }
  return best;
}

// dir：旧版 qq-bot 目录（里面有 data/settings.json）。返回 { config, names, copied, logRoot }
export async function importLegacy(ctx, dir, { efforts } = {}) {
  const settings = await readJson(path.join(dir, 'data', 'settings.json'));
  if (!settings) throw new Error('在 ' + dir + ' 下找不到 data/settings.json（旧版 qq-bot 的设置）');
  const config = mapSettings(settings, efforts);
  const groupsMeta = (await readJson(path.join(dir, 'data', 'groups.json'))) || {};
  const names = {};
  for (const [gid, g] of Object.entries(groupsMeta)) if (/^\d+$/.test(gid) && g && g.name) names['g' + gid] = String(g.name).trim();

  const logRoot = await findChatLogRoot(ctx.runtime.dataRoot);
  const copied = [];
  if (logRoot) {
    for (const gid of await readdir(logRoot)) {
      if (!/^\d+$/.test(gid)) continue;
      const ws = ctx.sandbox('g' + gid);
      // 合并进去：同名文件不覆盖（插件版已经记了的以插件版为准）
      await cp(path.join(logRoot, gid), ws.path('群聊记录'), { recursive: true, force: false, errorOnExist: false });
      copied.push(gid);
    }
  }
  return { config, names, copied, logRoot };
}
