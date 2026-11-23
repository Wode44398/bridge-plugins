<script>
  // Logcat 子页：服务端 adb logcat → SSE 批量推行；级别 / 包名在服务端过滤，关键词在前端过滤。
  // 只在可见（active）时连流，切走就断；再切回来时服务端会回放最近 300 行，按时间戳去掉已有的那段。
  // 行多（最多 5000）所以列表是虚拟滚动：固定行高、只画看得见的那几十行。
  import { untrack } from 'svelte';
  import { api } from '../lib/host.js';
  import { readDockSse } from '../lib/host.js';
  import { t } from '../lib/host.js';
  import { errText } from '../lib/util.js';

  let { serial, active = true, flash = () => {} } = $props();

  const MAX = 5000;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const ROW = coarse ? 20 : 18;
  const LEVELS = ['V', 'D', 'I', 'W', 'E', 'F'];
  const LEVEL_NAME = { V: 'Verbose', D: 'Debug', I: 'Info', W: 'Warn', E: 'Error', F: 'Fatal' };

  let level = $state('V');
  let pkg = $state('');            // 已生效的包名过滤
  let pkgDraft = $state('');
  let kw = $state('');
  let paused = $state(false);
  let follow = $state(true);
  let conn = $state('idle');       // idle | open | ended | failed
  let note = $state('');
  let ver = $state(0);             // 行数组是普通数组，改完 ver++ 通知重算
  let pendingN = $state(0);
  let picked = $state(null);       // 点选的那一行（底部展开全文）
  let apps = $state([]);
  let listEl = $state();
  let scrollTop = $state(0);
  let viewH = $state(0);
  let paneW = $state(0);

  let all = [];                    // 已显示的行
  let pending = [];                // 暂停期间攒下的行
  let lastKey = '';                // 断流前最后一行的时间戳，重连回放时据此去重
  let lastSet = new Set();         // 同一时间戳上已有的行

  const keyOf = (l) => `${l.pid}|${l.tid}|${l.tag}|${l.msg}`;
  function take(lines) {
    // 去掉重连回放里已经有的行
    if (lastKey) {
      const out = [];
      for (const l of lines) {
        if (lastKey && l.t < lastKey) continue;
        if (lastKey && l.t === lastKey && lastSet.has(keyOf(l))) continue;
        lastKey = ''; out.push(l);
      }
      lines = out;
    }
    if (!lines.length) return;
    if (paused) {
      pending.push(...lines);
      if (pending.length > MAX) pending = pending.slice(-MAX);
      pendingN = pending.length;
      return;
    }
    push(lines);
  }
  function push(lines) {
    all.push(...lines);
    if (all.length > MAX) all = all.slice(-MAX);
    ver++;
  }
  function wipe() { all = []; pending = []; pendingN = 0; lastKey = ''; lastSet = new Set(); picked = null; ver++; }

  // 连流：serial / level / pkg 变了 = 换一路新流并清屏；active 关掉 = 断开但留着已有的行
  let paramsKey = '';
  let retry = $state(0);
  $effect(() => {
    const key = `${serial}|${level}|${pkg}`;
    void retry;
    if (!active || !serial) return;
    return untrack(() => connect(key));
  });
  function connect(key) {
    if (key !== paramsKey) { paramsKey = key; wipe(); }
    else if (all.length) {
      // 同参数重连：记下最后一行，回放的那段跳过
      const last = all[all.length - 1];
      lastKey = last.t; lastSet = new Set(all.filter((l) => l.t === last.t).map(keyOf));
    }
    conn = 'idle'; note = '';
    const q = new URLSearchParams({ serial, level });
    if (pkg) q.set('pkg', pkg);
    const stop = readDockSse('/api/android/logcat?' + q, (ev) => {
      if (ev.type === 'hello') { conn = 'open'; note = ev.note || ''; }
      else if (ev.type === 'lines') take(ev.lines || []);
      else if (ev.type === 'end') conn = 'ended';
    }, {
      onDead: (code, body) => { conn = 'failed'; note = body?.error || (code === 403 ? t('安卓设备只对主机开放') : t('连不上日志流（{code}）', { code })); },
      onClose: () => { if (conn !== 'failed') conn = 'ended'; },
    });
    return () => stop();
  }

  // 包名候选：可见时拉一次第三方应用
  let appsFor = '';
  $effect(() => {
    if (!active || !serial || appsFor === serial) return;
    appsFor = serial;
    api.get('/api/android/apps?serial=' + encodeURIComponent(serial)).then((r) => { apps = r.apps || []; }).catch(() => {});
  });

  const filtered = $derived.by(() => {
    void ver;
    const k = kw.trim().toLowerCase();
    if (!k) return all.slice();
    return all.filter((l) => (l.tag || '').toLowerCase().includes(k) || (l.msg || '').toLowerCase().includes(k));
  });

  // 虚拟滚动
  const OVER = 24;
  const first = $derived(Math.max(0, Math.floor(scrollTop / ROW) - OVER));
  const lastIdx = $derived(Math.min(filtered.length, Math.ceil((scrollTop + viewH) / ROW) + OVER));
  const shown = $derived(filtered.slice(first, lastIdx));

  function onScroll() {
    if (!listEl) return;
    scrollTop = listEl.scrollTop;
    const atBottom = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - ROW * 1.5;
    if (atBottom !== follow) follow = atBottom;
  }
  $effect(() => {
    if (!listEl) return;
    const ro = new ResizeObserver(() => { viewH = listEl.clientHeight; scrollTop = listEl.scrollTop; });
    ro.observe(listEl);
    viewH = listEl.clientHeight;
    return () => ro.disconnect();
  });
  // 跟随：有新行就贴到底
  $effect(() => {
    void filtered.length; void active;
    if (!follow || !listEl || !active) return;
    const el = listEl;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; scrollTop = el.scrollTop; });
  });
  function toBottom() { follow = true; if (listEl) { listEl.scrollTop = listEl.scrollHeight; scrollTop = listEl.scrollTop; } }

  function togglePause() {
    if (paused) { paused = false; if (pending.length) { push(pending); pending = []; pendingN = 0; } }
    else paused = true;
  }
  async function clearLog() {
    try { await api.post('/api/android/logcat/clear', { serial }); wipe(); }
    catch (e) { flash(errText(e)); }
  }
  function applyPkg() {
    const p = pkgDraft.trim();
    if (p && !/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(p)) { flash(t('包名不合法')); return; }
    pkg = p;
  }
  function copyLine(l) {
    try { navigator.clipboard?.writeText(`${l.t} ${l.pid}-${l.tid} ${l.lvl}/${l.tag}: ${l.msg}`); flash(t('已复制')); } catch {}
  }
  const time = (s) => (s || '').split(' ').pop();
  const showPid = $derived(paneW >= 520);
</script>

<div class="ap lc" bind:clientWidth={paneW}>
  <div class="ap-bar">
    <select class="ap-sel" bind:value={level} title={t('最低级别')} aria-label={t('最低级别')}>
      {#each LEVELS as l (l)}<option value={l}>{l} · {LEVEL_NAME[l]}</option>{/each}
    </select>
    <input class="ap-in pkg" list="lc-apps-{serial}" placeholder={t('包名（全部）')} bind:value={pkgDraft}
      onchange={applyPkg} onkeydown={(e) => { if (e.key === 'Enter') applyPkg(); }} spellcheck="false" autocapitalize="off" aria-label={t('按包名过滤')} />
    <datalist id="lc-apps-{serial}">{#each apps as a (a.pkg)}<option value={a.pkg}></option>{/each}</datalist>
    <input class="ap-in grow" type="search" placeholder={t('搜索 tag 或内容')} bind:value={kw} spellcheck="false" autocapitalize="off" aria-label={t('关键词过滤')} />
    <button class="ap-ibtn" class:on={paused} onclick={togglePause} title={paused ? t('继续') : t('暂停')} aria-label={paused ? t('继续') : t('暂停')}>
      {#if paused}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M8 5.5v13l10.5-6.5z"/></svg>
      {:else}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M9 6v12M15 6v12"/></svg>
      {/if}
    </button>
    <button class="ap-ibtn" onclick={clearLog} title={t('清空日志')} aria-label={t('清空日志')}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5.2h4V7M7 7l.8 12h8.4L17 7M10.3 10.5v5.5M13.7 10.5v5.5"/></svg>
    </button>
  </div>
  {#if note || conn === 'failed' || conn === 'ended' || paused}
    <div class="lc-st">
      {#if conn === 'failed'}<span class="bad">{note}</span>
      {:else if conn === 'ended'}<span>{t('日志流已断开')}</span>
      {:else if note}<span>{note}</span>{/if}
      {#if paused}<span>{pendingN ? t('已暂停 · 新增 {n} 行', { n: pendingN }) : t('已暂停')}</span>{/if}
      {#if conn === 'failed' || conn === 'ended'}<button class="lc-link" onclick={() => retry++}>{t('重新连接')}</button>{/if}
    </div>
  {/if}

  <div class="lc-list" bind:this={listEl} onscroll={onScroll} role="log" aria-label={t('设备日志')}>
    <div class="lc-space" style="height:{filtered.length * ROW}px">
      {#each shown as l, i (first + i)}
        <button class="lc-row lv-{l.lvl}" class:sel={picked === l} style="top:{(first + i) * ROW}px;height:{ROW}px" onclick={() => (picked = picked === l ? null : l)}>
          <span class="c-t">{time(l.t)}</span>{#if showPid}<span class="c-p">{l.pid}</span>{/if}<span class="c-l">{l.lvl}</span><span class="c-g">{l.tag}</span><span class="c-m">{l.msg}</span>
        </button>
      {/each}
    </div>
    {#if !filtered.length}
      <div class="ap-empty lc-empty">{conn === 'open' || conn === 'idle' ? (kw ? t('没有匹配的日志') : t('等待日志…')) : ''}</div>
    {/if}
  </div>
  {#if !follow && filtered.length}
    <button class="lc-follow" onclick={toBottom}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v13M6.5 12.5 12 18l5.5-5.5"/></svg>{t('跳到最新')}
    </button>
  {/if}
  {#if picked}
    <div class="lc-detail">
      <div class="lc-dh">
        <span class="lv-{picked.lvl}">{picked.lvl}/{picked.tag}</span><span class="lc-dm">{picked.t} · {picked.pid}-{picked.tid}</span>
        <span class="ap-sp"></span>
        <button class="ap-ibtn" onclick={() => copyLine(picked)} title={t('复制')} aria-label={t('复制')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/></svg>
        </button>
        <button class="ap-ibtn" onclick={() => (picked = null)} title={t('关闭')} aria-label={t('关闭')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>
        </button>
      </div>
      <div class="lc-dt">{picked.msg}</div>
    </div>
  {/if}
</div>

<style>
  .pkg { width: 150px; }
  .lc-st { flex: none; display: flex; align-items: center; gap: 10px; padding: 0 12px 6px; font-size: 11.5px; color: var(--muted); }
  .lc-st .bad { color: var(--crit); }
  .lc-link { color: var(--text); font-size: 11.5px; text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--divider); }
  .lc-list { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; position: relative; margin: 0 6px 6px; border-radius: 8px;
    background: color-mix(in srgb, var(--bg) 60%, transparent); box-shadow: inset 0 0 0 1px var(--divider);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; font-size: 11.5px; }
  .lc-space { position: relative; min-width: 100%; }
  .lc-row { position: absolute; left: 0; right: 0; display: flex; align-items: center; gap: 8px; padding: 0 8px; text-align: left;
    white-space: nowrap; overflow: hidden; color: var(--text); font: inherit; line-height: 1; cursor: default; }
  @media (hover: hover) { .lc-row:hover { background: var(--hover); } }
  .lc-row.sel { background: var(--hover-strong); }
  .c-t { flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
  .c-p { flex: none; width: 5ch; text-align: right; color: var(--muted); }
  .c-l { flex: none; width: 1ch; font-weight: 600; }
  .c-g { flex: none; width: 15ch; overflow: hidden; text-overflow: ellipsis; }
  .c-m { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .lv-V, .lv-D { color: var(--muted); }
  .lv-I { color: var(--text); }
  .lv-W { color: color-mix(in srgb, var(--coral) 72%, var(--muted)); }
  .lv-E, .lv-F { color: var(--crit); }
  .lv-V .c-t, .lv-D .c-t, .lv-I .c-t { color: var(--muted); }
  .lv-W .c-t, .lv-E .c-t, .lv-F .c-t { color: inherit; opacity: .75; }
  .lc-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; }
  .lc-follow { position: absolute; right: 18px; bottom: 16px; z-index: 3; display: flex; align-items: center; gap: 5px; height: 28px; padding: 0 11px 0 9px;
    border-radius: 14px; background: var(--q-card); color: var(--text); font-size: 12px; box-shadow: var(--q-shadow), 0 0 0 .5px var(--divider); }
  .lc-follow svg { width: 13px; height: 13px; }
  .lc-detail { flex: none; max-height: 40%; display: flex; flex-direction: column; margin: 0 6px 6px; border-radius: 8px; background: var(--hover); overflow: hidden; }
  .lc-dh { flex: none; display: flex; align-items: center; gap: 8px; padding: 2px 2px 0 10px; font-size: 11.5px; }
  .lc-dm { color: var(--muted); font-variant-numeric: tabular-nums; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; min-width: 0; }
  .lc-dt { overflow: auto; padding: 2px 10px 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.5;
    white-space: pre-wrap; word-break: break-word; user-select: text; color: var(--text); }
  :global(.aw.coarse) .lc-list { font-size: 12px; }
  :global(.aw.coarse) .pkg { width: 130px; }
</style>
