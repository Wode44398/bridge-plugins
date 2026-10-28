// 校验 plugins/ 下全部插件；有问题非零退出。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPlugins, checkPlugin } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugins = listPlugins(root);
let bad = 0;
for (const p of plugins) {
  const issues = checkPlugin(p);
  if (issues.length) { bad++; console.error(`[失败] ${p.dirName}`); issues.forEach((i) => console.error(`  - ${i}`)); }
  else console.log(`[通过] ${p.dirName} v${p.manifest.version}`);
}
if (!plugins.length) { console.error('plugins/ 下没有插件'); process.exit(1); }
if (bad) { console.error(`${bad} 个插件有问题`); process.exit(1); }
console.log(`全部 ${plugins.length} 个插件校验通过`);
