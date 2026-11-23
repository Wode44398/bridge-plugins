// 安卓模拟器插件：工作区「安卓」卡（模拟器 / 真机的实时画面 + Android Studio 式工具）与给 agent 的 android 工具。
//
// 服务端：SDK 体检、设备表、模拟器启停（脱离 bridge 进程树、bridge 重启后认领、空闲自动关）、scrcpy 画面流、
// adb 动作（装包、Logcat、文件、控件树、录屏、无线配对）、模拟器控制台（定位、电池、短信、快照……）。
// 页面（web/index.html，源码在 page/）：经 bridge.socket 收画面流和设备表、经 bridge.json 调下面的接口。
// 只对服务器主机开放：模拟器吃资源、能装任意 apk。
//
// 接口（都在 /api/plugin/android/ 下，ctx.http.host 判权）：
//   GET  state                         体检 + 设备 + 启动中 + 启动失败原因
//   POST emulator/start {avd,cold?,wipe?}  → 202，进度走 events 通道
//   POST emulator/stop  {serial}
//   GET  screenshot?serial=            PNG
//   POST upload?id=&seq=&last=         分块上传（请求体 = 原始字节，每块 ≤ 16 MB；宿主代发单次 ≤ 20 MB）
//   POST install {serial, upload, name}      装分块传上来的 apk
//   POST file/push {serial, dir, name, upload}  推到设备
//   GET  file?serial=&path=            从设备下载
//   GET  files?serial=&path=  apps?serial=  snapshots?serial=  ui?serial=&full=  avd-options  record?serial=
//   POST app {serial,op,pkg}  emu {...}  snapshot {serial,op,name}  logcat/clear {serial}
//   POST avd/create {name,device,image}  avd/delete {name}  pair {host,port,code}  connect {host,port}  disconnect {serial}
//   POST record/start {serial}  record/stop {serial} → { url: 'record/file?id=…', name, size, seconds }；GET record/file?id=
// 实时通道（ctx.socket）：events（设备表推送）· stream?serial=（画面 + 控制）· logcat?serial=&pkg=&level=

import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createWriteStream, createReadStream, promises as fsp, rmSync, statSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setConfig, setDataDir } from './lib/config.mjs';
import { doctor, listAvds, installedImages, toolPath, requireTool, run, ok, brief, killTree } from './lib/sdk.mjs';
import { adb, shell, shq, validSerial, watchDevices, execOut } from './lib/adb.mjs';
import * as emu from './lib/emulators.mjs';
import { mirrorOf, viewerCount, stopAllMirrors, POINTER_GENERIC_FINGER } from './lib/scrcpy.mjs';
import { deviceTable } from './lib/devices.mjs';
import { runAndroidAction, getElements, ANDROID_PARAMS, ANDROID_DESCRIPTION } from './lib/actions.mjs';
import { startRecord, stopRecord, recordingOf } from './lib/record.mjs';
import { NUDGE_CLAUDE, NUDGE_PEER, operatorAgent } from './lib/prompts.mjs';

const BASE = '/api/plugin/android/';
const PKG = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;
const AVD = /^[A-Za-z0-9_.-]{1,64}$/;
const UPLOAD_ID = /^[A-Za-z0-9_-]{8,40}$/;
const CHUNK_MAX = 16 << 20;
const MAX_LOGCAT = 6;

export function apply(ctx) {
  setConfig(ctx.config);
  setDataDir(ctx.dataDir);
  ctx.onConfig((next) => { setConfig(next); return true; });   // 画质、自动关机、台数都现读，不用重启插件
  emu.setViewerCounter(viewerCount);
  emu.load().catch(() => {});
  // 停用 / 重新加载：画面流、心跳收掉；模拟器留着（下次启用或 bridge 重启后按进程表认领）
  ctx.onDispose(() => { stopAllMirrors(); emu.shutdown(); });

  const { json } = ctx.http;
  const host = (req, res) => ctx.http.host(req, res);
  const serialOf = (res, s) => { const v = String(s || ''); if (!validSerial(v)) { json(res, 400, { error: '设备序列号不合法' }); return ''; } return v; };
  const body = async (req, res) => { try { return await ctx.http.body(req); } catch { json(res, 400, { error: '请求体不是合法 JSON' }); return null; } };
  const fail = (res, e) => json(res, e?.status || 500, { error: String(e?.message || e) });
  const textOf = (r) => (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const route = (method, p, fn) => ctx.route(method, BASE + p, async (req, res, url) => {
    if (!host(req, res)) return;
    try { await fn(req, res, url); } catch (e) { if (!res.headersSent) fail(res, e); else try { res.end(); } catch {} }
  });

  // ── 设备表 / 启停 ─────────────────────────────────────
  const progress = new Map();     // key → { state, avd }
  const startErrors = new Map();  // avd → { error, at }
  const eventSocks = new Set();
  let lastDevices = [];
  let doctorCache = null;
  const cachedDoctor = async (force) => {
    if (!force && doctorCache && Date.now() - doctorCache.at < 30_000) return doctorCache.v;
    doctorCache = { at: Date.now(), v: await doctor() };
    return doctorCache.v;
  };
  const statePayload = async (list) => ({
    type: 'devices', devices: await deviceTable(list).catch(() => []),
    starting: [...progress.entries()].map(([serial, p]) => ({ serial, ...p })), errors: Object.fromEntries(startErrors),
  });
  const broadcast = async () => {
    if (!eventSocks.size) return;
    const p = await statePayload(lastDevices);
    for (const s of eventSocks) s.sendJson(p);
  };

  route('GET', 'state', async (req, res, url) => {
    const [doc, p] = await Promise.all([cachedDoctor(url.searchParams.get('fresh') === '1'), statePayload()]);
    json(res, 200, { doctor: doc, devices: p.devices, starting: p.starting, errors: p.errors });
  });

  ctx.socket('events', (sock) => {
    eventSocks.add(sock);
    const offDev = watchDevices((list) => { lastDevices = list; broadcast(); });
    const offEmu = emu.watchEmulators(() => broadcast());
    statePayload(lastDevices.length ? lastDevices : undefined).then((p) => sock.sendJson(p)).catch(() => {});
    sock.onClose(() => { eventSocks.delete(sock); offDev(); offEmu(); });
  });

  route('POST', 'emulator/start', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const avd = String(b.avd || '');
    if (!(await listAvds()).includes(avd)) return json(res, 404, { error: `没有这台虚拟设备：${avd}` });
    startErrors.delete(avd);
    let key = `pending:${avd}`;
    progress.set(key, { state: 'starting', avd });
    broadcast();
    emu.startEmulator(avd, {
      coldBoot: !!b.cold, wipe: !!b.wipe,
      onProgress: (p) => {
        if (key !== p.serial) { progress.delete(key); key = p.serial; }
        if (p.state === 'running') progress.delete(key); else progress.set(key, { state: p.state, avd });
        broadcast();
      },
    }).then(() => { progress.delete(key); broadcast(); })
      .catch((e) => { progress.delete(key); startErrors.set(avd, { error: String(e?.message || e), at: Date.now() }); broadcast(); });
    json(res, 202, { ok: true });
  });

  route('POST', 'emulator/stop', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const serial = serialOf(res, b.serial); if (!serial) return;
    json(res, 200, await emu.stopEmulator(serial, { reason: 'user' }));
    broadcast();
  });

  route('GET', 'screenshot', async (req, res, url) => {
    const serial = serialOf(res, url.searchParams.get('serial')); if (!serial) return;
    const png = await execOut(serial, ['screencap', '-p'], { timeout: 20_000 });
    emu.touch(serial);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': png.length });
    res.end(png);
  });

  // ── 画面流 ──────────────────────────────────────────
  ctx.socket('stream', (sock, who, query) => {
    const serial = String(query.get('serial') || '');
    if (!validSerial(serial)) { sock.close(1008, 'bad serial'); return; }
    const mirror = mirrorOf(serial);
    const off = mirror.addViewer({
      get bufferedAmount() { return sock.bufferedAmount; },
      sendJson: (o) => sock.sendJson(o),
      sendBinary: (b) => sock.sendBinary(b),
    });
    // 归一化坐标（0..1）→ 当前视频帧像素：旋转瞬间页面拿的宽高可能还是旧的，换算放在这边更稳
    const px = (v, n) => Math.max(0, Math.min(n - 1, Number(v) * n));
    sock.onJson(async (m) => {
      const W = mirror.width; const H = mirror.height;
      // 人手操作的时间：agent 下一步会被告知「用户刚动过这台设备」（接管）
      if (['touch', 'scroll', 'key', 'press', 'text', 'paste', 'rotate'].includes(m.t)) mirror.lastHuman = Date.now();
      switch (m.t) {
        case 'touch': {
          if (!W) return;
          const id = Number.isInteger(m.id) && m.id >= 0 && m.id < 10 ? BigInt(m.id) : POINTER_GENERIC_FINGER;
          mirror.touch([0, 1, 2].includes(m.a) ? m.a : 2, id, px(m.x, W), px(m.y, H), m.p ?? 1);
          break;
        }
        case 'scroll': if (W) mirror.scroll(px(m.x, W), px(m.y, H), Number(m.dx) || 0, Number(m.dy) || 0); break;
        case 'key': if (Number.isInteger(m.code)) mirror.key(m.a === 1 ? 1 : 0, m.code, Number(m.meta) | 0); break;
        case 'press': if (Number.isInteger(m.code)) mirror.press(m.code, Number(m.meta) | 0); break;
        case 'text': {
          const s = String(m.s || '').slice(0, 4000);
          if (!s) return;
          // 纯 ASCII 可见字符直接注入（像打字）；中文、emoji 走剪贴板粘贴
          if (/^[\x20-\x7e]+$/.test(s) && s.length <= 300) mirror.text(s);
          else await mirror.setClipboard(s, true);
          break;
        }
        case 'paste': await mirror.setClipboard(String(m.s || '').slice(0, 200_000), true); break;
        case 'clip': await mirror.setClipboard(String(m.s || '').slice(0, 200_000), false); break;
        case 'rotate': mirror.rotate(); break;
        case 'notif': mirror.expandNotifications(); break;
        case 'collapse': mirror.collapsePanels(); break;
        case 'keyframe': mirror.requestKeyFrame(); break;
        default: break;
      }
    });
    sock.onClose(() => off());
  });

  // ── Logcat ────────────────────────────────────────────
  let logcats = 0;
  ctx.socket('logcat', async (sock, who, query) => {
    const serial = String(query.get('serial') || '');
    if (!validSerial(serial)) { sock.close(1008, 'bad serial'); return; }
    if (logcats >= MAX_LOGCAT) { sock.sendJson({ type: 'error', error: 'logcat 流太多了，关掉几个再开' }); sock.close(1013, 'too many'); return; }
    const level = /^[VDIWEF]$/.test(query.get('level') || '') ? query.get('level') : 'V';
    const pkg = query.get('pkg') || '';
    const args = ['-s', serial, 'logcat', '-v', 'threadtime', '-T', '300'];
    let note = '';
    if (pkg) {
      if (!PKG.test(pkg)) { sock.sendJson({ type: 'error', error: '包名不合法' }); sock.close(1008, 'bad pkg'); return; }
      const pid = (await shell(serial, `pidof ${shq(pkg)}`, { timeout: 8000 }).catch(() => '')).trim().split(/\s+/)[0];
      if (/^\d+$/.test(pid || '')) args.push(`--pid=${pid}`); else note = `${pkg} 没在运行`;
    }
    args.push(`*:${level}`);
    if (!sock.open) return;
    logcats++;
    sock.sendJson({ type: 'hello', note });
    const child = spawn(requireTool('adb'), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = ''; let batch = []; let flushT = null;
    const flush = () => { flushT = null; if (batch.length) { sock.sendJson({ type: 'lines', lines: batch }); batch = []; } };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (line && !line.startsWith('--------- beginning of')) batch.push(parseLogLine(line));
      }
      // 页面跟不上就先攒着、别再往 socket 里塞
      if (sock.bufferedAmount > 4e6) return;
      if (batch.length > 400) flush(); else if (!flushT) flushT = setTimeout(flush, 120);
    });
    child.on('exit', () => { flush(); sock.sendJson({ type: 'end' }); sock.close(1000, 'end'); });
    let closed = false;
    sock.onClose(() => { if (closed) return; closed = true; logcats--; clearTimeout(flushT); if (child.exitCode == null) killTree(child.pid); });
  });

  route('POST', 'logcat/clear', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const serial = serialOf(res, b.serial); if (!serial) return;
    const r = await adb(serial, ['logcat', '-c'], { timeout: 10_000 });
    ok(r) ? json(res, 200, { ok: true }) : json(res, 500, { error: brief(r) });
  });

  // ── 分块上传（宿主代发单次请求体 ≤ 20 MB，apk 动辄上百 MB）────────────────
  const uploadDir = () => { const d = path.join(ctx.dataDir, 'uploads'); mkdirSync(d, { recursive: true }); return d; };
  const uploads = new Map();   // id → { file, next, done, at }
  const sweepUploads = () => {
    for (const [id, u] of uploads) if (Date.now() - u.at > 3600_000) { rmSync(u.file, { force: true }); uploads.delete(id); }
  };
  ctx.onDispose(() => { for (const u of uploads.values()) rmSync(u.file, { force: true }); uploads.clear(); });
  // 上次没清掉的残留（bridge 中途重启）
  try { for (const n of readdirSync(uploadDir())) rmSync(path.join(uploadDir(), n), { force: true }); } catch {}
  route('POST', 'upload', async (req, res, url) => {
    sweepUploads();
    const id = String(url.searchParams.get('id') || '');
    const seq = Number(url.searchParams.get('seq'));
    if (!UPLOAD_ID.test(id) || !Number.isInteger(seq) || seq < 0) return json(res, 400, { error: '分块参数不对' });
    let u = uploads.get(id);
    if (seq === 0 && !u) { u = { file: path.join(uploadDir(), id), next: 0, done: false, at: Date.now() }; uploads.set(id, u); rmSync(u.file, { force: true }); }
    if (!u || u.done || seq !== u.next) return json(res, 409, { error: '分块顺序不对，从头再传' });
    const size = await appendBody(req, u.file, CHUNK_MAX);
    u.next++; u.at = Date.now();
    if (url.searchParams.get('last') === '1') u.done = true;
    json(res, 200, { ok: true, size, done: u.done });
  });
  const takeUpload = (id) => {
    const u = uploads.get(String(id || ''));
    if (!u || !u.done) return null;
    uploads.delete(String(id));
    return u.file;
  };

  route('POST', 'install', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const serial = serialOf(res, b.serial); if (!serial) return;
    const name = String(b.name || 'app.apk');
    if (!/\.apk$/i.test(name)) return json(res, 400, { error: '只认 .apk 文件' });
    const file = takeUpload(b.upload);
    if (!file) return json(res, 400, { error: '没找到传上来的文件，重新上传' });
    const apk = file + '.apk';
    try {
      await fsp.rename(file, apk);
      const r = await runAndroidAction({ action: 'install', serial, path: apk }, { owner: 'panel', ws: path.dirname(apk) });
      r.isError ? json(res, 400, { error: textOf(r) }) : json(res, 200, { ok: true, text: textOf(r).replace(path.basename(apk), name) });
    } finally { rmSync(apk, { force: true }); rmSync(file, { force: true }); }
  });

  // ── 应用 ──────────────────────────────────────────────
  route('GET', 'apps', async (req, res, url) => {
    const serial = serialOf(res, url.searchParams.get('serial')); if (!serial) return;
    const out = await shell(serial, 'pm list packages -3 -f', { timeout: 20_000 });
    const apps = out.split(/\r?\n/).map((l) => /^package:(.+)=([\w.]+)$/.exec(l.trim())).filter(Boolean).map((m) => ({ pkg: m[2], path: m[1] }))
      .sort((a, b) => a.pkg.localeCompare(b.pkg));
    json(res, 200, { apps });
  });
  route('POST', 'app', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const serial = serialOf(res, b.serial); if (!serial) return;
    const op = { launch: 'launch', stop: 'stop_app', clear: 'clear_data', uninstall: 'uninstall' }[b.op];
    if (!op || !PKG.test(String(b.pkg || ''))) return json(res, 400, { error: '参数不对' });
    const r = await runAndroidAction({ action: op, serial, package: b.pkg, observe: false }, { owner: 'panel' });
    r.isError ? json(res, 400, { error: textOf(r) }) : json(res, 200, { ok: true, text: textOf(r) });
  });

  // ── 文件 ──────────────────────────────────────────────
  const devPath = (p) => {
    const s = String(p || '').trim() || '/sdcard';
    if (!s.startsWith('/') || s.split('/').includes('..') || /[\0\r\n]/.test(s)) return '';
    return s.replace(/\/+$/, '') || '/';
  };
  route('GET', 'files', async (req, res, url) => {
    const serial = serialOf(res, url.searchParams.get('serial')); if (!serial) return;
    const p = devPath(url.searchParams.get('path')); if (!p) return json(res, 400, { error: '路径不合法' });
    const out = await shell(serial, `ls -la ${shq(p + (p === '/' ? '' : '/'))} 2>&1`, { timeout: 15_000 });
    if (/Permission denied|No such file/.test(out) && !/^total/m.test(out)) return json(res, 400, { error: out.trim().split('\n').pop() });
    json(res, 200, { path: p, entries: parseLs(out) });
  });
  route('GET', 'file', async (req, res, url) => {
    const serial = serialOf(res, url.searchParams.get('serial')); if (!serial) return;
    const p = devPath(url.searchParams.get('path')); if (!p || p === '/') return json(res, 400, { error: '路径不合法' });
    const tmp = path.join(os.tmpdir(), `bridge-android-pull-${randomBytes(6).toString('hex')}`);
    const r = await adb(serial, ['pull', p, tmp], { timeout: 300_000 });
    if (!ok(r)) { rmSync(tmp, { force: true }); return json(res, 400, { error: brief(r) }); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': statSync(tmp).size, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(p))}` });
    const s = createReadStream(tmp);
    s.pipe(res);
    s.on('close', () => rmSync(tmp, { force: true }));
  });
  route('POST', 'file/push', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const serial = serialOf(res, b.serial); if (!serial) return;
    const dir = devPath(b.dir || '/sdcard/Download');
    const name = String(b.name || '').replace(/[/\\\0\r\n]/g, '_').trim();
    if (!dir || !name || name === '.' || name === '..') return json(res, 400, { error: '路径不合法' });
    const file = takeUpload(b.upload);
    if (!file) return json(res, 400, { error: '没找到传上来的文件，重新上传' });
    try {
      const target = `${dir === '/' ? '' : dir}/${name}`;
      const r = await adb(serial, ['push', file, target], { timeout: 600_000 });
      if (!ok(r)) return json(res, 400, { error: brief(r) });
      // 让相册 / 文件应用马上看得到
      await shell(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${shq('file://' + target)} >/dev/null 2>&1`, { timeout: 10_000 }).catch(() => {});
      json(res, 200, { ok: true, path: target });
    } finally { rmSync(file, { force: true }); }
  });

  // ── 扩展控制 / 快照 / 控件树 ──────────────────────────
  route('POST', 'emu', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const serial = serialOf(res, b.serial); if (!serial) return;
    const r = await runAndroidAction({ ...b, action: 'emu', serial, observe: false }, { owner: 'panel' });
    r.isError ? json(res, 400, { error: textOf(r) }) : json(res, 200, { ok: true, text: textOf(r) });
  });
  route('GET', 'snapshots', async (req, res, url) => {
    const serial = serialOf(res, url.searchParams.get('serial')); if (!serial) return;
    if (!serial.startsWith('emulator-')) return json(res, 200, { snapshots: [], unsupported: true });
    const r = await adb(serial, ['emu', 'avd', 'snapshot', 'list'], { timeout: 20_000 });
    ok(r) ? json(res, 200, { snapshots: parseSnapshots(r.stdout) }) : json(res, 500, { error: brief(r) });
  });
  route('POST', 'snapshot', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const serial = serialOf(res, b.serial); if (!serial) return;
    if (!['save', 'load', 'delete'].includes(b.op)) return json(res, 400, { error: 'op 不对' });
    const r = await runAndroidAction({ action: 'snapshot', serial, op: b.op, name: b.name }, { owner: 'panel' });
    r.isError ? json(res, 400, { error: textOf(r) }) : json(res, 200, { ok: true, text: textOf(r) });
  });
  route('GET', 'ui', async (req, res, url) => {
    const serial = serialOf(res, url.searchParams.get('serial')); if (!serial) return;
    const t = await getElements(serial, { full: url.searchParams.get('full') === '1' });
    json(res, 200, { elements: t.elements, via: t.via, note: t.note });
  });

  // ── 虚拟设备管理 ──────────────────────────────────────
  let deviceDefs = null;
  route('GET', 'avd-options', async (req, res) => {
    if (!deviceDefs) {
      const bin = toolPath('avdmanager');
      const r = bin ? await run(bin, ['list', 'device', '-c'], { timeout: 60_000 }) : { code: 1, stdout: '' };
      deviceDefs = ok(r) ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[\w.-]+$/.test(s)) : [];
    }
    const preferred = ['pixel_9', 'pixel_8', 'pixel_8_pro', 'pixel_9_pro_fold', 'pixel_tablet', 'medium_phone', 'medium_tablet', 'small_phone'];
    const devices = [...preferred.filter((d) => deviceDefs.includes(d)), ...deviceDefs.filter((d) => !preferred.includes(d) && /^pixel|phone|tablet|foldable/.test(d))];
    json(res, 200, { devices, images: installedImages(), avds: await listAvds() });
  });
  route('POST', 'avd/create', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const r = await runAndroidAction({ action: 'create_avd', name: b.name, device: b.device, image: b.image }, { owner: 'panel' });
    doctorCache = null;
    r.isError ? json(res, 400, { error: textOf(r) }) : json(res, 200, { ok: true, text: textOf(r) });
  });
  route('POST', 'avd/delete', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const name = String(b.name || '');
    if (!AVD.test(name)) return json(res, 400, { error: '名字不合法' });
    if (emu.snapshot().some((r) => r.avd === name)) return json(res, 409, { error: '这台虚拟设备正开着，先关机' });
    const bin = toolPath('avdmanager'); if (!bin) return json(res, 400, { error: '没装 cmdline-tools' });
    const r = await run(bin, ['delete', 'avd', '-n', name], { timeout: 60_000 });
    doctorCache = null;
    ok(r) ? json(res, 200, { ok: true }) : json(res, 400, { error: brief(r) });
  });

  // ── 无线调试 ──────────────────────────────────────────
  const HOST = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9][A-Za-z0-9.-]{0,252})$/;
  const portOk = (p) => Number.isInteger(Number(p)) && Number(p) > 0 && Number(p) < 65536;
  route('POST', 'pair', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    if (!HOST.test(String(b.host || '')) || !portOk(b.port) || !/^\d{6}$/.test(String(b.code || ''))) return json(res, 400, { error: '地址、端口或配对码不对（配对码是 6 位数字）' });
    const r = await adb('', ['pair', `${b.host}:${Number(b.port)}`, String(b.code)], { timeout: 30_000 });
    const out = (r.stdout + '\n' + r.stderr).trim();
    /Successfully paired/i.test(out) ? json(res, 200, { ok: true, text: out.split('\n')[0] }) : json(res, 400, { error: out.slice(0, 300) || '配对失败' });
  });
  route('POST', 'connect', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    if (!HOST.test(String(b.host || '')) || !portOk(b.port)) return json(res, 400, { error: '地址或端口不对' });
    const r = await adb('', ['connect', `${b.host}:${Number(b.port)}`], { timeout: 30_000 });
    const out = (r.stdout + '\n' + r.stderr).trim();
    /connected to/i.test(out) && !/failed|unable/i.test(out) ? json(res, 200, { ok: true, serial: `${b.host}:${Number(b.port)}`, text: out }) : json(res, 400, { error: out.slice(0, 300) || '连接失败' });
  });
  route('POST', 'disconnect', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const serial = serialOf(res, b.serial); if (!serial) return;
    if (!serial.includes(':')) return json(res, 400, { error: '只能断开无线连接的设备' });
    const r = await adb('', ['disconnect', serial], { timeout: 15_000 });
    ok(r) ? json(res, 200, { ok: true }) : json(res, 400, { error: brief(r) });
  });

  // ── 录屏 ──────────────────────────────────────────────
  const recFiles = new Map();   // id → { file, name, at }
  const sweepRecs = () => { for (const [id, f] of recFiles) if (Date.now() - f.at > 3600_000) { rmSync(f.file, { force: true }); recFiles.delete(id); } };
  ctx.onDispose(() => { for (const f of recFiles.values()) rmSync(f.file, { force: true }); recFiles.clear(); });
  route('GET', 'record', async (req, res, url) => {
    const serial = serialOf(res, url.searchParams.get('serial')); if (!serial) return;
    json(res, 200, { recording: recordingOf(serial) });
  });
  route('POST', 'record/start', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const serial = serialOf(res, b.serial); if (!serial) return;
    json(res, 200, { ok: true, ...startRecord(serial) });
  });
  route('POST', 'record/stop', async (req, res) => {
    const b = await body(req, res); if (!b) return;
    const serial = serialOf(res, b.serial); if (!serial) return;
    sweepRecs();
    const id = randomBytes(12).toString('base64url');
    const name = `android-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`;
    const dest = path.join(os.tmpdir(), `bridge-android-rec-${id}.mp4`);
    try {
      const r = await stopRecord(serial, dest);
      recFiles.set(id, { file: dest, name, at: Date.now() });
      json(res, 200, { ok: true, url: `record/file?id=${id}`, name, size: r.size, seconds: r.seconds });
    } catch (e) { rmSync(dest, { force: true }); throw e; }
  });
  route('GET', 'record/file', async (req, res, url) => {
    const f = recFiles.get(String(url.searchParams.get('id') || ''));
    if (!f || !existsSync(f.file)) return json(res, 404, { error: '录屏文件已过期' });
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': statSync(f.file).size, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${f.name}"` });
    createReadStream(f.file).pipe(res);
  });

  // ── 工作区卡片（Claude / ChatGPT / Antigravity / dimensio 的工作区都有）────────────
  ctx.ui.workbench({ id: 'device', title: '安卓', icon: 'android', page: 'web/index.html', hosts: 'all' });

  // ── 给 agent 的工具：Claude 看到 mcp__android__android，dimensio / Antigravity / Codex 经插件工具通道 ──
  const toolsOn = () => ctx.config?.tools !== false;
  const hostTurn = (turn) => toolsOn() && turn?.ctx?.kind === 'admin' && !turn?.ctx?.sandbox && !turn?.snap;
  ctx.tools.add({
    name: 'android', description: ANDROID_DESCRIPTION, access: 'write', who: 'host',
    params: { ...ANDROID_PARAMS, save_to: { type: 'string', desc: '把这次结果里的截图另存成 PNG：相对工作空间；以 / 结尾或是已有目录 = 存进去、自动起名' } },
    agents: ['claude', 'dimensio', 'agy', 'codex'],
    when: hostTurn,
    handler: async (args, turn) => {
      const { save_to: saveTo, ...rest } = args || {};
      const ws = turn?.ctx?.cwd || '';
      const r = await runAndroidAction(rest, { ws, owner: turn?.sessionId || '' });
      return saveTo ? saveShots(r, saveTo, ws) : r;
    },
  });
  ctx.claude.prompt((turn) => (hostTurn(turn) ? NUDGE_CLAUDE : ''), { agents: ['claude'] });
  ctx.claude.prompt((turn) => (hostTurn(turn) ? NUDGE_PEER : ''), { agents: ['dimensio', 'agy', 'codex'] });
  // 子 agent「安卓操作员」（多步界面操作在它自己的上下文里跑，截图不堆进主对话）
  ctx.claude.options((turn) => (hostTurn(turn) ? { agents: { 'android-operator': operatorAgent() } } : {}));

  ctx.manual('manual');
}

// ── 小工具 ───────────────────────────────────────────────────────────────
function appendBody(req, file, max) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(file, { flags: 'a' });
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > max) { req.destroy(); out.destroy(); reject(Object.assign(new Error('分块太大'), { status: 413 })); } });
    req.pipe(out);
    out.on('finish', () => resolve(size));
    out.on('error', reject);
    req.on('error', reject);
  });
}

// 截图另存进工作空间（工具参数 save_to：相对工作空间；以 / 结尾或是已有目录 = 存进去自动起名）
async function saveShots(result, saveTo, ws) {
  const imgs = (result.content || []).filter((c) => c.type === 'image' && c.data);
  if (!imgs.length) return result;
  const raw = String(saveTo).trim();
  const abs = path.resolve(ws || process.cwd(), raw);
  const asDir = /[\\/]$/.test(raw) || (existsSync(abs) && statSync(abs).isDirectory());
  const saved = [];
  for (let i = 0; i < imgs.length; i++) {
    let target = asDir ? path.join(abs, `android-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}${imgs.length > 1 ? '-' + (i + 1) : ''}.png`)
      : imgs.length > 1 ? abs.replace(/(\.png)?$/i, `-${i + 1}.png`) : (/\.png$/i.test(abs) ? abs : abs + '.png');
    mkdirSync(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, Buffer.from(imgs[i].data, 'base64'));
    saved.push(target);
  }
  return { ...result, content: [...result.content, { type: 'text', text: `截图已存：${saved.join('、')}` }] };
}

// ls -la 一行 → 条目（toybox 格式：权限 链接数 属主 组 大小 日期 时间 名字）
export function parseLs(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([dlcbsp-][rwxsStT-]{9}\S*)\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    let name = m[5]; let link = '';
    if (m[1][0] === 'l') { const i = name.indexOf(' -> '); if (i >= 0) { link = name.slice(i + 4); name = name.slice(0, i); } }
    if (name === '.' || name === '..') continue;
    out.push({ name, dir: m[1][0] === 'd' || (m[1][0] === 'l' && !/\.\w{1,5}$/.test(link)), link, size: Number(m[2]), mtime: `${m[3]} ${m[4]}`, perm: m[1] });
  }
  return out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

// 「emu avd snapshot list」的表格 → [{ name, size, date }]
export function parseSnapshots(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\S+\s+(\S+)\s+(\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(line.trim());
    if (m && m[1] !== 'TAG') out.push({ name: m[1], size: m[2], date: m[3] });
  }
  return out;
}

// logcat threadtime 一行 → { t, pid, tid, lvl, tag, msg }
export function parseLogLine(line) {
  const m = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.*?)\s*:\s?(.*)$/.exec(line);
  return m ? { t: m[1], pid: +m[2], tid: +m[3], lvl: m[4], tag: m[5], msg: m[6] } : { t: '', pid: 0, tid: 0, lvl: 'I', tag: '', msg: line };
}
