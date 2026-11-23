// adb：设备表与常用命令。
//
// 用 SDK 自带的 adb.exe，连本机 5037 上的 adb server（第一次调用时 adb 会自己把 server 拉起来）。
// adb server 是全机共享的（Android Studio、别的工具、别的会话都在用）——这里【绝不】kill-server。
// 设备表靠轮询 `adb devices -l`（有人关心时每 2 秒一次，约 20ms）：比常驻 track-devices 进程好收尸。

import { requireTool, run, ok, brief } from './sdk.mjs';

const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;
export const validSerial = (s) => SERIAL.test(String(s || ''));

export function assertSerial(serial) {
  if (!validSerial(serial)) throw Object.assign(new Error(`设备序列号不合法：${serial}`), { status: 400 });
  return serial;
}

/** adb 原始调用（serial 为空 = 不指定设备）。 */
export function adb(serial, args, opts = {}) {
  const bin = requireTool('adb');
  return run(bin, serial ? ['-s', assertSerial(serial), ...args] : args, opts);
}

/** adb shell，失败抛错。cmd 是一整条设备端命令（调用方负责转义），或参数数组（这里逐个加单引号）。 */
export async function shell(serial, cmd, opts = {}) {
  const line = Array.isArray(cmd) ? cmd.map(shq).join(' ') : String(cmd);
  const r = await adb(serial, ['shell', line], opts);
  if (!ok(r)) throw Object.assign(new Error(brief(r) || `adb shell 失败（${r.code}）`), { code: 'ADB_SHELL' });
  return r.stdout;
}

/** 设备端 sh 的单引号转义。 */
export function shq(v) {
  const s = String(v);
  if (s && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function execOut(serial, args, opts = {}) {
  const r = await adb(serial, ['exec-out', ...args], { encoding: 'buffer', ...opts });
  if (!ok(r)) throw Object.assign(new Error(brief(r) || 'adb exec-out 失败'), { code: 'ADB_EXEC' });
  return r.stdout;
}

export function parseDevices(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('List of devices') && !l.startsWith('*'))
    .map((line) => {
      const parts = line.split(/\s+/);
      const attrs = {};
      for (const p of parts.slice(2)) { const i = p.indexOf(':'); if (i > 0) attrs[p.slice(0, i)] = p.slice(i + 1); }
      const serial = parts[0] || '';
      return {
        serial,
        state: parts[1] || 'unknown',                // device | offline | unauthorized | ...
        kind: serial.startsWith('emulator-') ? 'emulator' : 'device',
        model: (attrs.model || '').replace(/_/g, ' '),
        product: attrs.product || '',
        transportId: attrs.transport_id || '',
      };
    })
    .filter((d) => validSerial(d.serial));
}

export async function listDevices() {
  const r = await adb('', ['devices', '-l'], { timeout: 15_000 });
  if (!ok(r)) throw new Error(brief(r) || 'adb devices 失败');
  return parseDevices(r.stdout);
}

export async function getprop(serial, key) {
  return (await shell(serial, ['getprop', key], { timeout: 10_000 })).trim();
}

export async function bootCompleted(serial) {
  try { return (await getprop(serial, 'sys.boot_completed')) === '1'; } catch { return false; }
}

/** 模拟器的 AVD 名（adb emu avd name；真机回 ''）。 */
export async function avdNameOf(serial) {
  if (!String(serial).startsWith('emulator-')) return '';
  const r = await adb(serial, ['emu', 'avd', 'name'], { timeout: 5_000 });
  if (!ok(r)) return '';
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s && s !== 'OK') || '';
}

/** 本机端口 → 设备上的 localabstract（scrcpy 用）。local 传 'tcp:0' 让 adb 挑端口，回实际端口号。 */
export async function forward(serial, local, remote) {
  const r = await adb(serial, ['forward', local, remote], { timeout: 10_000 });
  if (!ok(r)) throw new Error(brief(r) || 'adb forward 失败');
  const port = parseInt(r.stdout.trim(), 10);
  return Number.isFinite(port) && port > 0 ? port : parseInt(String(local).replace(/^tcp:/, ''), 10);
}

export async function forwardRemove(serial, local) {
  await adb(serial, ['forward', '--remove', local], { timeout: 10_000 });
}

export async function push(serial, local, remote, opts = {}) {
  const r = await adb(serial, ['push', local, remote], { timeout: 120_000, ...opts });
  if (!ok(r)) throw new Error(brief(r) || 'adb push 失败');
  return r.stdout.trim();
}

// ── 设备表（有人订阅时轮询）──────────────────────────────────────────────
const subs = new Set();
let timer = null;
let last = [];
let lastSig = '';

async function poll() {
  let list;
  try { list = await listDevices(); } catch { list = []; }
  const sig = JSON.stringify(list);
  last = list;
  if (sig !== lastSig) { lastSig = sig; for (const fn of subs) { try { fn(list); } catch {} } }
}

/** 订阅设备表变化（立即回一次当前值）。返回退订函数；没人订阅时停止轮询。 */
export function watchDevices(fn) {
  subs.add(fn);
  if (!timer) {
    poll();
    timer = setInterval(poll, 2000);
    timer.unref?.();
  } else {
    queueMicrotask(() => { try { fn(last); } catch {} });
  }
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) { clearInterval(timer); timer = null; lastSig = ''; }
  };
}

export const knownDevices = () => last;
