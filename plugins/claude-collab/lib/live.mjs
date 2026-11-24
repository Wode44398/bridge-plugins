// 谁在哪个协作文件夹里干活：由两个 agent 的 turn.start / turn.end 事件算出来。
// 新会话的 turn.start 里还没有会话 id（turn.end 里才有）：先按「agent + 目录」记成一条无 id 的，收尾时对上最早那条。
// 顺带认出「谁开的会话」：Claude 经 bridge 操作开的 Antigravity 会话，第一条消息带「来自 Claude」抬头；
// Antigravity 经 bridge 操作开的 Claude 会话，turn 事件带 via:'agy'（bridge 插件接口八期）。
import { samePath } from './paths.mjs';
import { FROM_CLAUDE } from './prompts.mjs';

const STALE = 6 * 3600_000;   // 收尾事件丢了的兜底：超过 6 小时的当它结束了

export function makeLive() {
  const runs = new Map();   // key → { key, agent, cwd, sid, since, message, isNew, by }
  let seq = 0;

  function sweep(now) {
    for (const [k, r] of runs) if (now - r.since > STALE) runs.delete(k);
  }

  /** turn.start → 记下这一轮。返回记下的条目。 */
  function start(e, now = Date.now()) {
    sweep(now);
    const agent = e.agent;
    const sid = e.sessionId || null;
    const by = agent === 'agy' && String(e.message || '').trimStart().startsWith(FROM_CLAUDE) ? 'claude'
      : agent === 'claude' && e.via === 'agy' ? 'agy' : '';
    const key = sid ? `${agent}:${sid}` : `${agent}:new:${++seq}`;
    const r = { key, agent, cwd: e.cwd || '', sid, since: Number(e.at) || now, message: String(e.message || ''), isNew: !!e.isNew || !sid, by };
    runs.set(key, r);
    return r;
  }

  /** turn.end → 摘掉对应那条；返回 { run, sid, openedBy }（openedBy：这是对方开的新会话时 = 对方）。没对上 → { run: null }。 */
  function end(e) {
    const agent = e.agent;
    const sid = e.sessionId || null;
    let r = sid ? runs.get(`${agent}:${sid}`) : null;
    if (!r) {
      // 新会话：同 agent、同目录、还没有 id 的最早一条
      for (const x of runs.values()) {
        if (x.agent === agent && !x.sid && samePath(x.cwd, e.cwd)) { r = x; break; }
      }
    }
    if (!r) return { run: null, sid, openedBy: '' };
    runs.delete(r.key);
    const by = r.by || (agent === 'claude' && e.via === 'agy' ? 'agy' : '');
    return { run: r, sid: sid || r.sid, openedBy: r.isNew && by ? by : '' };
  }

  /** 在 pred(cwd) 成立的目录里正在跑的轮（按开始时间，早的在前）。 */
  function inFolder(pred, now = Date.now()) {
    sweep(now);
    return [...runs.values()].filter((r) => pred(r.cwd)).sort((a, b) => a.since - b.since);
  }

  return { start, end, inFolder, size: () => runs.size, _runs: runs };
}
