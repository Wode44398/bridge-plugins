// 设备表：adb 看到的设备 + AVD 名 + 是不是 bridge 开的 + 观众数。面板接口和 agent 工具共用。

import { listDevices, avdNameOf } from './adb.mjs';
import * as emu from './emulators.mjs';
import { viewerCount } from './scrcpy.mjs';

const avdCache = new Map();   // serial → avd 名（设备消失时清掉）

export async function deviceTable(list) {
  const devices = list || await listDevices().catch(() => []);
  const seen = new Set(devices.map((d) => d.serial));
  for (const k of avdCache.keys()) if (!seen.has(k)) avdCache.delete(k);
  const own = new Map(emu.snapshot().map((r) => [r.serial, r]));
  const out = [];
  for (const d of devices) {
    let avd = '';
    if (d.kind === 'emulator' && d.state === 'device') {
      avd = avdCache.get(d.serial) || '';
      if (!avd) { avd = await avdNameOf(d.serial).catch(() => ''); if (avd) avdCache.set(d.serial, avd); }
    }
    const o = own.get(d.serial);
    out.push({
      serial: d.serial, kind: d.kind, state: o && o.state !== 'running' ? o.state : d.state,
      model: d.model, avd: avd || o?.avd || '', managed: !!o, viewers: viewerCount(d.serial),
    });
  }
  for (const o of own.values()) if (!seen.has(o.serial)) out.push({ serial: o.serial, kind: 'emulator', state: o.state, model: '', avd: o.avd, managed: true, viewers: 0 });
  return out;
}

export const deviceLabel = (d) => (d ? (d.avd ? d.avd.replace(/_/g, ' ') : d.model || d.serial) : '');
