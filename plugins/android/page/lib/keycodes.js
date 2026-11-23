// 浏览器键盘事件 → 安卓 KeyEvent 键码（android.view.KeyEvent.KEYCODE_*）与修饰键状态。
// 可见字符一般不走这里（直接注入文本，中文走剪贴板粘贴）；这里管功能键、方向键、带 Ctrl/Alt 的组合。

export const AK = {
  HOME: 3, BACK: 4, CALL: 5, ENDCALL: 6, DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22, DPAD_CENTER: 23,
  VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, CAMERA: 27, TAB: 61, SPACE: 62, ENTER: 66, DEL: 67, MENU: 82,
  SEARCH: 84, MEDIA_PLAY_PAUSE: 85, PAGE_UP: 92, PAGE_DOWN: 93, ESCAPE: 111, FORWARD_DEL: 112,
  MOVE_HOME: 122, MOVE_END: 123, INSERT: 124, APP_SWITCH: 187, VOLUME_MUTE: 164, SLEEP: 223, WAKEUP: 224,
  NOTIFICATION: 83, SETTINGS: 176, ALL_APPS: 284,
};

const CODE_MAP = {
  Enter: AK.ENTER, NumpadEnter: AK.ENTER, Backspace: AK.DEL, Delete: AK.FORWARD_DEL, Tab: AK.TAB, Escape: AK.ESCAPE,
  ArrowUp: AK.DPAD_UP, ArrowDown: AK.DPAD_DOWN, ArrowLeft: AK.DPAD_LEFT, ArrowRight: AK.DPAD_RIGHT,
  Home: AK.MOVE_HOME, End: AK.MOVE_END, PageUp: AK.PAGE_UP, PageDown: AK.PAGE_DOWN, Insert: AK.INSERT, Space: AK.SPACE,
  ContextMenu: AK.MENU,
};
// 字母、数字：KEYCODE_A = 29 … Z = 54；0 = 7 … 9 = 16（组合键 Ctrl+C 之类要用）
for (let i = 0; i < 26; i++) CODE_MAP['Key' + String.fromCharCode(65 + i)] = 29 + i;
for (let i = 0; i <= 9; i++) CODE_MAP['Digit' + i] = 7 + i;
// F1–F12 = 131–142
for (let i = 1; i <= 12; i++) CODE_MAP['F' + i] = 130 + i;

/** 键盘事件对应的安卓键码；没有对应的回 0。 */
export function keycodeOf(e) {
  return CODE_MAP[e.code] || 0;
}

// KeyEvent.META_*：SHIFT_ON 1、ALT_ON 2、CTRL_ON 0x1000、META_ON 0x10000
export function metaOf(e) {
  return (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 0x1000 : 0) | (e.metaKey ? 0x10000 : 0);
}

/** 这个按键要不要当成「按键事件」发（而不是等输入框里出字再当文本发）。 */
export function isKeyEvent(e) {
  if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return !!keycodeOf(e);
  return e.code in CODE_MAP && e.key.length !== 1;
}
