<script>
  // 文件子页：设备文件浏览（默认 /sdcard）。点目录进入、点文件下载；「上传到这里」或把文件拖进来 = 推到当前目录。
  import { api } from '../lib/host.js';
  import { t } from '../lib/host.js';
  import { errText, uploadRaw, downloadFrom, dragHasFiles, fmtSize } from '../lib/util.js';

  let { serial, active = true, flash = () => {} } = $props();

  let path = $state('/sdcard');
  let entries = $state([]);
  let loading = $state(false);
  let err = $state('');
  let ups = $state([]);            // [{ id, name, pct, done, error }]
  let dropOn = $state(false);
  let fileEl = $state();
  let listEl = $state();
  let dl = $state('');             // 正在取的文件路径

  const join = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
  const crumbs = $derived.by(() => {
    const parts = path.split('/').filter(Boolean);
    const out = [{ name: '/', path: '/' }];
    let acc = '';
    for (const p of parts) { acc += '/' + p; out.push({ name: p, path: acc }); }
    return out;
  });

  let seq = 0;
  async function go(p) {
    const my = ++seq;
    loading = true; err = '';
    try {
      const r = await api.get(`/api/android/files?serial=${encodeURIComponent(serial)}&path=${encodeURIComponent(p)}`);
      if (my !== seq) return;
      path = r.path || p; entries = r.entries || [];
      listEl?.scrollTo?.(0, 0);
    } catch (e) { if (my === seq) err = errText(e); }
    finally { if (my === seq) loading = false; }
  }
  // 第一次可见时拉；换设备回到 /sdcard
  let loadedFor = '';
  $effect(() => {
    if (!active || !serial || loadedFor === serial) return;
    const first = !loadedFor;
    loadedFor = serial;
    go(first ? path : '/sdcard');
  });

  const up = $derived(path === '/' ? '' : path.replace(/\/[^/]+$/, '') || '/');

  async function open(e) {
    if (e.dir) { go(join(path, e.name)); return; }
    const p = join(path, e.name);
    dl = p;
    try { await downloadFrom(`/api/android/file?serial=${encodeURIComponent(serial)}&path=${encodeURIComponent(p)}`, e.name); }
    catch (x) { flash(errText(x)); }
    finally { dl = ''; }
  }

  let upId = 0;
  async function sendFiles(files) {
    const list = [...files];
    if (!list.length) return;
    const dir = path;
    const items = list.map((f) => ({ id: ++upId, name: f.name, pct: 0, done: false, error: '' }));
    ups = [...ups.filter((u) => !u.done || u.error), ...items];
    let okN = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i]; const id = items[i].id;
      const patch = (o) => { ups = ups.map((u) => (u.id === id ? { ...u, ...o } : u)); };
      try {
        await uploadRaw(`/api/android/file?serial=${encodeURIComponent(serial)}&dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.name)}`, f, (p) => patch({ pct: p }));
        patch({ pct: 1, done: true }); okN++;
      } catch (e) { patch({ done: true, error: errText(e) }); }
    }
    if (okN) flash(t('已上传 {n} 个文件到 {dir}', { n: okN, dir }));
    if (path === dir) go(dir);
    // 成功的几行一会儿就收掉，失败的留着
    setTimeout(() => { ups = ups.filter((u) => !(u.done && !u.error)); }, 2500);
  }
  function onPick(e) { const fs = e.currentTarget.files; if (fs?.length) sendFiles(fs); e.currentTarget.value = ''; }
  function onDragOver(e) { if (!dragHasFiles(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; dropOn = true; }
  function onDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) dropOn = false; }
  function onDrop(e) { if (!dragHasFiles(e)) return; e.preventDefault(); e.stopPropagation(); dropOn = false; sendFiles(e.dataTransfer.files); }
</script>

<div class="ap" role="region" aria-label={t('文件')} ondragover={onDragOver} ondragleave={onDragLeave} ondrop={onDrop}>
  <div class="ap-bar">
    <button class="ap-ibtn" disabled={!up || loading} onclick={() => go(up)} title={t('上一级')} aria-label={t('上一级')}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/></svg>
    </button>
    <nav class="crumbs" aria-label={t('路径')}>
      {#each crumbs as c, i (c.path)}
        {#if i > 1}<span class="cr-sep">/</span>{/if}
        <button class="cr" class:cur={i === crumbs.length - 1} onclick={() => go(c.path)}>{c.name}</button>
      {/each}
    </nav>
    <button class="ap-ibtn" onclick={() => go(path)} disabled={loading} title={t('刷新')} aria-label={t('刷新')}>
      {#if loading}<span class="ap-spin"></span>{:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/></svg>{/if}
    </button>
    <button class="ap-btn" onclick={() => fileEl?.click()}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V4.5M7.5 9 12 4.5 16.5 9M5 19h14"/></svg>{t('上传到这里')}
    </button>
    <input bind:this={fileEl} type="file" multiple hidden onchange={onPick} />
  </div>
  {#if ups.length}
    <div class="ap-prog">
      {#each ups as u (u.id)}
        <div class="ap-prog-r"><span class="ap-prog-n">{u.name}</span>
          {#if u.error}<span class="bad">{u.error}</span><button class="x" onclick={() => (ups = ups.filter((v) => v.id !== u.id))} aria-label={t('关闭')}>×</button>
          {:else}<span>{u.done ? t('完成') : Math.round(u.pct * 100) + '%'}</span>{/if}
        </div>
        {#if !u.done}<div class="ap-prog-bar"><i style="width:{Math.round(u.pct * 100)}%"></i></div>{/if}
      {/each}
    </div>
  {/if}
  {#if err}<div class="ap-err">{err}</div>{/if}

  <div class="ap-list" bind:this={listEl}>
    {#each entries as e (e.name)}
      {@const p = join(path, e.name)}
      <button class="ap-row fr" onclick={() => open(e)} title={e.dir ? t('打开') : t('下载')}>
        {#if e.dir}
          <svg class="ap-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/></svg>
        {:else}
          <svg class="ap-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4"/></svg>
        {/if}
        <span class="ap-row-t">
          <span class="ap-name">{e.name}{#if e.link}<span class="lk"> → {e.link}</span>{/if}</span>
          <span class="ap-sub">{e.mtime}{#if !e.dir} · {fmtSize(e.size)}{/if}</span>
        </span>
        {#if dl === p}<span class="ap-spin"></span>
        {:else if !e.dir}<svg class="ap-ic dl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5v10M7.5 10l4.5 4.5 4.5-4.5M5 19h14"/></svg>
        {:else}<svg class="ap-ic dl" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 7l5 5-5 5"/></svg>{/if}
      </button>
    {:else}
      {#if !loading && !err}<div class="ap-empty">{t('空目录。把文件拖进来就能传到这里。')}</div>{/if}
    {/each}
  </div>
  {#if dropOn}<div class="ap-drop">{t('松手上传到 {dir}', { dir: path })}</div>{/if}
</div>

<style>
  .crumbs { flex: 1; min-width: 0; display: flex; align-items: center; gap: 1px; overflow-x: auto; scrollbar-width: none; white-space: nowrap; }
  .crumbs::-webkit-scrollbar { display: none; }
  .cr { flex: none; height: var(--ctl); padding: 0 6px; border-radius: 7px; color: var(--muted); font-size: 12.5px; }
  .cr.cur { color: var(--text); }
  @media (hover: hover) { .cr:hover { background: var(--hover); color: var(--text); } }
  .cr-sep { flex: none; color: var(--muted); opacity: .6; font-size: 12px; }
  .fr { width: 100%; text-align: left; }
  .lk { color: var(--muted); }
  .dl { color: var(--muted); opacity: .8; }
  .bad { color: var(--crit); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 60%; }
  .x { flex: none; width: 22px; height: 22px; border-radius: 6px; color: var(--muted); }
</style>
