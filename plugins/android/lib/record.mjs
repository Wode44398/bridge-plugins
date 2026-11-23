// 录屏：设备端 screenrecord（最长 3 分钟，系统限制），停止时发 SIGINT 让它把 mp4 收尾，再拉回电脑。
// 一台设备同时只录一段。adb shell 进程是自己 spawn 的，停不下来才 taskkill 自己的 PID。

import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { requireTool, killTree } from './sdk.mjs';
import { adb, shell, assertSerial } from './adb.mjs';
import { touch } from './emulators.mjs';

const recs = new Map();   // serial → { proc, remote, startedAt, done }
const LIMIT_S = 180;

export const recordingOf = (serial) => {
  const r = recs.get(serial);
  return r ? { startedAt: r.startedAt, seconds: Math.round((Date.now() - r.startedAt) / 1000), done: r.done, limit: LIMIT_S } : null;
};

export function startRecord(serial) {
  assertSerial(serial);
  if (recs.has(serial)) throw Object.assign(new Error('这台设备正在录屏'), { status: 409 });
  const remote = `/sdcard/bridge-rec-${Date.now()}.mp4`;
  const proc = spawn(requireTool('adb'), ['-s', serial, 'shell', `screenrecord --bit-rate 8000000 --time-limit ${LIMIT_S} ${remote}`],
    { windowsHide: true, stdio: 'ignore' });
  const rec = { proc, remote, startedAt: Date.now(), done: false };
  proc.on('exit', () => { rec.done = true; });
  proc.on('error', () => { rec.done = true; });
  recs.set(serial, rec);
  touch(serial);
  return { remote, limit: LIMIT_S };
}

/** 停止并拉回到 dest（本机文件路径）。回 { file, size, seconds }。 */
export async function stopRecord(serial, dest) {
  const rec = recs.get(serial);
  if (!rec) throw Object.assign(new Error('这台设备没有在录屏'), { status: 409 });
  try {
    if (!rec.done) await shell(serial, 'pkill -INT screenrecord; true', { timeout: 8000 }).catch(() => {});
    const until = Date.now() + 10_000;
    while (!rec.done && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    if (!rec.done) killTree(rec.proc.pid);
    await new Promise((r) => setTimeout(r, 600));   // 设备上写完 moov 尾
    const r = await adb(serial, ['pull', rec.remote, dest], { timeout: 120_000 });
    if (r.code !== 0) throw new Error('拉回录屏文件失败：' + (r.stderr || r.stdout).trim().slice(0, 300));
    return { file: dest, size: statSync(dest).size, seconds: Math.round((Date.now() - rec.startedAt) / 1000) };
  } finally {
    recs.delete(serial);
    shell(serial, `rm -f ${rec.remote}`, { timeout: 8000 }).catch(() => {});
  }
}
