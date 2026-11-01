// OneBot 11 协议适配：调接口、解析消息段、把消息渲染成群聊记录行、发文字 / 合并转发 / 图片 / 文件。
// 协议端（NapCat、Lagrange、LLOneBot……）开一个 HTTP 服务供我们发消息，再开一个 HTTP 上报指向插件的回调地址。

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_INLINE = 30 * 1024 * 1024;   // base64 发文件的上限（协议端可能不在同一台机器，只能传内容）

export function makeOneBot(getCfg) {
  async function call(action, params = {}, timeoutMs = 20_000) {
    const cfg = getCfg();
    const res = await fetch(String(cfg.apiUrl || '').replace(/\/+$/, '') + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.apiToken ? { Authorization: 'Bearer ' + cfg.apiToken } : {}) },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await res.json().catch(() => null);
    // 必须是 OneBot 的 JSON（别的程序蹲在这个端口上回 200 也算连不上）
    if (!res.ok || !j || (j.status === undefined && j.retcode === undefined)) throw new Error((j && (j.message || j.wording)) || 'HTTP ' + res.status);
    if (j.status && j.status !== 'ok' && j.status !== 'async') throw new Error(j.message || j.wording || 'OneBot 返回 ' + j.status);
    return j.data;
  }

  // QQ 真实登录态：NapCat 进程活着、HTTP 照常应答时 get_login_info 看不出掉线，只有 get_status 的 online 准
  async function loginState() {
    try {
      const d = await call('get_status', {}, 6_000);
      return { api: true, online: d?.online === true };
    } catch { return { api: false, online: null }; }
  }

  const isPriv = (cid) => cid.startsWith('p');
  const target = (cid) => Number(cid.slice(1));
  const sendMsg = (cid, message) => isPriv(cid)
    ? call('send_private_msg', { user_id: target(cid), message })
    : call('send_group_msg', { group_id: target(cid), message });

  function split(text, max) {
    const out = [];
    let s = String(text || '').trim();
    while (s.length > max) { let cut = s.lastIndexOf('\n', max); if (cut < max / 2) cut = max; out.push(s.slice(0, cut)); s = s.slice(cut).trim(); }
    if (s) out.push(s);
    return out;
  }

  // 普通文字：超长切段；第一段带引用回复和 @
  async function sendText(cid, text, { replyTo, atQQ, maxSeg = 3000 } = {}) {
    const parts = split(text, maxSeg);
    for (let i = 0; i < parts.length; i++) {
      const message = [];
      if (i === 0 && replyTo) message.push({ type: 'reply', data: { id: String(replyTo) } });
      if (i === 0 && atQQ && !isPriv(cid)) message.push({ type: 'at', data: { qq: String(atQQ) } }, { type: 'text', data: { text: ' ' } });
      message.push({ type: 'text', data: { text: parts[i] } });
      await sendMsg(cid, message);
    }
  }

  // 合并转发卡（长回答不刷屏）：按空行分段，最多 40 段；协议端不支持就退回普通文字
  async function sendForward(cid, text, { selfId, selfName, atQQ, replyTo, maxSeg = 3000 } = {}) {
    const paras = String(text).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    const chunks = paras.flatMap((p) => split(p, maxSeg)).slice(0, 40);
    const nodes = chunks.map((c) => ({ type: 'node', data: { user_id: String(selfId || '10000'), nickname: selfName || 'Claude', content: [{ type: 'text', data: { text: c } }] } }));
    try {
      if (isPriv(cid)) await call('send_private_forward_msg', { user_id: target(cid), messages: nodes });
      else await call('send_group_forward_msg', { group_id: target(cid), messages: nodes });
      if (atQQ && !isPriv(cid)) await sendMsg(cid, [{ type: 'at', data: { qq: String(atQQ) } }, { type: 'text', data: { text: ' 回答较长，已整理成上面的聊天记录' } }]).catch(() => {});
    } catch {
      await sendText(cid, text, { replyTo, atQQ, maxSeg });
    }
  }

  // 文件：图片发成图片消息，其余走群文件 / 私聊文件上传。内容一律 base64 传，协议端在别的机器上也能收。
  async function sendFile(cid, file, { name } = {}) {
    const st = await stat(file);
    if (st.size > MAX_INLINE) throw new Error(`${path.basename(file)} 太大（${Math.round(st.size / 1048576)}MB）`);
    const b64 = 'base64://' + (await readFile(file)).toString('base64');
    if (IMG_EXT.test(file)) return sendMsg(cid, [{ type: 'image', data: { file: b64 } }]);
    const fname = name || path.basename(file);
    if (isPriv(cid)) return call('upload_private_file', { user_id: target(cid), file: b64, name: fname }, 120_000);
    return call('upload_group_file', { group_id: target(cid), file: b64, name: fname }, 120_000);
  }

  // 下载一张图：优先协议端给的 CDN url，拿不到再让协议端把图落到本地读（同机部署时）
  async function imageBytes(img) {
    if (img.url) {
      try {
        const r = await fetch(img.url, { signal: AbortSignal.timeout(20_000) });
        if (r.ok) return Buffer.from(await r.arrayBuffer());
      } catch {}
    }
    if (img.file) {
      try {
        const d = await call('get_image', { file: img.file }, 15_000);
        if (d?.base64) return Buffer.from(d.base64, 'base64');
        if (d?.file) return await readFile(d.file);
      } catch {}
    }
    return null;
  }

  return { call, loginState, sendText, sendForward, sendFile, imageBytes };
}

// 消息段 → { text, atMe, images:[{url,file,kind}], replyId }。array 和 CQ 码字符串两种上报格式都认。
export function readSegments(msg, selfId) {
  let atMe = false, text = '', replyId = '';
  const images = [];
  for (const { type, data: d } of segmentsOf(msg)) {
    if (type === 'at') { if (selfId && String(d.qq) === String(selfId)) atMe = true; else if (d.qq && d.qq !== 'all') text += `@${d.name || d.qq} `; }
    else if (type === 'text') text += d.text || '';
    else if (type === 'image' && (d.url || d.file)) images.push({ url: d.url || '', file: d.file || d.file_id || '', kind: imgKind(d) });
    else if (type === 'reply') replyId = String(d.id ?? d.message_id ?? '');
    else if (type === 'face' || type === 'mface') text += '[表情]';
  }
  return { atMe, text: text.trim(), images: images.slice(0, 9), replyId };
}

// 一条消息 → 群聊记录行的正文。图片先占位（\0IMG<i>\0），存下来后再换成 [图片:相对路径]。
const SEG_LABEL = { face: '[表情]', mface: '[表情]', record: '[语音]', video: '[视频]', forward: '[合并转发]', json: '[卡片]', xml: '[卡片]', poke: '[戳一戳]', dice: '[骰子]', rps: '[猜拳]', markdown: '[消息]' };
export function renderForLog(msg, selfId, imgs = null) {
  return segmentsOf(msg).map(({ type, data: d }) => {
    if (type === 'text') return d.text || '';
    if (type === 'at') {
      if (String(d.qq) === 'all') return '@全体成员 ';
      if (selfId && String(d.qq) === String(selfId)) return '@你(机器人) ';
      return `@${d.name ? d.name + '(' + d.qq + ')' : d.qq} `;
    }
    if (type === 'image') {
      const kind = imgKind(d);
      if (imgs && (d.url || d.file)) { imgs.push({ url: d.url || '', file: d.file || d.file_id || '', kind }); return `\u0000IMG${imgs.length - 1}\u0000`; }
      return `[${kind}]`;
    }
    if (type === 'reply') return `↪#${d.id || d.message_id || '?'} `;
    if (type === 'file') return `[文件:${d.name || d.file || ''}]`;
    return SEG_LABEL[type] || `[${type}]`;
  }).join('').trim();
}

// 表情包的 summary 是「[动画表情]」之类，普通图为空或「[图片]」
const imgKind = (d) => (d.summary && d.summary !== '[图片]' ? String(d.summary).replace(/^\[|\]$/g, '') : '图片');

function segmentsOf(msg) {
  if (Array.isArray(msg)) return msg.map((x) => ({ type: x?.type, data: x?.data || {} }));
  const out = [];
  const s = String(msg || '');
  let last = 0;
  for (const m of s.matchAll(/\[CQ:(\w+)((?:,[^\]]*)?)\]/g)) {
    if (m.index > last) out.push({ type: 'text', data: { text: unescape(s.slice(last, m.index)) } });
    const d = {};
    for (const pair of m[2].split(',')) { const j = pair.indexOf('='); if (j > 0) d[pair.slice(0, j)] = unescape(pair.slice(j + 1)); }
    out.push({ type: m[1], data: d });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ type: 'text', data: { text: unescape(s.slice(last)) } });
  return out;
}
const unescape = (s) => s.replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&#44;/g, ',').replace(/&amp;/g, '&');

// 按文件头认图片格式（QQ 的 CDN 链接不带扩展名）
export function sniffExt(buf) {
  if (!buf || buf.length < 4) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return 'jpg';
}
