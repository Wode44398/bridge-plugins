// 「由 bridge 拉起」时自动把 NapCat 的 OneBot 网络配置写好，服主不用进 NapCat 的 WebUI 手配。
//
// NapCat 读 <目录>/napcat/config/onebot11_<QQ号>.json；这个号第一次登录、文件还没有时，拿 onebot11.json 当模板抄一份。
// 所以启动前两个都写：模板（新号扫码登录也带上）+ 已知 QQ 号自己的那份。只动名为 bridge 的条目，
// 或端口 / 地址和我们一样的条目；用户自己加的别的网络配置（别的机器人、WebSocket……）原样保留。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({
  network: { httpServers: [], httpSseServers: [], httpClients: [], websocketServers: [], websocketClients: [], plugins: [] },
  musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false,
});

const read = (f) => {
  try { const raw = readFileSync(f, 'utf8'); return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { return null; }
};

// { dir, qq, port, token, hookUrl, hookToken } → 改动了的文件列表
export function ensureNapcatNetwork({ dir, qq, port, token, hookUrl, hookToken }) {
  const cfgDir = path.join(dir, 'napcat', 'config');
  mkdirSync(cfgDir, { recursive: true });
  const files = [path.join(cfgDir, 'onebot11.json')];
  if (qq) files.push(path.join(cfgDir, `onebot11_${qq}.json`));
  const changed = [];
  for (const f of files) {
    const j = read(f) || EMPTY();
    const before = JSON.stringify(j);
    j.network = j.network && typeof j.network === 'object' ? j.network : EMPTY().network;
    for (const k of Object.keys(EMPTY().network)) if (!Array.isArray(j.network[k])) j.network[k] = [];

    const server = { enable: true, name: 'bridge', host: '127.0.0.1', port, enableCors: true, enableWebsocket: false, messagePostFormat: 'array', token: token || '', debug: false };
    const servers = j.network.httpServers;
    const si = servers.findIndex((s) => s && (s.name === 'bridge' || Number(s.port) === port));
    if (si >= 0) servers[si] = { ...servers[si], ...server, name: servers[si].name || 'bridge' };
    else servers.push(server);

    const client = { enable: true, name: 'bridge', url: hookUrl, reportSelfMessage: false, messagePostFormat: 'array', token: hookToken || '', debug: false };
    const clients = j.network.httpClients;
    const ci = clients.findIndex((c) => c && (c.name === 'bridge' || c.url === hookUrl));
    if (ci >= 0) clients[ci] = { ...clients[ci], ...client, name: clients[ci].name || 'bridge' };
    else clients.push(client);

    if (JSON.stringify(j) !== before) {
      writeFileSync(f, JSON.stringify(j, null, 2));
      changed.push(path.basename(f));
    }
  }
  return changed;
}

// 当前配置里有没有别的上报地址还开着：两边同时收会回答两遍
export function otherReporters({ dir, qq, hookUrl }) {
  const f = path.join(dir, 'napcat', 'config', qq ? `onebot11_${qq}.json` : 'onebot11.json');
  const j = existsSync(f) ? read(f) : null;
  return ((j && j.network && j.network.httpClients) || []).filter((c) => c && c.enable && c.url && c.url !== hookUrl).map((c) => c.url);
}
