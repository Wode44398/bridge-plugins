// 纯 Node 确定性 zip：同样的文件（路径 + 内容）永远打出逐字节相同的包，任何人都能从源码复现 sha256。
// 社区插件在 ubuntu 的 CI 上打包，不能像 lib.mjs 那样依赖 Windows 的 bsdtar；也不能用系统 zip（会写进 mtime、uid、扩展字段）。
//
// 怎么做到确定：
//   · 条目按路径的 UTF-8 字节序排序（不受输入顺序、文件系统遍历顺序影响）；
//   · 时间戳固定为 DOS 纪元 1980-01-01 00:00:00；不写额外字段（扩展时间戳、Unix uid/gid 都会随机器变）；
//   · 制作系统记为 MS-DOS、外部属性为 0：不把作者机器上的文件权限带进包；
//   · 只写文件条目、不写目录条目（解压时目录按路径自动建出来，空目录在 git 里本来也不存在）；
//   · 文件名一律 UTF-8 并置通用标志位 11，bsdtar / unzip / 资源管理器都按 UTF-8 解，中文名不乱码；
//   · 只存储、不压缩：deflate 的字节输出随 Node 自带的 zlib 版本变，压了就没法保证别人用别的 Node 复现出同一个 sha256。
//     社区插件合计不超过 8 MB，不压缩的代价可以接受。
//
// 用法（复现 CI 打出的包）：node scripts/zip.mjs community/<id> [输出.zip]
//   打印 sha256 与字节数；market.json 不进包，与 community-publish.mjs 完全一致。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOS_TIME = 0;                              // 00:00:00
const DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1; // 1980-01-01
const FLAG_UTF8 = 0x0800;
const VERSION = 10;                              // 1.0：只存储所需的最低版本；高字节 0 = MS-DOS
const STORE = 0;

// CRC-32（IEEE 802.3，zip 用的那个）。node:zlib 的 crc32 只在较新的 Node 里有，自己查表最稳。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 把条目打成 zip。
 * @param {{path: string, data: Buffer|string}[]} entries  path 用正斜杠、相对路径
 * @returns {Buffer}
 */
export function zipEntries(entries) {
  const list = entries.map((e) => {
    const p = String(e.path);
    if (!p || p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => !s || s === '.' || s === '..')) throw new Error(`zip 条目路径不规整：${p}`);
    return { name: Buffer.from(p, 'utf8'), data: Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ''), 'utf8') };
  }).sort((a, b) => Buffer.compare(a.name, b.name));
  for (let i = 1; i < list.length; i++) if (Buffer.compare(list[i - 1].name, list[i].name) === 0) throw new Error(`zip 条目重复：${list[i].name.toString('utf8')}`);
  if (list.length > 0xffff) throw new Error('条目太多（不支持 zip64）');

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of list) {
    const comp = data;
    const crc = crc32(data);
    if (data.length > 0xfffffffe || comp.length > 0xfffffffe || offset > 0xfffffffe) throw new Error('包太大（不支持 zip64）');

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(VERSION, 4);
    lh.writeUInt16LE(FLAG_UTF8, 6);
    lh.writeUInt16LE(STORE, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(VERSION, 4);   // 制作版本 + 系统（0 = MS-DOS）
    ch.writeUInt16LE(VERSION, 6);   // 解压所需版本
    ch.writeUInt16LE(FLAG_UTF8, 8);
    ch.writeUInt16LE(STORE, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);        // 额外字段
    ch.writeUInt16LE(0, 32);        // 注释
    ch.writeUInt16LE(0, 34);        // 磁盘号
    ch.writeUInt16LE(0, 36);        // 内部属性
    ch.writeUInt32LE(0, 38);        // 外部属性：不带权限位
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---- 命令行：复现某个社区插件目录的包 ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) { console.error('用法：node scripts/zip.mjs <插件目录> [输出.zip]'); process.exit(1); }
  // 动态引入且不用顶层 await：community-lib 静态引用本文件，本模块得先求值完，否则循环引用会互等
  import('./community-lib.mjs').then(({ readPluginFiles, packPlugin }) => {
    const { files, problems } = readPluginFiles(dir);
    if (problems.length) { problems.forEach((p) => console.error(`- ${p.message}`)); process.exit(1); }
    const buf = packPlugin(files);
    if (out) fs.writeFileSync(out, buf);
    console.log(`sha256 ${sha256(buf)}`);
    console.log(`size   ${buf.length}`);
  });
}
