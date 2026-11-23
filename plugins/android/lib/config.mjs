// 插件的生效配置与数据目录：index.mjs 的 apply / onConfig 写进来，lib 里各模块现读（不 import bridge 内部模块）。
let cfg = {};
let dir = '';

export const setConfig = (c) => { cfg = c && typeof c === 'object' ? c : {}; };
export const config = () => cfg;
export const setDataDir = (d) => { dir = d || ''; };
export const dataDir = () => dir;
