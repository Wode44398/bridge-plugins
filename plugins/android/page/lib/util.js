// 子页共用的小工具：错误文案、上传（分块，带进度）、下载。
import { t, uploadChunked, download } from './host.js';

/** api.get / api.post 抛的错 → 给人看的一句话（优先用服务端回的 {error}） */
export function errText(e) {
  const b = e?.body;
  if (b && typeof b === 'object' && b.error) return String(b.error);
  if (typeof b === 'string' && b) return b;
  return String(e?.message || e || t('出错了'));
}

/**
 * 上传文件并完成后续动作。onProgress(0..1)。成功 resolve 接口回的 JSON，失败 reject（message = 服务端的 error）。
 * path 沿用原来的写法：/api/android/install?serial=&name=  或  /api/android/file?serial=&dir=&name=
 */
export function uploadRaw(path, file, onProgress) {
  const u = new URL(String(path).replace(/^\/api\/android\//, ''), 'http://x/');
  const q = Object.fromEntries(u.searchParams.entries());
  const finish = u.pathname === '/install' ? 'install' : 'file/push';
  return uploadChunked(file, { finish, data: q }, onProgress);
}

/** 下载插件接口给的文件（嵌入时由 bridge 存：桌面壳 / 手机 App 走原生下载器） */
export async function downloadFrom(path, name) {
  await download(path, name);
}

/** 拖进来的是不是文件（拖文字 / 链接不接） */
export const dragHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

export const fmtSize = (n) => {
  if (typeof n !== 'number' || !isFinite(n)) return String(n ?? '');
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
};
