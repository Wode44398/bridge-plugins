<script>
  // 应用子页：第三方应用列表，每行 启动 / 结束 / 清除数据 / 卸载；顶上「安装 apk」，也可以把 .apk 拖进来。
  // 安装本身由 AndroidPanel 统一做（画面区拖 apk 也走它），这里只把文件交上去、显示进度，tick 变了就刷新列表。
  import { api } from '../lib/host.js';
  import { uiConfirm } from '../lib/host.js';
  import { t } from '../lib/host.js';
  import { errText, dragHasFiles } from '../lib/util.js';

  let { serial, active = true, flash = () => {}, install = async () => {}, installing = null, tick = 0 } = $props();

  let apps = $state([]);
  let loading = $state(false);
  let err = $state('');
  let q = $state('');
  let busy = $state('');           // 'pkg:op'
  let out = $state(null);          // { text, bad }
  let dropOn = $state(false);
  let fileEl = $state();

  async function load() {
    loading = true; err = '';
    try { const r = await api.get('/api/android/apps?serial=' + encodeURIComponent(serial)); apps = r.apps || []; }
    catch (e) { err = errText(e); }
    finally { loading = false; }
  }
  // 可见时拉；装好新应用（tick 变）也重拉
  let loadedKey = '';
  $effect(() => {
    const key = `${serial}|${tick}`;
    if (!active || !serial || key === loadedKey) return;
    loadedKey = key;
    load();
  });

  const list = $derived(q.trim() ? apps.filter((a) => a.pkg.toLowerCase().includes(q.trim().toLowerCase())) : apps);

  const OPS = {
    launch: () => t('启动'), stop: () => t('结束'), clear: () => t('清除数据'), uninstall: () => t('卸载'),
  };
  async function op(pkg, o) {
    if (o === 'clear' && !(await uiConfirm(t('清除 {pkg} 的全部数据？账号、设置和缓存都会删掉。', { pkg }), { danger: true, okLabel: t('清除数据') }))) return;
    if (o === 'uninstall' && !(await uiConfirm(t('卸载 {pkg}？', { pkg }), { danger: true, okLabel: t('卸载') }))) return;
    busy = pkg + ':' + o; out = null;
    try {
      const r = await api.post('/api/android/app', { serial, op: o, pkg });
      out = { text: r.text || t('已{op}', { op: OPS[o]() }), bad: false };
      if (o === 'uninstall') apps = apps.filter((a) => a.pkg !== pkg);
    } catch (e) { out = { text: errText(e), bad: true }; }
    finally { busy = ''; }
  }

  async function sendFiles(files) {
    const apks = [...files].filter((f) => /\.apk$/i.test(f.name));
    if (!apks.length) { flash(t('只能安装 .apk 文件')); return; }
    for (const f of apks) await install(f);
  }
  function onPick(e) { const fs = e.currentTarget.files; if (fs?.length) sendFiles(fs); e.currentTarget.value = ''; }
  function onDragOver(e) { if (!dragHasFiles(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; dropOn = true; }
  function onDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) dropOn = false; }
  function onDrop(e) { if (!dragHasFiles(e)) return; e.preventDefault(); e.stopPropagation(); dropOn = false; sendFiles(e.dataTransfer.files); }
</script>

<div class="ap" role="region" aria-label={t('应用')} ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop}>
  <div class="ap-bar">
    <button class="ap-btn pri" onclick={() => fileEl?.click()} disabled={!!installing}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5v10M7.5 10l4.5 4.5 4.5-4.5M5 19h14"/></svg>{t('安装 apk')}
    </button>
    <input bind:this={fileEl} type="file" accept=".apk,application/vnd.android.package-archive" multiple hidden onchange={onPick} />
    <input class="ap-in grow" type="search" placeholder={t('搜索包名')} bind:value={q} spellcheck="false" autocapitalize="off" aria-label={t('搜索包名')} />
    <button class="ap-ibtn" onclick={load} disabled={loading} title={t('刷新')} aria-label={t('刷新')}>
      {#if loading}<span class="ap-spin"></span>{:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/></svg>{/if}
    </button>
  </div>
  {#if installing}
    <div class="ap-prog">
      <div class="ap-prog-r"><span class="ap-prog-n">{installing.name}</span><span>{installing.pct < 1 ? Math.round(installing.pct * 100) + '%' : t('正在安装…')}</span></div>
      <div class="ap-prog-bar"><i style="width:{Math.round(installing.pct * 100)}%"></i></div>
    </div>
  {/if}
  {#if out}<div class="ap-out" class:bad={out.bad}>{out.text}</div>{/if}
  {#if err}<div class="ap-err">{err}</div>{/if}

  <div class="ap-list">
    {#each list as a (a.pkg)}
      <div class="ap-row">
        <svg class="ap-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="4.5" y="4.5" width="15" height="15" rx="4"/></svg>
        <div class="ap-row-t"><span class="ap-name" title={a.path}>{a.pkg}</span></div>
        <div class="ap-acts">
          <button class="ap-ibtn" disabled={!!busy} onclick={() => op(a.pkg, 'launch')} title={t('启动')} aria-label={t('启动')}>
            {#if busy === a.pkg + ':launch'}<span class="ap-spin"></span>{:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 5.5v13l10.5-6.5z"/></svg>{/if}
          </button>
          <button class="ap-ibtn" disabled={!!busy} onclick={() => op(a.pkg, 'stop')} title={t('结束')} aria-label={t('结束')}>
            {#if busy === a.pkg + ':stop'}<span class="ap-spin"></span>{:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>{/if}
          </button>
          <button class="ap-ibtn" disabled={!!busy} onclick={() => op(a.pkg, 'clear')} title={t('清除数据')} aria-label={t('清除数据')}>
            {#if busy === a.pkg + ':clear'}<span class="ap-spin"></span>{:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 19.5h10M4.6 14.2l8.8-8.8a2 2 0 0 1 2.8 0l2.4 2.4a2 2 0 0 1 0 2.8L11 18.2a2 2 0 0 1-1.4.6H8.3a2 2 0 0 1-1.4-.6l-2.3-2.3a1.2 1.2 0 0 1 0-1.7zM9 9.8l5.2 5.2"/></svg>{/if}
          </button>
          <button class="ap-ibtn crit" disabled={!!busy} onclick={() => op(a.pkg, 'uninstall')} title={t('卸载')} aria-label={t('卸载')}>
            {#if busy === a.pkg + ':uninstall'}<span class="ap-spin"></span>{:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5.2h4V7M7 7l.8 12h8.4L17 7"/></svg>{/if}
          </button>
        </div>
      </div>
    {:else}
      {#if !loading && !err}
        <div class="ap-empty">{q ? t('没有匹配的应用') : t('还没有装第三方应用。点「安装 apk」或把 .apk 拖进来。')}</div>
      {/if}
    {/each}
  </div>
  {#if dropOn}<div class="ap-drop">{t('松手安装到设备')}</div>{/if}
</div>
