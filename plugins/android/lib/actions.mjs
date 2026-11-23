// Claude 的安卓工具（mcp__android__android）的全部动作：与工作区「安卓」卡共用同一台设备。
//
// 看画面 = 截屏（screencap）+ 控件树（uiautomator dump，中文可靠；Android CLI 的 layout 在 Windows 上把非 ASCII 读成乱码，没用它）。
// 元素清单的坐标、截图上画的编号框、tap 的 x/y，全按【返回的那张截图】的像素算（长边缩到 1200）。
// 输入走 scrcpy 控制通道：ASCII 直接注入，中文 / emoji 写剪贴板后粘贴。
// 护栏：清数据、卸载、建 / 删虚拟设备由模型先问用户（描述里写明）；只用 SDK 自带的 adb；只停 bridge 开的模拟器。

import path from 'node:path';
import os from 'node:os';
import { existsSync, readdirSync, statSync, readFileSync, rmSync } from 'node:fs';
// sharp 用 bridge 自带的那份（插件目录没有 node_modules 时 bridge 的解析钩子回落到它）；用到时才加载，单测不需要它
let sharpP = null;
const loadSharp = () => (sharpP ||= import('sharp').then((m) => m.default));
import { sdkRoot, toolPath, requireTool, run, ok, brief, doctor, listAvds, installedImages } from './sdk.mjs';
import { adb, shell, shq, execOut, validSerial } from './adb.mjs';
import * as emu from './emulators.mjs';
import { mirrorOf, existingMirror } from './scrcpy.mjs';
import { deviceTable, deviceLabel } from './devices.mjs';

const SHOT_LONG = 1200;           // 回给模型的截图长边
const LEASE_MS = 120_000;         // 别的会话在这么久内动过这台设备 → 先别抢
const HUMAN_MS = 8_000;           // 用户在卡片里操作后这么久内，结果里提醒「用户刚动过」
const MAX_ELEMENTS = 80;

const KEYS = {
  back: 4, home: 3, recents: 187, app_switch: 187, enter: 66, delete: 67, backspace: 67, forward_delete: 112, tab: 61,
  escape: 111, space: 62, menu: 82, search: 84, power: 26, volume_up: 24, volume_down: 25, volume_mute: 164,
  up: 19, down: 20, left: 21, right: 22, dpad_center: 23, page_up: 92, page_down: 93, move_home: 122, move_end: 123,
  camera: 27, wakeup: 224, sleep: 223, notifications: 83, settings: 176, all_apps: 284, paste: 279, copy: 278, cut: 277,
};

export const ANDROID_DESCRIPTION = `操作安卓设备（模拟器，或用 USB / 无线调试连在 bridge 这台电脑上的真机）。和用户工作区里的「安卓」卡是同一台设备：你点的每一下用户都实时看得见，用户也可能随时伸手操作（结果里会提醒）。
动作（action）：
· doctor 体检 SDK / 加速 / 镜像 / 虚拟设备，缺什么给出安装步骤；devices 列设备
· start(avd?, cold?) 启动虚拟设备并等它开机（快速启动约 5 秒，冷启动约 20 秒）；stop(serial) 只关 bridge 开的模拟器；create_avd(name?, device?, image?)——【先问过用户】
· install(path) 装工作区里的 apk（会报出包名与启动 Activity）；launch(package, activity?)；stop_app(package)；open_url(url)；apps 列第三方应用；clear_data / uninstall(package)——【先问过用户】
· screen 看画面：截图（框出可交互元素并编号）+ 元素清单「[编号] 「文字」 类型 能力 @左,上,右,下」；ui_tree 只要元素清单（full:true 连不可交互的也列）
· tap(index | text | x,y)、long_press、swipe(x,y,to_x,to_y,ms?)、scroll(direction, index?)、input(text, index?/target?, submit?)、key(key)、wait(text? | ms?)
  这几样做完默认带回新画面（observe:false 只回文字）。坐标一律按最近一次截图的像素；编号只对最近一次画面有效，优先用 index / text。
· logs(package?, level?, lines?, grep?, crash?) 读 logcat（给了包名只看它的进程；crash:true 只看崩溃缓冲区）
· emu(kind, …) 模拟器扩展控制：geo(lat,lng) 定位、battery(level?, charging?)、rotate、sms(from,text)、call(number) / hangup、fold / unfold、finger(id) 指纹、network(speed: full|lte|edge|gsm…)
· snapshot(op: save|load|list|delete, name) 模拟器快照：做 UI 测试前存一个，测完 load 回到干净状态
· record(op: start|stop, path?) 录屏（最长 3 分钟）：stop 时存成 mp4，path 相对工作空间（默认 recordings/ 下），演示操作流程或复现 bug 时用
多台设备在线时用 serial 指定；不给就用用户正在看的那台 / bridge 开的那台。构建 apk 用你自己的 Bash 跑 gradlew；要更细的 adb 命令也可以用 Bash，adb 路径见 doctor（只用 SDK 里的 adb，别跑工作区里的）。`;

// 参数表只写一份：Claude 的进程内 MCP 用 androidParams(z) 转成 zod，dimensio / Antigravity 经插件工具通道（ctx.tools.add）直接用这张表
export const ANDROID_PARAMS = {
  action: { type: 'string', required: true, enum: ['doctor', 'devices', 'start', 'stop', 'create_avd', 'install', 'launch', 'stop_app', 'open_url', 'apps', 'clear_data', 'uninstall',
    'screen', 'ui_tree', 'tap', 'long_press', 'swipe', 'scroll', 'input', 'key', 'wait', 'logs', 'emu', 'snapshot', 'record'] },
  serial: { type: 'string', desc: '设备序列号（devices 里的 serial）；不给 = 用户正在看的 / bridge 开的那台' },
  avd: { type: 'string', desc: 'start：虚拟设备名（不给 = 第一台）' },
  cold: { type: 'boolean', desc: 'start：冷启动（不读快照）' },
  name: { type: 'string', desc: 'create_avd：新设备名；snapshot：快照名' },
  device: { type: 'string', desc: 'create_avd：机型（如 pixel_8、medium_phone、pixel_tablet）' },
  image: { type: 'string', desc: 'create_avd：系统镜像包名（doctor 里列出已装的）' },
  path: { type: 'string', desc: 'install：apk 路径（相对工作空间或绝对路径）' },
  package: { type: 'string', desc: '应用包名' },
  activity: { type: 'string', desc: 'launch：要启动的 Activity（如 .MainActivity）；不给 = 启动器入口' },
  url: { type: 'string' },
  index: { type: 'integer', desc: '元素编号（最近一次 screen / ui_tree / 带回画面里的）' },
  text: { type: 'string', desc: 'tap / wait：按文字（含 content-desc、resource-id）找元素；input：要输入的文字' },
  target: { type: 'string', desc: 'input：先点这个文字对应的输入框再输入' },
  submit: { type: 'boolean', desc: 'input：输完按回车' },
  x: { type: 'number' }, y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' },
  ms: { type: 'number', desc: 'swipe / long_press 时长；wait 单纯等待的毫秒数（≤15000）' },
  direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], desc: 'scroll：看更多下面的内容用 down' },
  key: { type: 'string', desc: 'key：back|home|recents|enter|delete|tab|escape|space|menu|search|power|volume_up|volume_down|up|down|left|right|page_up|page_down|notifications|settings，或安卓键码数字' },
  observe: { type: 'boolean', desc: '动作做完要不要带回新画面（默认 true）' },
  full: { type: 'boolean', desc: 'ui_tree：连不可交互的元素也列出' },
  level: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E', 'F'], desc: 'logs：最低级别（默认 I）' },
  lines: { type: 'integer', desc: 'logs：最多多少行（默认 200，最多 2000）' },
  grep: { type: 'string', desc: 'logs：只留包含这段文字的行（不分大小写）' },
  crash: { type: 'boolean', desc: 'logs：只看崩溃缓冲区' },
  clear: { type: 'boolean', desc: 'logs：读完清空 logcat（下次只看新的）' },
  kind: { type: 'string', enum: ['geo', 'battery', 'rotate', 'sms', 'call', 'hangup', 'fold', 'unfold', 'finger', 'network'] },
  lat: { type: 'number' }, lng: { type: 'number' },
  level_pct: { type: 'number', desc: 'emu battery：电量 0-100' },
  charging: { type: 'boolean' },
  from: { type: 'string' }, number: { type: 'string' }, speed: { type: 'string' },
  op: { type: 'string', enum: ['save', 'load', 'list', 'delete', 'start', 'stop'], desc: 'snapshot：save|load|list|delete；record：start|stop' },
};

export function androidParams(z) {
  const out = {};
  for (const [k, s] of Object.entries(ANDROID_PARAMS)) {
    let t = s.type === 'boolean' ? z.boolean() : s.type === 'integer' ? z.number().int() : s.type === 'number' ? z.number() : s.enum ? z.enum(s.enum) : z.string();
    if (s.desc) t = t.describe(s.desc);
    out[k] = s.required ? t : t.optional();
  }
  return out;
}

// ── 结果 ───────────────────────────────────────────────────────────────────
const txt = (text) => ({ type: 'text', text });
const fail = (text) => ({ content: [txt(text)], isError: true });
const done = (...parts) => ({ content: parts.filter(Boolean) });

// ── 设备选择与租约 ─────────────────────────────────────────────────────────
const leases = new Map();   // serial → { owner, at }
const lastView = new Map(); // serial → { elements, scale, w, h, at }（index 定位用）

async function pickDevice(serial, owner, { mutate = true, force = false } = {}) {
  const table = await deviceTable();
  const online = table.filter((d) => d.state === 'device');
  let d;
  if (serial) {
    if (!validSerial(serial)) return { error: `设备序列号不合法：${serial}` };
    d = table.find((x) => x.serial === serial);
    if (!d) return { error: `没有这台设备：${serial}。在线的：${online.map((x) => x.serial).join('、') || '（没有）'}` };
    if (d.state !== 'device') return { error: `${serial} 现在是 ${d.state} 状态，还不能操作${d.state === 'unauthorized' ? '（手机上要点「允许 USB 调试」）' : ''}` };
  } else {
    if (!online.length) {
      const avds = await listAvds();
      return { error: avds.length ? `没有在线设备。先 action:"start" 启动一台虚拟设备（有：${avds.join('、')}）。` : '没有在线设备，也没有虚拟设备。action:"doctor" 看看缺什么。' };
    }
    d = online.find((x) => x.viewers > 0) || online.find((x) => x.managed) || online[0];
  }
  if (mutate) {
    const l = leases.get(d.serial);
    if (!force && l && l.owner !== owner && owner && Date.now() - l.at < LEASE_MS) {
      return { error: `${deviceLabel(d)}（${d.serial}）正被另一个会话使用（${Math.round((Date.now() - l.at) / 1000)} 秒前还在操作）。等它用完，或换一台设备。` };
    }
    if (owner) leases.set(d.serial, { owner, at: Date.now() });
    emu.touch(d.serial);
  }
  return { device: d, note: !serial && online.length > 1 ? `（在线 ${online.length} 台，用的是 ${deviceLabel(d)} ${d.serial}）` : '' };
}

function humanNote(serial) {
  const m = existingMirror(serial);
  const ago = m?.lastHuman ? Date.now() - m.lastHuman : Infinity;
  return ago < HUMAN_MS ? `⚠ 用户 ${Math.max(1, Math.round(ago / 1000))} 秒前在安卓卡里亲手操作过这台设备——先看画面再继续，别和用户抢。` : '';
}

/** 告诉卡片 agent 在点哪里（卡片上画一圈涟漪 + 「Claude 操作中」）。x、y 是设备像素。 */
function showAgent(serial, action, x, y) {
  const m = existingMirror(serial);
  if (!m || !m.viewers.size) return;
  const dev = lastView.get(serial);
  const W = dev?.devW || m.width; const H = dev?.devH || m.height;
  m.broadcastJson({ type: 'agent', action, ...(x != null && W ? { x: x / W, y: y / H } : {}) });
}

// ── 看画面 ─────────────────────────────────────────────────────────────────
const ATTR = /([\w-]+)="([^"]*)"/g;
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#10;/g, ' ').replace(/&#13;/g, '').replace(/&amp;/g, '&');

export function parseUiXml(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<node\b([^>]*?)\/?>/g)) {
    const a = {};
    for (const p of m[1].matchAll(ATTR)) a[p[1]] = unesc(p[2]);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(a.bounds || '');
    if (!b) continue;
    const [l, t, r, btm] = b.slice(1).map(Number);
    if (r - l < 2 || btm - t < 2) continue;
    const cls = (a.class || '').split('.').pop();
    out.push({
      text: a.text || '', desc: a['content-desc'] || '', id: (a['resource-id'] || '').replace(/^.*:id\//, ''), cls, pkg: a.package || '',
      clickable: a.clickable === 'true', longClickable: a['long-clickable'] === 'true', scrollable: a.scrollable === 'true',
      checkable: a.checkable === 'true', checked: a.checked === 'true', enabled: a.enabled !== 'false', focused: a.focused === 'true',
      selected: a.selected === 'true', password: a.password === 'true', editable: /EditText|AutoCompleteTextView/.test(cls),
      l, t, r, b: btm,
    });
  }
  return out;
}

const interactive = (e) => e.clickable || e.longClickable || e.scrollable || e.checkable || e.editable;

const CLI_PKG = 'com.android.cli.interact.instrumentation';
const busyUntil = new Map();   // serial → 时间戳：这之前 uiautomator 多半等不到空闲

/**
 * 控件树 → { elements, via, note }。两级：
 *   1) uiautomator dump：文字（中文等）准确；但界面一直在动（进度条、轮播）时等不到「空闲」，10 秒后才报错——限时 4.5 秒；
 *   2) Android CLI 的 layout --no-idle 兜底：不等空闲、约 1.7 秒；但它在 Windows 上按系统代码页解码，非 ASCII 文字会乱码，
 *      所以结果里提示「文字以截图为准」。两者都抢 UiAutomation：用 uiautomator 前停掉 CLI 的常驻服务，反之杀掉残留的 dump。
 */
export async function getElements(serial, { full = false } = {}) {
  // 先删旧文件：dump 失败时 cat 读到的是上一屏的旧树——模型会看到「截图是新页面、清单还是旧页面」（11-23 真模型实测撞到过）
  const F = '/data/local/tmp/bridge-ui.xml';
  const cmd = `rm -f ${F}; uiautomator dump ${full ? '' : '--compressed '}${F} >/dev/null 2>&1; cat ${F} 2>/dev/null`;
  // 这台设备刚因「等不到空闲」超时过：同一屏多半还在动，15 秒内直接走兜底，别每步白等 4.5 秒
  if (!((busyUntil.get(serial) || 0) > Date.now())) {
    for (let i = 0; i < 2; i++) {
      const t0 = Date.now();
      const xml = await shell(serial, cmd, { timeout: 4500 }).catch(() => '');
      if (xml.includes('<hierarchy')) { busyUntil.delete(serial); return { elements: parseUiXml(xml), via: 'uiautomator', note: '' }; }
      // 很快就失败 = 被 Android CLI 的常驻服务占着 UiAutomation（Killed）：停掉它再来一次；慢慢失败 = 等不到空闲，直接走兜底
      if (Date.now() - t0 > 2500) { busyUntil.set(serial, Date.now() + 15_000); break; }
      await shell(serial, `am force-stop ${CLI_PKG}`, { timeout: 8000 }).catch(() => {});
    }
  }
  const cli = toolPath('android');
  if (!cli) return { elements: [], via: '', note: '' };
  await shell(serial, 'pkill -f com.android.commands.uiautomator 2>/dev/null; true', { timeout: 5000 }).catch(() => {});
  const out = path.join(os.tmpdir(), `bridge-android-layout-${process.pid}-${Date.now()}.json`);
  try {
    let wins = null;
    for (let i = 0; i < 2; i++) {
      const r = await run(cli, ['layout', `--device=${serial}`, '--flat', '--no-idle', ...(full ? ['--full'] : []), `--output=${out}`], { timeout: 30_000 });
      if (!ok(r) || !existsSync(out)) return { elements: [], via: '', note: '' };
      wins = JSON.parse(readFileSync(out, 'utf8'));
      // 转场瞬间偶尔只读到系统栏、没有应用窗口：隔半秒再读一次
      if (wins.some((w) => w.type === 'APPLICATION' && (w.content || []).length)) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    const elements = parseCliLayout(wins);
    return { elements, via: 'android-cli', note: '（界面一直在动，控件树改用 Android CLI 免等待读取：中文等非 ASCII 文字可能是乱码，以截图为准）' };
  } catch { return { elements: [], via: '', note: '' }; }
  finally { try { rmSync(out, { force: true }); } catch {} }
}

/** Android CLI `layout --flat` 的输出：[{ type, content: [{ class, resource-id, text, content-desc, interactions[], state[], bounds }] }] */
export function parseCliLayout(windows) {
  const out = [];
  // 应用窗口排前面（模型最关心的），再是输入法、系统栏
  const rank = (w) => ({ APPLICATION: 0, INPUT_METHOD: 1 }[w?.type] ?? 2);
  for (const w of [...(Array.isArray(windows) ? windows : [])].sort((a, b) => rank(a) - rank(b))) {
    for (const e of w.content || []) {
      const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(e.bounds || '');
      if (!b) continue;
      const [l, t, r, btm] = b.slice(1).map(Number);
      if (r - l < 2 || btm - t < 2) continue;
      const inter = new Set(e.interactions || []); const st = new Set(e.state || []);
      const cls = String(e.class || '').split('.').pop();
      out.push({
        text: e.text || '', desc: e['content-desc'] || '', id: String(e['resource-id'] || '').replace(/^.*:id\//, ''), cls, pkg: '',
        clickable: inter.has('CLICKABLE'), longClickable: inter.has('LONG_CLICKABLE'), scrollable: inter.has('SCROLLABLE'),
        checkable: inter.has('CHECKABLE'), checked: st.has('CHECKED'), enabled: !st.has('DISABLED'), focused: st.has('FOCUSED'),
        selected: st.has('SELECTED'), password: inter.has('PASSWORD'), editable: inter.has('EDITABLE') || /EditText/.test(cls),
        l, t, r, b: btm,
      });
    }
  }
  return out;
}

async function foreground(serial) {
  // Android 15 上 dumpsys window 的 mCurrentFocus 常是 null；topResumedActivity 稳定
  const out = await shell(serial, "dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity|mResumedActivity'", { timeout: 8000 }).catch(() => '');
  const m = /\s([\w.]+)\/([\w.$]+)/.exec(out);
  return m ? `${m[1]}/${m[2].startsWith(m[1]) ? m[2].slice(m[1].length) : m[2]}` : '';
}

/** 截图 + 控件树 → { text, image, elements }。坐标都换算到返回截图的像素。 */
async function observe(serial, { image = true, full = false } = {}) {
  const [png, tree, fg] = await Promise.all([
    image ? execOut(serial, ['screencap', '-p'], { timeout: 20_000 }).catch(() => null) : Promise.resolve(null),
    getElements(serial, { full }), foreground(serial),
  ]);
  let devW = 0; let devH = 0;
  const sharp = png ? await loadSharp().catch(() => null) : null;
  if (png && sharp) { try { const meta = await sharp(png).metadata(); devW = meta.width; devH = meta.height; } catch {} }
  const all = tree.elements;
  if (!devW && all.length) { devW = Math.max(...all.map((e) => e.r)); devH = Math.max(...all.map((e) => e.b)); }
  const scale = devW && devH ? Math.min(1, SHOT_LONG / Math.max(devW, devH)) : 1;
  const S = (v) => Math.round(v * scale);
  const list = (full ? all : all.filter((e) => interactive(e) || e.text || e.desc))
    .filter((e) => e.r > 0 && e.b > 0 && (!devW || e.l < devW) && (!devH || e.t < devH))
    .slice(0, full ? 300 : MAX_ELEMENTS)
    .map((e, i) => ({ ...e, i, sl: S(e.l), st: S(e.t), sr: S(e.r), sb: S(e.b) }));
  lastView.set(serial, { elements: list, scale, devW, devH, at: Date.now() });
  const lines = list.map((e) => {
    const label = e.text || e.desc || e.id || '';
    const caps = [e.editable && '可输入', e.clickable && '可点', e.longClickable && '可长按', e.scrollable && '可滚动', e.checkable && (e.checked ? '已勾选' : '未勾选'),
      e.focused && '焦点', e.selected && '选中', !e.enabled && '禁用', e.password && '密码'].filter(Boolean).join(' ');
    return `[${e.i}] ${label ? `「${label.slice(0, 60)}」` : '（无文字）'} ${e.cls}${caps ? ' ' + caps : ''} @${e.sl},${e.st},${e.sr},${e.sb}`;
  });
  const head = `前台：${fg || '（未知）'} · 截图 ${S(devW)}×${S(devH)}（设备 ${devW}×${devH}）`;
  const body = tree.via
    ? (lines.length ? lines.join('\n') : '（这一屏没有可交互元素，看截图）') + (tree.note ? '\n' + tree.note : '')
    : '（读不到控件树：可能是游戏 / 自绘界面，按截图坐标操作）';
  let img = null;
  if (png) {
    try {
      const W = S(devW); const H = S(devH);
      const boxes = list.filter((e) => interactive(e)).slice(0, 60).map((e) => {
        const c = PALETTE[e.i % PALETTE.length];
        const lw = String(e.i).length * 7 + 6;
        return `<rect x="${e.sl}" y="${e.st}" width="${Math.max(1, e.sr - e.sl)}" height="${Math.max(1, e.sb - e.st)}" fill="none" stroke="${c}" stroke-width="2"/>`
          + `<rect x="${e.sl}" y="${Math.max(0, e.st - 14)}" width="${lw}" height="14" fill="${c}"/>`
          + `<text x="${e.sl + 3}" y="${Math.max(0, e.st - 14) + 11}" font-family="Arial" font-size="11" font-weight="bold" fill="#fff">${e.i}</text>`;
      }).join('');
      const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${boxes}</svg>`);
      if (!sharp) throw new Error('no sharp');
      const buf = await sharp(png).resize(W, H).composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
      img = { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' };
    } catch { img = { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }; }
  }
  return { text: `${head}\n${body}`, image: img, elements: list, scale };
}
const PALETTE = ['#e5484d', '#3e63dd', '#30a46c', '#f76b15', '#8e4ec6', '#12a594', '#d6409f', '#0090ff'];

/** 动作要点的位置（设备像素）：index → 最近一次画面；text → 现取控件树；x,y → 按最近一次截图换算。 */
async function locate(serial, args) {
  const view = lastView.get(serial);
  if (args.index != null) {
    const e = view?.elements.find((x) => x.i === args.index);
    if (!e) return { error: `编号 ${args.index} 不在最近一次画面里（编号只对最近一次画面有效）：先 action:"screen" 再选。` };
    return { x: (e.l + e.r) / 2, y: (e.t + e.b) / 2, el: e };
  }
  if (args.text) {
    const { elements } = await observe(serial, { image: false, full: true });
    const q = args.text.trim().toLowerCase();
    const hits = elements.filter((e) => [e.text, e.desc, e.id].some((s) => s && s.toLowerCase() === q));
    const loose = hits.length ? hits : elements.filter((e) => [e.text, e.desc, e.id].some((s) => s && s.toLowerCase().includes(q)));
    const pick = loose.find(interactive) || loose[0];
    if (!pick) return { error: `画面里没找到含「${args.text}」的元素。` };
    return { x: (pick.l + pick.r) / 2, y: (pick.t + pick.b) / 2, el: pick };
  }
  if (args.x != null && args.y != null) {
    const scale = view?.scale || 1;
    return { x: args.x / scale, y: args.y / scale };
  }
  return { error: '要给 index、text 或 x,y 之一。' };
}

const desc = (el) => (el ? `「${(el.text || el.desc || el.id || el.cls).slice(0, 40)}」` : '');

async function afterAction(serial, args, summary, note = '') {
  const human = humanNote(serial);
  if (args.observe === false) return done(txt([summary, note, human].filter(Boolean).join('\n')));
  await new Promise((r) => setTimeout(r, 700));   // 等界面动完（转场动画约 300–500ms）
  const v = await observe(serial);
  return done(txt([[summary, note, human].filter(Boolean).join('\n'), v.text].join('\n\n')), v.image);
}

// ── apk 信息（aapt2 dump badging）─────────────────────────────────────────
function aapt2() {
  const root = sdkRoot();
  const bt = root && path.join(root, 'build-tools');
  if (!bt || !existsSync(bt)) return '';
  const vers = readdirSync(bt).filter((v) => existsSync(path.join(bt, v, process.platform === 'win32' ? 'aapt2.exe' : 'aapt2')))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return vers.length ? path.join(bt, vers[0], process.platform === 'win32' ? 'aapt2.exe' : 'aapt2') : '';
}
async function apkInfo(file) {
  const bin = aapt2();
  if (!bin) return {};
  const r = await run(bin, ['dump', 'badging', file], { timeout: 30_000 });
  const pkg = /package: name='([^']+)'/.exec(r.stdout)?.[1] || '';
  const act = /launchable-activity: name='([^']+)'/.exec(r.stdout)?.[1] || '';
  const ver = /versionName='([^']*)'/.exec(r.stdout)?.[1] || '';
  const label = /application-label:'([^']*)'/.exec(r.stdout)?.[1] || '';
  return { pkg, act, ver, label };
}

const PKG = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;
const checkPkg = (p) => (PKG.test(String(p || '')) ? '' : `包名不合法：${p || '（没给）'}`);

// ── 主入口 ─────────────────────────────────────────────────────────────────
/**
 * ctx = { ws: 工作空间绝对路径, owner: 会话 id（租约用）, roots: 允许读的目录（null = 不限） }
 */
export async function runAndroidAction(args, ctx = {}) {
  try { return await dispatch(args, ctx); }
  catch (e) {
    const msg = String(e?.message || e);
    if (e?.code === 'ANDROID_TOOL_MISSING') return fail(`${msg}。先 action:"doctor" 看缺什么。`);
    return fail(msg.slice(0, 1500));
  }
}

async function dispatch(args, ctx) {
  const a = args.action;
  const owner = ctx.owner || '';
  if (a === 'doctor') return doDoctor();
  if (a === 'devices') {
    const t = await deviceTable();
    const avds = await listAvds();
    const lines = t.map((d) => `${d.serial} · ${d.kind === 'emulator' ? '模拟器' : '真机'} ${deviceLabel(d)} · ${d.state}${d.managed ? ' · bridge 开的' : ''}${d.viewers ? ` · 用户正在看` : ''}`);
    const idle = avds.filter((x) => !t.some((d) => d.avd === x));
    return done(txt((lines.length ? lines.join('\n') : '没有在线设备。') + (idle.length ? `\n可启动的虚拟设备：${idle.join('、')}` : '')));
  }
  if (a === 'start') {
    const avds = await listAvds();
    const avd = args.avd || avds[0];
    if (!avd) return fail('没有虚拟设备。先 create_avd（问过用户再建），或者 doctor 看缺什么。');
    const r = await emu.startEmulator(avd, { coldBoot: !!args.cold });
    return done(txt(`${avd} 已开机：${r.serial}${r.already ? '（之前就开着）' : ''}${r.foreign ? '（是别的程序开的，bridge 不会去关它）' : ''}。用户在工作区「安卓」卡里能看到它。`));
  }
  if (a === 'stop') {
    const serial = args.serial || emu.snapshot()[0]?.serial;
    if (!serial) return fail('没有 bridge 开的模拟器可关。');
    await emu.stopEmulator(serial, { reason: 'agent' });
    return done(txt(`已关机：${serial}（存了快速启动快照，下次几秒就能开）`));
  }
  if (a === 'create_avd') return doCreateAvd(args);

  // 以下都要一台在线设备
  const mutating = !['screen', 'ui_tree', 'logs', 'apps', 'wait'].includes(a) && !(a === 'snapshot' && args.op === 'list');
  const p = await pickDevice(args.serial, owner, { mutate: mutating });
  if (p.error) return fail(p.error);
  const serial = p.device.serial;
  const note = p.note;

  switch (a) {
    case 'screen': {
      const v = await observe(serial);
      return done(txt([note, humanNote(serial), v.text].filter(Boolean).join('\n')), v.image);
    }
    case 'ui_tree': {
      const v = await observe(serial, { image: false, full: !!args.full });
      return done(txt([note, v.text].filter(Boolean).join('\n')));
    }
    case 'tap': case 'long_press': {
      const loc = await locate(serial, args);
      if (loc.error) return fail(loc.error);
      const x = Math.round(loc.x); const y = Math.round(loc.y);
      showAgent(serial, a, x, y);
      if (a === 'tap') await shell(serial, `input tap ${x} ${y}`, { timeout: 10_000 });
      else await shell(serial, `input swipe ${x} ${y} ${x} ${y} ${Math.round(Math.min(5000, Math.max(400, args.ms || 800)))}`, { timeout: 15_000 });
      return afterAction(serial, args, `${a === 'tap' ? '点了' : '长按了'}${desc(loc.el)}（设备坐标 ${x},${y}）`, note);
    }
    case 'swipe': {
      const view = lastView.get(serial); const s = view?.scale || 1;
      if ([args.x, args.y, args.to_x, args.to_y].some((v) => v == null)) return fail('swipe 要给 x, y, to_x, to_y（按最近一次截图的像素）。');
      const [x1, y1, x2, y2] = [args.x / s, args.y / s, args.to_x / s, args.to_y / s].map(Math.round);
      showAgent(serial, 'swipe', x1, y1);
      await shell(serial, `input swipe ${x1} ${y1} ${x2} ${y2} ${Math.round(Math.min(5000, Math.max(80, args.ms || 300)))}`, { timeout: 15_000 });
      return afterAction(serial, args, `滑动 ${x1},${y1} → ${x2},${y2}`, note);
    }
    case 'scroll': {
      const dir = args.direction || 'down';
      let box;
      if (args.index != null) {
        const e = lastView.get(serial)?.elements.find((x) => x.i === args.index);
        if (!e) return fail(`编号 ${args.index} 不在最近一次画面里。`);
        box = e;
      } else {
        const v = lastView.get(serial);
        const W = v?.devW || 1080; const H = v?.devH || 2400;
        box = { l: 0, t: H * 0.15, r: W, b: H * 0.85 };
      }
      const cx = (box.l + box.r) / 2; const cy = (box.t + box.b) / 2;
      const dx = (box.r - box.l) * 0.3; const dy = (box.b - box.t) * 0.3;
      const [x1, y1, x2, y2] = {
        down: [cx, cy + dy, cx, cy - dy], up: [cx, cy - dy, cx, cy + dy],
        right: [cx + dx, cy, cx - dx, cy], left: [cx - dx, cy, cx + dx, cy],
      }[dir].map(Math.round);
      showAgent(serial, 'scroll', x1, y1);
      await shell(serial, `input swipe ${x1} ${y1} ${x2} ${y2} 350`, { timeout: 15_000 });
      return afterAction(serial, args, `向${{ down: '下', up: '上', left: '左', right: '右' }[dir]}滚动${args.index != null ? `（第 ${args.index} 个元素里）` : ''}`, note);
    }
    case 'input': {
      const text = String(args.text ?? '');
      if (!text && !args.submit) return fail('input 要给 text。');
      let tapped = '';
      if (args.index != null || args.target) {
        const loc = await locate(serial, args.index != null ? { index: args.index } : { text: args.target });
        if (loc.error) return fail(loc.error);
        showAgent(serial, 'tap', loc.x, loc.y);
        await shell(serial, `input tap ${Math.round(loc.x)} ${Math.round(loc.y)}`, { timeout: 10_000 });
        await new Promise((r) => setTimeout(r, 400));
        tapped = `点了输入框${desc(loc.el)}，`;
      }
      const m = await mirrorOf(serial).control();
      if (text) {
        if (/^[\x20-\x7e]+$/.test(text) && text.length <= 300) m.text(text);
        else if (!(await m.setClipboard(text, true))) return fail('写设备剪贴板没有回执，可能没输进去：看一眼画面。');
      }
      if (args.submit) { await new Promise((r) => setTimeout(r, 150)); m.press(66); }
      return afterAction(serial, args, `${tapped}输入了 ${text.length} 个字${args.submit ? '并按了回车' : ''}`, note);
    }
    case 'key': {
      const k = String(args.key || '').toLowerCase().trim();
      const code = /^\d+$/.test(k) ? Number(k) : KEYS[k];
      if (!code) return fail(`不认识的按键：${args.key}。可用：${Object.keys(KEYS).join(' ')}，或键码数字。`);
      await shell(serial, `input keyevent ${code}`, { timeout: 10_000 });
      return afterAction(serial, args, `按了 ${args.key}`, note);
    }
    case 'wait': {
      if (args.text) {
        const until = Date.now() + Math.min(15_000, args.ms || 10_000);
        const q = args.text.toLowerCase();
        while (Date.now() < until) {
          const { elements } = await getElements(serial);
          if (elements.some((e) => [e.text, e.desc].some((s) => s && s.toLowerCase().includes(q)))) {
            const v = await observe(serial);
            return done(txt(`「${args.text}」出现了。\n${v.text}`), v.image);
          }
          await new Promise((r) => setTimeout(r, 700));
        }
        const v = await observe(serial);
        return done(txt(`等了 ${Math.round(Math.min(15_000, args.ms || 10_000) / 1000)} 秒，「${args.text}」还没出现。\n${v.text}`), v.image);
      }
      await new Promise((r) => setTimeout(r, Math.min(15_000, Math.max(0, args.ms || 1000))));
      if (args.observe === false) return done(txt('等完了。'));
      const v = await observe(serial);
      return done(txt(`等完了。\n\n${v.text}`), v.image);
    }
    case 'install': return doInstall(serial, args, ctx, note);
    case 'launch': {
      const bad = checkPkg(args.package); if (bad) return fail(bad);
      let out;
      if (args.activity) {
        const act = String(args.activity);
        if (!/^[\w.$]+$/.test(act)) return fail(`Activity 名不合法：${act}`);
        out = await shell(serial, `am start -W -n ${shq(`${args.package}/${act}`)} 2>&1`, { timeout: 30_000 }).catch((e) => e.message);
      } else {
        out = await shell(serial, `monkey -p ${shq(args.package)} -c android.intent.category.LAUNCHER 1 2>&1`, { timeout: 30_000 }).catch((e) => e.message);
      }
      if (/Error|No activities found|does not exist|monkey aborted/i.test(out)) return fail(`启动失败：${out.trim().slice(0, 600)}`);
      return afterAction(serial, args, `已启动 ${args.package}${args.activity ? '/' + args.activity : ''}`, note);
    }
    case 'stop_app': {
      const bad = checkPkg(args.package); if (bad) return fail(bad);
      await shell(serial, `am force-stop ${shq(args.package)}`, { timeout: 15_000 });
      return done(txt(`已结束 ${args.package}`));
    }
    case 'clear_data': {
      const bad = checkPkg(args.package); if (bad) return fail(bad);
      const out = await shell(serial, `pm clear ${shq(args.package)} 2>&1`, { timeout: 30_000 });
      return done(txt(`清除 ${args.package} 的数据：${out.trim()}`));
    }
    case 'uninstall': {
      const bad = checkPkg(args.package); if (bad) return fail(bad);
      const r = await adb(serial, ['uninstall', args.package], { timeout: 60_000 });
      return ok(r) && /Success/.test(r.stdout) ? done(txt(`已卸载 ${args.package}`)) : fail(`卸载失败：${brief(r)}`);
    }
    case 'open_url': {
      const u = String(args.url || '');
      if (!/^[a-z][\w+.-]*:\/\/|^(tel|mailto|geo|market|intent):/i.test(u)) return fail('url 要带协议（https://、myapp://、tel: …）。');
      const out = await shell(serial, `am start -W -a android.intent.action.VIEW -d ${shq(u)} 2>&1`, { timeout: 30_000 }).catch((e) => e.message);
      if (/Error|unable to resolve/i.test(out)) return fail(`打开失败：${out.trim().slice(0, 400)}`);
      return afterAction(serial, args, `打开了 ${u}`, note);
    }
    case 'apps': {
      const out = await shell(serial, 'pm list packages -3', { timeout: 20_000 });
      const pkgs = out.split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim()).filter(Boolean).sort();
      return done(txt(pkgs.length ? `第三方应用（${pkgs.length}）：\n${pkgs.join('\n')}` : '没有装第三方应用。'));
    }
    case 'logs': return doLogs(serial, args);
    case 'emu': return doEmu(serial, args, note);
    case 'snapshot': return doSnapshot(serial, args);
    case 'record': {
      const { startRecord, stopRecord } = await import('./record.mjs');
      if (args.op === 'start') { const r = startRecord(serial); return done(txt(`开始录屏（最长 ${r.limit} 秒）。做完操作后 action:"record", op:"stop" 停止并保存。`)); }
      if (args.op !== 'stop') return fail('record 要给 op：start 或 stop。');
      const rel = String(args.path || `recordings/android-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.mp4`);
      const dest = path.resolve(ctx.ws || process.cwd(), rel.endsWith('.mp4') ? rel : rel + '.mp4');
      if (ctx.roots && !ctx.roots.some((r) => dest.toLowerCase().startsWith(path.resolve(r).toLowerCase() + path.sep))) return fail('只能存进你的工作空间。');
      (await import('node:fs')).mkdirSync(path.dirname(dest), { recursive: true });
      const r = await stopRecord(serial, dest);
      return done(txt(`录屏已保存：${dest}（${r.seconds} 秒，${(r.size / 1048576).toFixed(1)} MB）。要交给用户时写成 markdown 链接。`));
    }
    default: return fail(`不支持的动作：${a}`);
  }
}

async function doDoctor() {
  const d = await doctor();
  const lines = [
    `SDK：${d.sdk || '没找到'}`,
    `adb：${toolPath('adb') || '没装（platform-tools）'}`,
    `emulator：${d.tools.emulator ? '有' : '没装'} · avdmanager：${d.tools.avdmanager ? '有' : '没装（cmdline-tools）'} · Android CLI：${d.tools.android ? '有' : '没装'}`,
    `硬件加速：${d.accel.ok ? '可用' : '不可用'}${d.accel.detail ? `（${d.accel.detail}）` : ''}`,
    `已装镜像：${d.images.map((i) => i.id).join('、') || '没有'}`,
    `虚拟设备：${d.avds.join('、') || '没有'}`,
  ];
  if (d.missing.length) {
    lines.push('', '缺：' + d.missing.join('、'));
    const sdk = d.sdk || '%LOCALAPPDATA%\\Android\\Sdk';
    if (d.missing.includes('cmdline-tools')) lines.push(`· cmdline-tools：从 https://dl.google.com/android/repository/repository2-3.xml 查最新 commandlinetools-win-*_latest.zip，校验 sha1 后解压到 ${sdk}\\cmdline-tools\\latest`);
    if (d.missing.includes('system-image')) lines.push(`· 系统镜像：sdkmanager "system-images;android-35;google_apis_playstore;x86_64"（约 1.6 GB）。要接受 SDK 许可时先问用户，别替用户点同意。`);
    if (d.missing.includes('avd')) lines.push('· 虚拟设备：android 工具 create_avd（先问用户）。');
    if (d.missing.includes('acceleration')) lines.push('· 硬件加速：请用户在「Windows 功能」里打开「Windows 虚拟机监控程序平台」并重启。');
  }
  return done(txt(lines.join('\n')));
}

async function doCreateAvd(args) {
  const name = String(args.name || 'Pixel_8_API_35');
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return fail(`名字只能用字母、数字、下划线、点、横线：${name}`);
  if ((await listAvds()).includes(name)) return fail(`已经有叫 ${name} 的虚拟设备了。`);
  const images = installedImages();
  const image = args.image || images.find((i) => i.tag === 'google_apis_playstore')?.id || images[0]?.id;
  if (!image) return fail('没有已装的系统镜像。先装一个（doctor 里有命令），装之前问用户。');
  if (!images.some((i) => i.id === image)) return fail(`没装这个镜像：${image}。已装：${images.map((i) => i.id).join('、') || '没有'}`);
  const device = String(args.device || 'pixel_8');
  if (!/^[\w.-]{1,64}$/.test(device)) return fail(`机型名不合法：${device}`);
  const bin = requireTool('avdmanager');
  const r = await run(bin, ['create', 'avd', '-n', name, '-k', image, '-d', device], { input: 'no\n', timeout: 120_000 });
  if (!ok(r)) return fail(`建虚拟设备失败：${brief(r)}`);
  // 命令行建出来的默认偏保守：按 Android Studio 的默认开 GPU、Play 标记、4 GB 内存
  try {
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const cfg = path.join(os.homedir(), '.android', 'avd', `${name}.avd`, 'config.ini');
    let t = await fs.readFile(cfg, 'utf8');
    t = t.replace(/^hw\.gpu\.enabled=no$/m, 'hw.gpu.enabled=yes').replace(/^hw\.ramSize=.*$/m, 'hw.ramSize=4096M');
    if (/google_apis_playstore/.test(image)) t = t.replace(/^PlayStore\.enabled=no$/m, 'PlayStore.enabled=yes');
    await fs.writeFile(cfg, t);
  } catch {}
  return done(txt(`已建虚拟设备 ${name}（${device}，${image}）。action:"start", avd:"${name}" 开机。`));
}

async function doInstall(serial, args, ctx, note) {
  const raw = String(args.path || '').trim();
  if (!raw) return fail('install 要给 apk 路径。');
  const file = path.resolve(ctx.ws || process.cwd(), raw);
  if (ctx.roots && !ctx.roots.some((r) => file.toLowerCase().startsWith(path.resolve(r).toLowerCase() + path.sep) || file.toLowerCase() === path.resolve(r).toLowerCase())) {
    return fail('只能装你工作空间里的 apk。');
  }
  if (!existsSync(file) || !statSync(file).isFile()) return fail(`没有这个文件：${file}`);
  if (!/\.apks?$/i.test(file)) return fail('只认 .apk 文件。');
  const info = await apkInfo(file);
  const r = await adb(serial, ['install', '-r', '-t', '-d', file], { timeout: 300_000 });
  const out = (r.stdout + '\n' + r.stderr).trim();
  if (!ok(r) || !/Success/.test(out)) return fail(`安装失败：${out.split(/\r?\n/).slice(-4).join('\n').slice(0, 800)}`);
  const sizeMb = (statSync(file).size / 1048576).toFixed(1);
  return done(txt([
    `已安装 ${path.basename(file)}（${sizeMb} MB）到 ${serial}${note ? ' ' + note : ''}`,
    info.pkg ? `包名 ${info.pkg}${info.ver ? ` · 版本 ${info.ver}` : ''}${info.label ? ` · 名称 ${info.label}` : ''}` : '',
    info.act ? `启动入口 ${info.act}（launch 时可以只给 package）` : '',
  ].filter(Boolean).join('\n')));
}

async function doLogs(serial, args) {
  const lines = Math.min(2000, Math.max(10, args.lines || 200));
  const level = args.level || 'I';
  const parts = ['logcat', '-d', '-v', 'threadtime', '-t', String(lines * (args.grep ? 5 : 1))];
  if (args.crash) parts.push('-b', 'crash');
  let pidNote = '';
  if (args.package) {
    const bad = checkPkg(args.package); if (bad) return fail(bad);
    const pid = (await shell(serial, `pidof ${shq(args.package)}`, { timeout: 8000 }).catch(() => '')).trim().split(/\s+/)[0];
    if (pid && /^\d+$/.test(pid)) parts.push(`--pid=${pid}`);
    else if (!args.crash) pidNote = `（${args.package} 现在没在运行，下面是全部进程的日志；崩溃了的话加 crash:true 看崩溃缓冲区）\n`;
  }
  parts.push(`*:${level}`);
  const r = await adb(serial, parts, { timeout: 30_000, maxBuffer: 16 << 20 });
  if (!ok(r)) return fail(`读日志失败：${brief(r)}`);
  let rows = r.stdout.split(/\r?\n/).filter(Boolean);
  if (args.grep) { const q = args.grep.toLowerCase(); rows = rows.filter((l) => l.toLowerCase().includes(q)); }
  rows = rows.slice(-lines);
  if (args.clear) await adb(serial, ['logcat', '-c'], { timeout: 10_000 });
  let body = rows.join('\n');
  if (body.length > 24_000) body = '…（前面省略）\n' + body.slice(-24_000);
  return done(txt(`${pidNote}${rows.length ? body : '（没有符合条件的日志）'}${args.clear ? '\n（已清空 logcat）' : ''}`));
}

async function doEmu(serial, args, note) {
  if (!serial.startsWith('emulator-')) return fail('emu 只对模拟器有效（这台是真机）。');
  const k = args.kind;
  const emuCmd = async (...c) => {
    const r = await adb(serial, ['emu', ...c.map(String)], { timeout: 15_000 });
    const out = (r.stdout || '').trim();
    if (!ok(r) || /^KO/m.test(out)) throw new Error(`模拟器拒绝了：${out || brief(r)}`);
    return out.replace(/\r?\nOK$/, '').trim();
  };
  switch (k) {
    case 'geo': {
      if (!Number.isFinite(args.lat) || !Number.isFinite(args.lng)) return fail('geo 要给 lat、lng。');
      await emuCmd('geo', 'fix', args.lng, args.lat);   // 注意顺序：经度在前
      return done(txt(`定位已设为 ${args.lat}, ${args.lng}`));
    }
    case 'battery': {
      if (Number.isFinite(args.level_pct)) await emuCmd('power', 'capacity', Math.max(0, Math.min(100, Math.round(args.level_pct))));
      if (args.charging != null) { await emuCmd('power', 'ac', args.charging ? 'on' : 'off'); await emuCmd('power', 'status', args.charging ? 'charging' : 'discharging'); }
      return done(txt(`电池：${Number.isFinite(args.level_pct) ? args.level_pct + '%' : ''}${args.charging != null ? (args.charging ? ' 充电中' : ' 未充电') : ''}`.trim()));
    }
    case 'rotate': await emuCmd('rotate'); return afterAction(serial, args, '旋转了屏幕', note);
    case 'sms': {
      if (!args.from || !args.text) return fail('sms 要给 from（号码）和 text。');
      if (!/^[+\d\s-]{2,20}$/.test(args.from)) return fail('from 要是电话号码。');
      await emuCmd('sms', 'send', args.from.replace(/\s/g, ''), args.text.replace(/[\r\n]+/g, ' ').slice(0, 300));
      return afterAction(serial, args, `模拟收到短信（来自 ${args.from}）`, note);
    }
    case 'call': case 'hangup': {
      const n = String(args.number || '').replace(/\s/g, '');
      if (!/^[+\d-]{2,20}$/.test(n)) return fail('要给 number（电话号码）。');
      await emuCmd('gsm', k === 'call' ? 'call' : 'cancel', n);
      return afterAction(serial, args, k === 'call' ? `模拟来电：${n}` : `挂断：${n}`, note);
    }
    case 'fold': case 'unfold': await emuCmd(k); return afterAction(serial, args, k === 'fold' ? '折叠了' : '展开了', note);
    case 'finger': {
      const id = Math.max(1, Math.min(10, Math.round(Number(args.number) || 1)));
      await emuCmd('finger', 'touch', id);
      return afterAction(serial, args, `模拟指纹 ${id} 按上去了`, note);
    }
    case 'network': {
      const sp = String(args.speed || 'full');
      if (!/^[a-z]+$/.test(sp)) return fail('speed 用 full / lte / hsdpa / umts / edge / gprs / gsm。');
      await emuCmd('network', 'speed', sp);
      return done(txt(`网速已设为 ${sp}`));
    }
    default: return fail('emu 要给 kind：geo|battery|rotate|sms|call|hangup|fold|unfold|finger|network');
  }
}

async function doSnapshot(serial, args) {
  if (!serial.startsWith('emulator-')) return fail('快照只对模拟器有效。');
  const op = args.op || 'list';
  if (op !== 'list' && !/^[\w.-]{1,64}$/.test(String(args.name || ''))) return fail('快照名只能用字母、数字、下划线、点、横线。');
  const r = await adb(serial, ['emu', 'avd', 'snapshot', op, ...(op === 'list' ? [] : [args.name])], { timeout: op === 'load' || op === 'save' ? 120_000 : 30_000 });
  const out = (r.stdout || '').replace(/\r?\nOK\s*$/, '').trim();
  if (!ok(r) || /^KO/m.test(r.stdout)) return fail(`快照 ${op} 失败：${out || brief(r)}`);
  const verb = { save: '已存快照', load: '已恢复快照', delete: '已删快照', list: '快照' }[op];
  return done(txt(op === 'list' ? (out || '没有快照') : `${verb} ${args.name}`));
}

export const _test = { parseUiXml, parseCliLayout, KEYS };
