<script>
  // 安卓卡：模拟器 / 真机的实时画面（scrcpy H.264 → WebCodecs），鼠标、手指、键盘直接操作。
  // 与 Claude 的 mcp__android__android 工具共用同一台设备——agent 点的每一下这里都看得见，用户点一下就是接管。
  // 后端：routes/android.mjs（设备表、启停、票据、WebSocket 画面流）。只对主机开放。
  // Android Studio 式子页（Logcat / 应用 / 文件 / 控制 / 快照 / 控件树）在 ./android/，后端是 routes/android-studio.mjs。
  // 卡片宽 ≥ 640px：左画面、右子页；窄卡片：工具条下一条分段按钮在「画面」和各子页间切换（画面只是藏起来，流不断）。
  import { onDestroy, untrack } from 'svelte';
  import { api } from './lib/host.js';
  import { uiConfirm } from './lib/host.js';
  import { readDockSse, prefs } from './lib/host.js';
  import { t } from './lib/host.js';
  import { openStream } from './lib/stream.js';
  import { H264Canvas, webCodecsOk } from './lib/decoder.js';
  import { AK, keycodeOf, metaOf, isKeyEvent } from './lib/keycodes.js';
  import LogcatPane from './panes/LogcatPane.svelte';
  import AppsPane from './panes/AppsPane.svelte';
  import FilesPane from './panes/FilesPane.svelte';
  import ControlsPane from './panes/ControlsPane.svelte';
  import SnapshotsPane from './panes/SnapshotsPane.svelte';
  import InspectorPane from './panes/InspectorPane.svelte';
  import { errText, uploadRaw, dragHasFiles, downloadFrom } from './lib/util.js';
  import './panes/pane.css';

  const LS_KEY = 'bridge-android-serial';
  const LS_SUB = 'bridge-android-sub';
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const codecOk = webCodecsOk();

  let doc = $state(null);           // 体检结果（routes/android.mjs → doctor()）
  let devices = $state([]);         // [{ serial, kind, state, model, avd, managed, viewers }]
  let starting = $state([]);        // [{ serial, state, avd }] 启动中
  let errors = $state({});          // avd → { error }
  let loadErr = $state('');
  let picked = $state(prefs.get(LS_KEY, ''));
  let session = $state(null);       // { width, height, name }
  let conn = $state('idle');        // idle | connecting | open | retry | failed
  let endedMsg = $state('');
  let gotFrame = $state(false);
  let devMenu = $state(false);
  let moreMenu = $state(false);
  let busy = $state('');            // 正在启动 / 停止的 AVD 或序列号
  let toast = $state('');
  let stageW = $state(0);
  let stageH = $state(0);
  let stageEl = $state();
  let canvasEl = $state();
  let imeEl = $state();
  let kbOn = $state(false);         // 手机：本机键盘接到设备
  let width = $state(0);            // 卡片宽，窄了收按钮

  const online = $derived(devices.filter((d) => d.state === 'device'));
  // 当前设备：用户选过且在线就用它，否则第一台在线的
  const current = $derived(online.find((d) => d.serial === picked) || online[0] || null);
  // 只依赖序列号的 effect 用它：current 是设备表推送里的对象，每推送一次都换新
  const curSerial = $derived(current?.serial || '');
  const label = (d) => (d ? d.avd ? d.avd.replace(/_/g, ' ') : d.model || d.serial : '');
  const narrow = $derived(width > 0 && width < 340);
  const stoppable = $derived(!!current && current.managed);

  // ── 设备表：首屏拉一次，之后 SSE 推 ─────────────────────────
  async function refresh(fresh = false) {
    try {
      const r = await api.get('/api/android/state' + (fresh ? '?fresh=1' : ''));
      doc = r.doctor; devices = r.devices || []; starting = r.starting || []; errors = r.errors || {}; loadErr = '';
    } catch (e) { loadErr = String(e?.message || e); }
  }
  refresh();
  // 设备表推送：断了就退避重连（服务重启、隧道抖动），重连后补拉一次全量
  let stopSse = null; let sseTimer = null; let sseTries = 0; let gone = false;
  function listen() {
    stopSse = readDockSse('/api/android/events', (ev) => {
      sseTries = 0;
      if (ev.type === 'devices') { devices = ev.devices || []; starting = ev.starting || []; errors = ev.errors || {}; }
    }, {
      onDead: (code) => { if (code === 403) loadErr = t('安卓设备只对主机开放'); else again(); },
      onClose: () => again(),
    });
  }
  function again() {
    if (gone) return;
    clearTimeout(sseTimer);
    sseTimer = setTimeout(() => { refresh(); listen(); }, Math.min(10_000, 1000 * 2 ** Math.min(3, sseTries++)));
  }
  listen();
  onDestroy(() => { gone = true; clearTimeout(sseTimer); stopSse?.(); });

  function pick(serial) {
    picked = serial; devMenu = false;
    prefs.set(LS_KEY, serial);
  }

  async function startAvd(avd, cold = false, wipe = false) {
    busy = avd; moreMenu = false; devMenu = false; avdMenu = '';
    try { await api.post('/api/android/emulator/start', wipe ? { avd, cold, wipe } : { avd, cold }); }
    catch (e) { flash(String(e?.message || e)); }
    finally { busy = ''; }
  }
  async function stopCurrent() {
    if (!current) return;
    moreMenu = false;
    busy = current.serial;
    try { await api.post('/api/android/emulator/stop', { serial: current.serial }); }
    catch (e) { flash(String(e?.message || e)); }
    finally { busy = ''; }
  }

  // agent 在操作：点按位置画一圈涟漪，角上挂「Claude 操作中」几秒（同浏览器卡的 agent 指针回显）
  let ripple = $state(null);        // { x, y, n }（0..1）
  let agentLive = $state(false);
  let agentTimer = null; let rippleN = 0;
  function markAgent(m) {
    if (typeof m.x === 'number' && typeof m.y === 'number') ripple = { x: m.x, y: m.y, n: ++rippleN };
    agentLive = true;
    clearTimeout(agentTimer);
    agentTimer = setTimeout(() => { agentLive = false; }, 2500);
  }

  let toastTimer = null;
  function flash(msg, ms = 3200) { toast = msg; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toast = ''), ms); }

  // ── 子页 ─────────────────────────────────────────────────
  const SUBS = [
    { key: 'logcat', label: () => 'Logcat' },
    { key: 'apps', label: () => t('应用') },
    { key: 'files', label: () => t('文件') },
    { key: 'controls', label: () => t('控制'), emu: true },
    { key: 'snapshots', label: () => t('快照'), emu: true },
    { key: 'inspector', label: () => t('控件树') },
  ];
  let sub = $state(prefs.get(LS_SUB, 'logcat'));
  let showScreen = $state(true);    // 窄卡片：true = 看画面，false = 看子页
  let visited = $state({});         // `${serial}:${key}` → 已挂载过（挂过就留着，切走只是藏起来，状态不丢）
  const wide = $derived(width >= 640);
  const isEmu = $derived(!!current && current.serial.startsWith('emulator-'));
  const tabs = $derived(SUBS.filter((s) => !s.emu || isEmu));
  const effSub = $derived(tabs.some((s) => s.key === sub) ? sub : 'logcat');
  const studio = $derived(!!current && !loadErr && !!doc && !sdkMissing);
  const paneOn = $derived(studio && (wide || !showScreen));
  const screenHidden = $derived(studio && !wide && !showScreen);
  $effect(() => {
    if (!paneOn || !curSerial) return;
    const k = curSerial + ':' + effSub;
    if (!untrack(() => visited[k])) visited = { ...untrack(() => visited), [k]: true };
  });
  function selectSub(k) {
    peeking = false;
    if (k === 'screen') { showScreen = true; return; }
    sub = k; showScreen = false;
    prefs.set(LS_SUB, k);
  }

  // 控件树高亮：悬停预览 + 点选固定；坐标是设备像素，按设备宽高换成百分比
  let hlHover = $state(null);
  let hlPin = $state(null);
  const hl = $derived(hlHover || hlPin);
  let peeking = false; let peekTimer = null;
  function onInspectPick(b) {
    hlPin = b;
    clearTimeout(peekTimer);
    if (!b || wide) return;
    // 窄卡片：切回画面亮 2 秒，再回到控件树（中途用户自己切页或碰了画面就不回）
    showScreen = true; peeking = true;
    peekTimer = setTimeout(() => {
      hlPin = null;
      if (peeking && !wide) showScreen = false;
      peeking = false;
    }, 2000);
  }
  $effect(() => { if (effSub !== 'inspector' || !current) { hlHover = null; hlPin = null; } });
  $effect(() => { void curSerial; hlHover = null; hlPin = null; });
  const hlStyle = (b) => `left:${(b.l / b.W) * 100}%;top:${(b.t / b.H) * 100}%;width:${((b.r - b.l) / b.W) * 100}%;height:${((b.b - b.t) / b.H) * 100}%`;

  // ── 安装 apk（应用页按钮 / 拖到画面区或应用页都走这里）──────────
  let installing = $state(null);    // { name, pct }
  let appsTick = $state(0);
  async function installApk(file) {
    const serial = current?.serial;
    if (!serial) return;
    installing = { name: file.name, pct: 0 };
    try {
      const r = await uploadRaw(`/api/android/install?serial=${encodeURIComponent(serial)}&name=${encodeURIComponent(file.name)}`, file,
        (p) => { installing = { name: file.name, pct: p }; });
      flash(r.text || t('已安装 {name}', { name: file.name }), 6000);
      appsTick++;
    } catch (e) { flash(t('安装失败：{msg}', { msg: errText(e) }), 6000); }
    finally { installing = null; }
  }
  let stageDrop = $state(false);
  function stageDragOver(e) {
    if (!studio || !dragHasFiles(e)) return;
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; stageDrop = true;
  }
  function stageDragLeave(e) { if (!e.currentTarget.contains(e.relatedTarget)) stageDrop = false; }
  async function stageDropped(e) {
    if (!studio || !dragHasFiles(e)) return;
    e.preventDefault(); e.stopPropagation(); stageDrop = false;
    const files = [...e.dataTransfer.files];
    const apks = files.filter((f) => /\.apk$/i.test(f.name));
    if (!apks.length) { flash(t('拖到画面上只能装 .apk；传别的文件请到「文件」页')); return; }
    for (const f of apks) await installApk(f);
  }

  // ── 虚拟设备管理：新建 / 冷启动 / 清空数据启动 / 删除 ──────────
  let avdMenu = $state('');         // 空态列表里开着「⋯」菜单的那台
  let avdForm = $state(null);       // { name, device, image, touched, busy, err }
  let avdOpts = $state(null);       // { devices, images }
  let avdOptsErr = $state('');
  const prettyDevice = (d) => (d || '').split('_').map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('_');
  const apiOf = (img) => (/android-(\w+)/.exec(img?.api || img?.id || '') || [])[1] || '';
  function defaultAvdName(device, imageId) {
    const img = avdOpts?.images?.find((i) => i.id === imageId);
    const a = apiOf(img);
    let base = (prettyDevice(device) || 'Device') + (a ? '_API_' + a : '');
    base = base.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 60);
    const taken = new Set(avdList);
    let n = base; let i = 2;
    while (taken.has(n)) n = `${base}_${i++}`;
    return n;
  }
  async function openAvdForm() {
    devMenu = false; avdOptsErr = '';
    avdForm = { name: '', device: '', image: '', touched: false, busy: false, err: '' };
    try {
      if (!avdOpts) { const r = await api.get('/api/android/avd-options'); avdOpts = { devices: r.devices || [], images: r.images || [] }; }
      if (!avdForm) return;
      const device = avdOpts.devices[0] || '';
      const image = avdOpts.images[avdOpts.images.length - 1]?.id || '';
      avdForm = { ...avdForm, device, image, name: defaultAvdName(device, image) };
    } catch (e) { avdOptsErr = errText(e); }
  }
  function avdFormChange(patch) {
    const f = { ...avdForm, ...patch };
    if (!f.touched) f.name = defaultAvdName(f.device, f.image);
    avdForm = f;
  }
  async function createAvd() {
    const f = avdForm;
    if (!f || f.busy) return;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(f.name)) { avdForm = { ...f, err: t('名字只能用字母、数字和 _ . -') }; return; }
    if (!f.device || !f.image) { avdForm = { ...f, err: t('先选机型和系统镜像') }; return; }
    avdForm = { ...f, busy: true, err: '' };
    try {
      const r = await api.post('/api/android/avd/create', { name: f.name, device: f.device, image: f.image });
      avdForm = null;
      flash(r.text || t('已新建 {name}', { name: f.name }), 5000);
      await refresh(true);
    } catch (e) { if (avdForm) avdForm = { ...avdForm, busy: false, err: errText(e) }; }
  }
  async function wipeStart(avd) {
    avdMenu = '';
    if (!(await uiConfirm(t('清空「{name}」的全部数据再启动？装过的应用和设置都会恢复出厂。', { name: avd.replace(/_/g, ' ') }), { danger: true, okLabel: t('清空并启动') }))) return;
    startAvd(avd, false, true);
  }
  async function deleteAvd(avd) {
    avdMenu = '';
    if (!(await uiConfirm(t('删除虚拟设备「{name}」？它的磁盘镜像和快照会一起删掉，不能恢复。', { name: avd.replace(/_/g, ' ') }), { danger: true, okLabel: t('删除') }))) return;
    busy = avd;
    try { await api.post('/api/android/avd/delete', { name: avd }); flash(t('已删除 {name}', { name: avd.replace(/_/g, ' ') })); await refresh(true); }
    catch (e) { flash(errText(e)); }
    finally { busy = ''; }
  }

  // ── 画面流 ────────────────────────────────────────────────
  let stream = null;
  let dec = null;
  $effect(() => {
    const serial = curSerial;   // 别依赖 current 对象：设备表一推送它就换新，画面流会白白断开重连
    const canvas = canvasEl;
    if (!serial || !canvas || !codecOk) return;
    session = null; gotFrame = false; endedMsg = '';
    dec = new H264Canvas(canvas, {
      onNeedKey: () => stream?.send({ t: 'keyframe' }),
      onFrame: (n) => { if (n === 1) gotFrame = true; },
      onError: () => {},
    });
    const s = openStream(serial, {
      onState: (st, why) => { conn = st; if (st === 'failed') endedMsg = why || ''; },
      onJson: (m) => {
        if (m.type === 'session') { session = { width: m.width, height: m.height, name: m.name }; dec?.setSize(m.width, m.height); endedMsg = ''; }
        else if (m.type === 'ended') { endedMsg = m.error || ''; gotFrame = false; }
        else if (m.type === 'clipboard') { lastClip = m.text || ''; if (wantCopy) { wantCopy = false; writeClip(lastClip); } }
        else if (m.type === 'agent') markAgent(m);
      },
      onBinary: (ab) => dec?.push(ab),
    });
    stream = s;
    return () => { s.close(); if (stream === s) stream = null; dec?.close(); dec = null; conn = 'idle'; };
  });

  // ── 画面尺寸：按设备比例塞进卡片 ───────────────────────────
  $effect(() => {
    if (!stageEl) return;
    const ro = new ResizeObserver(() => { stageW = stageEl.clientWidth; stageH = stageEl.clientHeight; });
    ro.observe(stageEl);
    return () => ro.disconnect();
  });
  const fit = $derived.by(() => {
    const vw = session?.width || 9; const vh = session?.height || 19.5;
    const pad = coarse ? 0 : 16;
    const W = Math.max(0, stageW - pad); const H = Math.max(0, stageH - pad);
    if (!W || !H) return { w: 0, h: 0 };
    const s = Math.min(W / vw, H / vh);
    return { w: Math.floor(vw * s), h: Math.floor(vh * s) };
  });

  // ── 输入：指针 → 触摸 ───────────────────────────────────────
  const slots = new Map();   // pointerId → 0..9（多指）
  function norm(e) {
    const r = canvasEl.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  function slotOf(e) {
    if (e.pointerType === 'mouse') return -1;   // 服务端换成「通用手指」
    if (slots.has(e.pointerId)) return slots.get(e.pointerId);
    for (let i = 0; i < 10; i++) if (![...slots.values()].includes(i)) { slots.set(e.pointerId, i); return i; }
    return -1;
  }
  function onPointerDown(e) {
    if (!stream) return;
    peeking = false;
    if (e.pointerType === 'mouse' && e.button === 2) { e.preventDefault(); key(AK.BACK); return; }
    if (e.pointerType === 'mouse' && e.button === 1) { e.preventDefault(); key(AK.HOME); return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    canvasEl.setPointerCapture?.(e.pointerId);
    if (!coarse) imeEl?.focus({ preventScroll: true });
    const p = norm(e);
    stream.send({ t: 'touch', a: 0, id: slotOf(e), x: p.x, y: p.y, p: e.pressure || 1 });
  }
  let moveRaf = 0; let pendingMoves = new Map();
  function onPointerMove(e) {
    if (!stream || !canvasEl.hasPointerCapture?.(e.pointerId)) return;
    pendingMoves.set(e.pointerId, { id: slotOf(e), ...norm(e), p: e.pressure || 1 });
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      for (const m of pendingMoves.values()) stream?.send({ t: 'touch', a: 2, id: m.id, x: m.x, y: m.y, p: m.p });
      pendingMoves.clear();
    });
  }
  function onPointerUp(e) {
    if (!stream || !canvasEl.hasPointerCapture?.(e.pointerId)) return;
    const p = norm(e);
    const id = slotOf(e);
    pendingMoves.delete(e.pointerId);
    stream.send({ t: 'touch', a: 1, id, x: p.x, y: p.y });
    slots.delete(e.pointerId);
  }
  let wheelAcc = 0; let wheelTimer = null;
  function onWheel(e) {
    if (!stream) return;
    e.preventDefault();
    const p = norm(e);
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      const dy = Math.max(-16, Math.min(16, -wheelAcc / 100));
      wheelAcc = 0;
      if (dy) stream?.send({ t: 'scroll', x: p.x, y: p.y, dx: 0, dy });
    }, 16);
  }

  // ── 输入：键盘 / 输入法（隐藏的 textarea 接住，中文输入法也行）──────────
  function key(code, meta = 0) { stream?.send({ t: 'press', code, meta }); }
  function onKeyDown(e) {
    if (!stream) return;
    // Ctrl/⌘+V：放行，让 paste 事件拿到系统剪贴板
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') return;
    // Ctrl/⌘+C / X：在设备上复制后，设备剪贴板会推回来，写进本机剪贴板
    if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyC' || e.code === 'KeyX')) wantCopy = true;
    if (isKeyEvent(e)) {
      e.preventDefault();
      stream.send({ t: 'key', a: 0, code: keycodeOf(e), meta: metaOf(e) });
    }
  }
  function onKeyUp(e) {
    if (!stream || !isKeyEvent(e)) return;
    e.preventDefault();
    stream.send({ t: 'key', a: 1, code: keycodeOf(e), meta: metaOf(e) });
  }
  let composing = false;
  function flushIme() {
    if (composing || !imeEl) return;
    const s = imeEl.value;
    imeEl.value = '';
    if (s) stream?.send({ t: 'text', s });
  }
  function onPaste(e) {
    const s = e.clipboardData?.getData('text') || '';
    if (s) { e.preventDefault(); stream?.send({ t: 'paste', s }); }
  }
  let lastClip = ''; let wantCopy = false;
  function writeClip(s) { try { navigator.clipboard?.writeText(s); flash(t('已复制设备上的内容')); } catch {} }
  function toggleKb() {
    if (kbOn) { kbOn = false; imeEl?.blur(); return; }
    kbOn = true; imeEl?.focus();
  }

  // ── 工具条动作 ───────────────────────────────────────────
  async function shot() {
    moreMenu = false;
    if (!canvasEl || !gotFrame) return;
    canvasEl.toBlob((b) => {
      if (!b) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `${(current?.avd || current?.serial || 'android').replace(/[^\w.-]/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }
  function more(fn) { moreMenu = false; fn(); }

  // ── 录屏（设备端 screenrecord，最长 3 分钟）：工具条上挂一个红点计时，点它停止并下载 ──
  let rec = $state(null);           // { serial, at }
  let recNow = $state(Date.now());
  let recBusy = $state(false);
  let recTimer = null;
  const recLeft = $derived(rec ? Math.max(0, 180 - Math.floor((recNow - rec.at) / 1000)) : 0);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  function recTick(on) { clearInterval(recTimer); recTimer = on ? setInterval(() => { recNow = Date.now(); if (rec && recNow - rec.at > 181_000) recStop(); }, 1000) : null; }
  $effect(() => {
    // 换设备 / 打开卡片时问一下这台是不是正在录（别的窗口开始的、或 Claude 开始的）
    const serial = curSerial;
    if (!serial) { rec = null; recTick(false); return; }
    api.get(`/api/android/record?serial=${encodeURIComponent(serial)}`).then((r) => {
      if (current?.serial !== serial) return;
      if (r?.recording && !r.recording.done) { rec = { serial, at: Date.now() - r.recording.seconds * 1000 }; recNow = Date.now(); recTick(true); }
      else { rec = null; recTick(false); }
    }).catch(() => {});
  });
  onDestroy(() => recTick(false));
  async function recStart() {
    moreMenu = false;
    if (!current || recBusy) return;
    recBusy = true;
    try { await api.post('/api/android/record/start', { serial: current.serial }); rec = { serial: current.serial, at: Date.now() }; recNow = Date.now(); recTick(true); }
    catch (e) { flash(errText(e)); }
    finally { recBusy = false; }
  }
  async function recStop() {
    if (!rec || recBusy) return;
    const serial = rec.serial;
    recBusy = true; recTick(false);
    try {
      const r = await api.post('/api/android/record/stop', { serial });
      rec = null;
      flash(t('录屏 {s} 秒，正在下载', { s: r.seconds }));
      await downloadFrom(r.url, r.name);
    } catch (e) { flash(errText(e)); rec = null; }
    finally { recBusy = false; }
  }

  // ── 无线连接手机（开发者选项 › 无线调试）：先配对一次，之后只要连接 ──
  let wl = $state(null);            // { host, pairPort, code, port, busy, err, msg }
  function openWireless() { devMenu = false; wl = { host: '', pairPort: '', code: '', port: '', busy: '', err: '', msg: '' }; }
  async function wlPair() {
    const f = wl;
    if (!f.host.trim() || !f.pairPort || !/^\d{6}$/.test(f.code.trim())) { wl = { ...f, err: t('填配对页上的 IP、端口和 6 位配对码') }; return; }
    wl = { ...f, busy: 'pair', err: '', msg: '' };
    try { await api.post('/api/android/pair', { host: f.host.trim(), port: Number(f.pairPort), code: f.code.trim() }); if (wl) wl = { ...wl, busy: '', msg: t('配对成功。再填「无线调试」页上的 IP 和端口，点连接。') }; }
    catch (e) { if (wl) wl = { ...wl, busy: '', err: errText(e) }; }
  }
  async function wlConnect() {
    const f = wl;
    if (!f.host.trim() || !f.port) { wl = { ...f, err: t('填无线调试页上的 IP 和端口') }; return; }
    wl = { ...f, busy: 'connect', err: '', msg: '' };
    try {
      const r = await api.post('/api/android/connect', { host: f.host.trim(), port: Number(f.port) });
      wl = null;
      flash(t('已连接 {serial}', { serial: r.serial }));
      pick(r.serial);
    } catch (e) { if (wl) wl = { ...wl, busy: '', err: errText(e) }; }
  }
  async function wlDisconnect() {
    moreMenu = false;
    if (!current) return;
    try { await api.post('/api/android/disconnect', { serial: current.serial }); flash(t('已断开 {serial}', { serial: current.serial })); }
    catch (e) { flash(errText(e)); }
  }

  const avdList = $derived(doc?.avds || []);
  const runningAvds = $derived(new Set(devices.map((d) => d.avd).filter(Boolean)));
  const startingAvd = (avd) => starting.find((s) => s.avd === avd) || (busy === avd ? { state: 'starting' } : null);
  const sdkMissing = $derived(doc && (doc.missing || []).some((m) => m === 'sdk' || m === 'platform-tools' || m === 'emulator'));
  const statusText = $derived(
    !current ? '' :
    conn === 'connecting' || (conn === 'open' && !gotFrame && !endedMsg) ? t('正在连接画面…') :
    conn === 'retry' ? t('连接断开，正在重连…') :
    conn === 'failed' || endedMsg ? (endedMsg || t('画面连接失败')) : '');
  const phase = (s) => (s === 'booting' ? t('开机中…') : s === 'stopping' ? t('正在关机…') : t('启动中…'));
</script>

<div class="aw" class:narrow class:coarse class:wide class:studio bind:clientWidth={width}>
  <!-- 工具条：设备 · 返回 / 主页 / 多任务 · 旋转 · 更多 -->
  <div class="aw-bar">
    <button class="devbtn" class:on={devMenu} onclick={() => { devMenu = !devMenu; moreMenu = false; }} aria-haspopup="menu" aria-expanded={devMenu}
      title={t('选择设备')}>
      <span class="dot" class:live={!!current && conn === 'open' && gotFrame} class:warn={!!current && (conn === 'retry' || conn === 'connecting')}></span>
      <span class="dev-t">{current ? label(current) : t('没有设备')}</span>
      <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10l5 5 5-5"/></svg>
    </button>
    <span class="sp"></span>
    {#if current}
      <button class="nbtn" aria-label={t('返回')} title={t('返回')} onclick={() => key(AK.BACK)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 5.5 8.5 12 16 18.5z"/></svg>
      </button>
      <button class="nbtn" aria-label={t('主屏幕')} title={t('主屏幕')} onclick={() => key(AK.HOME)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="6.2"/></svg>
      </button>
      <button class="nbtn" aria-label={t('最近任务')} title={t('最近任务')} onclick={() => key(AK.APP_SWITCH)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="6.2" y="6.2" width="11.6" height="11.6" rx="1.6"/></svg>
      </button>
      {#if !narrow}
        <button class="nbtn" aria-label={t('旋转')} title={t('旋转')} onclick={() => stream?.send({ t: 'rotate' })}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3.5" width="8" height="12.5" rx="1.6" transform="rotate(-45 12 12)"/><path d="M4 13.5a8 8 0 0 0 6 6.3M20 10.5a8 8 0 0 0-6-6.3M14 4.2l-1.5 1.8M10 19.8l1.5-1.8"/></svg>
        </button>
      {/if}
      {#if coarse}
        <button class="nbtn" class:on={kbOn} aria-label={kbOn ? t('收起键盘') : t('键盘')} onpointerdown={(e) => e.preventDefault()} onclick={toggleKb}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6.5" width="18" height="11" rx="2.2"/><path d="M7 10.3h.01M10.3 10.3h.01M13.7 10.3h.01M17 10.3h.01M8.5 14h7"/></svg>
        </button>
      {/if}
    {/if}
    {#if rec && current?.serial === rec.serial}
      <button class="recbtn" disabled={recBusy} title={t('停止录屏并下载')} aria-label={t('停止录屏并下载')} onclick={recStop}>
        <span class="rec-dot"></span>{recBusy ? t('保存中…') : mmss(recLeft)}
      </button>
    {/if}
    <button class="nbtn" class:on={moreMenu} aria-label={t('更多')} aria-haspopup="menu" aria-expanded={moreMenu} onclick={() => { moreMenu = !moreMenu; devMenu = false; }}>
      <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5.8" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18.2" r="1.6"/></svg>
    </button>

    {#if devMenu || moreMenu}
      <button class="menu-bd" aria-label={t('关闭菜单')} onclick={() => { devMenu = false; moreMenu = false; }}></button>
    {/if}
    {#if devMenu}
      <div class="amenu left" role="menu">
        {#if online.length}
          <div class="m-h">{t('在线设备')}</div>
          {#each online as d (d.serial)}
            <button class="m-item" class:sel={current?.serial === d.serial} role="menuitem" onclick={() => pick(d.serial)}>
              {@render kindIcon(d.kind)}<span class="m-t">{label(d)}</span><span class="m-sub">{d.serial}</span>
            </button>
          {/each}
        {/if}
        {#if avdList.filter((a) => !runningAvds.has(a)).length}
          <div class="m-h">{t('虚拟设备')}</div>
          {#each avdList.filter((a) => !runningAvds.has(a)) as avd (avd)}
            {@const st = startingAvd(avd)}
            <button class="m-item" role="menuitem" disabled={!!st} onclick={() => startAvd(avd)}>
              {@render kindIcon('emulator')}<span class="m-t">{avd.replace(/_/g, ' ')}</span>
              <span class="m-sub">{st ? phase(st.state) : t('启动')}</span>
            </button>
          {/each}
        {/if}
        {#if !online.length && !avdList.length}<div class="m-empty">{t('没有可用的设备')}</div>{/if}
        {#if doc && !sdkMissing}
          <div class="m-sep"></div>
          <button class="m-item" role="menuitem" onclick={openAvdForm}>{@render ic('plus')}<span class="m-t">{t('新建虚拟设备…')}</span></button>
          <button class="m-item" role="menuitem" onclick={openWireless}>{@render ic('wifi')}<span class="m-t">{t('无线连接手机…')}</span></button>
        {/if}
      </div>
    {/if}
    {#if moreMenu}
      <div class="amenu right" role="menu">
        {#if current}
          <button class="m-item" role="menuitem" onclick={() => more(() => key(AK.POWER))}>{@render ic('power')}<span class="m-t">{t('电源键')}</span></button>
          <button class="m-item" role="menuitem" onclick={() => more(() => key(AK.VOLUME_UP))}>{@render ic('volup')}<span class="m-t">{t('音量 +')}</span></button>
          <button class="m-item" role="menuitem" onclick={() => more(() => key(AK.VOLUME_DOWN))}>{@render ic('voldown')}<span class="m-t">{t('音量 −')}</span></button>
          {#if narrow}<button class="m-item" role="menuitem" onclick={() => more(() => stream?.send({ t: 'rotate' }))}>{@render ic('rotate')}<span class="m-t">{t('旋转')}</span></button>{/if}
          <button class="m-item" role="menuitem" onclick={() => more(() => stream?.send({ t: 'notif' }))}>{@render ic('notif')}<span class="m-t">{t('下拉通知栏')}</span></button>
          <button class="m-item" role="menuitem" disabled={!gotFrame} onclick={shot}>{@render ic('shot')}<span class="m-t">{t('截图')}</span></button>
          {#if rec && rec.serial === current.serial}
            <button class="m-item" role="menuitem" disabled={recBusy} onclick={() => { moreMenu = false; recStop(); }}>{@render ic('rec')}<span class="m-t">{t('停止录屏')}</span><span class="m-sub">{mmss(recLeft)}</span></button>
          {:else}
            <button class="m-item" role="menuitem" disabled={recBusy || !!rec} onclick={recStart}>{@render ic('rec')}<span class="m-t">{t('开始录屏')}</span><span class="m-sub">{t('最长 3 分钟')}</span></button>
          {/if}
          {#if current.serial.includes(':')}
            <div class="m-sep"></div>
            <button class="m-item" role="menuitem" onclick={wlDisconnect}>{@render ic('wifi')}<span class="m-t">{t('断开无线连接')}</span></button>
          {/if}
          {#if stoppable}
            <div class="m-sep"></div>
            <button class="m-item crit" role="menuitem" disabled={busy === current.serial} onclick={stopCurrent}>{@render ic('stop')}<span class="m-t">{t('关闭模拟器')}</span></button>
          {/if}
        {:else}
          <button class="m-item" role="menuitem" onclick={() => more(() => refresh(true))}>{@render ic('refresh')}<span class="m-t">{t('重新检查环境')}</span></button>
        {/if}
      </div>
    {/if}
  </div>

  <!-- 窄卡片：画面 / 各子页切换（可横滑） -->
  {#if studio && !wide}
    <div class="aw-tabs">
      <div class="tabs" role="tablist" aria-label={t('安卓工具')}>
        <button class="tab" class:on={showScreen} role="tab" aria-selected={showScreen} onclick={() => selectSub('screen')}>{t('画面')}</button>
        {#each tabs as tb (tb.key)}
          <button class="tab" class:on={!showScreen && effSub === tb.key} role="tab" aria-selected={!showScreen && effSub === tb.key} onclick={() => selectSub(tb.key)}>{tb.label()}</button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="aw-body">
  <div class="aw-stage" class:hid={screenHidden} bind:this={stageEl} role="application" aria-label={t('安卓设备画面')}
    ondragover={stageDragOver} ondragleave={stageDragLeave} ondrop={stageDropped}>
    {#if loadErr}
      <div class="aw-empty"><div class="t1">{t('打不开安卓设备')}</div><div class="t2">{loadErr}</div></div>
    {:else if !doc}
      <div class="aw-empty"><div class="t2">{t('正在检查安卓环境…')}</div></div>
    {:else if sdkMissing}
      <div class="aw-empty">
        {@render bigIcon()}
        <div class="t1">{t('没有找到 Android SDK')}</div>
        <div class="t2">{t('装好 Android Studio（或命令行工具）后，在「设置 › 功能扩展 › 安卓模拟器」里填 SDK 位置；也可以让 Claude 帮你装。')}</div>
      </div>
    {:else if !codecOk && !current}
      <div class="aw-empty"><div class="t1">{t('这个浏览器放不了画面')}</div><div class="t2">{t('需要支持 WebCodecs 的浏览器（Chrome、Edge 或 bridge 客户端）。')}</div></div>
    {:else if !current}
      <div class="aw-empty">
        {@render bigIcon()}
        <div class="t1">{t('启动一台安卓设备')}</div>
        {#if avdList.length}
          <div class="avds">
            {#each avdList as avd (avd)}
              {@const st = startingAvd(avd)}
              <div class="avd">
                <span class="avd-n">{avd.replace(/_/g, ' ')}</span>
                {#if st}
                  <span class="avd-st"><span class="spin"></span>{phase(st.state)}</span>
                {:else}
                  <button class="avd-go" onclick={() => startAvd(avd)}>{t('启动')}</button>
                  <button class="avd-more" class:on={avdMenu === avd} aria-label={t('更多启动方式')} aria-haspopup="menu" aria-expanded={avdMenu === avd}
                    onclick={() => (avdMenu = avdMenu === avd ? '' : avd)}>
                    <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5.8" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.2" cy="12" r="1.6"/></svg>
                  </button>
                  {#if avdMenu === avd}
                    <button class="menu-bd" aria-label={t('关闭菜单')} onclick={() => (avdMenu = '')}></button>
                    <div class="amenu right avd-menu" role="menu">
                      <button class="m-item" role="menuitem" onclick={() => startAvd(avd, true)}>{@render ic('power')}<span class="m-t">{t('冷启动')}</span></button>
                      <button class="m-item" role="menuitem" onclick={() => wipeStart(avd)}>{@render ic('wipe')}<span class="m-t">{t('清空数据并启动')}</span></button>
                      <div class="m-sep"></div>
                      <button class="m-item crit" role="menuitem" onclick={() => deleteAvd(avd)}>{@render ic('trash')}<span class="m-t">{t('删除')}</span></button>
                    </div>
                  {/if}
                {/if}
              </div>
              {#if errors[avd]}<div class="avd-err">{errors[avd].error}</div>{/if}
            {/each}
          </div>
          <button class="avd-new" onclick={openAvdForm}>{@render ic('plus')}{t('新建虚拟设备…')}</button>
          <div class="t2">{t('用 USB 或无线调试连到这台电脑的手机也会出现在这里。')}</div>
        {:else}
          <div class="t2">{t('还没有虚拟设备。新建一台，或者让 Claude 用 android 工具建。')}</div>
          <button class="avd-new" onclick={openAvdForm}>{@render ic('plus')}{t('新建虚拟设备…')}</button>
        {/if}
      </div>
    {:else if !codecOk}
      <div class="aw-empty"><div class="t1">{t('这个浏览器放不了画面')}</div><div class="t2">{t('需要支持 WebCodecs 的浏览器（Chrome、Edge 或 bridge 客户端）。Logcat、应用、文件等子页照样能用。')}</div></div>
    {/if}
    {#if current && codecOk && !loadErr && doc && !sdkMissing}
      <div class="cwrap" style="width:{fit.w}px;height:{fit.h}px" class:ready={gotFrame}>
        <canvas bind:this={canvasEl}
          onpointerdown={onPointerDown} onpointermove={onPointerMove} onpointerup={onPointerUp} onpointercancel={onPointerUp}
          onwheel={onWheel} oncontextmenu={(e) => e.preventDefault()}></canvas>
        {#key ripple?.n}
          {#if ripple}<span class="ripple" style="left:{ripple.x * 100}%;top:{ripple.y * 100}%"></span>{/if}
        {/key}
        {#if hl}<span class="hlbox" style={hlStyle(hl)}></span>{/if}
        {#if agentLive}<span class="agent-chip">{t('Claude 操作中')}</span>{/if}
        {#if statusText}
          <div class="veil"><span class="spin" class:still={conn === 'failed' || !!endedMsg}></span><span>{statusText}</span>
            {#if conn === 'failed' || endedMsg}<button class="retry" onclick={() => { endedMsg = ''; picked = current.serial; stream?.reconnect(); }}>{t('重试')}</button>{/if}
          </div>
        {/if}
      </div>
    {/if}
    {#if stageDrop}<div class="stage-drop">{t('松手安装 apk')}</div>{/if}
    <textarea bind:this={imeEl} class="ime" aria-hidden="true" tabindex="-1" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="enter"
      onkeydown={onKeyDown} onkeyup={onKeyUp} oninput={flushIme} onpaste={onPaste}
      oncompositionstart={() => (composing = true)} oncompositionend={() => { composing = false; flushIme(); }}
      onblur={() => (kbOn = false)}></textarea>
  </div>

  {#if studio}
    <div class="aw-side" class:hid={!paneOn}>
      {#if wide}
        <div class="side-tabs">
          <div class="tabs" role="tablist" aria-label={t('安卓工具')}>
            {#each tabs as tb (tb.key)}
              <button class="tab" class:on={effSub === tb.key} role="tab" aria-selected={effSub === tb.key} onclick={() => selectSub(tb.key)}>{tb.label()}</button>
            {/each}
          </div>
        </div>
      {/if}
      {#key current.serial}
        {#each tabs as tb (tb.key)}
          {#if visited[current.serial + ':' + tb.key]}
            {@const on = paneOn && effSub === tb.key}
            <div class="pane" class:hid={!on} role="tabpanel">
              {#if tb.key === 'logcat'}<LogcatPane serial={current.serial} active={on} {flash} />
              {:else if tb.key === 'apps'}<AppsPane serial={current.serial} active={on} {flash} install={installApk} {installing} tick={appsTick} />
              {:else if tb.key === 'files'}<FilesPane serial={current.serial} active={on} {flash} />
              {:else if tb.key === 'controls'}<ControlsPane serial={current.serial} />
              {:else if tb.key === 'snapshots'}<SnapshotsPane serial={current.serial} active={on} />
              {:else if tb.key === 'inspector'}<InspectorPane serial={current.serial} onhover={(b) => (hlHover = b)} onpick={onInspectPick} />{/if}
            </div>
          {/if}
        {/each}
      {/key}
    </div>
  {/if}
  </div>

  {#if installing && !(paneOn && effSub === 'apps')}
    <div class="inst-chip"><span class="spin"></span>{installing.pct < 1 ? t('正在上传 {name} {pct}%', { name: installing.name, pct: Math.round(installing.pct * 100) }) : t('正在安装 {name}…', { name: installing.name })}</div>
  {/if}
  {#if toast}<div class="toast">{toast}</div>{/if}

  <!-- 无线连接手机 -->
  {#if wl}
    <button class="menu-bd dim" aria-label={t('关闭')} onclick={() => { if (!wl?.busy) wl = null; }}></button>
    <div class="avd-form" role="dialog" aria-label={t('无线连接手机')}>
      <div class="af-h">{t('无线连接手机')}</div>
      <div class="af-note">{t('手机和这台服务器要在同一个局域网。手机上打开 开发者选项 › 无线调试：第一次先点「使用配对码配对设备」配对，之后只要连接。')}</div>
      <label class="af-row"><span>{t('IP 地址')}</span>
        <input class="af-in" value={wl.host} placeholder="192.168.1.20" spellcheck="false" autocapitalize="off" inputmode="decimal" disabled={!!wl.busy}
          oninput={(e) => (wl = { ...wl, host: e.currentTarget.value })} />
      </label>
      <div class="af-sub">{t('第一次：配对')}</div>
      <label class="af-row"><span>{t('配对端口')}</span>
        <input class="af-in" value={wl.pairPort} placeholder="37xxx" inputmode="numeric" disabled={!!wl.busy} oninput={(e) => (wl = { ...wl, pairPort: e.currentTarget.value.replace(/\D/g, '') })} />
      </label>
      <label class="af-row"><span>{t('配对码')}</span>
        <input class="af-in" value={wl.code} placeholder="123456" inputmode="numeric" maxlength="6" disabled={!!wl.busy}
          oninput={(e) => (wl = { ...wl, code: e.currentTarget.value.replace(/\D/g, '') })} onkeydown={(e) => { if (e.key === 'Enter') wlPair(); }} />
      </label>
      <div class="af-acts"><button class="af-btn" disabled={!!wl.busy} onclick={wlPair}>{#if wl.busy === 'pair'}<span class="spin"></span>{/if}{t('配对')}</button></div>
      <div class="af-sub">{t('连接')}</div>
      <label class="af-row"><span>{t('端口')}</span>
        <input class="af-in" value={wl.port} placeholder="4xxxx" inputmode="numeric" disabled={!!wl.busy}
          oninput={(e) => (wl = { ...wl, port: e.currentTarget.value.replace(/\D/g, '') })} onkeydown={(e) => { if (e.key === 'Enter') wlConnect(); }} />
      </label>
      {#if wl.msg}<div class="af-note ok">{wl.msg}</div>{/if}
      {#if wl.err}<div class="af-err">{wl.err}</div>{/if}
      <div class="af-acts">
        <button class="af-btn" disabled={!!wl.busy} onclick={() => (wl = null)}>{t('取消')}</button>
        <button class="af-btn pri" disabled={!!wl.busy} onclick={wlConnect}>{#if wl.busy === 'connect'}<span class="spin"></span>{/if}{t('连接')}</button>
      </div>
    </div>
  {/if}

  <!-- 新建虚拟设备 -->
  {#if avdForm}
    <button class="menu-bd dim" aria-label={t('关闭')} onclick={() => { if (!avdForm?.busy) avdForm = null; }}></button>
    <div class="avd-form" role="dialog" aria-label={t('新建虚拟设备')}>
      <div class="af-h">{t('新建虚拟设备')}</div>
      {#if avdOptsErr}
        <div class="af-err">{avdOptsErr}</div>
      {:else if !avdOpts}
        <div class="af-note"><span class="spin"></span>{t('正在读取机型和系统镜像…')}</div>
      {:else if !avdOpts.images.length}
        <div class="af-note">{t('还没有装系统镜像。在 Android Studio 的 SDK Manager 里装一个，或者让 Claude 用 sdkmanager 装。')}</div>
      {:else}
        <label class="af-row"><span>{t('名字')}</span>
          <input class="af-in" value={avdForm.name} spellcheck="false" autocapitalize="off" disabled={avdForm.busy}
            oninput={(e) => (avdForm = { ...avdForm, name: e.currentTarget.value, touched: true })}
            onkeydown={(e) => { if (e.key === 'Enter') createAvd(); }} />
        </label>
        <label class="af-row"><span>{t('机型')}</span>
          <select class="af-in" value={avdForm.device} disabled={avdForm.busy} onchange={(e) => avdFormChange({ device: e.currentTarget.value })}>
            {#each avdOpts.devices as d (d)}<option value={d}>{prettyDevice(d).replace(/_/g, ' ')}</option>{/each}
          </select>
        </label>
        <label class="af-row"><span>{t('系统镜像')}</span>
          <select class="af-in" value={avdForm.image} disabled={avdForm.busy} onchange={(e) => avdFormChange({ image: e.currentTarget.value })}>
            {#each avdOpts.images as im (im.id)}<option value={im.id}>{im.api} · {im.tag} · {im.abi}</option>{/each}
          </select>
        </label>
      {/if}
      {#if avdForm.err}<div class="af-err">{avdForm.err}</div>{/if}
      <div class="af-acts">
        <button class="af-btn" disabled={avdForm.busy} onclick={() => (avdForm = null)}>{t('取消')}</button>
        <button class="af-btn pri" disabled={avdForm.busy || !avdOpts?.images?.length} onclick={createAvd}>
          {#if avdForm.busy}<span class="spin"></span>{t('正在新建…')}{:else}{t('新建')}{/if}
        </button>
      </div>
    </div>
  {/if}
</div>

{#snippet kindIcon(kind)}
  {#if kind === 'emulator'}
    <svg class="m-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3" width="10" height="18" rx="2.4"/><path d="M4 9v6M20 9v6"/></svg>
  {:else}
    <svg class="m-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3" width="10" height="18" rx="2.4"/><path d="M11 17.8h2"/></svg>
  {/if}
{/snippet}
{#snippet ic(name)}
  <svg class="m-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    {#if name === 'power'}<path d="M12 4v7M7.4 7.2a7 7 0 1 0 9.2 0"/>
    {:else if name === 'volup'}<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3zM16 9.5v5M13.5 12h5"/>
    {:else if name === 'voldown'}<path d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3zM14 12h5"/>
    {:else if name === 'rotate'}<path d="M4 13.5a8 8 0 0 0 6 6.3M20 10.5a8 8 0 0 0-6-6.3"/><rect x="8" y="3.5" width="8" height="12.5" rx="1.6" transform="rotate(-45 12 12)"/>
    {:else if name === 'notif'}<path d="M6.5 16.5h11l-1.3-2V10a4.2 4.2 0 0 0-8.4 0v4.5zM10.3 19a1.9 1.9 0 0 0 3.4 0"/>
    {:else if name === 'shot'}<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.8" r="3.2"/>
    {:else if name === 'stop'}<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>
    {:else if name === 'plus'}<path d="M12 5.5v13M5.5 12h13"/>
    {:else if name === 'wipe'}<path d="M9.5 19.5h10M4.6 14.2l8.8-8.8a2 2 0 0 1 2.8 0l2.4 2.4a2 2 0 0 1 0 2.8L11 18.2a2 2 0 0 1-1.4.6H8.3a2 2 0 0 1-1.4-.6l-2.3-2.3a1.2 1.2 0 0 1 0-1.7zM9 9.8l5.2 5.2"/>
    {:else if name === 'trash'}<path d="M5 7h14M10 7V5.2h4V7M7 7l.8 12h8.4L17 7"/>
    {:else if name === 'rec'}<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none"/>
    {:else if name === 'wifi'}<path d="M4.5 9.6a11 11 0 0 1 15 0M7.4 12.8a6.6 6.6 0 0 1 9.2 0M10.3 15.9a2.4 2.4 0 0 1 3.4 0"/><circle cx="12" cy="18.6" r=".7" fill="currentColor" stroke="none"/>
    {:else}<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>{/if}
  </svg>
{/snippet}
{#snippet bigIcon()}
  <svg class="big" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M10.5 18.6h3"/></svg>
{/snippet}

<style>
  .aw { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; --ctl: 30px; }
  .aw.coarse { --ctl: 36px; }

  /* —— 工具条 —— */
  .aw-bar { flex: none; position: relative; z-index: 9; display: flex; align-items: center; gap: 2px; padding: 6px 8px; }
  .sp { flex: 1; }
  .nbtn { width: var(--ctl); height: var(--ctl); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--serif); flex: none; }
  .nbtn svg { width: 17px; height: 17px; }
  .nbtn:not(:disabled):active { background: var(--hover); }
  @media (hover: hover) { .nbtn:not(:disabled):hover { background: var(--hover); color: var(--text); } }
  .nbtn.on { color: var(--coral); }
  .devbtn { min-width: 0; display: flex; align-items: center; gap: 7px; height: var(--ctl); padding: 0 8px 0 10px; border-radius: 9px;
    background: var(--hover); color: var(--text); font-size: 12.5px; max-width: 62%; }
  .devbtn.on { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--coral) 45%, transparent); }
  .dev-t { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .chev { width: 11px; height: 11px; color: var(--muted); flex: none; transition: transform .15s ease; }
  .devbtn.on .chev { transform: rotate(180deg); }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); flex: none; transition: background .2s ease; }
  .dot.live { background: var(--ok); }
  .dot.warn { background: var(--coral); }

  /* —— 菜单 —— */
  .menu-bd { position: fixed; inset: 0; z-index: 1; cursor: default; }
  .amenu { position: absolute; top: calc(100% - 2px); z-index: 2; min-width: 220px; max-width: calc(100% - 16px); padding: 6px;
    display: flex; flex-direction: column; gap: 1px; background: var(--q-card); border-radius: 12px;
    box-shadow: var(--q-shadow), 0 0 0 .5px var(--divider); animation: amIn .16s cubic-bezier(.2,.8,.2,1); }
  .amenu.left { left: 8px; transform-origin: top left; }
  .amenu.right { right: 8px; transform-origin: top right; }
  @keyframes amIn { from { opacity: 0; transform: translateY(-4px) scale(.98); } to { opacity: 1; transform: none; } }
  .m-h { padding: 6px 8px 4px; font-size: 11px; color: var(--muted); }
  .m-item { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 8px; border-radius: 8px; color: var(--text); font-size: 13px; text-align: left; }
  .coarse .m-item { height: 40px; }
  .m-item:disabled { opacity: .5; }
  .m-item:not(:disabled):active { background: var(--hover); }
  @media (hover: hover) { .m-item:not(:disabled):hover { background: var(--hover); } }
  .m-item.sel { color: var(--coral); }
  .m-item.crit, .m-item.crit :global(.m-ic) { color: var(--crit); }
  .m-ic { width: 16px; height: 16px; flex: none; color: var(--serif); }
  .m-t { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .m-sub { flex: none; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .m-sep { height: 1px; margin: 4px -6px; background: var(--divider); }
  .m-empty { padding: 10px 8px; font-size: 12.5px; color: var(--muted); }

  /* —— 画面 —— */
  .aw-stage { flex: 1; min-height: 0; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden;
    margin: 0 8px 8px; border-radius: 10px; background: color-mix(in srgb, var(--bg) 70%, black); }
  :global(html[data-theme="light"]) .aw-stage { background: color-mix(in srgb, var(--bg) 88%, black); }
  .aw.coarse .aw-stage { margin: 0 4px 4px; border-radius: 8px; }
  .cwrap { position: relative; flex: none; border-radius: 14px; overflow: hidden; background: #000;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 10%, transparent); }
  .aw.coarse .cwrap { border-radius: 10px; }
  .cwrap canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: default; opacity: 0; transition: opacity .2s ease; }
  .cwrap.ready canvas { opacity: 1; }
  .ripple { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; pointer-events: none;
    border: 2px solid var(--coral); background: color-mix(in srgb, var(--coral) 22%, transparent); animation: rip .7s cubic-bezier(.2,.7,.3,1) forwards; }
  @keyframes rip { from { transform: scale(.35); opacity: 1; } to { transform: scale(1.25); opacity: 0; } }
  .agent-chip { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); padding: 4px 10px; border-radius: 10px; pointer-events: none;
    font-size: 11.5px; color: #fff; background: color-mix(in srgb, var(--coral) 82%, black); box-shadow: 0 2px 8px rgba(0,0,0,.25);
    animation: chipIn .18s ease-out; white-space: nowrap; }
  @keyframes chipIn { from { opacity: 0; transform: translate(-50%, -4px); } to { opacity: 1; transform: translateX(-50%); } }
  .veil { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
    padding: 16px; text-align: center; color: rgba(255,255,255,.78); font-size: 12.5px; line-height: 1.5; background: rgba(0,0,0,.35); }
  .retry { margin-top: 2px; height: 28px; padding: 0 14px; border-radius: 14px; background: rgba(255,255,255,.14); color: #fff; font-size: 12.5px; }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 1.6px solid currentColor; border-right-color: transparent; animation: sp .8s linear infinite; opacity: .8; flex: none; }
  .spin.still { animation: none; border-right-color: currentColor; opacity: .35; }
  @keyframes sp { to { transform: rotate(360deg); } }

  .aw-empty { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--muted); padding: 24px; text-align: center; max-width: 340px; }
  .big { width: 34px; height: 34px; margin-bottom: 8px; opacity: .7; }
  .t1 { font-size: 14.5px; font-weight: 500; color: var(--serif); }
  .t2 { font-size: 12.5px; line-height: 1.55; }
  .avds { width: 100%; display: flex; flex-direction: column; gap: 6px; margin: 10px 0 6px; }
  .avd { display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 6px 0 14px; border-radius: 10px; background: var(--hover); }
  .avd-n { flex: 1; min-width: 0; text-align: left; color: var(--text); font-size: 13px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .avd-go { height: 32px; padding: 0 14px; border-radius: 8px; background: var(--text); color: var(--bg); font-size: 12.5px; font-weight: 500; }
  .avd-go:active { opacity: .8; }
  .avd-st { display: flex; align-items: center; gap: 8px; padding-right: 8px; font-size: 12.5px; color: var(--muted); }
  .avd-st .spin { width: 13px; height: 13px; }
  .avd-err { margin: -2px 4px 4px; text-align: left; font-size: 12px; color: var(--crit); line-height: 1.45; }

  /* 输入法接收框：不可见但能拿焦点（手机上点「键盘」唤起本机键盘） */
  .ime { position: absolute; left: 0; bottom: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; resize: none; pointer-events: none; font-size: 16px; }
  .toast { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); max-width: calc(100% - 32px); padding: 8px 14px; border-radius: 10px;
    background: var(--q-card); color: var(--text); font-size: 12.5px; line-height: 1.5; white-space: pre-line; word-break: break-word;
    box-shadow: var(--q-shadow), 0 0 0 .5px var(--divider); z-index: 12; max-height: 40%; overflow: auto; }

  /* —— 布局：宽卡片左画面右子页；窄卡片分段切换 —— */
  .aw-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .aw.wide .aw-body { flex-direction: row; }
  .aw.wide.studio .aw-stage { flex: 0 1 42%; min-width: 240px; max-width: 520px; margin-right: 4px; }
  .aw-stage.hid, .aw-side.hid, .pane.hid { display: none; }
  .aw-side { flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; margin: 0 8px 8px; border-radius: 10px;
    box-shadow: inset 0 0 0 1px var(--divider); overflow: hidden; }
  .aw.wide .aw-side { margin-left: 4px; }
  .aw.coarse .aw-side { margin: 0 4px 4px; border-radius: 8px; }
  .pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .aw-tabs { flex: none; padding: 0 8px 6px; }
  .aw.coarse .aw-tabs { padding: 0 4px 4px; }
  .side-tabs { flex: none; padding: 8px 10px 2px; }
  .tabs { display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--hover); overflow-x: auto; scrollbar-width: none; overscroll-behavior-x: contain; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { flex: 1 0 auto; display: flex; align-items: center; justify-content: center; height: 28px; padding: 0 11px; border-radius: 7px; white-space: nowrap;
    color: var(--muted); font-size: 12.5px; transition: background-color .12s ease, color .12s ease; }
  .tab.on { background: var(--card); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
  @media (hover: hover) { .tab:not(.on):hover { color: var(--text); } }
  .aw.coarse .tab { height: 36px; padding: 0 14px; font-size: 13px; }

  /* 控件树高亮框（设备坐标 → 百分比，同 .ripple 的做法） */
  .hlbox { position: absolute; pointer-events: none; box-sizing: border-box; border: 1.5px solid var(--coral); border-radius: 2px;
    background: color-mix(in srgb, var(--coral) 14%, transparent); box-shadow: 0 0 0 1px rgba(0,0,0,.35); z-index: 2; transition: all .12s ease; }

  /* 拖 apk 到画面区 */
  .stage-drop { position: absolute; inset: 8px; z-index: 6; display: flex; align-items: center; justify-content: center; pointer-events: none; border-radius: 10px;
    border: 1.5px dashed rgba(255,255,255,.45); background: rgba(0,0,0,.5); color: #fff; font-size: 13px; }
  .inst-chip { position: absolute; left: 50%; top: calc(var(--ctl) + 18px); transform: translateX(-50%); z-index: 11; display: flex; align-items: center; gap: 8px;
    max-width: calc(100% - 32px); padding: 6px 12px; border-radius: 10px; background: var(--q-card); color: var(--text); font-size: 12px; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; box-shadow: var(--q-shadow), 0 0 0 .5px var(--divider); }
  .inst-chip .spin { width: 12px; height: 12px; }

  /* 空态 AVD 行的「⋯」菜单 */
  .avd { position: relative; }
  .avd-more { width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--serif); flex: none; }
  .avd-more svg { width: 16px; height: 16px; }
  .avd-more.on { color: var(--coral); }
  .avd-more:active { background: var(--hover-strong); }
  @media (hover: hover) { .avd-more:hover { background: var(--hover-strong); } }
  .avd-menu { top: calc(100% + 2px); right: 0; min-width: 190px; }
  .avd-new { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; margin: 0 0 6px; border-radius: 8px; color: var(--serif); font-size: 12.5px;
    box-shadow: inset 0 0 0 1px var(--divider); }
  .avd-new :global(.m-ic) { width: 14px; height: 14px; }
  @media (hover: hover) { .avd-new:hover { background: var(--hover); color: var(--text); } }
  .aw.coarse .avd-more, .aw.coarse .avd-go, .aw.coarse .avd-new { height: 36px; }
  .aw.coarse .avd-more { width: 36px; }

  /* 新建虚拟设备小表单 */
  .menu-bd.dim { position: absolute; z-index: 13; background: rgba(0,0,0,.22); border-radius: inherit; }
  .avd-form { position: absolute; left: 50%; top: 50px; transform: translateX(-50%); z-index: 14; width: min(340px, calc(100% - 24px)); padding: 14px;
    display: flex; flex-direction: column; gap: 10px; background: var(--q-card); border-radius: 12px; box-shadow: var(--q-shadow), 0 0 0 .5px var(--divider);
    animation: amIn .16s cubic-bezier(.2,.8,.2,1); }
  .af-h { font-size: 13.5px; font-weight: 500; color: var(--text); }
  .af-row { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--muted); }
  .af-in { height: var(--ctl); padding: 0 9px; border-radius: 8px; border: none; outline: none; background: var(--hover); color: var(--text); font: inherit; font-size: 12.5px; }
  .af-in option { background: var(--q-card); color: var(--text); }
  .af-in:focus { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--coral) 55%, transparent); }
  .aw.coarse .af-in { font-size: 16px; }
  .af-note { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
  .af-note .spin { width: 13px; height: 13px; }
  .af-note.ok { color: var(--ok); }
  .af-sub { margin-top: 4px; font-size: 11.5px; color: var(--muted); }
  /* 录屏计时：红点 + 剩余时间，点它停止并下载 */
  .recbtn { flex: none; display: flex; align-items: center; gap: 6px; height: var(--ctl); padding: 0 9px; margin-right: 2px; border-radius: 8px;
    font-size: 12px; color: var(--crit); font-variant-numeric: tabular-nums; background: color-mix(in srgb, var(--crit) 10%, transparent); }
  .recbtn:disabled { opacity: .6; }
  .rec-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--crit); animation: recPulse 1.2s ease-in-out infinite; }
  @keyframes recPulse { 50% { opacity: .35; } }
  .af-err { font-size: 12px; color: var(--crit); line-height: 1.45; white-space: pre-wrap; word-break: break-word; }
  .af-acts { display: flex; justify-content: flex-end; gap: 6px; margin-top: 2px; }
  .af-btn { display: inline-flex; align-items: center; gap: 6px; height: var(--ctl); padding: 0 14px; border-radius: 8px; color: var(--serif); font-size: 12.5px;
    box-shadow: inset 0 0 0 1px var(--divider); }
  .af-btn.pri { background: var(--text); color: var(--bg); box-shadow: none; font-weight: 500; }
  .af-btn:disabled { opacity: .5; }
  .af-btn .spin { width: 12px; height: 12px; }
</style>
