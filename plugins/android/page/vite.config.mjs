// 页面构建：page/ 下的 Svelte 源码 → web/（插件实际提供的页面）。
// 借 bridge 的前端工具链（svelte、vite 装在 claude-bridge/web/node_modules），插件目录不另装依赖：page/node_modules 是指向它的目录联接（不进 zip、不进 git）；
//   node <claude-bridge>/web/node_modules/vite/bin/vite.js build --config page/vite.config.mjs
// 或者直接跑 page/build.mjs。SDK（/plugins/_sdk/bridge-plugin.js）由 bridge 提供，不打进包。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
// 依赖从哪找：默认就是 page/ 自己（page/node_modules 是指向 bridge 前端依赖的目录联接）；也可以用环境变量 BRIDGE_WEB 指到 <claude-bridge>/web。
const BRIDGE_WEB = process.env.BRIDGE_WEB || here;
const req = createRequire(path.join(BRIDGE_WEB, 'package.json'));
const { svelte } = await import(pathToFileURL(req.resolve('@sveltejs/vite-plugin-svelte')).href);

export default {
  root: here,
  base: './',
  plugins: [svelte()],
  build: {
    outDir: path.join(here, '..', 'web'),
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      external: ['/plugins/_sdk/bridge-plugin.js'],
      output: { entryFileNames: 'app.js', chunkFileNames: 'app-[hash].js', assetFileNames: 'app[extname]' },
    },
  },
  logLevel: 'warn',
};
