/**
 * M3 Task 1：最小 ZIP 解析 / 解包。
 *
 * 用例全部在**内存里现造 ZIP**（不依赖任何真实压缩包文件，也不联网）：
 * - stored(0) 与 deflate(8) 两种压缩方法都要能解出**逐字节一致**的内容；
 * - 中央目录结束记录（EOCD）**带注释**时也要能解析（注释长度参与定位）；
 * - Zip Slip（`..` / 绝对路径）与**符号链接条目**必须被拒绝，且**一个字节都不许写盘**。
 *
 * 为什么这些必须由单测守住：受管安装要把 124MB 的第三方制品解到用户磁盘上，
 * 一旦条目名能越界（Zip Slip）或能落符号链接，就等于让压缩包在用户机器上任意写/任意链。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractZip, listZipEntries, type ZipEntry } from '../src/server/host/unzip.js';

// ── 造 ZIP 的小工具 ─────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface BuildEntry {
  name: string;
  data: Buffer;
  /** 0 = stored，8 = deflate，其它值原样写入（用来构造「不支持的方法」）。 */
  method?: number;
  /** 外部属性（Unix 模式放在高 16 位）。 */
  externalAttrs?: number;
  /** versionMadeBy：高字节 = 主机系统（3 = Unix），低字节 = 版本号。 */
  versionMadeBy?: number;
}

interface BuildOptions {
  /** EOCD 注释（用来验证「带注释的中央目录结束记录」也能解析）。 */
  comment?: string;
}

/** 造一个最小但**合法**的 ZIP（本地头 + 中央目录 + EOCD）。 */
function buildZip(entries: BuildEntry[], options: BuildOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const method = e.method ?? 0;
    const raw = e.data;
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    lfh.writeUInt16LE(20, 4); // 解压所需版本
    lfh.writeUInt16LE(0, 6); // 通用标志位
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); // 时间
    lfh.writeUInt16LE(0, 12); // 日期
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra 长度
    locals.push(lfh, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    cd.writeUInt16LE(e.versionMadeBy ?? 20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); // 通用标志位
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra 长度
    cd.writeUInt16LE(0, 32); // 注释长度
    cd.writeUInt16LE(0, 34); // 起始磁盘号
    cd.writeUInt16LE(0, 36); // 内部属性
    cd.writeUInt32LE(e.externalAttrs ?? 0, 38);
    cd.writeUInt32LE(offset, 42); // 本地头偏移
    centrals.push(cd, nameBuf);

    offset += lfh.length + nameBuf.length + payload.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const commentBuf = Buffer.from(options.comment ?? '', 'utf8');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD 签名
  eocd.writeUInt16LE(0, 4); // 本磁盘号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘
  eocd.writeUInt16LE(entries.length, 8); // 本磁盘条目数
  eocd.writeUInt16LE(entries.length, 10); // 总条目数
  eocd.writeUInt32LE(cdBuf.length, 12); // 中央目录大小
  eocd.writeUInt32LE(offset, 16); // 中央目录偏移
  eocd.writeUInt16LE(commentBuf.length, 20);

  return Buffer.concat([...locals, cdBuf, eocd, commentBuf]);
}

/** 递归列出目录下的所有文件（相对路径，用 `/` 分隔）。 */
function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) walk(join(current, item.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

// ── 用例 ────────────────────────────────────────────────────────────

describe('M3 Task 1：最小 ZIP 解包', () => {
  let destDir: string;

  beforeEach(() => {
    destDir = mkdtempSync(join(tmpdir(), 'napcat-unzip-'));
  });

  afterEach(() => {
    rmSync(destDir, { recursive: true, force: true });
  });

  it('列出中央目录条目（stored + deflate 混合，EOCD 带注释）', () => {
    const buf = buildZip(
      [
        { name: 'index.js', data: Buffer.from('console.log(1)\n'), method: 8 },
        { name: 'napcat/', data: Buffer.alloc(0), method: 0 },
        { name: 'napcat/napcat.mjs', data: Buffer.from('export default 1\n'), method: 8 },
      ],
      { comment: '这个压缩包带一段 EOCD 注释' },
    );

    const entries = listZipEntries(buf);
    expect(entries.map((e) => e.name)).toEqual(['index.js', 'napcat/', 'napcat/napcat.mjs']);
    const index = entries[0];
    expect(index.method).toBe(8);
    expect(index.size).toBe(Buffer.byteLength('console.log(1)\n'));
    expect(index.compressedSize).toBeGreaterThan(0);
    expect(typeof index.offset).toBe('number');
    expect(entries[2].size).toBe(Buffer.byteLength('export default 1\n'));
  });

  it('解压 stored 与 deflate 条目，内容逐字节一致', () => {
    const stored = Buffer.from('plain stored content\n');
    const deflated = Buffer.from('deflated content '.repeat(50));
    const buf = buildZip([
      { name: 'stored.txt', data: stored, method: 0 },
      { name: 'deflated.txt', data: deflated, method: 8 },
    ]);

    const entries = listZipEntries(buf);
    const result = extractZip(buf, entries, destDir);

    expect(result.files).toBe(2);
    expect(result.bytes).toBe(stored.length + deflated.length);
    expect(readFileSync(join(destDir, 'stored.txt'))).toEqual(stored);
    expect(readFileSync(join(destDir, 'deflated.txt'))).toEqual(deflated);
  });

  it('解压时保留目录结构，并创建目录条目', () => {
    const buf = buildZip([
      { name: 'napcat/', data: Buffer.alloc(0), method: 0 },
      { name: 'napcat/static/app.js', data: Buffer.from('app'), method: 8 },
    ]);

    const entries = listZipEntries(buf);
    const result = extractZip(buf, entries, destDir);

    expect(result.files).toBe(1);
    expect(existsSync(join(destDir, 'napcat'))).toBe(true);
    expect(readFileSync(join(destDir, 'napcat', 'static', 'app.js')).toString()).toBe('app');
  });

  it('filter 可以只解出需要的条目', () => {
    const buf = buildZip([
      { name: 'keep.js', data: Buffer.from('keep'), method: 0 },
      { name: 'drop.js', data: Buffer.from('drop'), method: 0 },
    ]);

    const entries = listZipEntries(buf);
    const result = extractZip(buf, entries, destDir, { filter: (e) => e.name === 'keep.js' });

    expect(result.files).toBe(1);
    expect(listFiles(destDir)).toEqual(['keep.js']);
  });

  it('拒绝含 `..` 的条目（Zip Slip）：列表阶段就报错，且不写盘', () => {
    const buf = buildZip([{ name: '../evil.txt', data: Buffer.from('pwned'), method: 0 }]);

    expect(() => listZipEntries(buf)).toThrow(/Zip Slip|\.\./);
    expect(listFiles(destDir)).toEqual([]);
  });

  it('拒绝含 `..` 的条目：解压阶段（手工构造条目）同样拒绝，且不写盘', () => {
    const buf = buildZip([{ name: 'safe.txt', data: Buffer.from('ok'), method: 0 }]);
    const evil: ZipEntry = { name: '../evil.txt', size: 5, compressedSize: 5, method: 0, offset: 0 };

    expect(() => extractZip(buf, [evil], destDir)).toThrow(/Zip Slip|\.\./);
    expect(listFiles(destDir)).toEqual([]);
    expect(existsSync(join(destDir, '..', 'evil.txt'))).toBe(false);
  });

  it('先全量校验、后写盘：后面的条目越界时，前面正常的条目也不落盘', () => {
    // 「前几条正常、后一条越界」如果边校验边写，会留下半个安装目录（用户根本不知道装了一半）
    const buf = buildZip([
      { name: 'good.txt', data: Buffer.from('good'), method: 0 },
      { name: 'also-good.txt', data: Buffer.from('also good'), method: 8 },
    ]);
    const evil: ZipEntry = { name: '../evil.txt', size: 5, compressedSize: 5, method: 0, offset: 0 };

    expect(() => extractZip(buf, listZipEntries(buf).concat([evil]), destDir)).toThrow(/Zip Slip|\.\./);
    expect(listFiles(destDir)).toEqual([]);
  });

  it('拒绝绝对路径条目', () => {
    const buf = buildZip([{ name: '/etc/evil.txt', data: Buffer.from('pwned'), method: 0 }]);

    expect(() => listZipEntries(buf)).toThrow(/绝对路径/);
    expect(listFiles(destDir)).toEqual([]);
  });

  it('拒绝 Windows 盘符条目', () => {
    const buf = buildZip([{ name: 'C:/Windows/evil.txt', data: Buffer.from('pwned'), method: 0 }]);

    expect(() => listZipEntries(buf)).toThrow(/盘符|绝对路径/);
  });

  it('拒绝符号链接条目（外部属性高位标记）', () => {
    // Unix 创建的 zip：versionMadeBy 高字节 = 3，外部属性高 16 位是 Unix 模式
    // 0xA1FF = S_IFLNK | 0777 → 符号链接
    const buf = buildZip([
      {
        name: 'link.txt',
        data: Buffer.from('/etc/passwd'),
        method: 0,
        versionMadeBy: (3 << 8) | 20,
        externalAttrs: (0xa1ff << 16) >>> 0,
      },
    ]);

    expect(() => listZipEntries(buf)).toThrow(/符号链接/);
    expect(() => extractZip(buf, [{ name: 'link.txt', size: 11, compressedSize: 11, method: 0, offset: 0 }], destDir)).toThrow(
      /符号链接/,
    );
    expect(listFiles(destDir)).toEqual([]);
  });

  it('不支持的压缩方法（12 = bzip2）给出明确中文错误', () => {
    const buf = buildZip([{ name: 'weird.bin', data: Buffer.from('data'), method: 12 }]);
    const entries = listZipEntries(buf);

    expect(entries[0].method).toBe(12);
    expect(() => extractZip(buf, entries, destDir)).toThrow(/不支持的压缩方法/);
    expect(() => extractZip(buf, entries, destDir)).toThrow(/12/);
    expect(listFiles(destDir)).toEqual([]);
  });

  it('不是 ZIP 的内容给出明确错误', () => {
    expect(() => listZipEntries(Buffer.from('this is not a zip file at all'))).toThrow(/ZIP/);
  });

  it('条目数据被截断时给出明确错误（不写半个文件）', () => {
    const buf = buildZip([{ name: 'a.txt', data: Buffer.from('0123456789'), method: 0 }]);
    const truncated = buf.subarray(0, buf.length - 40); // 砍掉数据尾部

    let entries: ZipEntry[] = [];
    try {
      entries = listZipEntries(truncated);
    } catch {
      // 中央目录本身被砍掉时列表阶段就会失败——那也是「明确错误」
      expect(() => listZipEntries(truncated)).toThrow();
      return;
    }
    expect(() => extractZip(truncated, entries, destDir)).toThrow();
    expect(listFiles(destDir)).toEqual([]);
  });

  it('解压目标必须落在 destDir 之内（越界条目不写盘）', () => {
    const buf = buildZip([{ name: 'ok.txt', data: Buffer.from('ok'), method: 0 }]);
    const escapeName = 'escape.txt';
    const evil: ZipEntry = {
      name: `sub/../../${escapeName}`,
      size: 2,
      compressedSize: 2,
      method: 0,
      offset: 0,
    };

    expect(() => extractZip(buf, [evil], destDir)).toThrow();
    expect(existsSync(join(destDir, '..', escapeName))).toBe(false);
    expect(listFiles(destDir)).toEqual([]);
  });
});
