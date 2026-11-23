// 安卓卡前端的纯逻辑：SPS → avc1 编码串、键盘事件 → 安卓键码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { codecFromConfig } from './decoder.js';
import { keycodeOf, metaOf, isKeyEvent, AK } from './keycodes.js';

test('从配置包的 SPS 取 profile / constraint / level', () => {
  // 00 00 00 01 | 67 (SPS) | 64 00 28 …  → High profile、level 4.0
  const sps = Uint8Array.from([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac, 0, 0, 0, 1, 0x68, 0xee]);
  assert.equal(codecFromConfig(sps), 'avc1.640028');
  // 三字节起始码也认
  assert.equal(codecFromConfig(Uint8Array.from([0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0x00])), 'avc1.42c01f');
  // 没有 SPS 时给个保底
  assert.equal(codecFromConfig(Uint8Array.from([1, 2, 3, 4, 5])), 'avc1.42e01f');
});

test('键码：功能键、字母、修饰键', () => {
  assert.equal(keycodeOf({ code: 'Enter' }), AK.ENTER);
  assert.equal(keycodeOf({ code: 'Backspace' }), AK.DEL);
  assert.equal(keycodeOf({ code: 'KeyC' }), 31);
  assert.equal(keycodeOf({ code: 'Digit0' }), 7);
  assert.equal(keycodeOf({ code: 'F5' }), 135);
  assert.equal(metaOf({ ctrlKey: true, shiftKey: true }), 0x1001);
});

test('哪些键当按键事件发：功能键与组合键是，普通字符与输入法组字不是', () => {
  assert.equal(isKeyEvent({ code: 'Enter', key: 'Enter' }), true);
  assert.equal(isKeyEvent({ code: 'KeyA', key: 'a' }), false);
  assert.equal(isKeyEvent({ code: 'KeyA', key: 'a', ctrlKey: true }), true);
  assert.equal(isKeyEvent({ code: 'KeyA', key: 'Process', isComposing: true }), false);
  assert.equal(isKeyEvent({ code: 'Space', key: ' ' }), false);
});
