<script>
  // 控件树子页：读一次当前界面的无障碍节点（/api/android/ui），列出文字 / 描述 / id / 类名 / 能力；
  // 悬停或点选某行，AndroidPanel 在画面上画出它的框（坐标是设备像素，设备宽高取所有元素 r / b 的最大值）。
  import { api } from '../lib/host.js';
  import { t } from '../lib/host.js';
  import { errText } from '../lib/util.js';

  // onhover(box|null)：悬停预览；onpick(box|null)：点选（再点一次取消）。box = { l, t, r, b, W, H }
  let { serial, onhover = () => {}, onpick = () => {} } = $props();

  let els = $state([]);
  let dims = $state({ W: 0, H: 0 });
  let loading = $state(false);
  let err = $state('');
  let info = $state('');
  let q = $state('');
  let onlyAct = $state(false);
  let sel = $state(-1);
  let readAt = $state('');

  async function read() {
    loading = true; err = '';
    try {
      const r = await api.get('/api/android/ui?serial=' + encodeURIComponent(serial));
      const list = (r.elements || []).map((e, i) => ({ ...e, i }));
      let W = 0; let H = 0;
      for (const e of list) { if (e.r > W) W = e.r; if (e.b > H) H = e.b; }
      els = list; dims = { W, H }; sel = -1; onpick(null);
      info = [r.via, r.note].filter(Boolean).join(' · ');
      readAt = new Date().toLocaleTimeString();
    } catch (e) { err = errText(e); }
    finally { loading = false; }
  }

  const acts = (e) => e.clickable || e.longClickable || e.scrollable || e.checkable || e.editable;
  const list = $derived.by(() => {
    const k = q.trim().toLowerCase();
    return els.filter((e) => (!onlyAct || acts(e)) &&
      (!k || [e.text, e.desc, e.id, e.cls].some((s) => (s || '').toLowerCase().includes(k))));
  });
  const box = (e) => (e && dims.W && dims.H ? { l: e.l, t: e.t, r: e.r, b: e.b, W: dims.W, H: dims.H } : null);
  function tags(e) {
    const out = [];
    if (e.clickable) out.push(t('可点击'));
    if (e.longClickable) out.push(t('可长按'));
    if (e.scrollable) out.push(t('可滚动'));
    if (e.checkable) out.push(e.checked ? t('已勾选') : t('可勾选'));
    if (e.editable) out.push(t('可输入'));
    if (e.password) out.push(t('密码'));
    if (e.focused) out.push(t('有焦点'));
    if (e.selected) out.push(t('已选中'));
    if (e.enabled === false) out.push(t('已禁用'));
    return out;
  }
  function pick(e) {
    if (sel === e.i) { sel = -1; onpick(null); return; }
    sel = e.i; onpick(box(e));
  }
</script>

<div class="ap">
  <div class="ap-bar">
    <button class="ap-btn pri" disabled={loading} onclick={read}>
      {#if loading}<span class="ap-spin"></span>{t('读取中…')}{:else}{els.length ? t('重新读取') : t('读取')}{/if}
    </button>
    <input class="ap-in grow" type="search" placeholder={t('搜索文字、描述、id、类名')} bind:value={q} spellcheck="false" autocapitalize="off" aria-label={t('搜索控件')} />
    <button class="ap-btn" class:on={onlyAct} onclick={() => (onlyAct = !onlyAct)} aria-pressed={onlyAct}>{t('只看可交互')}</button>
  </div>
  {#if err}<div class="ap-err">{err}</div>{/if}
  {#if els.length}
    <div class="ap-note">{t('{n} 个节点', { n: list.length })}{#if readAt} · {readAt}{/if}{#if info} · {info}{/if}</div>
  {/if}
  <div class="ap-list" role="listbox" aria-label={t('控件')} tabindex="-1" onpointerleave={() => onhover(null)}>
    {#each list as e (e.i)}
      {@const head = e.text || e.desc || e.id || e.cls}
      {@const tg = tags(e)}
      <button class="ap-row el" class:sel={sel === e.i} role="option" aria-selected={sel === e.i}
        onpointerenter={(ev) => { if (ev.pointerType === 'mouse') onhover(box(e)); }} onclick={() => pick(e)}>
        <span class="ap-row-t">
          <span class="ap-name" class:dim={!e.text && !e.desc}>{head}</span>
          <span class="ap-sub">
            {e.cls}{#if e.id && head !== e.id} · #{e.id}{/if}{#if e.desc && e.text} · {e.desc}{/if} · [{e.l},{e.t}][{e.r},{e.b}]
          </span>
          {#if tg.length}<span class="tgs">{#each tg as x (x)}<span class="ap-tag">{x}</span>{/each}</span>{/if}
        </span>
      </button>
    {:else}
      {#if !loading}
        <div class="ap-empty">{els.length ? t('没有匹配的控件') : t('点「读取」抓一次当前界面的控件树，需要几秒。悬停或点选一行，画面上会框出它。')}</div>
      {/if}
    {/each}
  </div>
</div>

<style>
  .grow { flex: 1; width: 0; min-width: 80px; }
  .el { width: 100%; text-align: left; padding-top: 5px; padding-bottom: 5px; }
  .ap-name.dim { color: var(--serif); }
  .tgs { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
</style>
