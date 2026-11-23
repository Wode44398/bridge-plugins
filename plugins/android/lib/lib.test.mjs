// 插件的纯逻辑：adb 设备表、两种控件树、ls / 快照表 / logcat 行的解析。不碰真设备。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDevices, shq } from './adb.mjs';
import { _test } from './actions.mjs';
import { parseLs, parseSnapshots, parseLogLine } from '../index.mjs';

test('adb devices -l 解析：模拟器 / 真机 / 未授权，跳过表头与 daemon 提示', () => {
  const out = [
    '* daemon not running; starting now at tcp:5037',
    'List of devices attached',
    'emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64xa transport_id:3',
    'R5CT10ABCDE            unauthorized usb:1-1 transport_id:4',
    '192.168.1.20:5555      device product:husky model:Pixel_8_Pro device:husky transport_id:5',
    '',
  ].join('\r\n');
  const d = parseDevices(out);
  assert.equal(d.length, 3);
  assert.deepEqual(d[0], { serial: 'emulator-5554', state: 'device', kind: 'emulator', model: 'sdk gphone64 x86 64', product: 'sdk_gphone64_x86_64', transportId: '3' });
  assert.equal(d[1].state, 'unauthorized');
  assert.equal(d[1].kind, 'device');
  assert.equal(d[2].model, 'Pixel 8 Pro');
});

test('设备端 sh 转义：安全词原样，带空格与单引号的加引号', () => {
  assert.equal(shq('com.example.app'), 'com.example.app');
  assert.equal(shq("it's a test"), `'it'\\''s a test'`);
  assert.equal(shq(''), "''");
});

test('uiautomator XML：属性、能力、实体反转义、零尺寸节点跳过', () => {
  const xml = '<?xml version="1.0"?><hierarchy rotation="0">'
    + '<node index="0" text="你好 &amp; &quot;世界&quot;" resource-id="com.x:id/title" class="android.widget.TextView" package="com.x" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[10,20][110,60]" />'
    + '<node index="1" text="" class="android.widget.EditText" clickable="true" enabled="true" focused="true" bounds="[0,100][500,160]" />'
    + '<node index="2" text="零尺寸" class="android.view.View" bounds="[5,5][5,5]" />'
    + '</hierarchy>';
  const els = _test.parseUiXml(xml);
  assert.equal(els.length, 2);
  assert.equal(els[0].text, '你好 & "世界"');
  assert.equal(els[0].id, 'title');
  assert.equal(els[0].cls, 'TextView');
  assert.equal(els[0].clickable, true);
  assert.deepEqual([els[0].l, els[0].t, els[0].r, els[0].b], [10, 20, 110, 60]);
  assert.equal(els[1].editable, true);
  assert.equal(els[1].focused, true);
});

test('Android CLI layout --flat：应用窗口排前，能力 / 状态映射', () => {
  const wins = [
    { type: 'SYSTEM', content: [{ class: 'android.widget.TextView', text: '5:00', bounds: '[42,45][146,88]' }] },
    { type: 'APPLICATION', content: [
      { class: 'android.widget.EditText', 'resource-id': 'com.x:id/input', text: 'hi', interactions: ['CLICKABLE', 'EDITABLE'], state: ['FOCUSED'], bounds: '[206,160][894,305]' },
      { class: 'android.widget.Switch', interactions: ['CLICKABLE', 'CHECKABLE'], state: ['CHECKED'], bounds: '[0,400][100,460]' },
    ] },
  ];
  const els = _test.parseCliLayout(wins);
  assert.equal(els.length, 3);
  assert.equal(els[0].cls, 'EditText');
  assert.equal(els[0].editable, true);
  assert.equal(els[0].focused, true);
  assert.equal(els[0].id, 'input');
  assert.equal(els[1].checkable && els[1].checked, true);
  assert.equal(els[2].text, '5:00');
  assert.deepEqual(_test.parseCliLayout(null), []);
});

test('按键表覆盖常用键', () => {
  for (const k of ['back', 'home', 'recents', 'enter', 'delete', 'power', 'volume_up']) assert.ok(Number.isInteger(_test.KEYS[k]), k);
});

test('ls -la、快照表、logcat 行', () => {
  const ls = parseLs([
    'total 8',
    'drwxrws--- 2 u0_a1 media_rw 3452 2026-11-23 16:43 Download',
    'lrwxrwxrwx 1 root root 21 2026-11-23 16:43 sdcard -> /storage/self/primary',
    '-rw-rw---- 1 u0_a1 media_rw 18 2026-11-23 17:30 a b.txt',
    'drwx------ 2 root root 60 2026-11-23 16:43 .',
  ].join('\n'));
  assert.deepEqual(ls.map((e) => [e.name, e.dir]), [['Download', true], ['sdcard', true], ['a b.txt', false]]);
  assert.equal(ls[2].size, 18);
  const snaps = parseSnapshots([
    'List of snapshots present on all disks:',
    'ID        TAG                 VM SIZE                DATE       VM CLOCK',
    '--        default_boot            68M 2026-11-23 11:50:41   00:00:19.845',
  ].join('\n'));
  assert.deepEqual(snaps, [{ name: 'default_boot', size: '68M', date: '2026-11-23 11:50:41' }]);
  const l = parseLogLine("11-23 17:25:44.114   581   581 W WindowTokenClientController: Can't find attached");
  assert.deepEqual([l.lvl, l.pid, l.tag, l.msg], ['W', 581, 'WindowTokenClientController', "Can't find attached"]);
});

