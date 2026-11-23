// 安卓 SDK：找 SDK、工具路径、跑命令、体检。
//
// SDK 位置按顺序：功能设置里填的 → ANDROID_HOME → ANDROID_SDK_ROOT → %LOCALAPPDATA%\Android\Sdk（Android Studio 默认）。
// 只用 SDK 里的工具，绝不执行工作区里的 adb / emulator（防有人往项目里放一个假的）。

import path from 'node:path';
import os from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { config } from './config.mjs';

const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';
const BAT = WIN ? '.bat' : '';

export function sdkRoot() {
  const cands = [
    String(config().sdkPath || '').trim(),
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
      : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter(Boolean);
  for (const c of cands) if (existsSync(path.join(c, 'platform-tools')) || existsSync(path.join(c, 'emulator'))) return path.resolve(c);
  return '';
}

/** 工具的绝对路径；没装回 ''。name：adb | emulator | avdmanager | sdkmanager | android */
export function toolPath(name) {
  const root = sdkRoot();
  if (!root) return '';
  const p = {
    adb: path.join(root, 'platform-tools', 'adb' + EXE),
    emulator: path.join(root, 'emulator', 'emulator' + EXE),
    avdmanager: path.join(root, 'cmdline-tools', 'latest', 'bin', 'avdmanager' + BAT),
    sdkmanager: path.join(root, 'cmdline-tools', 'latest', 'bin', 'sdkmanager' + BAT),
    android: path.join(root, 'cmdline-tools', 'latest', 'bin', 'android' + EXE),
  }[name];
  return p && existsSync(p) ? p : '';
}

export function requireTool(name) {
  const p = toolPath(name);
  if (!p) {
    const hint = { adb: 'platform-tools', emulator: 'emulator', avdmanager: 'cmdline-tools', sdkmanager: 'cmdline-tools', android: 'cmdline-tools' }[name];
    throw Object.assign(new Error(`没有找到 Android SDK 的 ${name}（需要 SDK 组件 ${hint}）`), { code: 'ANDROID_TOOL_MISSING', tool: name });
  }
  return p;
}

// Windows 上 .bat 不能直接 spawn（Node 会拒），经 cmd /c 起，参数逐个加引号（调用方已校验过内容）。
function launch(file, args, opts) {
  if (WIN && /\.bat$/i.test(file)) {
    const line = [file, ...args].map((a) => `"${String(a).replace(/"/g, '')}"`).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return spawn(file, args, opts);
}

/**
 * 脱离当前进程树启动一个长命进程，回它的 PID。stdout / stderr 写进文件。
 * Windows：经 PowerShell Start-Process 中转（中转进程随即退出，新进程的父进程号悬空，taskkill /T 顺着 bridge 找不到它）。
 * 参数由调用方保证是安全的词（AVD 名已校验、其余是数字和固定开关）。
 */
export async function launchDetached(file, args, { stdout, stderr }) {
  if (WIN) {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const argLine = args.map((a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '')}"` : String(a))).join(' ');
    // 进程号经临时文件带回来，中转进程的三个标准流一律不接管道：新进程会继承中转进程的句柄，
    // 接了管道就永远等不到它关闭（中转早退了，管道还被模拟器攥着）。
    const pidFile = `${stdout}.pid`;
    try { (await import('node:fs')).rmSync(pidFile, { force: true }); } catch {}
    const cmd = `$p = Start-Process -FilePath ${q(file)} -ArgumentList ${q(argLine)} -WindowStyle Hidden -PassThru`
      + ` -RedirectStandardOutput ${q(stdout)} -RedirectStandardError ${q(stderr)}; Set-Content -LiteralPath ${q(pidFile)} -Value $p.Id -Encoding ascii`;
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { killTree(ps.pid); reject(new Error('启动超时（中转进程 30 秒没返回）')); }, 30_000);
      ps.once('exit', () => { clearTimeout(t); resolve(); });
      ps.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    const { readFileSync, rmSync } = await import('node:fs');
    let pid = 0;
    try { pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10); rmSync(pidFile, { force: true }); } catch {}
    if (!pid) throw new Error('启动失败：没拿到进程号');
    return pid;
  }
  const { openSync, closeSync } = await import('node:fs');
  const o = openSync(stdout, 'a'); const e = openSync(stderr, 'a');
  try {
    const child = spawn(file, args, { detached: true, stdio: ['ignore', o, e] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return child.pid;
  } finally { closeSync(o); closeSync(e); }
}

/** 结束一棵进程树（Windows 上 child.kill 只杀直接子进程）。只用于自己 spawn 的 pid。 */
export function killTree(pid) {
  if (!pid) return;
  if (WIN) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
}

/**
 * 跑一条命令拿结果：{ code, stdout, stderr }（stdout 按 encoding，默认 utf8 字符串；'buffer' 给 Buffer）。
 * 超时整树结束。input 写进 stdin（avdmanager 会问「要不要自定义硬件」）。
 */
export function run(file, args, { timeout = 30_000, input, encoding = 'utf8', env, maxBuffer = 64 << 20 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = launch(file, args, { windowsHide: true, env: env ? { ...process.env, ...env } : process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { resolve({ code: 127, stdout: encoding === 'buffer' ? Buffer.alloc(0) : '', stderr: String(e?.message || e) }); return; }
    const out = []; const err = [];
    let size = 0; let timedOut = false; let done = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeout);
    child.stdout.on('data', (c) => { size += c.length; if (size <= maxBuffer) out.push(c); });
    child.stderr.on('data', (c) => { if (err.length < 256) err.push(c); });
    const finish = (code) => {
      if (done) return; done = true; clearTimeout(timer);
      const so = Buffer.concat(out);
      resolve({
        code: timedOut ? 124 : (code ?? 1),
        stdout: encoding === 'buffer' ? so : so.toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8') + (timedOut ? `\n（超时 ${Math.round(timeout / 1000)} 秒）` : ''),
      });
    };
    child.on('error', (e) => { err.push(Buffer.from(String(e?.message || e))); finish(127); });
    child.on('close', finish);
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

export const ok = (r) => r.code === 0;
export const brief = (r) => (String(r.stderr || '').trim() || String(r.stdout || '').trim()).split(/\r?\n/).slice(-6).join('\n').slice(0, 800);

/** 已装的系统镜像：[{ id: 'system-images;android-35;google_apis_playstore;x86_64', api, tag, abi }] */
export function installedImages() {
  const root = sdkRoot();
  const base = root && path.join(root, 'system-images');
  if (!base || !existsSync(base)) return [];
  const out = [];
  for (const api of safeDir(base)) for (const tag of safeDir(path.join(base, api))) for (const abi of safeDir(path.join(base, api, tag))) {
    if (existsSync(path.join(base, api, tag, abi, 'system.img')) || existsSync(path.join(base, api, tag, abi, 'source.properties'))) {
      out.push({ id: `system-images;${api};${tag};${abi}`, api, tag, abi });
    }
  }
  return out;
}

function safeDir(p) {
  try { return readdirSync(p).filter((n) => { try { return statSync(path.join(p, n)).isDirectory(); } catch { return false; } }); } catch { return []; }
}

/** AVD 列表：emulator -list-avds（会混进 INFO 行，只留像名字的）。 */
export async function listAvds() {
  const emu = toolPath('emulator');
  if (!emu) return [];
  const r = await run(emu, ['-list-avds'], { timeout: 20_000 });
  if (!ok(r)) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_.-]+$/.test(s));
}

let accelCache = null;
/** 硬件加速是否可用（emulator -accel-check，结果缓存：开机后不会变）。 */
export async function accelCheck() {
  if (accelCache) return accelCache;
  const emu = toolPath('emulator');
  if (!emu) return { ok: false, detail: '没装 emulator' };
  const r = await run(emu, ['-accel-check'], { timeout: 20_000 });
  const text = (r.stdout + '\n' + r.stderr).trim();
  const line = text.split(/\r?\n/).find((l) => /usable|installed|not|error|accel/i.test(l) && !/^accel:?$/i.test(l.trim())) || text;
  accelCache = { ok: /\n0\r?\n|^accel:\s*0/m.test(text) || /is installed and usable/i.test(text), detail: line.trim().slice(0, 200) };
  return accelCache;
}

/** 体检：缺什么、有什么。给面板首屏和 agent 的 doctor 用。 */
export async function doctor() {
  const root = sdkRoot();
  const tools = Object.fromEntries(['adb', 'emulator', 'avdmanager', 'sdkmanager', 'android'].map((n) => [n, !!toolPath(n)]));
  const [avds, accel] = await Promise.all([listAvds(), tools.emulator ? accelCheck() : Promise.resolve({ ok: false, detail: '' })]);
  const images = installedImages();
  const missing = [];
  if (!root) missing.push('sdk');
  else {
    if (!tools.adb) missing.push('platform-tools');
    if (!tools.emulator) missing.push('emulator');
    if (!tools.avdmanager) missing.push('cmdline-tools');
    if (!images.length) missing.push('system-image');
    if (!avds.length) missing.push('avd');
    if (tools.emulator && !accel.ok) missing.push('acceleration');
  }
  return { sdk: root, tools, accel, images, avds, missing, ready: !!root && tools.adb && tools.emulator && avds.length > 0 && accel.ok };
}
