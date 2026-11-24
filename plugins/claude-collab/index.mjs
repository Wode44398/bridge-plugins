// Claude 协作工作空间：把一个文件夹设成 Antigravity 和 Claude 共用。
//
// 设了之后：
//   · Antigravity 在这个文件夹里的新会话开场带一段说明（记忆在哪、怎么读、怎么写回、怎么找 Claude）；
//     Claude 在这里的会话也带一段（这里也是 Antigravity 的工作空间、怎么看 / 发 / 开会话）。
//   · 两个分页的侧栏都换一身样子（ctx.ui.workspaceDecor）：底板、双方标识、谁在干活、共用记忆行、悬停卡、谁开的会话；
//     Claude 侧栏的这个项目下另列 Antigravity 的会话。
//   · Claude 经 bridge 操作发给 Antigravity 的消息自动带「来自 Claude」抬头（新会话自动开在这个文件夹）；
//     Antigravity 经 bridge 操作发给 Claude 的，Claude 收到的那份带「来自 Antigravity」抬头。
//   · 「互相发消息前先问我」：开着时 Claude 发给 Antigravity 的每条消息、每个新会话都弹审批（绕过权限下也弹）。
//     Antigravity 那边 bridge 现在没有插件审批钩子，只能在它的开场说明里要求先问用户（见 README）。
//
// 数据在 ctx.store：folders [{ path, memoryDir, askFirst, at, claudeProject }]、origins { claude: { 会话: 'agy' }, agy: { 会话: 'claude' } }。
// 需要 bridge 插件接口八期（ctx.ops.call、审批策略 'ask'、turn 事件的 via）。
import fs from 'node:fs';
import path from 'node:path';
import { belongsTo, samePath, baseName } from './lib/paths.mjs';
import { memoryStats, forgetMemoryStats } from './lib/memory.mjs';
import { agyNote, claudeNote, withFrom, stripFrom, fromAgyHint, FROM_CLAUDE } from './lib/prompts.mjs';
import { makeLive } from './lib/live.mjs';
import { buildDecor, shortMemDir, memSummary, NAMES } from './lib/decor.mjs';

const DECOR = 'collab';
const ORIGIN_CAP = 500;
const LIST_TTL = 3000;
const UNDO_KEEP = 10 * 60_000;

/** mcp__bridge__call 的入参是不是「发给 Antigravity」（chat.send + agent:'agy'）；是 → 它的 args。 */
export function agySendArgs(toolInput) {
  const ti = toolInput && typeof toolInput === 'object' ? toolInput : null;
  if (!ti || ti.op !== 'chat.send' || !ti.args || typeof ti.args !== 'object' || ti.args.agent !== 'agy') return null;
  return ti.args;
}

/** mcp_bridge_call（agy）的入参是不是「发给 Claude」（chat.send，不带 agent 或 agent:'claude'）；是 → 它的 args。 */
export function claudeSendArgs(toolInput) {
  const ti = toolInput && typeof toolInput === 'object' ? toolInput : null;
  if (!ti || ti.op !== 'chat.send') return null;
  const a = ti.args && typeof ti.args === 'object' ? ti.args : {};
  return !a.agent || a.agent === 'claude' ? a : null;
}

/** bridge 操作结果里的会话 id（MCP 结果是 [{ type:'text', text: JSON }]）。 */
export function sessionIdOf(resp) {
  let s = '';
  try { s = typeof resp === 'string' ? resp : JSON.stringify(resp ?? ''); } catch { return ''; }
  const m = /\\?"sessionId\\?"\s*:\s*\\?"([A-Za-z0-9._:-]{8,200})\\?"/.exec(s);
  return m ? m[1] : '';
}

export function apply(ctx) {
  const store = ctx.store;
  const opsOk = typeof ctx.has === 'function' && ctx.has('ops.call');
  if (!opsOk) ctx.warn('这台 bridge 没有 ctx.ops.call（插件接口八期）：侧栏里列不出两边的会话');

  // ── 协作文件夹 ─────────────────────────────────────────────────────
  const folders = () => (Array.isArray(store.get('folders', [])) ? store.get('folders', []) : []).filter((f) => f && typeof f.path === 'string');
  const find = (p) => folders().find((f) => samePath(f.path, p)) || null;
  // 一个目录归哪个协作文件夹：最具体的那个（嵌套时取路径最长的）
  const memberOf = (cwd) => {
    if (!cwd) return null;
    const hits = folders().filter((f) => belongsTo(cwd, f.path));
    return hits.sort((a, b) => b.path.length - a.path.length)[0] || null;
  };
  let lastOff = null;   // 刚取消的那个：撤销时把开关恢复回去
  const save = (list) => { store.set('folders', list); syncWatchers(); try { ctx.status.refresh(); } catch {} };

  const origins = () => {
    const o = store.get('origins', null);
    return { claude: { ...(o?.claude || {}) }, agy: { ...(o?.agy || {}) } };
  };
  function setOrigin(agent, sid, by) {
    if (!sid || !['agy', 'claude'].includes(agent)) return;
    const o = origins();
    if (o[agent][sid] === by) return;
    o[agent][sid] = by;
    const keys = Object.keys(o[agent]);
    if (keys.length > ORIGIN_CAP) for (const k of keys.slice(0, keys.length - ORIGIN_CAP)) delete o[agent][k];
    store.set('origins', o);
  }

  // ── 外观刷新（去抖）──────────────────────────────────────────────────
  let refreshT = null;
  const refresh = (ms = 250) => {
    if (refreshT) return;
    refreshT = ctx.setTimeout(() => { refreshT = null; try { ctx.ui.refreshDecor(DECOR); } catch {} }, ms);
  };

  // 记忆目录有改动（谁写回了记忆）→ 底部记忆行跟着变
  const watchers = new Map();
  function syncWatchers() {
    const want = new Set(folders().map((f) => f.memoryDir).filter(Boolean));
    for (const [d, w] of watchers) if (!want.has(d)) { try { w.close(); } catch {} watchers.delete(d); }
    for (const d of want) {
      if (watchers.has(d)) continue;
      try {
        const w = fs.watch(d, { persistent: false }, (_ev, name) => {
          if (name && !/\.md$/i.test(String(name))) return;
          forgetMemoryStats(d);
          refresh(1000);
        });
        w.on('error', () => { try { w.close(); } catch {} watchers.delete(d); });
        watchers.set(d, w);
      } catch {}   // 目录还没建：下次列外观时再试
    }
  }
  ctx.onDispose(() => { for (const w of watchers.values()) { try { w.close(); } catch {} } watchers.clear(); });
  syncWatchers();

  // ── 两边的会话（经只读 agent 操作，按调用者身份）──────────────────────
  const cache = new Map();
  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < LIST_TTL) return hit.p;
    const p = Promise.resolve().then(fn);
    cache.set(key, { at: Date.now(), p });
    p.catch(() => cache.delete(key));
    return p;
  }
  const keyOf = (who) => (who && who.key) || 'admin';
  const quiet = async (fn, dflt) => { try { return await fn(); } catch { return dflt; } };
  // 标题去掉跨 agent 消息的抬头（对方开的会话，标题常常就是那条带抬头的第一句）
  const norm = (s) => ({ id: String(s.id), title: stripFrom(String(s.title || '')), updatedAt: Number(s.updatedAt) || 0, running: !!s.running, cwd: s.cwd || '' });

  const claudeProjects = (who) => (opsOk ? cached('proj:' + keyOf(who), async () => (await ctx.ops.call('projects.list', {}, { who })).projects || []) : Promise.resolve([]));
  async function claudeSessionsFor(f, who, projects) {
    const mine = projects.filter((p) => p.path && belongsTo(p.path, f.path)).slice(0, 4);
    const lists = await Promise.all(mine.map((p) => quiet(() => cached(`cs:${keyOf(who)}:${p.id}`, async () => (await ctx.ops.call('sessions.list', { project: p.id, limit: 30 }, { who })).sessions || []), [])));
    return lists.flat().map(norm).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async function agySessionsFor(f, who) {
    if (!opsOk) return [];
    const all = await quiet(() => cached('agy:' + keyOf(who), async () => (await ctx.ops.call('sessions.list', { agent: 'agy', limit: 200 }, { who })).sessions || []), []);
    return all.filter((s) => s.cwd && belongsTo(s.cwd, f.path)).map(norm).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const projectFor = (projects, p) => {
    const hit = projects.find((x) => x.path && samePath(x.path, p));
    return hit ? { id: String(hit.id), name: String(hit.name || baseName(p)) } : null;
  };

  // ── 谁在干活（turn 事件）────────────────────────────────────────────
  const live = makeLive();
  ctx.events.on('turn.start', (e) => {
    if (!['agy', 'claude'].includes(e.agent) || !memberOf(e.cwd)) return;
    live.start(e);
    cache.clear();
    refresh();
  });
  ctx.events.on('turn.end', (e) => {
    if (!['agy', 'claude'].includes(e.agent)) return;
    const { run, sid, openedBy } = live.end(e);
    if (!run && !memberOf(e.cwd)) return;
    if (openedBy && sid) setOrigin(e.agent, sid, openedBy);
    cache.clear();
    forgetMemoryStats();
    refresh();
  });

  // ── 外观 ────────────────────────────────────────────────────────────
  ctx.ui.workspaceDecor({
    id: DECOR,
    agents: ['agy', 'claude'],
    async list(who, { agent }) {
      const fl = folders();
      if (!fl.length) return [];
      const projects = await quiet(() => claudeProjects(who), []);
      // Claude 那边对应的项目变了（新建 / 删掉）：记下来，给 Antigravity 的开场说明用（提示函数是同步的，只能读存着的）
      let changed = false;
      const next = fl.map((f) => {
        const pj = projectFor(projects, f.path);
        if (JSON.stringify(pj) === JSON.stringify(f.claudeProject || null)) return f;
        changed = true;
        return { ...f, claudeProject: pj };
      });
      if (changed && projects.length) store.set('folders', next);
      syncWatchers();
      const og = origins();
      return Promise.all(next.map(async (f) => {
        const [mem, cs, as] = await Promise.all([
          memoryStats(f.memoryDir),
          quiet(() => claudeSessionsFor(f, who, projects), []),
          agySessionsFor(f, who),
        ]);
        const runs = live.inFolder((cwd) => samePath(memberOf(cwd)?.path, f.path));
        return buildDecor({ f, agent, mem, sessions: { claude: cs, agy: as }, runs, origins: og });
      }));
    },
  });

  // ── 菜单项与确认框 ──────────────────────────────────────────────────
  async function memoryChip(p, who) {
    const info = await quiet(() => ctx.claude.memoryInfo(p, { who }), null);
    if (!info) return { info, chip: { ok: false, text: '算不出这个文件夹的 Claude 记忆目录' } };
    if (!info.exists) return { info, chip: { ok: false, code: shortMemDir(p, info.dir), text: '这个目录还没有：Claude 还没在这里记过东西' } };
    const stats = await memoryStats(info.dir);
    const code = shortMemDir(p, info.dir) + (info.index ? path.sep + 'MEMORY.md' : '');
    return { info, chip: { ok: true, code, text: `自动找到 · ${memSummary(stats)}${info.index ? '' : ' · 还没有总索引 MEMORY.md'}` } };
  }

  async function dialogFor(who, { path: p }, editing) {
    const f = find(p);
    const [{ chip }, projects] = await Promise.all([memoryChip(p, who), quiet(() => claudeProjects(who), [])]);
    const pj = projectFor(projects, p);
    const restore = !f && lastOff && samePath(lastOff.path, p) && Date.now() - lastOff.at < UNDO_KEEP ? lastOff.askFirst : false;
    return {
      title: editing ? '协作设置' : '和 Claude 共用这个文件夹',
      subtitle: `${baseName(p)} · ${p}`,
      hero: { peers: ['agy', 'claude'] },
      sections: [
        {
          label: 'Antigravity 在这里会',
          items: [
            { icon: 'book', title: '开工前先读 Claude 的记忆', desc: '从索引读起，只打开和手头任务相关的几篇', chip },
            { icon: 'doc', title: '按 Claude 的规矩写回记忆', desc: '规矩以记忆库自己写的为准；它改过的文件记 last_edited_by: agy' },
            { icon: 'send', title: '找 Claude 商量、分活', desc: '看 Claude 在这里的会话，给它发消息，或开一个新会话交给它' },
          ],
        },
        {
          label: 'Claude 在这里会',
          items: [{
            agent: 'claude', title: '看 Antigravity 的对话，也能发消息、开新会话', desc: 'Claude 侧栏的这个项目下会多出 Antigravity 的对话',
            chip: pj ? { ok: true, text: `Claude 项目「${pj.name}」` } : { ok: true, text: '会在 Claude 里建成项目' },
          }],
        },
      ],
      fields: [{ id: 'askFirst', type: 'switch', label: '它们互相发消息前先问我', desc: '打开后，每条消息、每个新会话都要你批准', value: f ? !!f.askFirst : restore }],
      ok: editing ? '完成' : '设为协作空间',
      cancel: '取消',
      ...(editing ? { extra: { label: '取消协作', action: 'collab-off', danger: true } } : {}),
    };
  }

  const peerName = (agent) => NAMES[agent === 'claude' ? 'agy' : 'claude'];
  async function ensureProject(p, who) {
    const r = await quiet(() => ctx.claude.ensureProject(p, { who }), null);
    if (r) { cache.clear(); return { id: String(r.id), name: String(r.name || baseName(p)) }; }
    return projectFor(await quiet(() => claudeProjects(who), []), p);
  }

  ctx.ui.workspaceAction({
    id: 'collab-on', label: '设为和 Claude 的协作工作空间', icon: 'claude', agents: ['agy'], when: 'plain', decor: DECOR, danger: false,
    dialog: (who, v) => dialogFor(who, v, false),
    async handler(who, { path: p, values, agent }) {
      if (find(p)) return '这个文件夹已经是协作空间了';
      // Claude 那边要有这个项目，侧栏才画得出来、agy 才开得了 Claude 会话：不是就建（取消协作不删）
      const [info, pj] = await Promise.all([quiet(() => ctx.claude.memoryInfo(p, { who }), null), ensureProject(p, who)]);
      save([...folders(), { path: p, memoryDir: info?.dir || '', askFirst: !!values.askFirst, at: Date.now(), claudeProject: pj }]);
      lastOff = null;
      refresh(0);
      const peer = peerName(agent);
      return { toast: `${baseName(p)} 已和 ${peer} 共用，${peer} 那边也会显示`, decorChanged: true, undo: { label: '撤销', action: 'collab-off' } };
    },
  });
  ctx.ui.workspaceAction({
    id: 'collab-edit', label: '协作设置…', icon: 'settings', agents: ['agy', 'claude'], when: 'decorated', decor: DECOR, danger: false,
    dialog: (who, v) => dialogFor(who, v, true),
    async handler(who, { path: p, values }) {
      const f = find(p);
      if (!f) return '这个文件夹已经不是协作空间了';
      const [info, pj] = await Promise.all([quiet(() => ctx.claude.memoryInfo(p, { who }), null), ensureProject(p, who)]);
      save(folders().map((x) => (x === f || samePath(x.path, p) ? { ...x, askFirst: !!values.askFirst, memoryDir: info?.dir || x.memoryDir || '', claudeProject: pj || x.claudeProject || null } : x)));
      refresh(0);
      return { toast: values.askFirst ? '协作设置已保存：互相发消息前会先问你' : '协作设置已保存', decorChanged: true };
    },
  });
  ctx.ui.workspaceAction({
    id: 'collab-off', label: '取消协作', icon: 'link', agents: ['agy', 'claude'], when: 'decorated', decor: DECOR, danger: false,
    handler(who, { path: p, agent }) {
      const f = find(p);
      if (!f) return '这个文件夹本来就没共用';
      save(folders().filter((x) => !samePath(x.path, p)));
      lastOff = { path: f.path, askFirst: !!f.askFirst, at: Date.now() };
      refresh(0);
      return { toast: `${baseName(p)} 不再和 ${peerName(agent)} 共用`, decorChanged: true, undo: { label: '撤销', action: 'collab-on' } };
    },
  });

  // ── 开场说明 ────────────────────────────────────────────────────────
  // 给 Antigravity：只在协作空间里的会话（turn.cwd = 要挂载的那个会话的目录）
  ctx.claude.prompt((turn) => {
    const f = memberOf(turn?.cwd);
    return f ? agyNote(f, { claudeProject: f.claudeProject || null }) : '';
  }, { agents: ['agy'] });
  // 给 Claude：同一个协作空间里的 Claude 会话（项目目录在 turn.ctx.cwd；worktree 会话按主仓库认）
  ctx.claude.prompt((turn) => {
    const f = memberOf(turn?.cwd || turn?.ctx?.cwd);
    return f ? claudeNote(f) : '';
  });

  // ── 跨 agent 消息：抬头、新会话落点、「先问我」───────────────────────────
  const turnCwd = (turn) => turn?.cwd || turn?.ctx?.cwd || '';
  ctx.claude.hook('PreToolUse', (input, turn) => {
    const f = memberOf(turnCwd(turn));
    const a = f && agySendArgs(input?.tool_input);
    if (!a) return undefined;
    const sid = turn?.sessionId || '';
    const args = { ...a, message: withFrom(FROM_CLAUDE, a.message, sid ? `Claude 会话 ${sid}` : '') };
    if (!args.sessionId && !args.project) args.project = f.path;   // 新会话开在这个文件夹
    const ti = { ...input.tool_input, args };
    if (!f.askFirst) return { input: ti };
    return { decision: 'ask', reason: `「互相发消息前先问我」开着：Claude 要给 Antigravity ${a.sessionId ? '发一条消息' : '开一个新会话'}`, input: ti };
  }, { matcher: 'mcp__bridge__call' });
  // 「先问我」：两边互相发消息、开会话都要用户本人批——绕过权限 / 完全放行下也弹卡（插件接口八期 claude.permission.ask / .agy）
  //   Claude → agy：mcp__bridge__call 的 chat.send 带 agent:'agy'；agy → Claude：mcp_bridge_call 的 chat.send 不带 agent 或 agent:'claude'
  ctx.claude.permission(({ tool, input }, turn) => {
    const cross = turn?.agent === 'agy' ? tool === 'mcp_bridge_call' && !!claudeSendArgs(input) : tool === 'mcp__bridge__call' && !!agySendArgs(input);
    if (!cross) return undefined;
    return memberOf(turnCwd(turn))?.askFirst ? 'ask' : undefined;
  }, { agents: ['claude', 'agy'] });
  // Claude 开的 Antigravity 新会话：记下「谁开的」
  ctx.claude.hook('PostToolUse', (input, turn) => {
    const a = agySendArgs(input?.tool_input);
    if (!a || a.sessionId || !memberOf(turnCwd(turn))) return undefined;
    const sid = sessionIdOf(input.tool_response);
    if (sid) { setOrigin('agy', sid, 'claude'); refresh(); }
    return undefined;
  }, { matcher: 'mcp__bridge__call' });
  // Antigravity 经 bridge 操作发来的：给 Claude 一段旁注说明来源（hint：模型看得到，会话标题、历史气泡都不带它）
  ctx.claude.input((_m, turn) => {
    if (turn?.via !== 'agy') return undefined;
    const f = memberOf(turnCwd(turn));
    if (!f) return undefined;
    const agyRuns = live.inFolder((cwd) => belongsTo(cwd, f.path)).filter((r) => r.agent === 'agy' && r.sid);
    return { hint: fromAgyHint(agyRuns.length === 1 ? agyRuns[0].sid : '') };
  });

  // ── 详情页状态块 ─────────────────────────────────────────────────────
  ctx.status(() => {
    const fl = folders();
    if (!fl.length) return { tone: 'idle', text: '还没有协作空间：在 Antigravity 侧栏右键一个文件夹，选「设为和 Claude 的协作工作空间」' };
    return {
      tone: 'ok', text: `${fl.length} 个协作空间`,
      items: fl.map((f) => ({ label: baseName(f.path), value: `${f.path} · 记忆 ${f.memoryDir || '（算不出）'} · ${f.askFirst ? '往来先问我' : '往来不用批'}` })),
    };
  });
}
