// scrcpy 镜像会话：每台设备一路（视频 + 控制），多个观众共用一路编码。
//
// 协议照 scrcpy v5.0.1 服务端源码（server 文件随包：vendor/scrcpy-server-v5.0.1，Apache-2.0，sha256 见 SERVER_SHA256）：
//   视频 socket（第一个连上的）：dummy 字节 → 64 字节设备名 → u32 编码 id → 会话包（12 字节：首位 1、宽、高）→
//   媒体包（u64 pts+标志位：bit63 会话、bit62 配置、bit61 关键帧；u32 长度；数据）……旋转时会再来一个会话包。
//   控制 socket（第二个）：客户端写控制消息；设备回剪贴板（type 0）、剪贴板回执（type 1）、UHID（type 2）。
// 走 adb forward（tunnel_forward=true），本机端口由 adb 挑（tcp:0）。
//
// 观众（WebSocket 连接）拿到的：文本帧 = JSON 状态（session / clipboard / ended）；二进制帧 = [u8 标志][u64 pts][H.264 数据]，
// 标志 bit0 = 配置包（SPS/PPS），bit1 = 关键帧。观众积压超过 HIGH_WATER 就停发，等下一个关键帧（同时请求重新编码）再接上。

import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import { requireTool, killTree } from './sdk.mjs';
import { adb, shell, push, forward, forwardRemove, assertSerial } from './adb.mjs';
import { touch as touchEmulator } from './emulators.mjs';

export const SERVER_VERSION = '5.0.1';
export const SERVER_SHA256 = '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536';
const SERVER_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', `scrcpy-server-v${SERVER_VERSION}`);
const DEVICE_JAR = `/data/local/tmp/bridge-scrcpy-${SERVER_VERSION}.jar`;

const HIGH_WATER = 1_500_000;     // 观众 socket 积压超过这么多字节就丢帧等关键帧
const IDLE_STOP_MS = 30_000;      // 最后一个观众走后多久停流
const KEY_REQ_GAP_MS = 400;       // 请求关键帧的最小间隔

// 画质档：长边像素上限、码率。手机经隧道看时用「流畅」也够；本机看「高清」。
const QUALITY = {
  smooth: { maxSize: 1024, bitRate: 2_000_000, maxFps: 30 },
  standard: { maxSize: 1280, bitRate: 4_000_000, maxFps: 60 },
  high: { maxSize: 1920, bitRate: 8_000_000, maxFps: 60 },
};
const quality = () => QUALITY[config().quality] || QUALITY.standard;

// 控制消息类型（ControlMessage.java）
const T = { KEY: 0, TEXT: 1, TOUCH: 2, SCROLL: 3, BACK_OR_SCREEN_ON: 4, EXPAND_NOTIF: 5, EXPAND_SETTINGS: 6, COLLAPSE: 7,
  GET_CLIPBOARD: 8, SET_CLIPBOARD: 9, DISPLAY_POWER: 10, ROTATE: 11, RESET_VIDEO: 17 };
export const POINTER_GENERIC_FINGER = -2n;

const mirrors = new Map();   // serial → Mirror

/** 拿（必要时建）一台设备的镜像会话。 */
export function mirrorOf(serial) {
  assertSerial(serial);
  let m = mirrors.get(serial);
  if (!m || m.dead) { m = new Mirror(serial); mirrors.set(serial, m); }
  return m;
}
export const existingMirror = (serial) => { const m = mirrors.get(serial); return m && !m.dead ? m : null; };
export const viewerCount = (serial) => existingMirror(serial)?.viewers.size || 0;

export function stopAllMirrors() { for (const m of mirrors.values()) m.stop('shutdown'); }

class Mirror {
  constructor(serial) {
    this.serial = serial;
    this.viewers = new Set();
    this.dead = false;
    this.started = null;        // Promise
    this.name = '';
    this.width = 0; this.height = 0;
    this.config = null;         // 最近一次配置包（SPS/PPS）
    this.lastKeyReq = 0;
    this.keyTimer = null;
    this.idleTimer = null;
    this.proc = null; this.video = null; this.control = null; this.port = 0;
    this.serverLog = [];
    this.clipSeq = 1n;
    this.clipAcks = new Map();
  }

  // ── 观众 ─────────────────────────────────────────────
  /** viewer = { sendJson(obj), sendBinary(buf), bufferedAmount } → 返回移除函数。 */
  addViewer(viewer) {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    viewer.waitKey = true;
    this.viewers.add(viewer);
    touchEmulator(this.serial);
    this.ensureStarted().then(() => {
      if (!this.viewers.has(viewer)) return;
      if (this.width && !viewer.sessionSent) viewer.sendJson({ type: 'session', width: this.width, height: this.height, name: this.name, codec: 'h264' });
      if (this.config) viewer.sendBinary(packet(1, 0n, this.config));
      this.requestKeyFrame();
    }).catch((e) => {
      viewer.sendJson({ type: 'ended', error: String(e?.message || e) });
    });
    return () => {
      this.viewers.delete(viewer);
      if (!this.viewers.size && !this.dead) {
        this.idleTimer = setTimeout(() => { if (!this.viewers.size) this.stop('idle'); }, IDLE_STOP_MS);
        this.idleTimer.unref?.();
      }
    };
  }

  broadcastJson(obj) { for (const v of this.viewers) { try { v.sendJson(obj); } catch {} } }

  /** agent 要用控制通道（中文输入、按键）：没人看时也起一路，30 秒没人来看就停。 */
  async control() {
    await this.ensureStarted();
    if (!this.viewers.size) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (!this.viewers.size) this.stop('idle'); }, IDLE_STOP_MS);
      this.idleTimer.unref?.();
    }
    return this;
  }

  requestKeyFrame() {
    if (this.keyTimer) return;
    const wait = Math.max(0, this.lastKeyReq + KEY_REQ_GAP_MS - Date.now());
    this.keyTimer = setTimeout(() => {
      this.keyTimer = null;
      this.lastKeyReq = Date.now();
      this.sendControl(Buffer.from([T.RESET_VIDEO]));
    }, wait);
  }

  // ── 启动 ─────────────────────────────────────────────
  ensureStarted() {
    if (!this.started) this.started = this.start().catch((e) => { this.stop('error', e); throw e; });
    return this.started;
  }

  async start() {
    requireTool('adb');
    // 推 server（设备上已有同版本就不推；cleanup=true 时 server 退出会删掉自己，所以多半每次都推，约 0.2 秒）
    const have = await shell(this.serial, `ls -l ${DEVICE_JAR} 2>/dev/null || true`, { timeout: 10_000 }).catch(() => '');
    if (!/\s733930\s|\b733930\b/.test(have)) await push(this.serial, SERVER_FILE, DEVICE_JAR);
    const scid = randomInt(1, 0x7fffffff).toString(16).padStart(8, '0');
    this.port = await forward(this.serial, 'tcp:0', `localabstract:scrcpy_${scid}`);
    const q = quality();
    const args = [
      `CLASSPATH=${DEVICE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', SERVER_VERSION,
      `scid=${scid}`, 'log_level=info', 'tunnel_forward=true', 'audio=false', 'control=true', 'cleanup=true',
      'video_codec=h264', `max_size=${q.maxSize}`, `video_bit_rate=${q.bitRate}`, `max_fps=${q.maxFps}`,
      'stay_awake=true', 'power_off_on_close=false', 'clipboard_autosync=true',
    ].join(' ');
    const adbBin = requireTool('adb');
    this.proc = spawn(adbBin, ['-s', this.serial, 'shell', args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const keepLog = (c) => {
      for (const line of String(c).split(/\r?\n/)) if (line.trim()) { this.serverLog.push(line.trim()); if (this.serverLog.length > 40) this.serverLog.shift(); }
    };
    this.proc.stdout.on('data', keepLog);
    this.proc.stderr.on('data', keepLog);
    this.proc.on('exit', () => { if (!this.dead) this.stop('server-exit'); });

    this.video = await connectFirst(this.port, () => this.dead || this.proc.exitCode != null);
    this.control = await connectPlain(this.port);
    this.control.on('data', (c) => this.onDeviceMessage(c));
    this.control.on('error', () => {});
    this.control.on('close', () => { if (!this.dead) this.stop('control-closed'); });
    await this.readVideo();
  }

  // 视频 socket 的读取状态机：先读固定头（设备名 64 + 编码 4），之后是包流。
  readVideo() {
    return new Promise((resolve, reject) => {
      let buf = this.video.firstChunk || Buffer.alloc(0);   // dummy 字节已被 connectFirst 吃掉
      let stage = 'meta';
      let pending = null;   // 正在等数据的媒体包头
      let resolved = false;
      const settle = (err) => { if (resolved) return; resolved = true; err ? reject(err) : resolve(); };
      const pump = () => {
        for (;;) {
          if (stage === 'meta') {
            if (buf.length < 68) return;
            const nameBuf = buf.subarray(0, 64);
            const z = nameBuf.indexOf(0);
            this.name = nameBuf.subarray(0, z < 0 ? 64 : z).toString('utf8');
            const codec = buf.readUInt32BE(64);
            buf = buf.subarray(68);
            if (codec === 0 || codec === 1) { settle(new Error(codec === 1 ? 'scrcpy 配置错误（编码器不可用）' : '设备拒绝了视频流')); return; }
            if (codec !== 0x68323634) { settle(new Error(`不支持的视频编码 0x${codec.toString(16)}`)); return; }
            stage = 'packets';
            continue;
          }
          if (pending) {
            if (buf.length < pending.size) return;
            const data = Buffer.from(buf.subarray(0, pending.size));
            buf = buf.subarray(pending.size);
            this.onMedia(pending, data);
            pending = null;
            continue;
          }
          if (buf.length < 12) return;
          if (buf[0] & 0x80) {   // 会话包
            this.width = buf.readUInt32BE(4);
            this.height = buf.readUInt32BE(8);
            buf = buf.subarray(12);
            for (const v of this.viewers) v.sessionSent = true;
            this.broadcastJson({ type: 'session', width: this.width, height: this.height, name: this.name, codec: 'h264' });
            settle();
            continue;
          }
          const head = buf.readBigUInt64BE(0);
          const size = buf.readUInt32BE(8);
          buf = buf.subarray(12);
          pending = { config: (head & (1n << 62n)) !== 0n, key: (head & (1n << 61n)) !== 0n, pts: head & ((1n << 61n) - 1n), size };
        }
      };
      this.video.on('data', (c) => { buf = buf.length ? Buffer.concat([buf, c]) : c; pump(); });
      this.video.resume();
      this.video.on('error', () => {});
      this.video.on('close', () => { settle(new Error('视频连接断开')); if (!this.dead) this.stop('video-closed'); });
      pump();
      setTimeout(() => settle(new Error('等第一帧超时：' + (this.serverLog.slice(-3).join(' / ') || '设备没有回应'))), 15_000).unref?.();
    });
  }

  onMedia(h, data) {
    if (h.config) this.config = data;
    const flags = (h.config ? 1 : 0) | (h.key ? 2 : 0);
    const frame = packet(flags, h.pts, data);
    let congested = false;
    for (const v of this.viewers) {
      try {
        if (h.config) { v.sendBinary(frame); continue; }
        if (v.waitKey) {
          if (!h.key) { congested = true; continue; }
          v.waitKey = false;
        }
        if (v.bufferedAmount > HIGH_WATER) { v.waitKey = true; congested = true; continue; }
        v.sendBinary(frame);
      } catch {}
    }
    if (congested) this.requestKeyFrame();
  }

  onDeviceMessage(chunk) {
    this.devBuf = this.devBuf ? Buffer.concat([this.devBuf, chunk]) : chunk;
    for (;;) {
      const b = this.devBuf;
      if (!b || !b.length) return;
      const type = b[0];
      if (type === 0) {               // 剪贴板
        if (b.length < 5) return;
        const len = b.readUInt32BE(1);
        if (b.length < 5 + len) return;
        const text = b.subarray(5, 5 + len).toString('utf8');
        this.devBuf = b.subarray(5 + len);
        this.broadcastJson({ type: 'clipboard', text });
      } else if (type === 1) {        // 剪贴板回执
        if (b.length < 9) return;
        const seq = b.readBigUInt64BE(1);
        this.devBuf = b.subarray(9);
        const done = this.clipAcks.get(seq); if (done) { this.clipAcks.delete(seq); done(); }
      } else if (type === 2) {        // UHID 输出：跳过
        if (b.length < 5) return;
        const len = b.readUInt16BE(3);
        if (b.length < 5 + len) return;
        this.devBuf = b.subarray(5 + len);
      } else { this.devBuf = null; return; }
    }
  }

  // ── 控制 ─────────────────────────────────────────────
  sendControl(buf) {
    if (!this.control || this.control.destroyed) return false;
    touchEmulator(this.serial);
    return this.control.write(buf);
  }

  /** action：0 按下 1 抬起 2 移动；坐标是视频帧像素坐标（以当前会话宽高为准）。 */
  touch(action, pointerId, x, y, pressure = 1) {
    if (!this.width) return false;
    const b = Buffer.alloc(32);
    b[0] = T.TOUCH; b[1] = action;
    b.writeBigInt64BE(BigInt(pointerId), 2);
    b.writeInt32BE(Math.round(x), 10); b.writeInt32BE(Math.round(y), 14);
    b.writeUInt16BE(this.width, 18); b.writeUInt16BE(this.height, 20);
    b.writeUInt16BE(action === 1 ? 0 : Math.round(Math.min(1, Math.max(0, pressure)) * 0xffff), 22);
    b.writeInt32BE(0, 24); b.writeInt32BE(0, 28);
    return this.sendControl(b);
  }

  scroll(x, y, dx, dy) {
    if (!this.width) return false;
    const b = Buffer.alloc(21);
    b[0] = T.SCROLL;
    b.writeInt32BE(Math.round(x), 1); b.writeInt32BE(Math.round(y), 5);
    b.writeUInt16BE(this.width, 9); b.writeUInt16BE(this.height, 11);
    // i16 定点数，满量程 [-16, 16]
    const fx = (v) => Math.max(-32768, Math.min(32767, Math.round((Math.max(-16, Math.min(16, v)) / 16) * 32767)));
    b.writeInt16BE(fx(dx), 13); b.writeInt16BE(fx(dy), 15);
    b.writeInt32BE(0, 17);
    return this.sendControl(b);
  }

  /** action：0 按下 1 抬起。 */
  key(action, keycode, meta = 0, repeat = 0) {
    const b = Buffer.alloc(14);
    b[0] = T.KEY; b[1] = action;
    b.writeInt32BE(keycode, 2); b.writeInt32BE(repeat, 6); b.writeInt32BE(meta, 10);
    return this.sendControl(b);
  }

  press(keycode, meta = 0) { this.key(0, keycode, meta); return this.key(1, keycode, meta); }

  /** 直接注入文本：只适合 ASCII（服务端按键盘字符表转按键）。中文等走 paste。 */
  text(s) {
    const t = Buffer.from(String(s).slice(0, 300), 'utf8');
    const b = Buffer.alloc(5 + t.length);
    b[0] = T.TEXT; b.writeUInt32BE(t.length, 1); t.copy(b, 5);
    return this.sendControl(b);
  }

  /** 写设备剪贴板，paste=true 时顺手粘贴进当前焦点（中文、emoji 都靠它）。等设备回执，最多 3 秒。 */
  setClipboard(s, paste = false) {
    const t = Buffer.from(String(s), 'utf8').subarray(0, (1 << 18) - 14);
    const seq = this.clipSeq++;
    const b = Buffer.alloc(14 + t.length);
    b[0] = T.SET_CLIPBOARD; b.writeBigInt64BE(seq, 1); b[9] = paste ? 1 : 0; b.writeUInt32BE(t.length, 10); t.copy(b, 14);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.clipAcks.delete(seq); resolve(false); }, 3000);
      this.clipAcks.set(seq, () => { clearTimeout(timer); resolve(true); });
      if (!this.sendControl(b) && (!this.control || this.control.destroyed)) { clearTimeout(timer); this.clipAcks.delete(seq); resolve(false); }
    });
  }

  rotate() { return this.sendControl(Buffer.from([T.ROTATE])); }
  expandNotifications() { return this.sendControl(Buffer.from([T.EXPAND_NOTIF])); }
  collapsePanels() { return this.sendControl(Buffer.from([T.COLLAPSE])); }

  // ── 停止 ─────────────────────────────────────────────
  stop(reason = 'stop', err = null) {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.idleTimer); clearTimeout(this.keyTimer);
    const why = err ? String(err.message || err) : reason === 'server-exit' ? ('scrcpy 服务退出' + (this.serverLog.length ? '：' + this.serverLog.slice(-2).join(' / ') : '')) : '';
    this.broadcastJson({ type: 'ended', reason, error: why });
    try { this.video?.destroy(); } catch {}
    try { this.control?.destroy(); } catch {}
    if (this.proc && this.proc.exitCode == null) killTree(this.proc.pid);
    if (this.port) forwardRemove(this.serial, `tcp:${this.port}`).catch(() => {});
    if (mirrors.get(this.serial) === this) mirrors.delete(this.serial);
  }
}

function packet(flags, pts, data) {
  const head = Buffer.alloc(9);
  head[0] = flags;
  head.writeBigUInt64BE(BigInt.asUintN(64, BigInt(pts)), 1);
  return Buffer.concat([head, data]);
}

// adb forward 下：没人监听时连接也会成功，但立刻被关。第一个 socket 上的 dummy 字节证明 server 真的接上了。
async function connectFirst(port, gaveUp) {
  for (let i = 0; i < 100; i++) {
    if (gaveUp()) throw new Error('scrcpy 服务没起来');
    const s = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      let done = false;
      const end = (v) => { if (done) return; done = true; resolve(v); };
      sock.once('data', (c) => { sock.pause(); sock.removeAllListeners('close'); sock.firstChunk = c.subarray(1); end(sock); });
      sock.once('close', () => end(null));
      sock.once('error', () => end(null));
      setTimeout(() => { if (!done) { sock.destroy(); end(null); } }, 1500);
    });
    // 保持暂停：readVideo 挂上 data 监听后再 resume，否则中间到的数据没人接就丢了
    if (s) { s.removeAllListeners('error'); s.on('error', () => {}); return s; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('连不上设备上的 scrcpy 服务');
}

function connectPlain(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => { sock.setNoDelay(true); resolve(sock); });
    sock.once('error', reject);
  });
}
