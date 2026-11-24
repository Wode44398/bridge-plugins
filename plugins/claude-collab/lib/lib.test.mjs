// 插件的纯逻辑与接线：路径归属（含 worktree）、记忆概况、开场说明、外观条目、回合追踪；apply() 跑在一个假 ctx 上，
// 验菜单动作、外观、两段提示只在协作空间里出现、跨 agent 消息的抬头 / 新会话落点 / 「先问我」、谁开的会话。不起 bridge。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathKey, samePath, within, belongsTo, gitInfo, _resetGitCache } from './paths.mjs';
import { memoryStats, editedByOf, forgetMemoryStats, lastWriteText, ago } from './memory.mjs';
import { agyNote, claudeNote, withFrom, taskText, stripFrom, FROM_CLAUDE, FROM_AGY } from './prompts.mjs';
import { buildDecor, shortMemDir, memSummary } from './decor.mjs';
import { makeLive } from './live.mjs';
import { apply, agySendArgs, sessionIdOf } from '../index.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'claude-collab-'));
test.after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch {} });

// 一个主仓库 + 它的一个 worktree（只造 .git 结构，不跑 git）+ 一个不相干的目录
const repo = path.join(tmp, 'Repo');
const wt = path.join(tmp, 'wt-feature');
const other = path.join(tmp, 'Other');
mkdirSync(path.join(repo, '.git', 'worktrees', 'feature'), { recursive: true });
mkdirSync(path.join(repo, 'sub', 'deep'), { recursive: true });
mkdirSync(path.join(repo, 'sibling'), { recursive: true });
mkdirSync(path.join(wt, 'sub'), { recursive: true });
mkdirSync(path.join(wt, 'sibling'), { recursive: true });
writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'feature')}\n`);
mkdirSync(other, { recursive: true });

test('路径键：斜杠、尾斜杠、Windows 不分大小写；非绝对路径给空', () => {
  assert.equal(pathKey('relative/x'), '');
  assert.ok(samePath(repo, repo + path.sep));
  if (process.platform === 'win32') assert.ok(samePath(repo.toUpperCase(), repo.replace(/\\/g, '/')));
  assert.ok(within(path.join(repo, 'sub'), repo));
  assert.ok(!within(repo + 'x', repo), '前缀相同的兄弟目录不算');
});

test('归属：本身、下面、同一主仓库的 worktree（按仓库里的相对位置）；不相干的不算', () => {
  _resetGitCache();
  assert.equal(samePath(gitInfo(path.join(wt, 'sub')).main, repo), true);
  assert.equal(samePath(gitInfo(path.join(wt, 'sub')).top, wt), true);
  assert.ok(belongsTo(repo, repo));
  assert.ok(belongsTo(path.join(repo, 'sub', 'deep'), repo));
  assert.ok(belongsTo(wt, repo), 'worktree 根 ↔ 主仓库根');
  assert.ok(belongsTo(path.join(wt, 'sub'), path.join(repo, 'sub')), 'worktree 里的子目录 ↔ 主仓库的同一子目录');
  assert.ok(!belongsTo(path.join(wt, 'sibling'), path.join(repo, 'sub')), '同仓库但不在协作子目录里');
  assert.ok(!belongsTo(path.join(repo, 'sibling'), path.join(repo, 'sub')));
  assert.ok(!belongsTo(other, repo));
  assert.ok(!belongsTo('', repo));
});

const memDir = path.join(tmp, 'mem');
mkdirSync(memDir, { recursive: true });
const md = (name, by, t) => {
  const f = path.join(memDir, name);
  writeFileSync(f, `---\nname: ${name.replace(/\.md$/, '')}\ndescription: x\nmetadata:\n  type: project\n${by ? `  last_edited_by: ${by}\n` : ''}---\n\n正文\n`);
  utimesSync(f, t / 1000, t / 1000);
};
const T0 = Date.now() - 3600_000;
md('MEMORY.md', '', T0 + 9000);
md('MEMORY-a.md', '', T0 + 9000);
md('MEMORY-b.md', '', T0 + 9000);
md('project_x.md', 'claude', T0);
md('project_y.md', 'agy', T0 + 5000);

test('记忆概况：篇数、分区、最近写的那篇（不算索引）与它的 last_edited_by', async () => {
  forgetMemoryStats();
  const s = await memoryStats(memDir);
  assert.deepEqual([s.exists, s.files, s.parts, s.index], [true, 5, 2, true]);
  assert.equal(s.latest.name, 'project_y.md');
  assert.equal(s.latest.by, 'agy');
  assert.equal(editedByOf('---\nlast_edited_by: "codex"\n---'), 'codex');
  assert.equal(editedByOf('没有 frontmatter'), '');
  const none = await memoryStats(path.join(tmp, 'nope'));
  assert.equal(none.exists, false);
  assert.match(lastWriteText({ by: 'agy', mtime: Date.now() - 180_000 }), /^agy 3 分钟前写入$/);
  assert.equal(ago(Date.now() - 5000), '刚刚');
});

test('开场说明：给 agy 的照 demo（记忆路径换成实际的、last_edited_by 写 agy、「来自 Claude」）；给 Claude 的写明 agent:"agy" 与「来自 Antigravity」', () => {
  const f = { path: repo, memoryDir: memDir, askFirst: false };
  const a = agyNote(f, { claudeProject: { id: 'p-1', name: 'Repo' } });
  assert.match(a, /^这个文件夹（Repo）是你和 Claude 共用的工作空间。/);
  assert.ok(a.includes(path.join(memDir, 'MEMORY.md')));
  assert.match(a, /last_edited_by\n\s+写 agy。/);
  assert.match(a, /sessions\.list[\s\S]*sessions\.read[\s\S]*chat\.send/);
  assert.match(a, /项目 id 是 p-1/);
  assert.ok(a.includes(`4. 以${FROM_CLAUDE}送到你这里的消息是 Claude 写的，不是用户本人。`));
  assert.ok(!a.includes('先问我'));
  assert.match(agyNote({ ...f, askFirst: true }), /5\. 用户打开了「互相发消息前先问我」/);
  assert.match(agyNote(f), /还不是项目/);
  const c = claudeNote(f);
  assert.match(c, /^这个文件夹也是 Antigravity 的工作空间。/);
  assert.match(c, /agent:"agy"/);
  assert.ok(c.includes(`以${FROM_AGY}送来的消息不是用户本人。`));
  assert.ok(c.includes(repo));
});

test('抬头：只加一次；显示用的任务文字去掉抬头', () => {
  const m = withFrom(FROM_CLAUDE, '帮我跑测试', 'Claude 会话 abc');
  assert.equal(m, `${FROM_CLAUDE}（Claude 会话 abc）\n\n帮我跑测试`);
  assert.equal(withFrom(FROM_CLAUDE, m), m);
  assert.equal(taskText(m), '帮我跑测试');
  assert.equal(taskText('第一行\n第二行'), '第一行');
  assert.equal(stripFrom(`${FROM_AGY} 出 apk 验脚注窄屏`), '出 apk 验脚注窄屏', '会话标题里的抬头也去掉');
});

const sess = (id, title, updatedAt, running = false) => ({ id, title, updatedAt, running });

test('外观条目：agy 分页——底板、双方标识、Claude 在干活的状态行（打开那个会话）、记忆行、悬停卡、Claude 开的会话行首标记', () => {
  const now = Date.now();
  const f = { path: repo, memoryDir: path.join(repo, 'memory'), askFirst: true };
  const mem = { exists: true, files: 214, parts: 8, index: true, latest: { name: 'project_y.md', mtime: now - 180_000, by: 'agy' } };
  const it = buildDecor({
    f, agent: 'agy', mem, now,
    sessions: { claude: [sess('c1', '出 apk 验脚注窄屏', now - 1000, true), sess('c2', '社区插件市场', now - 86_400_000)], agy: [sess('a1', 'agy 后台等待态', now - 5000), sess('a2', '整理记忆', now - 9000)] },
    runs: [{ agent: 'claude', sid: 'c1', since: now - 42_000, message: '「来自 Antigravity」\n\n出 apk' }],
    origins: { agy: { a1: 'claude' }, claude: {} },
  });
  assert.deepEqual([it.path, it.panel, it.peers], [repo, true, ['agy', 'claude']]);
  assert.deepEqual(it.busy, ['claude']);
  assert.equal(it.note, '与 Claude 共用 · 记忆 214 篇');
  assert.deepEqual(it.status, { agent: 'claude', text: '正在出 apk 验脚注窄屏', since: now - 42_000, open: { session: { agent: 'claude', id: 'c1' } } });
  assert.equal(it.footer.text, '共用记忆 214 篇 · agy 3 分钟前写入');
  assert.deepEqual(it.footer.open, { file: { rel: 'MEMORY.md', ws: f.memoryDir } });
  assert.equal(it.card.title, '与 Claude 共用');
  assert.equal(it.card.sections[0].rows[0].text, path.join('Repo', 'memory'));
  assert.equal(it.card.sections[0].rows[0].meta, '8 个分区 · 214 篇');
  assert.equal(it.card.sections[1].label, 'Claude 在这里');
  assert.equal(it.card.sections[1].rows[0].live, true);
  assert.equal(it.card.sections[1].rows[0].since, now - 42_000);
  assert.equal(it.card.foot.text, '往来要你批');
  assert.deepEqual(it.card.foot.link, { label: '协作设置', open: { action: 'collab-edit' } });
  assert.deepEqual(it.sessions, [{ agent: 'agy', id: 'a1', by: 'claude' }]);
  assert.equal(it.peerSessions, undefined, 'agy 分页不列 Claude 的会话');
});

test('外观条目：Claude 分页——状态是 Antigravity 在跑的那个、peerSessions 列 agy 的会话、agy 开的 Claude 会话行首标记', () => {
  const now = Date.now();
  const f = { path: repo, memoryDir: '', askFirst: false };
  const it = buildDecor({
    f, agent: 'claude', mem: { exists: false, files: 0, parts: 0, index: false, latest: null }, now,
    sessions: { claude: [sess('c1', '甲', now), sess('c2', '乙', now)], agy: [sess('a1', '把脚注再收一收', now - 1000, true), sess('a2', '整理记忆', now - 120_000)] },
    runs: [{ agent: 'agy', sid: null, since: now - 3000, message: '把脚注再收一收' }],
    origins: { claude: { c2: 'agy' }, agy: {} },
  });
  assert.deepEqual(it.busy.sort(), ['agy']);
  assert.equal(it.note, '与 Antigravity 共用 · 还没有记忆');
  assert.equal(it.status.agent, 'agy');
  assert.equal(it.status.text, '把脚注再收一收');
  assert.equal(it.footer.text, '共用记忆 0 篇');
  assert.deepEqual(it.footer.open, { action: 'collab-edit' }, '没有索引时点记忆行打开协作设置');
  assert.equal(it.card.sections[0].rows[0].text, '（算不出记忆目录）');
  assert.equal(it.card.sections[1].label, 'Antigravity 在这里');
  assert.equal(it.card.foot.text, '往来不用你批');
  assert.deepEqual(it.sessions, [{ agent: 'claude', id: 'c2', by: 'agy' }]);
  assert.equal(it.peerSessions[0].agent, 'agy');
  assert.deepEqual(it.peerSessions[0].items.map((x) => [x.id, x.live]), [['a1', true], ['a2', false]]);
  assert.equal(memSummary({ exists: true, files: 3, parts: 0 }), '3 篇');
  assert.equal(shortMemDir(repo, path.join(tmp, 'elsewhere')), path.join(tmp, 'elsewhere'));
});

test('回合追踪：新会话 start 没 id、end 才有；对上之后认出谁开的', () => {
  const live = makeLive();
  live.start({ agent: 'agy', cwd: repo, sessionId: null, isNew: true, message: `${FROM_CLAUDE}\n\n帮忙` });
  live.start({ agent: 'claude', cwd: repo, sessionId: 's-old', message: '续聊' });
  assert.equal(live.inFolder((c) => belongsTo(c, repo)).length, 2);
  const e1 = live.end({ agent: 'agy', cwd: repo, sessionId: 'agy-1' });
  assert.deepEqual([e1.sid, e1.openedBy], ['agy-1', 'claude']);
  const e2 = live.end({ agent: 'claude', cwd: repo, sessionId: 's-old' });
  assert.equal(e2.openedBy, '', '续聊不是「开的」');
  live.start({ agent: 'claude', cwd: repo, sessionId: null, isNew: true, via: 'agy', message: 'x' });
  assert.equal(live.end({ agent: 'claude', cwd: repo, sessionId: 'c-new', via: 'agy' }).openedBy, 'agy');
  assert.equal(live.end({ agent: 'claude', cwd: repo, sessionId: 'nope' }).run, null);
  assert.equal(live.size(), 0);
});

test('认 bridge 操作：chat.send + agent:agy；结果里的会话 id', () => {
  assert.deepEqual(agySendArgs({ op: 'chat.send', args: { agent: 'agy', message: 'x' } }), { agent: 'agy', message: 'x' });
  assert.equal(agySendArgs({ op: 'chat.send', args: { message: 'x' } }), null);
  assert.equal(agySendArgs({ op: 'sessions.list', args: { agent: 'agy' } }), null);
  assert.equal(sessionIdOf([{ type: 'text', text: JSON.stringify({ sessionId: 'e0c3a1f2-77aa', status: 'running' }, null, 1) }]), 'e0c3a1f2-77aa');
  assert.equal(sessionIdOf({ content: [{ type: 'text', text: '没有' }] }), '');
});

// ── apply() 跑在假 ctx 上 ─────────────────────────────────────────────
function fakeCtx({ projects = [], agy = [], claude = {} } = {}) {
  const reg = { decor: [], actions: {}, prompts: [], hooks: [], perms: [], inputs: [], events: {}, refreshed: 0, status: null };
  const data = new Map();
  const disposers = [];
  const ctx = {
    id: 'claude-collab', has: (n) => ['ops.call', 'claude.permission.ask', 'events.via'].includes(n),
    log() {}, warn() {}, error() {},
    store: { get: (k, d) => (data.has(k) ? structuredClone(data.get(k)) : d), set: (k, v) => data.set(k, structuredClone(v)), delete: (k) => data.delete(k), all: () => Object.fromEntries(data) },
    setTimeout: (fn, ms) => setTimeout(fn, ms), onDispose: (fn) => disposers.push(fn),
    events: { on: (n, fn) => { (reg.events[n] ||= []).push(fn); } },
    ui: {
      workspaceDecor: (s) => reg.decor.push(s), workspaceAction: (s) => { reg.actions[s.id] = s; }, refreshDecor: () => { reg.refreshed++; },
    },
    claude: {
      prompt: (fn, o = {}) => reg.prompts.push({ fn, agents: o.agents || ['claude'] }),
      hook: (ev, fn, o = {}) => reg.hooks.push({ ev, fn, matcher: o.matcher }),
      permission: (fn) => reg.perms.push(fn),
      input: (fn) => reg.inputs.push(fn),
      memoryInfo: async (p) => (samePath(p, repo) ? { dir: memDir, exists: true, index: true, files: 5 } : { dir: path.join(p, 'nomem'), exists: false, index: false, files: 0 }),
    },
    ops: {
      call: async (name, args) => {
        if (name === 'projects.list') return { projects };
        if (name === 'sessions.list' && args.agent === 'agy') return { agent: 'agy', sessions: agy };
        if (name === 'sessions.list') return { sessions: claude[args.project] || [] };
        throw Object.assign(new Error('没有'), { code: 'not_found' });
      },
    },
    status: Object.assign((fn) => { reg.status = fn; }, { refresh() {} }),
  };
  return { ctx, reg, dispose: () => disposers.forEach((f) => f()) };
}
const emit = (reg, name, e) => (reg.events[name] || []).forEach((fn) => fn({ at: Date.now(), ...e }));
const promptFor = (reg, agent, turn) => reg.prompts.filter((p) => p.agents.includes(agent)).map((p) => p.fn(turn)).filter(Boolean).join('\n');
const HOST = { kind: 'admin', key: 'admin' };

test('接线：菜单项声明照 demo；设为 → 外观两边都有；提示只在协作空间（含 worktree）里给；取消 / 撤销', async () => {
  const now = Date.now();
  const { ctx, reg, dispose } = fakeCtx({
    projects: [{ id: 'p-repo', name: 'Repo', path: repo }, { id: 'p-other', name: 'Other', path: other }],
    agy: [{ id: 'agy-1', title: '整理记忆', updatedAt: now - 1000, cwd: repo }, { id: 'agy-2', title: '别处', updatedAt: now, cwd: other }, { id: 'agy-3', title: 'worktree 里', updatedAt: now - 2000, cwd: path.join(wt, 'sub') }],
    claude: { 'p-repo': [{ id: 'c-1', title: '出 apk', updatedAt: now }], 'p-other': [{ id: 'c-x', title: '无关', updatedAt: now }] },
  });
  apply(ctx);
  try {
    const on = reg.actions['collab-on'], edit = reg.actions['collab-edit'], off = reg.actions['collab-off'];
    assert.deepEqual([on.label, on.agents, on.when, on.icon, on.danger], ['设为和 Claude 的协作工作空间', ['agy'], 'plain', 'claude', false]);
    assert.deepEqual([edit.label, edit.agents, edit.when], ['协作设置…', ['agy', 'claude'], 'decorated']);
    assert.deepEqual([off.label, off.agents, off.when, off.danger], ['取消协作', ['agy', 'claude'], 'decorated', false]);

    // 确认框：记忆 chip 带算出来的目录与篇数；找不到时 ok=false
    const dlg = await on.dialog(HOST, { path: repo, agent: 'agy' });
    assert.equal(dlg.title, '和 Claude 共用这个文件夹');
    assert.deepEqual(dlg.hero, { peers: ['agy', 'claude'] });
    const chip = dlg.sections[0].items[0].chip;
    assert.equal(chip.ok, true);
    assert.ok(chip.code.endsWith(path.join('mem', 'MEMORY.md')));
    assert.match(chip.text, /^自动找到 · 2 个分区 · 5 篇/);
    assert.equal(dlg.sections[1].items[0].chip.ok, true, 'Claude 那边有对应项目');
    assert.deepEqual(dlg.fields.map((x) => [x.id, x.value]), [['askFirst', false]]);
    assert.deepEqual([dlg.ok, dlg.cancel, dlg.extra], ['设为协作空间', '取消', undefined]);
    const dlgOther = await on.dialog(HOST, { path: other, agent: 'agy' });
    assert.equal(dlgOther.sections[0].items[0].chip.ok, false);
    assert.match(dlgOther.sections[0].items[0].chip.text, /还没有/);

    // 设之前：提示都不给
    assert.equal(promptFor(reg, 'agy', { cwd: repo }), '');
    assert.equal(promptFor(reg, 'claude', { ctx: { cwd: repo } }), '');

    const r = await on.handler(HOST, { path: repo, values: { askFirst: false }, agent: 'agy' });
    assert.equal(r.decorChanged, true);
    assert.deepEqual(r.undo, { label: '撤销', action: 'collab-off' });
    assert.match(r.toast, /Repo 已和 Claude 共用/);
    const saved = ctx.store.get('folders')[0];
    assert.deepEqual([saved.memoryDir, saved.askFirst, saved.claudeProject], [memDir, false, { id: 'p-repo', name: 'Repo' }]);

    // 外观：两个分页各一条；Claude 分页的 peerSessions 只有这个文件夹（含 worktree）的 agy 会话
    const ag = await reg.decor[0].list(HOST, { agent: 'agy' });
    const cl = await reg.decor[0].list(HOST, { agent: 'claude' });
    assert.equal(ag.length, 1);
    assert.equal(ag[0].path, repo);
    assert.equal(ag[0].card.sections[1].rows[0].text, '出 apk');
    assert.deepEqual(cl[0].peerSessions[0].items.map((x) => x.id), ['agy-1', 'agy-3']);

    // 提示：协作空间、它的子目录、worktree 都给；别处不给
    assert.match(promptFor(reg, 'agy', { cwd: repo }), /是你和 Claude 共用的工作空间/);
    assert.match(promptFor(reg, 'agy', { cwd: path.join(repo, 'sub') }), /共用的工作空间/);
    assert.match(promptFor(reg, 'agy', { cwd: wt }), /共用的工作空间/);
    assert.equal(promptFor(reg, 'agy', { cwd: other }), '');
    assert.match(promptFor(reg, 'claude', { ctx: { cwd: wt } }), /也是 Antigravity 的工作空间/);
    assert.equal(promptFor(reg, 'claude', { ctx: { cwd: other } }), '');
    assert.equal(promptFor(reg, 'claude', { cwd: repo }).includes('Antigravity 的工作空间'), true, '给 Claude 的提示不给 agy');
    assert.equal(promptFor(reg, 'agy', { cwd: repo }).includes('也是 Antigravity 的工作空间'), false);

    // 编辑：开「先问我」；编辑框有「取消协作」
    const ed = await edit.dialog(HOST, { path: repo, agent: 'claude' });
    assert.deepEqual([ed.title, ed.ok, ed.extra], ['协作设置', '完成', { label: '取消协作', action: 'collab-off', danger: true }]);
    await edit.handler(HOST, { path: repo, values: { askFirst: true } });
    assert.equal(ctx.store.get('folders')[0].askFirst, true);

    // 取消 → 撤销（开关恢复）
    const o = await off.handler(HOST, { path: repo, agent: 'claude' });
    assert.deepEqual(o.undo, { label: '撤销', action: 'collab-on' });
    assert.match(o.toast, /不再和 Antigravity 共用/);
    assert.equal(ctx.store.get('folders').length, 0);
    assert.equal((await reg.decor[0].list(HOST, { agent: 'agy' })).length, 0);
    const back = await on.dialog(HOST, { path: repo, agent: 'agy' });
    assert.equal(back.fields[0].value, true, '撤销时开关取刚才的值');
    await on.handler(HOST, { path: repo, values: { askFirst: back.fields[0].value }, agent: 'agy' });
    assert.equal(ctx.store.get('folders')[0].askFirst, true);
  } finally { dispose(); }
});

test('接线：跨 agent 消息——抬头、新会话开在协作文件夹、「先问我」要审批；谁开的；agy 发来的带抬头；事件推刷新', async () => {
  const { ctx, reg, dispose } = fakeCtx({ projects: [{ id: 'p-repo', name: 'Repo', path: repo }] });
  apply(ctx);
  try {
    await reg.actions['collab-on'].handler(HOST, { path: repo, values: { askFirst: false }, agent: 'agy' });
    const pre = reg.hooks.find((h) => h.ev === 'PreToolUse');
    const post = reg.hooks.find((h) => h.ev === 'PostToolUse');
    assert.equal(pre.matcher, 'mcp__bridge__call');
    const call = { op: 'chat.send', args: { agent: 'agy', message: '帮我看看脚注' } };
    const turn = { cwd: path.join(repo, 'sub'), sessionId: 'c-777' };
    const r1 = pre.fn({ tool_name: 'mcp__bridge__call', tool_input: call }, turn);
    assert.equal(r1.decision, undefined, '没开先问我：不要审批');
    assert.equal(r1.input.args.message, `${FROM_CLAUDE}（Claude 会话 c-777）\n\n帮我看看脚注`);
    assert.equal(r1.input.args.project, repo, '新会话开在协作文件夹');
    assert.equal(pre.fn({ tool_input: { op: 'chat.send', args: { agent: 'agy', sessionId: 'agy-1', message: 'x' } } }, turn).input.args.project, undefined, '续聊不填 project');
    assert.equal(pre.fn({ tool_input: call }, { cwd: other }), undefined, '不在协作空间：不管');
    assert.equal(pre.fn({ tool_input: { op: 'sessions.list', args: { agent: 'agy' } } }, turn), undefined);
    assert.equal(await reg.perms[0]({ tool: 'mcp__bridge__call', input: call }, turn), undefined);

    await reg.actions['collab-edit'].handler(HOST, { path: repo, values: { askFirst: true } });
    const r2 = pre.fn({ tool_input: call }, turn);
    assert.equal(r2.decision, 'ask');
    assert.match(r2.reason, /先问我/);
    assert.equal(reg.perms[0]({ tool: 'mcp__bridge__call', input: call }, turn), 'ask');
    assert.equal(reg.perms[0]({ tool: 'mcp__bridge__call', input: { op: 'sessions.read', args: { agent: 'agy' } } }, turn), undefined, '读类不拦');
    assert.equal(reg.perms[0]({ tool: 'mcp__bridge__call', input: call }, { cwd: other }), undefined);

    // Claude 开的 agy 新会话：从工具结果里记下
    post.fn({ tool_input: r1.input, tool_response: [{ type: 'text', text: JSON.stringify({ sessionId: 'agy-new-1', status: 'running' }) }] }, turn);
    assert.equal(ctx.store.get('origins').agy['agy-new-1'], 'claude');

    // agy 经 bridge 操作发来的：Claude 那份带抬头；用户自己发的不动
    const inp = reg.inputs[0];
    emit(reg, 'turn.start', { agent: 'agy', cwd: repo, sessionId: 'agy-9', message: '问问 Claude' });
    assert.equal(inp({ message: '帮我出 apk' }, { via: 'agy', cwd: repo }).message, `${FROM_AGY}（Antigravity 会话 agy-9）\n\n帮我出 apk`);
    assert.equal(inp({ message: '帮我出 apk' }, { cwd: repo }), undefined);
    assert.equal(inp({ message: 'x' }, { via: 'agy', cwd: other }), undefined);

    // agy 开的 Claude 新会话：turn 事件带 via
    emit(reg, 'turn.start', { agent: 'claude', cwd: repo, sessionId: null, isNew: true, via: 'agy', message: '「来自 Antigravity」\n\n出 apk' });
    const busy = await reg.decor[0].list(HOST, { agent: 'agy' });
    assert.deepEqual(busy[0].busy.sort(), ['agy', 'claude']);
    assert.equal(busy[0].status.text, '正在出 apk');
    emit(reg, 'turn.end', { agent: 'claude', cwd: repo, sessionId: 'c-from-agy', via: 'agy', ok: true });
    assert.equal(ctx.store.get('origins').claude['c-from-agy'], 'agy');
    emit(reg, 'turn.end', { agent: 'agy', cwd: repo, sessionId: 'agy-9', ok: true });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(reg.refreshed > 0, '事件推了外观刷新');
    // 不在协作空间里的事件不管
    emit(reg, 'turn.start', { agent: 'claude', cwd: other, sessionId: 's', message: 'x' });
    const after = await reg.decor[0].list(HOST, { agent: 'agy' });
    assert.deepEqual(after[0].busy, []);
    const st = reg.status();
    assert.equal(st.tone, 'ok');
    assert.equal(st.items.length, 1);
  } finally { dispose(); }
});
