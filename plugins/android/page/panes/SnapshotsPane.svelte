<script>
  // 快照子页（只对模拟器）：列出 / 保存 / 恢复 / 删除模拟器快照。default_boot 是快速启动用的那份。
  import { api } from '../lib/host.js';
  import { uiConfirm } from '../lib/host.js';
  import { t } from '../lib/host.js';
  import { errText } from '../lib/util.js';

  let { serial, active = true } = $props();

  let snaps = $state([]);
  let unsupported = $state(false);
  let loading = $state(false);
  let err = $state('');
  let busy = $state('');           // 'op:name'
  let out = $state(null);          // { text, bad }
  let name = $state('');

  const stamp = () => {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    return `snap_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  };
  const NAME_OK = /^[A-Za-z0-9_.-]{1,64}$/;

  async function load() {
    loading = true; err = '';
    try {
      const r = await api.get('/api/android/snapshots?serial=' + encodeURIComponent(serial));
      snaps = r.snapshots || []; unsupported = !!r.unsupported;
    } catch (e) { err = errText(e); }
    finally { loading = false; }
  }
  let loadedFor = '';
  $effect(() => {
    if (!active || !serial || loadedFor === serial) return;
    loadedFor = serial;
    load();
  });

  async function run(op, n) {
    if (op === 'load' && !(await uiConfirm(t('恢复到快照「{name}」？设备当前的状态会被替换掉。', { name: n }), { okLabel: t('恢复') }))) return;
    if (op === 'delete' && !(await uiConfirm(t('删除快照「{name}」？', { name: n }), { danger: true, okLabel: t('删除') }))) return;
    busy = op + ':' + n; out = null;
    try {
      const r = await api.post('/api/android/snapshot', { serial, op, name: n });
      out = { text: r.text || t('完成'), bad: false };
      if (op === 'save') name = '';
      if (op !== 'load') await load();
    } catch (e) { out = { text: errText(e), bad: true }; }
    finally { busy = ''; }
  }
  function save() {
    const n = name.trim() || stamp();
    if (!NAME_OK.test(n)) { out = { text: t('名字只能用字母、数字和 _ . -'), bad: true }; return; }
    run('save', n);
  }
</script>

<div class="ap">
  <div class="ap-bar">
    <input class="ap-in grow" placeholder={t('新快照名字（留空自动起名）')} bind:value={name} spellcheck="false" autocapitalize="off"
      onkeydown={(e) => { if (e.key === 'Enter') save(); }} aria-label={t('快照名字')} />
    <button class="ap-btn pri" disabled={!!busy || unsupported} onclick={save}>
      {#if busy.startsWith('save:')}<span class="ap-spin"></span>{/if}{t('保存快照')}
    </button>
    <button class="ap-ibtn" onclick={load} disabled={loading} title={t('刷新')} aria-label={t('刷新')}>
      {#if loading}<span class="ap-spin"></span>{:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/></svg>{/if}
    </button>
  </div>
  {#if out}<div class="ap-out" class:bad={out.bad}>{out.text}</div>{/if}
  {#if err}<div class="ap-err">{err}</div>{/if}
  <div class="ap-list">
    {#if unsupported}
      <div class="ap-empty">{t('真机不支持快照。')}</div>
    {:else}
      {#each snaps as s (s.name)}
        <div class="ap-row">
          <svg class="ap-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5.5" width="16" height="13" rx="2"/><path d="M4 9.5h16M8 5.5v4"/></svg>
          <div class="ap-row-t">
            <span class="ap-name">{s.name}{#if s.name === 'default_boot'}<span class="ap-tag tg">{t('快速启动')}</span>{/if}</span>
            <span class="ap-sub">{s.date}{#if s.size} · {s.size}{/if}</span>
          </div>
          <div class="ap-acts">
            <button class="ap-btn" disabled={!!busy} onclick={() => run('load', s.name)}>
              {#if busy === 'load:' + s.name}<span class="ap-spin"></span>{/if}{t('恢复')}
            </button>
            <button class="ap-ibtn crit" disabled={!!busy} onclick={() => run('delete', s.name)} title={t('删除')} aria-label={t('删除')}>
              {#if busy === 'delete:' + s.name}<span class="ap-spin"></span>{:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5.2h4V7M7 7l.8 12h8.4L17 7"/></svg>{/if}
            </button>
          </div>
        </div>
      {:else}
        {#if !loading && !err}<div class="ap-empty">{t('还没有快照。保存一份，之后随时回到这一刻。')}</div>{/if}
      {/each}
    {/if}
  </div>
</div>

<style>
  .grow { flex: 1; width: 0; }
  .tg { margin-left: 6px; vertical-align: 1px; }
  .ap-acts { gap: 2px; }
</style>
