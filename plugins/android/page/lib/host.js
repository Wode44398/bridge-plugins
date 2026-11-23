// 插件页面和 bridge 之间的唯一一层：请求、实时通道、确认框、下载、分块上传、中英文都经插件 SDK（/plugins/_sdk/bridge-plugin.js）。
// 组件里照旧写 api.get('/api/android/…') / readDockSse(…) / uiConfirm(…) / t(…)——这里把它们接到 SDK 上：
//   · 接口路径 /api/android/x → 插件自己的 /api/plugin/android/x（bridge.json：嵌入时宿主代发，独立打开时带插件票据）
//   · 「SSE」→ bridge.socket 实时通道（events / logcat），消息格式不变
//   · 上传 → 分块（宿主代发单次请求体 ≤ 20 MB，apk 动辄上百 MB）
import { bridge } from '/plugins/_sdk/bridge-plugin.js';
import EN from './en.js';

let lang = 'zh';
export const ready = bridge.ready().then((info) => { lang = info?.lang === 'en' ? 'en' : 'zh'; return info; });

/** 中文原文为键；英文界面查 en.js，没有就照中文显示。{name} 占位替换。 */
export function t(s, params) {
  let out = lang === 'en' && EN[s] ? EN[s] : s;
  if (params) out = out.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
  return out;
}
export const tc = (_ctx, s, params) => t(s, params);

const rel = (p) => String(p).replace(/^\/api\/android\//, '');

/** 抛的错带 body（{ error }），给 errText 用 */
async function call(path, data) {
  try {
    return await bridge.json(rel(path), data);
  } catch (e) {
    if (!e.body && e.message) e.body = { error: e.message };
    throw e;
  }
}
export const api = {
  get: (p) => call(p),
  post: (p, b) => call(p, b ?? {}),
};

export const uiConfirm = async (message, opts = {}) => !!(await bridge.confirm({ title: String(message || ''), danger: !!opts.danger, yes: opts.okLabel || '' }));
export const toast = (text, error = false) => bridge.toast(text, { error });

/**
 * 原来的 SSE 读法：readDockSse('/api/android/events' | '/api/android/logcat?…', onEvent, { onDead, onClose }) → 停止函数。
 * 现在走 bridge.socket：路径最后一段是通道名，查询串原样当连接参数。
 */
export function readDockSse(path, onEvent, { onDead, onClose } = {}) {
  const u = new URL(rel(path), 'http://x/');
  const name = u.pathname.replace(/^\//, '').split('/')[0];
  const query = Object.fromEntries(u.searchParams.entries());
  let ws = null; let stopped = false; let opened = false;
  bridge.socket(name, query).then((s) => {
    if (stopped) { s.close(); return; }
    ws = s;
    ws.onopen = () => { opened = true; };
    ws.onmessage = (e) => { if (typeof e.data === 'string') { try { onEvent(JSON.parse(e.data)); } catch {} } };
    ws.onclose = () => { if (!stopped) (opened ? onClose : () => onDead?.(0, null))?.(); };
  }).catch((e) => { if (!stopped) onDead?.(e?.status || 0, e?.body || null); });
  return () => { stopped = true; try { ws?.close(); } catch {} };
}

/** 实时画面通道（App 用）：bridge.socket('stream', { serial }) */
export const openSocket = (name, query) => bridge.socket(name, query);

/** 下载插件接口给的文件（路径同 api：/api/android/… 或相对） */
export const download = (path, name) => bridge.download(rel(path), name);

/**
 * 分块上传文件，再调 finish 接口。onProgress(0..1)。
 *   target = { finish: 'install' | 'file/push', data: { serial, name, dir? } }
 * 每块 8 MB（宿主代发单次 ≤ 20 MB；服务端单块 ≤ 16 MB）。
 */
const CHUNK = 8 << 20;
export async function uploadChunked(file, target, onProgress) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  const total = file.size || 0;
  let sent = 0; let seq = 0;
  do {
    const part = file.slice(sent, sent + CHUNK);
    const last = sent + part.size >= total;
    const r = await bridge.fetch(`upload?id=${id}&seq=${seq}&last=${last ? 1 : 0}`, { method: 'POST', body: part, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j?.error) msg = j.error; } catch {}
      throw Object.assign(new Error(msg), { body: { error: msg } });
    }
    sent += part.size; seq++;
    onProgress?.(total ? Math.min(1, sent / total) : 1);
  } while (sent < total);
  return call(target.finish, { ...target.data, upload: id });
}

/** 页面里记点小偏好（选过的设备、子页）：不透明源里没有 localStorage，用 bridge.kv（存在服务器上、每人一份） */
const memo = new Map();
export const prefs = {
  get(k, dflt = '') { return memo.has(k) ? memo.get(k) : dflt; },
  set(k, v) { memo.set(k, v); if (bridge.can('kv')) bridge.kv.set('pref.' + k, v).catch(() => {}); },
  async load(keys) {
    if (!bridge.can('kv')) return;
    await Promise.all(keys.map(async (k) => { try { const v = await bridge.kv.get('pref.' + k); if (v != null) memo.set(k, v); } catch {} }));
  },
};

export { bridge };
