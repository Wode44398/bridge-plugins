// Gemini 网页版：把 gemini.google.com 网页端的订阅额度做成模型服务，按勾选进 Claude / dimensio 的模型列表。
//
// 三块：
//   1. 反代：server/ 下是 Gemini Proxy 的源码（FastAPI + gemini-webapi，复刻网页端 StreamGenerate，对外是 Anthropic / OpenAI 兼容接口，
//      多账号轮询、冷却、Cookie 续期）。「由 bridge 拉起」时插件在数据目录建 Python 虚拟环境装依赖、无窗口模式托管它
//      （ctx.process：按进程树收尸、崩了退避重启、/api/ping 健康检查），账号与设置存在 <数据目录>/home（GEMINI_PROXY_HOME），
//      也可以改成连一个已经在跑的反代。
//   2. 模型服务：ctx.models.provide 登记一个 Anthropic 协议的服务（地址 = 反代，Key = 插件生成的），agents / members 按设置；
//      模型清单取账号的真实可用模型（/v1/models），记在 store 里，反代没起来时也照旧登记（会话里记着的模型不至于失效）。
//      推理强度两档：标准 / 深度思考（请求体 gemini_thinking=false / true，反代认它）。
//   3. 控制面板：账号增删改测（经反代的 /api/accounts，Cookie 明文从不回给页面）、最近请求、设置表单。
import { spawn as spawnChild } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(HERE, 'server');
const REQUIREMENTS = path.join(SERVER_DIR, 'requirements.txt');
const APP_TITLE = 'Gemini Proxy';
// 改了这些要整个重启（重新拉起反代 / 换地址）；其余热更新
const RESTART_KEYS = ['mode', 'python', 'port', 'externalUrl', 'apiKey'];
// 还没从账号读到模型时先登记这几个（网页端常见的；读到真实清单后换掉）
const FALLBACK_MODELS = [
  { id: 'gemini-argon', name: 'Gemini 4 Argon' },
  { id: 'gemini-pro', name: 'Gemini 3.1 Pro' },
  { id: 'gemini-flash-lite', name: 'Gemini Flash Lite' },
];
// 网页端接口上已知坏掉的型号（见 serviceSpec）与没指定时优先的默认型号
const BROKEN_MODELS = new Set(['gemini-flash']);
const PREFERRED_MODEL = 'gemini-argon';
const isWin = process.platform === 'win32';

export function apply(ctx) {
  let cfg = ctx.config;
  const home = path.join(ctx.dataDir, 'home');
  const venv = path.join(ctx.dataDir, 'venv');
  const venvPy = path.join(venv, isWin ? 'Scripts' : 'bin', isWin ? 'python.exe' : 'python');

  let phase = 'starting';        // starting / setup / running / stopped / error
  let lastErr = '';
  let proc = null;               // ctx.process 句柄
  let setupChild = null;         // 建虚拟环境 / pip 的子进程（停用时杀掉）
  let overview = null;           // 反代 /api/overview 的最近一份（账号、计数、请求）
  let overviewAt = 0;
  let svc = null;                // ctx.models.provide 的句柄
  let disposed = false;
  ctx.onDispose(() => { disposed = true; try { setupChild?.kill(); } catch {} });

  // —— 地址与 Key ——
  const localKey = () => {
    let k = ctx.store.get('apiKey', '');
    if (!k) { k = 'gw-' + randomBytes(18).toString('hex'); ctx.store.set('apiKey', k); }
    return k;
  };
  const base = () => (cfg.mode === 'external' ? String(cfg.externalUrl || '').replace(/\/+$/, '') : `http://127.0.0.1:${cfg.port}`);
  const key = () => (cfg.mode === 'external' ? String(cfg.apiKey || '') : localKey());

  async function call(method, p, body, timeoutMs = 15_000) {
    let r;
    try {
      r = await fetch(base() + p, {
        method,
        headers: { 'content-type': 'application/json', ...(key() ? { authorization: 'Bearer ' + key() } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = e?.name === 'TimeoutError' ? '超时' : '连不上';
      throw Object.assign(new Error(`反代${why}（${base()}）`), { status: 502 });
    }
    const text = await r.text();
    let j = null;
    try { j = text ? JSON.parse(text) : {}; } catch {}
    if (!r.ok) {
      const d = j?.detail ?? j?.error?.message ?? j?.error ?? text.slice(0, 200);
      throw Object.assign(new Error(typeof d === 'string' ? d : JSON.stringify(d)), { status: r.status });
    }
    return j ?? {};
  }
  const ping = async () => {
    try { return (await call('GET', '/api/ping', undefined, 3000)).app === APP_TITLE; } catch { return false; }
  };

  // —— 模型清单与模型服务 ——
  const knownModels = () => {
    const m = ctx.store.get('models', null);
    return Array.isArray(m) && m.length ? m : FALLBACK_MODELS;
  };
  async function refreshModels() {
    const j = await call('GET', '/v1/models');
    const list = (Array.isArray(j.data) ? j.data : []).filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, name: m.display_name || m.id }));
    if (!list.length) return knownModels();
    // 反代读不到账号时回的是它自带的兜底清单（没有 4 Argon）——只在有账号连通过之后才记下来、才算数
    if (!(overview?.accounts || []).some((a) => a.status === 'ok')) return knownModels();
    if (JSON.stringify(list) !== JSON.stringify(ctx.store.get('models', null))) { ctx.store.set('models', list); provide(); }
    return list;
  }

  const tiers = [
    { id: 'medium', name: '标准', value: { gemini_thinking: false } },
    { id: 'high', name: '深度思考', value: { gemini_thinking: true } },
  ];
  function serviceSpec() {
    const all = knownModels();
    // 「列出哪些模型」都没勾时：网页端接口上坏掉的型号不列（3.8 Flash：要么一直不出字、要么回一句固定拒答，
    // 反代要干等 60 秒才换默认模型重试——看起来就是「不回消息」）。明确勾了照样给。
    const pick = Array.isArray(cfg.models) && cfg.models.length ? all.filter((m) => cfg.models.includes(m.id)) : all.filter((m) => !BROKEN_MODELS.has(m.id));
    const models = (pick.length ? pick : all).map((m) => ({
      id: m.id, label: m.name || m.id, contextWindow: 200_000, maxOutput: 32_000, vision: false,
      thinking: 'effort', efforts: tiers, effortDefault: cfg.deepThinking ? 'high' : 'medium',
    }));
    const k = key();
    return {
      id: 'default',
      name: cfg.name || 'Gemini 网页版',
      protocol: 'anthropic',
      baseUrl: base(),
      apiKey: k,
      authStyle: k ? 'bearer' : 'none',   // 反代只认 Authorization: Bearer
      agents: Array.isArray(cfg.agents) ? cfg.agents : [],
      members: cfg.members === true,
      models,
      defaultModel: models.some((m) => m.id === cfg.defaultModel) ? cfg.defaultModel : (models.find((m) => m.id === PREFERRED_MODEL) || models[0]).id,
      timeoutSec: Math.max(300, (cfg.requestTimeout || 180) + 60),
      // 反代把整段对话拼成提示词发网页端：不认提示缓存与 beta 头，历史思考块也不用回传
      compat: { promptCaching: false, stripBetas: true, slimBody: true, stripThinkingHistory: true },
    };
  }
  function provide() {
    if (disposed) return;
    const spec = serviceSpec();
    try {
      if (!spec.agents.length) { svc?.dispose(); svc = null; return; }
      if (svc) svc.update(spec);
      else svc = ctx.models.provide(spec);
    } catch (e) { ctx.error('登记模型服务失败：', e?.message || e); }
  }

  // —— 概览（状态块、面板都用它）——
  async function refreshOverview() {
    try {
      overview = await call('GET', '/api/overview', undefined, 8000);
      overviewAt = Date.now();
      if (phase !== 'setup') { phase = 'running'; lastErr = ''; }
    } catch (e) {
      overview = null;
      if (cfg.mode === 'external') { phase = 'error'; lastErr = e.message; }
    }
    ctx.status.refresh();
    return overview;
  }

  // 访问 Google 用的代理：设置里填了用填的；没填就沿用 bridge 当前的出站代理（ctx.net，bridge 7.06 起），出口变了自动跟上
  const effectiveProxy = () => String(cfg.proxy || '').trim() || (ctx.has?.('net') ? ctx.net.proxy() : '');
  if (ctx.has?.('net')) ctx.net.onProxyChange(() => {
    if (String(cfg.proxy || '').trim()) return;
    call('POST', '/api/settings', proxySettings()).then(() => ctx.log('bridge 的出站代理变了，反代已跟上：' + (effectiveProxy() || '直连'))).catch(() => {});
  });

  // —— 反代的设置：启动前写进 state.json；运行中经 /api/settings 改 ——
  const proxySettings = () => ({
    proxy: effectiveProxy(),
    cooldown_seconds: cfg.cooldownSec,
    request_timeout: cfg.requestTimeout,
    default_model: cfg.defaultModel || (knownModels().find((m) => m.id === PREFERRED_MODEL) || knownModels()[0]).id,
    thinking: false,
  });
  function writeState() {
    mkdirSync(home, { recursive: true });
    const file = path.join(home, 'state.json');
    let cur = {};
    try { cur = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    const next = {
      settings: { ...(cur.settings || {}), ...proxySettings(), host: '127.0.0.1', port: cfg.port, api_key: localKey(), auto_start: false },
      accounts: Array.isArray(cur.accounts) ? cur.accounts : [],
    };
    writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  }

  // —— Python 虚拟环境 ——
  function run(command, args, { timeoutMs = 15 * 60_000 } = {}) {
    return new Promise((resolve, reject) => {
      const tail = [];
      let child;
      try {
        child = spawnChild(command, args, { cwd: SERVER_DIR, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1' } });
      } catch (e) { reject(e); return; }
      setupChild = child;
      const keep = (d) => { for (const line of d.toString().split(/\r?\n/)) if (line.trim()) { tail.push(line); if (tail.length > 30) tail.shift(); } };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); setupChild = null; reject(new Error(`起不来「${command}」：${e.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer); setupChild = null;
        if (code === 0) resolve(tail);
        else reject(new Error(`「${path.basename(command)} ${args.slice(0, 3).join(' ')}」退出码 ${code}：${tail.slice(-6).join(' | ')}`));
      });
    });
  }
  const pythonCmd = () => {
    const p = String(cfg.python || 'python').trim();
    if (existsSync(p) || !/\s/.test(p)) return [p, []];
    const [c, ...rest] = p.split(/\s+/);
    return [c, rest];
  };
  const reqHash = () => createHash('sha1').update(readFileSync(REQUIREMENTS)).digest('hex').slice(0, 12);
  async function ensureVenv(force = false) {
    if (!force && existsSync(venvPy) && ctx.store.get('reqHash', '') === reqHash()) return;
    phase = 'setup'; lastErr = ''; ctx.status.refresh();
    if (force || !existsSync(venvPy)) {
      const [c, pre] = pythonCmd();
      ctx.log(`建 Python 虚拟环境：${c} ${[...pre, '-m', 'venv'].join(' ')} ${venv}`);
      await run(c, [...pre, '-m', 'venv', ...(force ? ['--clear'] : []), venv], { timeoutMs: 5 * 60_000 });
    }
    ctx.log('安装依赖（gemini-webapi、fastapi、uvicorn）…');
    const proxy = effectiveProxy();
    await run(venvPy, ['-m', 'pip', 'install', '--upgrade', '-r', REQUIREMENTS, ...(proxy ? ['--proxy', proxy] : [])]);
    ctx.store.set('reqHash', reqHash());
    ctx.log('Python 环境就绪');
  }

  // —— 端口占用 ——
  const portBusy = (port) => new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });

  // —— 拉起反代 ——
  async function startManaged() {
    await ensureVenv();
    if (disposed) return;
    if (await portBusy(cfg.port)) {
      const ours = await ping();
      throw new Error(ours
        ? `端口 ${cfg.port} 已被另一个 Gemini Proxy 占着：关掉它，或换个端口，或把「反代服务」改成「已经在跑」`
        : `端口 ${cfg.port} 被别的程序占着：换个端口`);
    }
    writeState();
    const env = { GEMINI_PROXY_HOME: home, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    const common = {
      cwd: SERVER_DIR,
      env, restart: 'on-failure', maxRestarts: 5,
      health: { check: ping, every: 20_000, failAfter: 3, grace: 60_000, timeout: 5_000 },
    };
    proc = ctx.process.spawn('proxy', { ...common, command: venvPy, args: [path.join(SERVER_DIR, 'main.py'), '--headless', '--port', String(cfg.port)] });
    proc.on('state', (s) => {
      if (s === 'running') { phase = 'running'; waitUp().then(boot); }
      else if (s === 'failed') { phase = 'error'; lastErr = '反代反复崩溃，看「子进程」日志'; ctx.notify({ title: '反代起不来', body: '反复崩溃，打开插件详情看子进程日志', level: 'error' }); }
      else if (s === 'unhealthy') { phase = 'error'; lastErr = '反代不应答'; }
      ctx.status.refresh();
    });
  }

  // 进程起来不等于端口就绪（导入 gemini-webapi 要几秒）：最多等 45 秒
  async function waitUp() {
    for (let i = 0; i < 90 && !disposed; i++) {
      if (await ping()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  // 起来以后：取概览与模型清单、登记服务。第一次（还没记下过真实模型）顺手测一个账号——账号连上了才读得到它真有哪些模型
  async function boot() {
    await refreshOverview();
    if (!overview) return;
    if (!ctx.store.get('models', null)) {
      const first = (overview.accounts || []).find((a) => a.enabled);
      if (first) await call('POST', '/api/accounts/' + encodeURIComponent(first.id) + '/test', {}, 90_000).then(refreshOverview).catch((e) => ctx.warn('测试账号失败：', e?.message || e));
    }
    await refreshModels().catch((e) => ctx.warn('读模型清单失败：', e?.message || e));
    provide();
  }

  // —— 启动 ——
  provide();   // 先按记着的模型登记，反代起来后再按真实清单更新
  ctx.when('ready', () => {
    (async () => {
      try {
        if (cfg.mode === 'managed') await startManaged();
        else await boot();
      } catch (e) {
        phase = 'error'; lastErr = String(e?.message || e);
        ctx.error(lastErr);
        ctx.status.refresh();
      }
    })();
  });
  ctx.setInterval(() => { if (phase !== 'setup') refreshOverview().catch(() => {}); }, 60_000);

  // —— 热更新 ——
  ctx.onConfig((next, prev) => {
    if (RESTART_KEYS.some((k) => JSON.stringify(next[k]) !== JSON.stringify(prev[k]))) return false;
    cfg = next;
    const p = proxySettings();
    if (['proxy', 'cooldownSec', 'requestTimeout', 'defaultModel'].some((k) => next[k] !== prev[k])) {
      call('POST', '/api/settings', p).catch((e) => ctx.warn('反代设置没同步上（下次启动时写进去）：', e?.message || e));
    }
    provide();
    ctx.status.refresh();
  });

  // —— 设置里的动态选项 ——
  ctx.configOptions('agents', () => ctx.models.agents().map((a) => ({ value: a.id, label: a.label, ...(a.available ? {} : { desc: '扩展没开' }) })));
  const modelOptions = () => knownModels().map((m) => ({ value: m.id, label: m.name || m.id, ...(m.name && m.name !== m.id ? { desc: m.id } : {}) }));
  ctx.configOptions('models', modelOptions);
  ctx.configOptions('defaultModel', modelOptions);

  // —— 状态块 ——
  const providedTo = () => {
    const names = { claude: 'Claude', dimensio: 'dimensio' };
    const on = (Array.isArray(cfg.agents) ? cfg.agents : []).map((a) => names[a] || a);
    return on.length ? on.join('、') + (cfg.members ? '（含成员）' : '') : '没勾任何 agent';
  };
  ctx.status(() => {
    const acc = overview?.accounts || [];
    const ok = acc.filter((a) => a.enabled && a.status === 'ok').length;
    const c = overview?.counters;
    const items = [
      { label: '反代地址', value: base() },
      { label: '账号', value: overview ? `${acc.length} 个（${ok} 个连通过）` : '—' },
      { label: '模型', value: String(serviceSpec().models.length) + ' 个' },
      { label: '提供给', value: providedTo() },
      ...(c ? [{ label: '请求', value: `${c.total} 次，失败 ${c.failed}` }] : []),
    ];
    if (phase === 'setup') return { tone: 'idle', text: '正在准备 Python 环境（第一次约 1 分钟）…', items };
    if (phase === 'error') return { tone: 'error', text: lastErr || '出错了', items };
    if (!overview) return { tone: 'warn', text: cfg.mode === 'managed' ? '反代启动中…' : '连不上反代：' + base(), items };
    if (!acc.length) return { tone: 'warn', text: '还没有账号：打开控制面板添加 Google 账号 Cookie', items };
    if (!acc.some((a) => a.enabled)) return { tone: 'warn', text: '账号都停用了', items };
    return { tone: 'ok', text: '运行中', items };
  });

  // —— 按钮 ——
  async function restartProxy() {
    if (cfg.mode !== 'managed') { await boot(); return '已重新连接'; }
    if (!proc) { await startManaged(); return '已启动'; }
    await proc.restart();
    return '已重启';
  }
  ctx.action({ id: 'restart', label: '重启反代', desc: '重新拉起反代进程（进行中的请求会断）', handler: async () => restartProxy() });
  ctx.action({
    id: 'refresh-models', label: '刷新模型清单', desc: '从账号重新读一遍可用模型',
    handler: async () => { await refreshOverview(); const l = await refreshModels(); provide(); return `${l.length} 个模型`; },
  });
  ctx.action({
    id: 'setup', label: '重装 Python 环境', desc: '删掉虚拟环境重建并重装依赖（依赖出问题、网页端改版要升级 gemini-webapi 时用）',
    confirm: '重装期间反代停着（约 1 分钟）。',
    handler: async () => {
      if (cfg.mode !== 'managed') return '现在不是「由 bridge 拉起」，不用装';
      await proc?.stop();
      try { await ensureVenv(true); } catch (e) { phase = 'error'; lastErr = e.message; ctx.status.refresh(); throw e; }
      if (proc) await proc.restart(); else await startManaged();
      return '已重装并重启';
    },
  });

  // —— 面板接口（只给服务器主机）——
  const api = (m, p, fn) => ctx.route(m, `/api/plugin/${ctx.id}/${p}`, async (req, res, url) => {
    if (!ctx.http.host(req, res)) return;
    try { await fn(req, res, url); } catch (e) { ctx.http.json(res, e?.status && e.status < 600 ? e.status : 500, { error: String(e?.message || e) }); }
  });
  const accountsView = () => (overview?.accounts || []).map((a) => ({
    id: a.id, name: a.name, enabled: a.enabled, psid: a.psid_masked, hasTs: a.has_psidts, status: a.status, error: a.last_error,
    lastOk: a.last_ok, lastChecked: a.last_checked, requests: a.requests, failures: a.failures, avgMs: a.avg_ms,
    models: (a.models || []).map((m) => m.id), quota: a.quota || [], cooldownUntil: a.cooldown_until,
  }));
  api('GET', 'overview', async (req, res, url) => {
    if (url.searchParams.get('fresh') === '1' || Date.now() - overviewAt > 5000) await refreshOverview();
    ctx.http.json(res, 200, {
      phase, error: lastErr, mode: cfg.mode, base: base(), online: !!overview,
      accounts: accountsView(),
      counters: overview?.counters || null,
      requests: (overview?.requests || []).slice(0, 30).map((r) => ({ ts: r.ts, model: r.model, account: r.account, status: r.status, ms: r.ms, error: r.error, preview: r.preview, stream: r.stream })),
      models: serviceSpec().models.map((m) => ({ id: m.id, label: m.label })),
      agents: ctx.models.agents(), providedTo: providedTo(),
    });
  });
  api('POST', 'accounts/add', async (req, res) => {
    const b = await ctx.http.body(req);
    const cookie = String(b.cookie || '').trim();
    if (!cookie) return ctx.http.json(res, 400, { error: '要填 Cookie（整段 Cookie 或 __Secure-1PSID 的值）' });
    const r = await call('POST', '/api/accounts', { name: String(b.name || '').slice(0, 40), psid: cookie, psidts: String(b.psidts || '').trim() });
    const id = r?.account?.id;
    await refreshOverview();
    ctx.http.json(res, 200, { ok: true, id });
  });
  api('POST', 'accounts/update', async (req, res) => {
    const b = await ctx.http.body(req);
    const patch = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 40);
    if (typeof b.cookie === 'string' && b.cookie.trim()) patch.psid = b.cookie.trim();
    if (typeof b.psidts === 'string' && b.psidts.trim()) patch.psidts = b.psidts.trim();
    await call('PATCH', '/api/accounts/' + encodeURIComponent(String(b.id || '')), patch);
    await refreshOverview();
    ctx.http.json(res, 200, { ok: true });
  });
  api('POST', 'accounts/delete', async (req, res) => {
    const b = await ctx.http.body(req);
    await call('DELETE', '/api/accounts/' + encodeURIComponent(String(b.id || '')));
    await refreshOverview();
    ctx.http.json(res, 200, { ok: true });
  });
  api('POST', 'accounts/test', async (req, res) => {
    const b = await ctx.http.body(req);
    const r = await call('POST', '/api/accounts/' + encodeURIComponent(String(b.id || '')) + '/test', {}, 90_000);
    await refreshOverview();
    const models = await refreshModels().catch(() => knownModels());
    provide();
    ctx.http.json(res, 200, { ok: true, elapsed: r.elapsed, models: (r.models || []).map((m) => m.id || m), total: models.length });
  });
}
