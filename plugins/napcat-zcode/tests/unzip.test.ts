/**
 * M3 Task 1：最小 ZIP 解析 / 解包。
 *
 * 用例全部在**内存里现造 ZIP**（不依赖任何真实压缩包文件，也不联网）：
 * - stored(0) 与 deflate(8) 两种压缩方法都要能解出**逐字节一致**的内容；
 * - 中央目录结束记录（EOCD）**带注释**时也要能解析（注释长度参与定位）；
 * - ZIP64 变体（32 位字段全是哨兵 + ZIP64 扩展）也要能解析；
 * - Zip Slip（`..` / 绝对路径）、**符号链接条目**、**不支持的压缩方法**、**坏 CRC** 必须被拒绝，
 *   且**一个字节都不许写盘**（含「前面几条正常、后面一条坏」的情形）。
 *
 * 为什么这些必须由单测守住：受管安装要把 124MB 的第三方制品解到用户磁盘上，
 * 一旦条目名能越界（Zip Slip）或能落符号链接，就等于让压缩包在用户机器上任意写/任意链；
 * 而「解一半失败」会留下半个安装目录，用户根本不知道装了一半。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
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
  /** 只在**中央目录**里写这个 CRC（本地头仍写真值）→ 制造「CRC 不匹配」。 */
  cdCrc?: number;
  /** 只在**中央目录**里写这个压缩大小（本地头仍写真值）→ 制造「数据被砍短」。 */
  cdCompressedSize?: number;
  /** 只在**中央目录**里写这个未压缩大小（本地头仍写真值）→ 制造「解压炸弹」。 */
  cdSize?: number;
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
    cd.writeUInt32LE(e.cdCrc ?? crc, 16);
    cd.writeUInt32LE(e.cdCompressedSize ?? payload.length, 20);
    cd.writeUInt32LE(e.cdSize ?? raw.length, 24);
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

/**
 * 造一个 ZIP64 变体：32 位字段全是哨兵（0xffff / 0xffffffff），
 * 真实值放在 ZIP64 扩展里，末尾是 ZIP64 EOCD + 定位器 + 普通 EOCD。
 */
function buildZip64(entries: BuildEntry[], options: { omitCentralExtra?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const method = e.method ?? 0;
    const raw = e.data;
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);

    // 本地头里的 ZIP64 extra：未压缩大小 + 压缩大小
    const localExtra = Buffer.alloc(4 + 16);
    localExtra.writeUInt16LE(0x0001, 0);
    localExtra.writeUInt16LE(16, 2);
    localExtra.writeBigUInt64LE(BigInt(raw.length), 4);
    localExtra.writeBigUInt64LE(BigInt(payload.length), 12);

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(45, 4); // 需要 4.5（ZIP64）
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(0xffffffff, 18); // 压缩大小 → ZIP64
    lfh.writeUInt32LE(0xffffffff, 22); // 未压缩大小 → ZIP64
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(localExtra.length, 28);
    locals.push(lfh, nameBuf, localExtra, payload);

    // 中央目录里的 ZIP64 extra：未压缩大小 + 压缩大小 + 本地头偏移
    const cdExtra = Buffer.alloc(4 + 24);
    cdExtra.writeUInt16LE(0x0001, 0);
    cdExtra.writeUInt16LE(24, 2);
    cdExtra.writeBigUInt64LE(BigInt(raw.length), 4);
    cdExtra.writeBigUInt64LE(BigInt(payload.length), 12);
    cdExtra.writeBigUInt64LE(BigInt(offset), 20);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(45, 4);
    cd.writeUInt16LE(45, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(0xffffffff, 20); // 压缩大小 → ZIP64
    cd.writeUInt32LE(0xffffffff, 24); // 未压缩大小 → ZIP64
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(options.omitCentralExtra ? 0 : cdExtra.length, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(e.externalAttrs ?? 0, 38);
    cd.writeUInt32LE(0xffffffff, 42); // 本地头偏移 → ZIP64
    centrals.push(cd, nameBuf);
    if (!options.omitCentralExtra) centrals.push(cdExtra);

    offset += lfh.length + nameBuf.length + localExtra.length + payload.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const cdOffset = offset;

  const z64 = Buffer.alloc(56);
  z64.writeUInt32LE(0x06064b50, 0);
  z64.writeBigUInt64LE(BigInt(44), 4); // 记录大小（不含前 12 字节）
  z64.writeUInt16LE(45, 12);
  z64.writeUInt16LE(45, 14);
  z64.writeUInt32LE(0, 16);
  z64.writeUInt32LE(0, 20);
  z64.writeBigUInt64LE(BigInt(entries.length), 24);
  z64.writeBigUInt64LE(BigInt(entries.length), 32);
  z64.writeBigUInt64LE(BigInt(cdBuf.length), 40);
  z64.writeBigUInt64LE(BigInt(cdOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(BigInt(cdOffset + cdBuf.length), 8); // ZIP64 EOCD 的偏移
  locator.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(0xffff, 8); // 哨兵
  eocd.writeUInt16LE(0xffff, 10); // 哨兵
  eocd.writeUInt32LE(0xffffffff, 12); // 哨兵
  eocd.writeUInt32LE(0xffffffff, 16); // 哨兵
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cdBuf, z64, locator, eocd]);
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

/**
 * 断言目标目录**存在且是空的**。
 *
 * ⚠️ 不能只写 `expect(listFiles(dir)).toEqual([])`：listFiles 在目录不存在时直接返回 []，
 * 那样「目录根本没被创建」也会恒真（假绿）。
 */
function expectDirEmpty(dir: string): void {
  expect(existsSync(dir)).toBe(true);
  expect(readdirSync(dir)).toEqual([]);
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
    expectDirEmpty(destDir);
  });

  it('拒绝含 `..` 的条目：解压阶段（手工构造条目）同样拒绝，且不写盘', () => {
    const buf = buildZip([{ name: 'safe.txt', data: Buffer.from('ok'), method: 0 }]);
    const evil: ZipEntry = { name: '../evil.txt', size: 5, compressedSize: 5, method: 0, offset: 0 };

    expect(() => extractZip(buf, [evil], destDir)).toThrow(/Zip Slip|\.\./);
    expectDirEmpty(destDir);
    expect(existsSync(join(destDir, '..', 'evil.txt'))).toBe(false);
  });

  it('拒绝绝对路径条目', () => {
    const buf = buildZip([{ name: '/etc/evil.txt', data: Buffer.from('pwned'), method: 0 }]);

    expect(() => listZipEntries(buf)).toThrow(/绝对路径/);
    expectDirEmpty(destDir);
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
    expectDirEmpty(destDir);
  });

  it('符号链接判定不绑死主机系统（DOS 来源但写了 Unix 模式位也要拒）', () => {
    const buf = buildZip([
      {
        name: 'sneaky.txt',
        data: Buffer.from('/etc/passwd'),
        method: 0,
        versionMadeBy: 20, // 高字节 = 0（MS-DOS），但外部属性仍带 S_IFLNK
        externalAttrs: (0xa1ff << 16) >>> 0,
      },
    ]);

    expect(() => listZipEntries(buf)).toThrow(/符号链接/);
  });

  it('不支持的压缩方法（12 = bzip2）给出明确中文错误', () => {
    const buf = buildZip([{ name: 'weird.bin', data: Buffer.from('data'), method: 12 }]);
    const entries = listZipEntries(buf);

    expect(entries[0].method).toBe(12);
    expect(() => extractZip(buf, entries, destDir)).toThrow(/不支持的压缩方法/);
    expect(() => extractZip(buf, entries, destDir)).toThrow(/12/);
    expectDirEmpty(destDir);
  });

  it('不是 ZIP 的内容给出明确错误', () => {
    expect(() => listZipEntries(Buffer.from('this is not a zip file at all'))).toThrow(/ZIP/);
  });

  it('中央目录还在、条目数据被砍短 → 抛错且不写盘', () => {
    // ⚠️ 不能把整个文件尾部砍掉（那样 EOCD 都没了，listZipEntries 先抛错，
    // extractZip 的断言一次都跑不到 = 假绿）。这里只让**中央目录里声明的**
    // 压缩大小比实际数据大 → 数据不完整。
    const buf = buildZip([
      { name: 'a.txt', data: Buffer.from('0123456789'), method: 0, cdCompressedSize: 9999 },
    ]);

    const entries = listZipEntries(buf);
    expect(() => extractZip(buf, entries, destDir)).toThrow(/数据不完整|截断/);
    expectDirEmpty(destDir);
  });

  it('条目 CRC 不匹配 → 抛错，且前面的正常条目也不能留下', () => {
    const buf = buildZip([
      { name: 'good.txt', data: Buffer.from('good'), method: 0 },
      // 中央目录里的 CRC 被改坏（本地头仍是真值）→ 解出来的内容对不上
      { name: 'bad.txt', data: Buffer.from('bad data'), method: 0, cdCrc: 0xdeadbeef },
    ]);

    const entries = listZipEntries(buf);
    expect(() => extractZip(buf, entries, destDir)).toThrow(/CRC/);
    expectDirEmpty(destDir);
  });

  it('第 2 条用了不支持的方法 → 第 1 条也不能留下', () => {
    const buf = buildZip([
      { name: 'first.txt', data: Buffer.from('first'), method: 0 },
      { name: 'second.bin', data: Buffer.from('second'), method: 12 },
    ]);

    const entries = listZipEntries(buf);
    expect(() => extractZip(buf, entries, destDir)).toThrow(/不支持的压缩方法/);
    expectDirEmpty(destDir);
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
    expectDirEmpty(destDir);
  });

  it('解压体积预算：超过上限的压缩包被拒绝（zip 炸弹）', () => {
    const buf = buildZip([{ name: 'big.txt', data: Buffer.from('x'.repeat(1024)), method: 0 }]);
    const entries = listZipEntries(buf);

    expect(() => extractZip(buf, entries, destDir, { maxTotalBytes: 100 })).toThrow(/压缩炸弹/);
    expectDirEmpty(destDir);
  });

  it('单条解压体积上限：声明的大小比实际小 → 拒绝（不无限膨胀）', () => {
    // 中央目录声明 10 字节，实际 deflate 出来 10000 字节 → 解压炸弹
    const buf = buildZip([
      { name: 'bomb.bin', data: Buffer.from('x'.repeat(10000)), method: 8, cdSize: 10 },
    ]);

    expect(() => extractZip(buf, listZipEntries(buf), destDir)).toThrow(/压缩炸弹|超出/);
    expectDirEmpty(destDir);
  });

  it('ZIP64 变体（32 位哨兵 + ZIP64 扩展）能正常解析与解压', () => {
    const payload = Buffer.from('zip64 content '.repeat(10));
    const buf = buildZip64([{ name: 'z64.txt', data: payload, method: 8 }]);

    const entries = listZipEntries(buf);
    expect(entries).toHaveLength(1);
    expect(entries[0].size).toBe(payload.length);
    expect(entries[0].method).toBe(8);

    const result = extractZip(buf, entries, destDir);
    expect(result.files).toBe(1);
    expect(readFileSync(join(destDir, 'z64.txt'))).toEqual(payload);
  });

  it('ZIP64 扩展信息不完整 → 明确报错（不静默返回哨兵值）', () => {
    const buf = buildZip64([{ name: 'z64.txt', data: Buffer.from('x'), method: 0 }], {
      omitCentralExtra: true,
    });

    expect(() => listZipEntries(buf)).toThrow(/ZIP64/);
  });

  it.runIf(process.platform !== 'win32')('目标位置已经是符号链接时拒绝写入', () => {
    const outside = join(destDir, '..', `outside-${process.pid}.txt`);
    symlinkSync(outside, join(destDir, 'target.txt'));
    const buf = buildZip([{ name: 'target.txt', data: Buffer.from('pwned'), method: 0 }]);

    try {
      expect(() => extractZip(buf, listZipEntries(buf), destDir)).toThrow(/符号链接/);
      expect(existsSync(outside)).toBe(false);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('解压保留可执行位', () => {
    const buf = buildZip([
      {
        name: 'run.sh',
        data: Buffer.from('#!/bin/sh\necho hi\n'),
        method: 0,
        versionMadeBy: (3 << 8) | 20,
        externalAttrs: (0o100755 << 16) >>> 0,
      },
    ]);

    extractZip(buf, listZipEntries(buf), destDir);
    const mode = statSync(join(destDir, 'run.sh')).mode & 0o777;
    expect(mode & 0o111).toBe(0o111);
  });
});
