// H.264（Annex B）→ WebCodecs VideoDecoder → canvas。
//
// 服务端（runtime/android/scrcpy.mjs）发来的二进制帧：[u8 标志][u64 pts][数据]，标志 bit0 = 配置包（SPS/PPS），bit1 = 关键帧。
// 不给 VideoDecoder 传 description，按规范它就吃 Annex B（带起始码）的码流；配置包拼在下一个关键帧前面送进去。
// 延迟优先：optimizeForLatency、解码一帧画一帧；解码队列堆起来（后台标签页、手机慢）就丢到下一个关键帧，并让服务端重新编码。

export const webCodecsOk = () => typeof window !== 'undefined' && typeof window.VideoDecoder === 'function' && typeof window.EncodedVideoChunk === 'function';

/** 从 SPS 里取 profile / constraint / level，拼成 avc1.PPCCLL。 */
export function codecFromConfig(buf) {
  for (let i = 0; i + 4 < buf.length; i++) {
    // 起始码 00 00 01 或 00 00 00 01
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      const h = buf[i + 2] === 1 ? i + 3 : i + 4;
      if ((buf[h] & 0x1f) === 7 && h + 3 < buf.length) {
        const hex = (v) => v.toString(16).padStart(2, '0');
        return `avc1.${hex(buf[h + 1])}${hex(buf[h + 2])}${hex(buf[h + 3])}`;
      }
    }
  }
  return 'avc1.42e01f';
}

export class H264Canvas {
  /** onNeedKey：要请服务端出关键帧时调；onFrame：画出一帧时调（首帧到达、统计帧率）。 */
  constructor(canvas, { onNeedKey, onFrame, onError } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.onNeedKey = onNeedKey || (() => {});
    this.onFrame = onFrame || (() => {});
    this.onError = onError || (() => {});
    this.decoder = null;
    this.config = null;
    this.codec = '';
    this.waitKey = true;
    this.frames = 0;
  }

  setSize(w, h) {
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  ensureDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        try {
          if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) this.setSize(frame.displayWidth, frame.displayHeight);
          this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
          this.frames++;
          this.onFrame(this.frames);
        } finally { frame.close(); }
      },
      error: (e) => { this.onError(e); this.reset(); },
    });
    return this.decoder;
  }

  reset() {
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch {}
    this.decoder = null;
    this.codec = '';
    this.waitKey = true;
    this.onNeedKey();
  }

  /** 一条二进制消息（ArrayBuffer）。 */
  push(ab) {
    const u8 = new Uint8Array(ab);
    if (u8.length < 9) return;
    const flags = u8[0];
    const pts = Number(new DataView(ab).getBigUint64(1));
    const data = u8.subarray(9);
    if (flags & 1) {   // 配置包：SPS/PPS 变了就重建解码器（旋转、改分辨率）
      const codec = codecFromConfig(data);
      this.config = data.slice();
      if (codec !== this.codec || !this.decoder || this.decoder.state === 'closed') {
        try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch {}
        this.decoder = null;
        this.codec = codec;
        const d = this.ensureDecoder();
        try { d.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference' }); }
        catch (e) { this.onError(e); return; }
      }
      this.waitKey = true;
      return;
    }
    const key = !!(flags & 2);
    const d = this.decoder;
    if (!d || d.state !== 'configured') { if (key) this.onNeedKey(); return; }
    if (this.waitKey && !key) return;
    if (!key && d.decodeQueueSize > 6) { this.waitKey = true; this.onNeedKey(); return; }
    let payload = data;
    if (key && this.config) {
      payload = new Uint8Array(this.config.length + data.length);
      payload.set(this.config, 0);
      payload.set(data, this.config.length);
    }
    try {
      d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data: payload }));
      if (key) this.waitKey = false;
    } catch (e) { this.onError(e); this.reset(); }
  }

  close() {
    try { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); } catch {}
    this.decoder = null;
  }
}
