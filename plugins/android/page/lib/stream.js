// 安卓画面流的连接：插件实时通道 bridge.socket('stream', { serial })（SDK 先换一次性票据再直连 WebSocket）。
// 断线自动重连（退避 1 → 8 秒，最多 30 次）；页面切到后台时不重连，回来再连。
import { openSocket } from './host.js';

export function openStream(serial, { onJson, onBinary, onState } = {}) {
  let ws = null;
  let closed = false;
  let tries = 0;
  let timer = null;

  const state = (s, extra) => onState?.(s, extra);

  async function connect() {
    if (closed) return;
    state('connecting');
    let s;
    try { s = await openSocket('stream', { serial }); }
    catch (e) { return retry(String(e?.message || e)); }
    if (closed) { try { s.close(); } catch {} return; }
    ws = s;
    ws.onopen = () => { tries = 0; state('open'); };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') { try { onJson?.(JSON.parse(ev.data)); } catch {} }
      else onBinary?.(ev.data);
    };
    ws.onclose = () => { ws = null; if (!closed) retry('closed'); };
    ws.onerror = () => {};
  }

  function retry(why) {
    if (closed) return;
    if (tries >= 30) { state('failed', why); return; }
    const wait = Math.min(8000, 1000 * 2 ** Math.min(3, tries));
    tries++;
    state('retry', why);
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (document.hidden) { const go = () => { document.removeEventListener('visibilitychange', go); connect(); }; document.addEventListener('visibilitychange', go); }
      else connect();
    }, wait);
  }

  connect();

  return {
    send(obj) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; },
    get open() { return !!ws && ws.readyState === 1; },
    close() { closed = true; clearTimeout(timer); try { ws?.close(); } catch {} ws = null; },
    reconnect() { tries = 0; try { ws?.close(); } catch {} },
  };
}
