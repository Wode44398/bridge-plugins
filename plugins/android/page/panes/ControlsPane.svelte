<script>
  // 控制子页（只对模拟器）：Android Studio「扩展控制」里常用的那几样——定位、电池、旋转、折叠、短信、来电、指纹、网速。
  // 每个操作都走 POST /api/android/emu，返回的 text 显示在那一组下面。
  import { api } from '../lib/host.js';
  import { t } from '../lib/host.js';
  import { errText } from '../lib/util.js';

  let { serial } = $props();

  const CITIES = [
    { name: () => t('北京'), lat: 39.9042, lng: 116.4074 },
    { name: () => t('上海'), lat: 31.2304, lng: 121.4737 },
    { name: () => t('深圳'), lat: 22.5431, lng: 114.0579 },
    { name: () => t('旧金山'), lat: 37.7749, lng: -122.4194 },
    { name: () => t('伦敦'), lat: 51.5074, lng: -0.1278 },
  ];
  const SPEEDS = [
    { v: 'full', n: () => t('不限速') }, { v: 'lte', n: () => 'LTE' }, { v: 'hsdpa', n: () => 'HSDPA' }, { v: 'umts', n: () => 'UMTS（3G）' },
    { v: 'edge', n: () => 'EDGE' }, { v: 'gprs', n: () => 'GPRS' }, { v: 'gsm', n: () => 'GSM' },
  ];

  let lat = $state('39.9042');
  let lng = $state('116.4074');
  let level = $state(80);
  let charging = $state(true);
  let smsFrom = $state('10086');
  let smsText = $state('');
  let phone = $state('13800138000');
  let finger = $state(1);
  let speed = $state('full');
  let busy = $state('');           // 正在跑的组
  let out = $state({});            // 组 → { text, bad }

  async function emu(group, body) {
    busy = group;
    try {
      const r = await api.post('/api/android/emu', { serial, ...body });
      out = { ...out, [group]: { text: r.text || t('完成'), bad: false } };
    } catch (e) { out = { ...out, [group]: { text: errText(e), bad: true } }; }
    finally { if (busy === group) busy = ''; }
  }
  function setGeo() {
    const a = Number(lat); const b = Number(lng);
    if (!isFinite(a) || !isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) { out = { ...out, geo: { text: t('纬度要在 -90 到 90，经度要在 -180 到 180'), bad: true } }; return; }
    emu('geo', { kind: 'geo', lat: a, lng: b });
  }
  function city(c) { lat = String(c.lat); lng = String(c.lng); emu('geo', { kind: 'geo', lat: c.lat, lng: c.lng }); }
  function sendSms() {
    if (!smsFrom.trim() || !smsText.trim()) { out = { ...out, sms: { text: t('号码和内容都要填'), bad: true } }; return; }
    emu('sms', { kind: 'sms', from: smsFrom.trim(), text: smsText });
  }
  function call(kind) {
    if (!phone.trim()) { out = { ...out, call: { text: t('先填号码'), bad: true } }; return; }
    emu('call', { kind, number: phone.trim() });
  }
</script>

{#snippet result(g)}
  {#if out[g]}<div class="res" class:bad={out[g].bad}>{out[g].text}</div>{/if}
{/snippet}
{#snippet spin(g)}{#if busy === g}<span class="ap-spin"></span>{/if}{/snippet}

<div class="ap">
  <div class="ap-list ctl">
    <section class="ap-sec">
      <div class="ap-sec-h">{t('定位')} {@render spin('geo')}</div>
      <div class="ap-line">
        <span class="ap-lab">{t('纬度')}</span><input class="ap-in num grow" inputmode="decimal" bind:value={lat} aria-label={t('纬度')} />
        <span class="ap-lab">{t('经度')}</span><input class="ap-in num grow" inputmode="decimal" bind:value={lng} aria-label={t('经度')} />
        <button class="ap-btn pri" disabled={busy === 'geo'} onclick={setGeo}>{t('设定')}</button>
      </div>
      <div class="ap-line">
        {#each CITIES as c (c.lat)}<button class="ap-btn" disabled={busy === 'geo'} onclick={() => city(c)}>{c.name()}</button>{/each}
      </div>
      {@render result('geo')}
    </section>

    <section class="ap-sec">
      <div class="ap-sec-h">{t('电池')} {@render spin('battery')}</div>
      <div class="ap-line">
        <input class="ap-range" type="range" min="0" max="100" step="1" bind:value={level} aria-label={t('电量')}
          onchange={() => emu('battery', { kind: 'battery', level_pct: Number(level), charging })} />
        <span class="pct">{level}%</span>
        <label class="sw"><input type="checkbox" bind:checked={charging} onchange={() => emu('battery', { kind: 'battery', level_pct: Number(level), charging })} /><span>{t('充电中')}</span></label>
      </div>
      {@render result('battery')}
    </section>

    <section class="ap-sec">
      <div class="ap-sec-h">{t('屏幕')} {@render spin('screen')}</div>
      <div class="ap-line">
        <button class="ap-btn" disabled={busy === 'screen'} onclick={() => emu('screen', { kind: 'rotate' })}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13.5a8 8 0 0 0 6 6.3M20 10.5a8 8 0 0 0-6-6.3"/><rect x="8" y="3.5" width="8" height="12.5" rx="1.6" transform="rotate(-45 12 12)"/></svg>{t('旋转')}
        </button>
        <button class="ap-btn" disabled={busy === 'screen'} onclick={() => emu('screen', { kind: 'fold' })}>{t('折叠')}</button>
        <button class="ap-btn" disabled={busy === 'screen'} onclick={() => emu('screen', { kind: 'unfold' })}>{t('展开')}</button>
      </div>
      {@render result('screen')}
    </section>

    <section class="ap-sec">
      <div class="ap-sec-h">{t('短信')} {@render spin('sms')}</div>
      <div class="ap-line">
        <span class="ap-lab">{t('发件号码')}</span><input class="ap-in num grow" inputmode="tel" bind:value={smsFrom} aria-label={t('发件号码')} />
      </div>
      <textarea class="ap-in" rows="2" placeholder={t('短信内容')} bind:value={smsText} aria-label={t('短信内容')}></textarea>
      <div class="ap-line"><span class="ap-sp"></span><button class="ap-btn pri" disabled={busy === 'sms'} onclick={sendSms}>{t('发送到设备')}</button></div>
      {@render result('sms')}
    </section>

    <section class="ap-sec">
      <div class="ap-sec-h">{t('来电')} {@render spin('call')}</div>
      <div class="ap-line">
        <input class="ap-in num grow" inputmode="tel" bind:value={phone} aria-label={t('来电号码')} />
        <button class="ap-btn pri" disabled={busy === 'call'} onclick={() => call('call')}>{t('打进来')}</button>
        <button class="ap-btn" disabled={busy === 'call'} onclick={() => call('hangup')}>{t('挂断')}</button>
      </div>
      {@render result('call')}
    </section>

    <section class="ap-sec">
      <div class="ap-sec-h">{t('指纹')} {@render spin('finger')}</div>
      <div class="ap-line">
        <div class="seg" role="group" aria-label={t('手指')}>
          {#each [1, 2, 3] as n (n)}<button class="seg-b" class:on={finger === n} onclick={() => (finger = n)}>{t('手指 {n}', { n })}</button>{/each}
        </div>
        <button class="ap-btn pri" disabled={busy === 'finger'} onclick={() => emu('finger', { kind: 'finger', number: finger })}>{t('按一下')}</button>
      </div>
      <div class="ap-note hint">{t('先在设备的「设置 › 安全」里录入指纹，录入时也在这里按。')}</div>
      {@render result('finger')}
    </section>

    <section class="ap-sec">
      <div class="ap-sec-h">{t('网络')} {@render spin('net')}</div>
      <div class="ap-line">
        <span class="ap-lab">{t('网速')}</span>
        <select class="ap-sel grow" bind:value={speed} onchange={() => emu('net', { kind: 'network', speed })} aria-label={t('网速')}>
          {#each SPEEDS as s (s.v)}<option value={s.v}>{s.n()}</option>{/each}
        </select>
      </div>
      {@render result('net')}
    </section>
  </div>
</div>

<style>
  .ctl { padding: 0; }
  .ap-sec-h { display: flex; align-items: center; gap: 8px; }
  .ap-sec-h :global(.ap-spin) { width: 11px; height: 11px; }
  .grow { flex: 1; width: 0; min-width: 60px; }
  .pct { flex: none; width: 4ch; text-align: right; font-variant-numeric: tabular-nums; color: var(--serif); }
  .sw { flex: none; display: inline-flex; align-items: center; gap: 6px; height: var(--ctl); padding: 0 4px; color: var(--serif); cursor: pointer; }
  .sw input { accent-color: var(--text); width: 15px; height: 15px; margin: 0; }
  .res { padding: 6px 9px; border-radius: 8px; background: var(--hover); color: var(--serif); font-size: 11.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .res.bad { color: var(--crit); }
  .hint { margin: 0; }
  .seg { display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--hover); }
  .seg-b { display: flex; align-items: center; justify-content: center; height: calc(var(--ctl) - 4px); padding: 0 10px; border-radius: 7px;
    color: var(--muted); font-size: 12px; white-space: nowrap; transition: background-color .12s ease, color .12s ease; }
  .seg-b.on { background: var(--card); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
  @media (hover: hover) { .seg-b:not(.on):hover { color: var(--text); } }
  :global(.aw.coarse) .seg-b { height: 36px; font-size: 13px; }
  :global(.aw.coarse) .seg { padding: 0; background: none; gap: 4px; }
  :global(.aw.coarse) .seg-b:not(.on) { background: var(--hover); }
</style>
