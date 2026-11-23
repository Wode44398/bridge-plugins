// 模拟器进程：启动、等开机、停止、bridge 重启后认领、空闲自动关、心跳。
//
// 纪律（见 design/安卓模拟器方案.md 4.6）：
//   · 不在主机桌面弹窗口（-no-window），声音不从主机喇叭出来（-no-audio）。
//   · 只停自己记下的 PID：进程表落盘 <数据根>/android/emulators.json；停止顺序 adb emu kill → 等 15 秒 → taskkill /T 自己的 PID。
//   · bridge 重启不关模拟器（自更新重启很频繁），重启后按进程表认领：PID 活着、是模拟器进程、adb 里 AVD 名对得上才认。
//   · 双保险：启动带 -idle-grpc-timeout，bridge 每分钟发一次 gRPC 心跳；bridge 没了，模拟器自己在超时后退出。
//   · 没人看、agent 也没动它超过设定时长 → 关机（默认会存 quickboot 快照，下次秒开）。

import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http2 from 'node:http2';
import { promises as fsp, readFileSync, readdirSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { config, dataDir } from './config.mjs';
import { requireTool, killTree, listAvds, launchDetached } from './sdk.mjs';
import { adb, listDevices, bootCompleted, avdNameOf } from './adb.mjs';

// 插件数据目录（<数据根>/plugin-data/android/）：进程表、模拟器日志
const DIR_ = () => dataDir() || path.join(os.tmpdir(), 'bridge-android');
const TABLE_ = () => path.join(DIR_(), 'emulators.json');
const AVD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const HEARTBEAT_MS = 60_000;

const cfg = () => config();
const idleMinutes = () => { const n = Number(cfg().idleMinutes); return Number.isFinite(n) && n >= 0 ? n : 30; };
const maxRunning = () => { const n = Number(cfg().maxEmulators); return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 2; };

/** serial → { serial, avd, pid, consolePort, grpcPort, startedAt, state, lastActive, error? } */
const table = new Map();
const subs = new Set();
let loaded = false;
let ticker = null;

function emit() {
  const list = snapshot();
  for (const fn of subs) { try { fn(list); } catch {} }
}
export function watchEmulators(fn) { subs.add(fn); return () => subs.delete(fn); }
export const snapshot = () => [...table.values()].map(({ serial, avd, pid, startedAt, state, error, lastActive }) => ({ serial, avd, pid, startedAt, state, error: error || '', lastActive }));
export const ownEmulator = (serial) => table.get(serial) || null;

async function save() {
  mkdirSync(DIR_(), { recursive: true });
  const rows = [...table.values()].filter((r) => r.pid && r.state !== 'stopped')
    .map(({ serial, avd, pid, qemuPid, consolePort, grpcPort, startedAt }) => ({ serial, avd, pid, qemuPid: qemuPid || 0, consolePort, grpcPort, startedAt }));
  const tmp = TABLE_() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify({ v: 1, emulators: rows }, null, 2));
  await fsp.rename(tmp, TABLE_());
}

// ── 进程判定 ───────────────────────────────────────────────────────────────
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** PID 对应的可执行文件名（Windows：tasklist；别处：ps）。PID 被复用成别的程序时据此识别。 */
function imageOf(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 8000 }, (err, out) => {
        const m = /^"([^"]+)"/m.exec(String(out || ''));
        resolve(err || !m ? '' : m[1].toLowerCase());
      });
    } else {
      execFile('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 8000 }, (err, out) => resolve(err ? '' : String(out).trim().toLowerCase()));
    }
  });
}
const looksLikeEmulator = (img) => /^(emulator|qemu-system)/.test(img);

// ── 端口 ───────────────────────────────────────────────────────────────────
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

async function pickConsolePort(taken) {
  for (let p = 5554; p <= 5682; p += 2) {
    if (taken.has(`emulator-${p}`)) continue;
    if (await portFree(p) && await portFree(p + 1)) return p;
  }
  throw new Error('没有空闲的模拟器端口（5554–5683 都被占了）');
}

async function pickGrpcPort() {
  const used = new Set([...table.values()].map((r) => r.grpcPort));
  for (let p = 8554; p < 8654; p++) if (!used.has(p) && await portFree(p)) return p;
  throw new Error('没有空闲的 gRPC 端口（8554–8653）');
}

// ── gRPC 心跳（node:http2 直接发一次一元调用，不引 grpc 库）──────────────────
// 每台模拟器启动时把自己的 gRPC 端口与令牌写进登记文件 %TEMP%\avd\running\pid_<qemu 进程号>.ini
//（Android Studio 也是读这里找到正在跑的模拟器）。按 grpc.port 对上是哪一台。
export function runningRegistry() {
  const dirs = [path.join(os.tmpdir(), 'avd', 'running'), path.join(process.env.LOCALAPPDATA || '', 'Temp', 'avd', 'running')];
  const out = [];
  const seen = new Set();
  for (const d of dirs) {
    let names = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/^pid_\d+\.ini$/.test(n) || seen.has(n)) continue;
      seen.add(n);
      try {
        const kv = {};
        for (const line of readFileSync(path.join(d, n), 'utf8').split(/\r?\n/)) {
          const i = line.indexOf('=');
          if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        out.push({ pid: parseInt(n.slice(4), 10), serialPort: parseInt(kv['port.serial'], 10), grpcPort: parseInt(kv['grpc.port'], 10), token: kv['grpc.token'] || '', avd: kv['avd.name'] || '' });
      } catch { /* 正在写 */ }
    }
  }
  return out;
}

function grpcToken(port) {
  return runningRegistry().find((r) => r.grpcPort === port)?.token || '';
}

/** 调一次 EmulatorController/getStatus，只看成功与否。 */
export function grpcPing(port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const end = (v) => { if (done) return; done = true; try { client.close(); } catch {} resolve(v); };
    const client = http2.connect(`http://127.0.0.1:${port}`);
    client.on('error', () => end(false));
    const t = setTimeout(() => end(false), timeoutMs);
    const headers = { ':method': 'POST', ':path': '/android.emulation.control.EmulatorController/getStatus', 'content-type': 'application/grpc', te: 'trailers' };
    const token = grpcToken(port);
    if (token) headers.authorization = `Bearer ${token}`;
    const req = client.request(headers);
    let status = null;
    req.on('response', (h) => { if (h['grpc-status'] != null) status = String(h['grpc-status']); });
    req.on('trailers', (h) => { if (h['grpc-status'] != null) status = String(h['grpc-status']); });
    req.on('data', () => {});
    req.on('end', () => { clearTimeout(t); end(status === '0'); });
    req.on('error', () => { clearTimeout(t); end(false); });
    req.end(Buffer.from([0, 0, 0, 0, 0]));   // 未压缩、长度 0 的 google.protobuf.Empty
  });
}

// ── 认领（bridge 重启后）────────────────────────────────────────────────────
export async function load() {
  if (loaded) return;
  loaded = true;
  let rows = [];
  try { rows = JSON.parse(readFileSync(TABLE_(), 'utf8')).emulators || []; } catch { rows = []; }
  let devices = [];
  try { devices = await listDevices(); } catch {}
  for (const r of rows) {
    if (!r || !r.pid || !AVD_NAME.test(String(r.avd || ''))) continue;
    if (!pidAlive(r.pid) || !looksLikeEmulator(await imageOf(r.pid))) continue;
    const online = devices.find((d) => d.serial === r.serial && d.state === 'device');
    if (online && (await avdNameOf(r.serial)) !== r.avd) continue;   // 端口被别的模拟器占了：不是我们的
    table.set(r.serial, { ...r, state: online ? 'running' : 'booting', lastActive: Date.now() });
  }
  await save().catch(() => {});
  startTicker();
  emit();
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(tick, HEARTBEAT_MS);
  ticker.unref?.();
}

let viewersOf = () => 0;
/** 由 scrcpy 会话层告诉这里每台设备此刻有几个观众（空闲判定用）。 */
export function setViewerCounter(fn) { viewersOf = fn; }

/** 有人在用（观众操作、agent 调用）：推迟空闲关机。 */
export function touch(serial) {
  const r = table.get(serial);
  if (r) r.lastActive = Date.now();
}

async function tick() {
  const idleMs = idleMinutes() * 60_000;
  for (const r of [...table.values()]) {
    if (r.state === 'stopping' || r.state === 'starting') continue;
    if (!pidAlive(r.pid)) { table.delete(r.serial); await save().catch(() => {}); emit(); continue; }
    if (r.state === 'running') grpcPing(r.grpcPort).then((alive) => { r.grpcOk = alive; }).catch(() => {});
    if (idleMs > 0 && r.state === 'running' && viewersOf(r.serial) === 0 && Date.now() - (r.lastActive || 0) > idleMs) {
      stopEmulator(r.serial, { reason: 'idle' }).catch(() => {});
    }
  }
  if (!table.size) { clearInterval(ticker); ticker = null; }
}

// ── 启动 / 停止 ─────────────────────────────────────────────────────────────
/**
 * 启动一台 AVD，等到开机完成。onProgress({ state, serial }) 给面板显示进度。
 * 返回 { serial, avd, pid }。
 */
export async function startEmulator(avd, { coldBoot = false, wipe = false, onProgress } = {}) {
  await load();
  if (!AVD_NAME.test(String(avd || ''))) throw Object.assign(new Error(`AVD 名不合法：${avd}`), { status: 400 });
  const avds = await listAvds();
  if (!avds.includes(avd)) throw Object.assign(new Error(`没有这台虚拟设备：${avd}`), { status: 404 });
  const running = [...table.values()].filter((r) => r.state !== 'stopped');
  const dup = running.find((r) => r.avd === avd);
  if (dup) return { serial: dup.serial, avd, pid: dup.pid, already: true };
  if (running.length >= maxRunning()) {
    throw Object.assign(new Error(`同时最多开 ${maxRunning()} 台模拟器（设置里可改），先关掉一台`), { status: 409, code: 'ANDROID_LIMIT' });
  }
  // 别的程序（Android Studio）已经开着这台 AVD：直接用它，不归我们管
  let devices = [];
  try { devices = await listDevices(); } catch {}
  for (const d of devices.filter((x) => x.kind === 'emulator' && x.state === 'device')) {
    if ((await avdNameOf(d.serial)) === avd) return { serial: d.serial, avd, pid: 0, already: true, foreign: true };
  }

  const emu = requireTool('emulator');
  const consolePort = await pickConsolePort(new Set(devices.map((d) => d.serial)));
  const grpcPort = await pickGrpcPort();
  const serial = `emulator-${consolePort}`;
  const idle = Math.max(10, idleMinutes() || 30) * 60 + 600;   // gRPC 自退比我们的空闲关机晚 10 分钟，正常情况下轮不到它
  const args = [
    '-avd', avd, '-port', String(consolePort),
    '-grpc', String(grpcPort), '-grpc-use-token', '-idle-grpc-timeout', String(idle),
    '-no-window', '-no-audio', '-no-boot-anim',
    ...(coldBoot ? ['-no-snapshot-load'] : []),
    ...(wipe ? ['-wipe-data'] : []),   // 清空用户数据重开（界面先确认过）
  ];
  mkdirSync(DIR_(), { recursive: true });
  // 上一次的日志（关机时存快照有没有成功）挪成 .prev.log 留着，排查「启动卡住」要看它
  const logPath0 = path.join(DIR_(), `${avd}.log`);
  try { if (existsSync(logPath0)) renameSync(logPath0, path.join(DIR_(), `${avd}.prev.log`)); } catch {}
  // 脱离 bridge 的进程树启动：别的工具按进程树结束 bridge（taskkill /T）时不会连带关掉模拟器
  const pid = await launchDetached(emu, args, { stdout: logPath0, stderr: path.join(DIR_(), `${avd}.err.log`) });
  const rec = { serial, avd, pid, consolePort, grpcPort, startedAt: Date.now(), state: 'starting', lastActive: Date.now() };
  table.set(serial, rec);
  await save();
  startTicker();
  emit();
  onProgress?.({ state: 'starting', serial });

  const deadline = Date.now() + 240_000;
  try {
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) {
        table.delete(serial); save().catch(() => {}); emit();
        throw new Error(`模拟器进程退出了，没开起来。日志：${logPath0}`);
      }
      const list = await listDevices().catch(() => []);
      const d = list.find((x) => x.serial === serial);
      if (d && d.state === 'device') {
        if (rec.state !== 'booting') { rec.state = 'booting'; emit(); onProgress?.({ state: 'booting', serial }); }
        if (await bootCompleted(serial)) {
          rec.qemuPid = runningRegistry().find((x) => x.grpcPort === grpcPort)?.pid || 0;
          rec.state = 'running'; rec.lastActive = Date.now(); emit();
          save().catch(() => {});
          onProgress?.({ state: 'running', serial });
          return { serial, avd, pid };
        }
      }
      await sleep(1500);
    }
    throw new Error('等模拟器开机超时（4 分钟）');
  } catch (e) {
    await stopEmulator(serial, { reason: 'failed' }).catch(() => {});
    throw e;
  }
}

/** 停一台自己开的模拟器。别人开的（Android Studio）不碰。 */
export async function stopEmulator(serial, { reason = 'user' } = {}) {
  await load();
  const rec = table.get(serial);
  if (!rec) throw Object.assign(new Error('这台模拟器不是 bridge 开的，不去关它'), { status: 409, code: 'ANDROID_FOREIGN' });
  if (rec.state === 'stopping') return { stopped: false, pending: true };
  rec.state = 'stopping'; rec.stopReason = reason; emit();
  // 真正的虚拟机是 qemu 子进程：emulator.exe 先退、qemu 还在存 quickboot 快照。只等启动器就收手，
  // 下次从写了一半的快照启动会卡在 adb「offline」——所以两个都要等到退出（存快照可能要十几秒）。
  const qemuPid = rec.qemuPid || runningRegistry().find((r) => r.grpcPort === rec.grpcPort)?.pid || 0;
  await adb(serial, ['emu', 'kill'], { timeout: 15_000 }).catch(() => {});
  const until = Date.now() + 60_000;
  while (Date.now() < until && (pidAlive(rec.pid) || pidAlive(qemuPid))) await sleep(500);
  if (pidAlive(rec.pid) && looksLikeEmulator(await imageOf(rec.pid))) killTree(rec.pid);
  if (pidAlive(qemuPid) && looksLikeEmulator(await imageOf(qemuPid))) killTree(qemuPid);
  table.delete(serial);
  await save().catch(() => {});
  emit();
  return { stopped: true };
}

/** bridge 关闭时什么都不做（模拟器留着，重启后认领）；这里只停心跳计时器。 */
export function shutdown() { if (ticker) { clearInterval(ticker); ticker = null; } }

export const tablePath = () => TABLE_();
export const logPath = (avd) => path.join(DIR_(), `${avd}.log`);
export const hasLog = (avd) => AVD_NAME.test(String(avd || '')) && existsSync(logPath(avd));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
