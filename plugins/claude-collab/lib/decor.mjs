// 一个协作文件夹在某个分页（agent = 'agy' | 'claude'）里的外观条目。纯函数：数据都由调用方备好，好测。
//
// 两边都给：底板、双方标识、谁在干活（busy）、对方在干什么（status，点了打开那个会话）、一行说明（note）、
// 底部共用记忆行（footer：篇数 + 最近谁写的）、悬停卡（记忆、对方在这里的会话、往来设置）、本页会话行首「谁开的」（sessions）。
// Claude 分页另给 peerSessions：Antigravity 在这个文件夹的会话（Claude 侧栏的项目下单独一组）。
import path from 'node:path';
import { baseName } from './paths.mjs';
import { ago, lastWriteText } from './memory.mjs';
import { taskText } from './prompts.mjs';

export const NAMES = Object.freeze({ agy: 'Antigravity', claude: 'Claude' });
const CARD_ROWS = 4;
const PEER_ITEMS = 20;

/** 记忆目录在说明里怎么写：在协作文件夹里面就写「文件夹名\相对路径」，否则写全路径。 */
export function shortMemDir(folder, dir) {
  if (!dir) return '';
  const rel = path.relative(folder, dir);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(baseName(folder), rel);
  return dir;
}

/** 记忆概况一句话：「8 个分区 · 214 篇」。 */
export function memSummary(stats) {
  if (!stats?.exists) return '还没有记忆';
  return [stats.parts ? `${stats.parts} 个分区` : '', `${stats.files} 篇`].filter(Boolean).join(' · ');
}

/** 打开记忆索引的 Target：有 MEMORY.md 才给。 */
export function memIndexTarget(f, stats) {
  return f.memoryDir && stats?.index ? { file: { rel: 'MEMORY.md', ws: f.memoryDir } } : null;
}

/**
 * @param o.f        协作文件夹记录 { path, memoryDir, askFirst }
 * @param o.agent    正在取外观的分页
 * @param o.mem      memoryStats() 的结果
 * @param o.sessions { claude: [{ id, title, updatedAt, running }], agy: [...] }（已按目录筛好、按时间倒序）
 * @param o.runs     这个文件夹里正在跑的轮（live.inFolder 的结果）
 * @param o.origins  { claude: { <会话 id>: 'agy' }, agy: { <会话 id>: 'claude' } }
 */
export function buildDecor({ f, agent, mem, sessions = {}, runs = [], origins = {}, now = Date.now() }) {
  const other = agent === 'agy' ? 'claude' : 'agy';
  const list = (a) => (Array.isArray(sessions[a]) ? sessions[a] : []);
  const titleOf = (a, id) => list(a).find((s) => s.id === id)?.title || '';

  // 谁在干活：事件里在跑的轮 + 会话列表里标着 running 的（插件晚于那一轮启用时只有后者）
  const busy = new Set(runs.map((r) => r.agent));
  for (const a of ['agy', 'claude']) if (list(a).some((s) => s.running)) busy.add(a);
  const liveIds = (a) => new Set([...runs.filter((r) => r.agent === a && r.sid).map((r) => r.sid), ...list(a).filter((s) => s.running).map((s) => s.id)]);

  // 对方在干什么：优先有会话 id 的那一轮
  const peerRuns = runs.filter((r) => r.agent === other);
  const pr = peerRuns.find((r) => r.sid) || peerRuns[0] || null;
  // 新会话那一轮的事件里还没有会话 id：会话列表里标着在跑的那条补上（点状态行才打得开）
  const runningPeer = list(other).find((s) => s.running) || null;
  let status;
  if (pr || runningPeer) {
    const sid = pr?.sid || runningPeer?.id || '';
    const task = (sid && titleOf(other, sid)) || taskText(pr?.message) || '在干活';
    status = {
      agent: other,
      // agy 分页画成「Claude 正在…」；Claude 分页画成「Antigravity 在跑 · …」
      text: agent === 'agy' ? (task === '在干活' ? task : `正在${task.replace(/^正在/, '')}`) : task,
      since: pr?.since || 0,
      ...(sid ? { open: { session: { agent: other, id: sid } } } : {}),
    };
  }

  const memTarget = memIndexTarget(f, mem);
  const memLine = lastWriteText(mem?.latest, now);
  const memText = mem?.exists ? `记忆 ${mem.files} 篇` : '还没有记忆';
  const settings = { label: '协作设置', open: { action: 'collab-edit' } };

  const peerList = list(other);
  const peerLive = liveIds(other);
  const peerRows = peerList.slice(0, CARD_ROWS).map((s) => {
    const live = peerLive.has(s.id);
    const run = live ? runs.find((r) => r.agent === other && r.sid === s.id) || runs.find((r) => r.agent === other && !r.sid) : null;
    return {
      agent: other, live, text: s.title || '（没有标题）',
      ...(live ? (run?.since ? { since: run.since } : { meta: '在跑' }) : { meta: ago(s.updatedAt, now) }),
      open: { session: { agent: other, id: s.id } },
    };
  });

  const card = {
    title: `与 ${NAMES[other]} 共用`,
    subtitle: f.path,
    sections: [
      {
        label: '共用记忆',
        ...(memTarget ? { link: { label: '打开索引', open: memTarget } } : {}),
        rows: [
          { icon: 'book', agent: 'claude', text: shortMemDir(f.path, f.memoryDir) || '（算不出记忆目录）', meta: memSummary(mem), mono: true },
          ...(mem?.latest ? [{ icon: 'doc', text: `${memLine} · ${mem.latest.name}`, meta: '' }] : []),
        ],
      },
      {
        label: `${NAMES[other]} 在这里`,
        rows: peerRows.length ? peerRows : [{ agent: other, text: '还没有会话', meta: '' }],
      },
    ],
    foot: { text: f.askFirst ? '往来要你批' : '往来不用你批', link: settings },
  };

  // 本页会话行首「谁开的」：本页 agent 的会话里，对方开的那些
  const mineBy = origins[agent] || {};
  const marks = list(agent).filter((s) => mineBy[s.id] === other).map((s) => ({ agent, id: s.id, by: other }));

  const item = {
    path: f.path,
    panel: true,
    peers: ['agy', 'claude'],
    busy: [...busy],
    note: `与 ${NAMES[other]} 共用 · ${memText}`,
    ...(status ? { status } : {}),
    footer: { icon: 'book', text: `共用记忆 ${mem?.files || 0} 篇${memLine ? ' · ' + memLine : ''}`, open: memTarget || { action: 'collab-edit' } },
    card,
    sessions: marks,
  };
  if (agent === 'claude') {
    item.peerSessions = [{
      agent: 'agy',
      items: list('agy').slice(0, PEER_ITEMS).map((s) => ({ id: s.id, title: s.title || '（没有标题）', meta: peerLive.has(s.id) ? '' : ago(s.updatedAt, now), live: peerLive.has(s.id) })),
    }];
  }
  return item;
}
