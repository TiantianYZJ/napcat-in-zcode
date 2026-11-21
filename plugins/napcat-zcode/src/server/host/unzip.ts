/**
 * M3 Task 1：最小 ZIP 解析与解包。
 *
 * 为什么自己实现：**Node 没有内置 ZIP 支持**（`zlib` 只有 deflate/inflate），
 * 而本项目**不引入任何运行时依赖**（可移植性红线 §7：市场安装不跑 `npm install`，
 * 交付物必须自包含）。故这里自带一个「够用且安全」的最小实现。
 *
 * 实现的范围：
 * - 解析 **EOCD**（含注释情形）、**中央目录**、**本地文件头**；支持 ZIP64 兜底。
 * - 支持 **stored(0)** 与 **deflate(8)** 两种压缩方法；其它方法给出明确中文错误。
 * - **Zip Slip 防护**：条目名含 `..` / 绝对路径 / 盘符 → 直接拒绝。
 * - **符号链接条目拒绝**：外部属性高 16 位是 Unix 模式位，`S_IFLNK`（0xA000）即符号链接 → 拒绝
 *   （符号链接能把安装目录里的文件指到别处）。
 * - 解压目标做**越界校验**：`path.resolve` 后必须仍在 `destDir` 之内。
 * - **zip 炸弹**防护：单条解压有 `maxOutputLength` 上限，全局有总字节预算。
 *
 * 三条硬约束（安全相关，改动前先读）：
 * 1. **两阶段**：① 校验阶段（名字 / 符号链接 / 压缩方法 / 本地头 / 解压 / 大小 / CRC / 体积预算
 *    **全部过一遍，数据丢弃不写盘**）→ ② 写盘阶段（只可能因 I/O 失败）。
 *    只在写盘前查名字是不够的：内容坏掉（CRC 不符 / 方法不支持）同样会留下半个安装目录，
 *    而用户根本不知道装了一半（计划 Task 2 要求「失败不留半成品目录」）。
 * 2. **不信任调用方给的 `entries`**：解包时用中央目录里的权威元数据复核
 *    （外部属性 / CRC / 大小），因为 `ZipEntry` 这个公开形状里放不下这些字段。
 * 3. **不覆盖已有的符号链接**：词法越界检查挡不住「目标位置本来就是个软链」，
 *    写盘前必须 `lstat` 一次。
 */

import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';

/** 中央目录里的一个条目（公开形状）。 */
export interface ZipEntry {
  /** 条目名（压缩包内路径，`/` 分隔；目录条目以 `/` 结尾）。 */
  name: string;
  /** 解压后的字节数。 */
  size: number;
  /** 压缩后的字节数。 */
  compressedSize: number;
  /** 压缩方法：0 = stored（不压缩），8 = deflate。 */
  method: number;
  /** 本地文件头在压缩包中的偏移。 */
  offset: number;
}

/** 中央目录条目（内部用：比公开形状多几个安全相关字段）。 */
interface CentralRecord extends ZipEntry {
  /** CRC-32（0 表示压缩包没写，跳过校验）。 */
  crc: number;
  /** 外部属性（含 Unix 模式位）。 */
  externalAttrs: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
/** EOCD 固定长度。 */
const EOCD_SIZE = 22;
/** 中央目录项固定长度。 */
const CENTRAL_SIZE = 46;
/** 本地文件头固定长度。 */
const LOCAL_SIZE = 30;
/** ZIP 注释最长 65535 字节（EOCD 里是 2 字节）。 */
const MAX_COMMENT_SIZE = 0xffff;
/** Unix 模式里的文件类型位。 */
const UNIX_S_IFMT = 0xf000;
const UNIX_S_IFLNK = 0xa000;

/**
 * 解压总字节预算上限（默认 2 GiB）——**zip 炸弹**防护。
 *
 * 压缩包可以声明「解压后 4GB」而实际只有几 KB；没有预算的话，
 * 一个恶意压缩包就能把用户磁盘塞满。
 */
export const DEFAULT_MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;

/** 压缩方法 → 中文名（报错时要说清「这是个什么方法」）。 */
const METHOD_NAMES: Record<number, string> = {
  1: 'shrink',
  2: 'reduce1',
  3: 'reduce2',
  4: 'reduce3',
  5: 'reduce4',
  6: 'implode',
  7: 'implode',
  9: 'deflate64',
  10: 'ibm teras',
  12: 'bzip2',
  14: 'lzma',
  93: 'zstd',
  94: 'xz',
  95: 'xz',
  96: 'jpeg',
  97: 'wavpack',
  98: 'ppmd',
  99: 'aes',
};

// ── CRC-32 ─────────────────────────────────────────────────────────

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

// ── 解析 ───────────────────────────────────────────────────────────

/** 找到 EOCD 的位置。 */
function findEocd(buf: Buffer): number {
  const minPos = Math.max(0, buf.length - EOCD_SIZE - MAX_COMMENT_SIZE);
  let fallback = -1;
  for (let pos = buf.length - EOCD_SIZE; pos >= minPos; pos--) {
    if (pos < 0 || pos + 4 > buf.length) continue;
    if (buf.readUInt32LE(pos) !== EOCD_SIGNATURE) continue;
    const commentLen = buf.readUInt16LE(pos + 20);
    if (pos + EOCD_SIZE + commentLen === buf.length) return pos;
    if (fallback < 0 && pos + EOCD_SIZE + commentLen <= buf.length) fallback = pos;
  }
  if (fallback >= 0) return fallback;
  throw new Error('解压失败：这不是一个有效的 ZIP 文件（找不到中央目录结束记录，文件可能已损坏或不是压缩包）。');
}

/** 读 ZIP64 的中央目录结束记录（普通字段是 0xffff/0xffffffff 时才需要）。 */
function readZip64Eocd(buf: Buffer, eocdPos: number): { total: number; size: number; offset: number } {
  const locatorPos = eocdPos - 20;
  if (locatorPos < 0 || buf.readUInt32LE(locatorPos) !== ZIP64_LOCATOR_SIGNATURE) {
    throw new Error('解压失败：压缩包使用了 ZIP64 扩展，但缺少 ZIP64 定位记录（文件可能被截断）。');
  }
  const z64Offset = Number(buf.readBigUInt64LE(locatorPos + 8));
  if (!Number.isSafeInteger(z64Offset) || z64Offset < 0 || z64Offset + 56 > buf.length) {
    throw new Error('解压失败：压缩包的 ZIP64 中央目录记录位置无效（文件可能被截断）。');
  }
  if (buf.readUInt32LE(z64Offset) !== ZIP64_EOCD_SIGNATURE) {
    throw new Error('解压失败：压缩包的 ZIP64 中央目录记录已损坏。');
  }
  const total = Number(buf.readBigUInt64LE(z64Offset + 32));
  const size = Number(buf.readBigUInt64LE(z64Offset + 40));
  const offset = Number(buf.readBigUInt64LE(z64Offset + 48));
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(size) || !Number.isSafeInteger(offset)) {
    throw new Error('解压失败：压缩包的 ZIP64 中央目录数值超出可处理范围。');
  }
  return { total, size, offset };
}

/**
 * 从 extra 字段里读 ZIP64 扩展信息（只补 0xffffffff 的那几项）。
 *
 * ⚠️ 找不到 / 读不全时**必须抛错**：静默返回 0xffffffff 哨兵会让后面按那个天文数字
 * 去切片，结果是「解压了半个空文件」或「越界读」——比直接报错难查得多。
 */
function readZip64Extra(
  extra: Buffer,
  current: { size: number; compressedSize: number; offset: number },
): { size: number; compressedSize: number; offset: number } {
  const needSize = current.size === 0xffffffff;
  const needCompressed = current.compressedSize === 0xffffffff;
  const needOffset = current.offset === 0xffffffff;
  if (!needSize && !needCompressed && !needOffset) return current;

  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const fieldSize = extra.readUInt16LE(pos + 2); // 这个 extra 字段自身的长度
    const dataStart = pos + 4;
    const dataEnd = dataStart + fieldSize;
    if (dataEnd > extra.length) break;
    if (id === 0x0001) {
      let cursor = dataStart;
      let uncompressedSize = current.size;
      let compressedSize = current.compressedSize;
      let localOffset = current.offset;
      // ZIP64 扩展里的值按「未压缩大小 / 压缩大小 / 本地头偏移」的顺序出现，
      // 且**只**出现那些在 32 位字段里写成 0xffffffff 的项。
      if (needSize) {
        if (cursor + 8 > dataEnd) break;
        uncompressedSize = Number(extra.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (needCompressed) {
        if (cursor + 8 > dataEnd) break;
        compressedSize = Number(extra.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (needOffset) {
        if (cursor + 8 > dataEnd) break;
        localOffset = Number(extra.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (!Number.isSafeInteger(uncompressedSize) || !Number.isSafeInteger(compressedSize) || !Number.isSafeInteger(localOffset)) {
        throw new Error('解压失败：压缩包的 ZIP64 扩展数值超出可处理范围。');
      }
      return { size: uncompressedSize, compressedSize, offset: localOffset };
    }
    pos = dataEnd;
  }
  throw new Error('解压失败：压缩包的 ZIP64 扩展信息不完整（文件可能被截断）。');
}

/** 解析中央目录（权威元数据）。 */
function parseCentralDirectory(buf: Buffer): CentralRecord[] {
  const eocdPos = findEocd(buf);
  let total = buf.readUInt16LE(eocdPos + 10);
  let cdOffset = buf.readUInt32LE(eocdPos + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) {
    const z64 = readZip64Eocd(buf, eocdPos);
    total = z64.total;
    cdOffset = z64.offset;
  }
  if (!Number.isSafeInteger(cdOffset) || cdOffset < 0 || cdOffset > buf.length) {
    throw new Error('解压失败：压缩包的中央目录位置无效（文件可能被截断）。');
  }

  const records: CentralRecord[] = [];
  let pos = cdOffset;
  for (let i = 0; i < total; i++) {
    if (pos + CENTRAL_SIZE > buf.length || buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw new Error(`解压失败：压缩包中央目录已损坏（读到第 ${i + 1} 个条目时中断）。`);
    }
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    let compressedSize = buf.readUInt32LE(pos + 20);
    let size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    let offset = buf.readUInt32LE(pos + 42);
    const nameStart = pos + CENTRAL_SIZE;
    if (nameStart + nameLen + extraLen + commentLen > buf.length) {
      throw new Error('解压失败：压缩包中央目录的条目信息不完整（文件可能被截断）。');
    }
    const name = buf.subarray(nameStart, nameStart + nameLen).toString('utf8');
    const extra = buf.subarray(nameStart + nameLen, nameStart + nameLen + extraLen);
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      const z64 = readZip64Extra(extra, { size, compressedSize, offset });
      size = z64.size;
      compressedSize = z64.compressedSize;
      offset = z64.offset;
    }
    records.push({ name, size, compressedSize, method, offset, crc, externalAttrs });
    pos = nameStart + nameLen + extraLen + commentLen;
  }
  return records;
}

// ── 安全校验 ───────────────────────────────────────────────────────

/**
 * 条目名是否安全（Zip Slip 防护）。
 *
 * 拒绝：绝对路径（`/x`）、Windows 盘符（`C:\x`）、含 `..` 路径段、含 NUL 字节。
 * 反斜杠按路径分隔符处理（Windows 上用 `\` 的压缩包不少见）。
 */
function assertSafeEntryName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('解压被拒绝：压缩包里有条目名无效，已中止（没有写出任何文件）。');
  }
  if (name.includes('\0')) {
    throw new Error('解压被拒绝：条目名包含非法字符，已中止（没有写出任何文件）。');
  }
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    throw new Error(`解压被拒绝：条目「${name}」是绝对路径，不允许写到目标目录之外，已中止（没有写出任何文件）。`);
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new Error(`解压被拒绝：条目「${name}」带盘符（绝对路径），不允许写到目标目录之外，已中止（没有写出任何文件）。`);
  }
  if (normalized.split('/').includes('..')) {
    throw new Error(
      `解压被拒绝：条目「${name}」含有「..」（Zip Slip），试图写到目标目录之外，已中止（没有写出任何文件）。`,
    );
  }
}

/**
 * 条目是不是符号链接。
 *
 * 只看**外部属性高 16 位的 Unix 模式位**（`S_IFLNK` = 0xA000）：
 * 不绑 `versionMadeBy` 的主机系统字节——有些工具用 DOS 来源标记却仍写入 Unix 模式位，
 * 绑死主机系统会漏判（漏判 = 符号链接被写进安装目录）。
 */
function isSymlinkEntry(rec: CentralRecord): boolean {
  const mode = (rec.externalAttrs >>> 16) & 0xffff;
  return (mode & UNIX_S_IFMT) === UNIX_S_IFLNK;
}

function assertNotSymlink(rec: CentralRecord): void {
  if (isSymlinkEntry(rec)) {
    throw new Error(
      `解压被拒绝：条目「${rec.name}」是符号链接，不允许写进目标目录（符号链接能把安装目录里的文件指到别处），已中止（没有写出任何文件）。`,
    );
  }
}

/** 压缩方法必须是 0（stored）或 8（deflate）。 */
function assertSupportedMethod(rec: CentralRecord): void {
  if (rec.method === 0 || rec.method === 8) return;
  const label = METHOD_NAMES[rec.method];
  throw new Error(
    `解压失败：条目「${rec.name}」使用了不支持的压缩方法 ${rec.method}${label ? `（${label}）` : ''}。` +
      '本插件只支持 0（不压缩）与 8（deflate）两种方法。',
  );
}

/** 解压目标路径：必须在 `root` 之内。 */
function resolveTarget(root: string, name: string): string {
  const rel = name.replace(/\\/g, '/').replace(/\/+$/, '');
  if (rel === '') return root;
  const target = resolve(root, rel);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`解压被拒绝：条目「${name}」的目标路径越出了目标目录，已中止（没有写出任何文件）。`);
  }
  return target;
}

/**
 * 写盘前检查目标位置是不是已有的符号链接。
 *
 * 词法越界检查（`resolve` 后仍在 destDir 内）挡不住这种情况：
 * destDir 里本来就有个 `config` → 指向别处的软链，
 * 往里写文件实际是写到了 destDir 之外。
 */
function assertTargetNotSymlink(target: string, name: string): void {
  let isSymlink = false;
  try {
    isSymlink = lstatSync(target).isSymbolicLink();
  } catch {
    return; // 不存在 → 正常（写的时候才创建）
  }
  if (isSymlink) {
    throw new Error(
      `解压被拒绝：目标位置「${name}」已经是一个符号链接，不允许覆盖（否则会写到目标目录之外），已中止。`,
    );
  }
}

/** 写文件时保留可执行位（Unix 来源的压缩包带模式位）。 */
function writeMode(rec: CentralRecord): { mode: number } | undefined {
  const mode = (rec.externalAttrs >>> 16) & 0o777;
  return mode ? { mode } : undefined;
}

// ── 公开接口 ───────────────────────────────────────────────────────

/**
 * 列出压缩包里的全部条目。
 *
 * **在这里就拒绝危险条目**（Zip Slip / 符号链接）是有意的：
 * 公开的 `ZipEntry` 形状放不下「这是符号链接」这类信息，
 * 与其让调用方拿到一份「看起来正常」的清单，不如在列目录这一步就失败——
 * 这样任何调用方都不可能「看一眼就放心地」去解它。
 *
 * @throws 压缩包损坏、含危险条目名、含符号链接条目时抛错（中文说明）。
 */
export function listZipEntries(buf: Buffer): ZipEntry[] {
  if (!Buffer.isBuffer(buf)) {
    throw new Error('解压失败：压缩包内容无效（不是二进制数据）。');
  }
  const records = parseCentralDirectory(buf);
  const out: ZipEntry[] = [];
  for (const rec of records) {
    assertSafeEntryName(rec.name);
    assertNotSymlink(rec);
    out.push({
      name: rec.name,
      size: rec.size,
      compressedSize: rec.compressedSize,
      method: rec.method,
      offset: rec.offset,
    });
  }
  return out;
}

/** 读出并解压单个条目的内容（含大小 / CRC 校验）。 */
function readEntryData(buf: Buffer, rec: CentralRecord): Buffer {
  assertSupportedMethod(rec);
  const lfh = rec.offset;
  if (!Number.isSafeInteger(lfh) || lfh < 0 || lfh + LOCAL_SIZE > buf.length) {
    throw new Error(`解压失败：条目「${rec.name}」的本地文件头位置无效（文件可能被截断）。`);
  }
  if (buf.readUInt32LE(lfh) !== LOCAL_SIGNATURE) {
    throw new Error(`解压失败：条目「${rec.name}」的本地文件头已损坏。`);
  }
  const nameLen = buf.readUInt16LE(lfh + 26);
  const extraLen = buf.readUInt16LE(lfh + 28);
  const dataStart = lfh + LOCAL_SIZE + nameLen + extraLen;
  const dataEnd = dataStart + rec.compressedSize;
  if (dataStart > buf.length || dataEnd > buf.length) {
    throw new Error(`解压失败：条目「${rec.name}」的数据不完整（压缩包可能被截断）。`);
  }
  const raw = buf.subarray(dataStart, dataEnd);

  let out: Buffer;
  if (rec.method === 0) {
    out = Buffer.from(raw);
  } else {
    try {
      out = inflateRawSync(raw, {
        // 单条上限：声明多大就只能解出多大（解压炸弹防护）
        maxOutputLength: Math.max(rec.size, 1),
      });
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code ?? '';
      if (code === 'ERR_BUFFER_TOO_LARGE') {
        throw new Error(
          `解压被拒绝：条目「${rec.name}」解压后的体积超过了压缩包声明的大小（疑似压缩炸弹或数据已损坏），已中止（没有写出任何文件）。`,
        );
      }
      throw new Error(`解压失败：条目「${rec.name}」无法用 deflate 解开（数据可能已损坏）。`);
    }
  }

  if (out.length !== rec.size) {
    throw new Error(`解压失败：条目「${rec.name}」解出的大小（${out.length} 字节）与压缩包记录（${rec.size} 字节）不一致。`);
  }
  if (rec.crc !== 0) {
    const actual = crc32(out);
    if (actual !== rec.crc) {
      throw new Error(`解压失败：条目「${rec.name}」的 CRC 校验不匹配（数据已损坏）。`);
    }
  }
  return out;
}

/** 解包选项。 */
export interface ExtractZipOptions {
  /**
   * 过滤条件：返回 `false` 的条目**不**解出来。
   *
   * 例如只解 `napcat/` 与顶层运行文件：`e => e.name.startsWith('napcat/') || !e.name.includes('/')`。
   */
  filter?: (e: ZipEntry) => boolean;
  /**
   * 解压总字节预算（zip 炸弹防护）。默认 2 GiB（`DEFAULT_MAX_EXTRACTED_BYTES`）。
   */
  maxTotalBytes?: number;
}

function normalizeBudget(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_EXTRACTED_BYTES;
  return Math.floor(value);
}

/**
 * 把压缩包解到 `destDir`。
 *
 * **两阶段**（硬约束）：
 * 1. 校验阶段：名字 / 符号链接 / 压缩方法 / 本地头 / 解压 / 大小 / CRC / 体积预算
 *    **全部过一遍**，数据只用于校验、**不写盘**；
 * 2. 写盘阶段：此时内容已经全部验证过，只可能因 I/O 失败。
 *
 * 代价是解压两次（124MB 制品多几秒 CPU），换来的是「失败不留半成品目录」。
 *
 * @returns 解出的文件数与总字节数（只统计文件，不含目录条目）。
 */
export function extractZip(
  buf: Buffer,
  entries: ZipEntry[],
  destDir: string,
  opts?: ExtractZipOptions,
): { files: number; bytes: number } {
  if (!Buffer.isBuffer(buf)) {
    throw new Error('解压失败：压缩包内容无效（不是二进制数据）。');
  }
  const root = resolve(destDir);
  const records = parseCentralDirectory(buf);
  const byName = new Map<string, CentralRecord>();
  for (const rec of records) byName.set(rec.name, rec);
  const maxTotalBytes = normalizeBudget(opts?.maxTotalBytes);

  // ── 阶段 ①：全量校验（一个字节都不写盘） ──
  const plan: { rec: CentralRecord; target: string; dir: boolean }[] = [];
  let declaredTotal = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.name !== 'string') {
      throw new Error('解压失败：条目信息无效（缺少条目名）。');
    }
    if (opts?.filter && opts.filter(entry) === false) continue;
    assertSafeEntryName(entry.name);
    const rec = byName.get(entry.name);
    if (!rec) {
      throw new Error(`解压失败：压缩包里找不到条目「${entry.name}」（清单与压缩包内容不一致）。`);
    }
    assertNotSymlink(rec);
    assertSupportedMethod(rec);
    const target = resolveTarget(root, rec.name);
    const isDir = rec.name.endsWith('/') || rec.name.endsWith('\\');
    declaredTotal += rec.size;
    if (declaredTotal > maxTotalBytes) {
      throw new Error(
        `解压被拒绝：压缩包声明的解压总大小超过上限（${maxTotalBytes} 字节），疑似压缩炸弹，已中止（没有写出任何文件）。`,
      );
    }
    plan.push({ rec, target, dir: isDir });
  }

  // 逐条解压校验（数据丢弃）：内容坏了必须在这里暴露，不能等到写盘时才发现
  let actualTotal = 0;
  for (const item of plan) {
    if (item.dir) continue;
    const data = readEntryData(buf, item.rec);
    actualTotal += data.length;
    if (actualTotal > maxTotalBytes) {
      throw new Error(
        `解压被拒绝：实际解压出的总大小超过上限（${maxTotalBytes} 字节），疑似压缩炸弹，已中止（没有写出任何文件）。`,
      );
    }
  }

  // ── 阶段 ②：写盘（内容已全部验证过） ──
  mkdirSync(root, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const item of plan) {
    if (item.dir) {
      mkdirSync(item.target, { recursive: true });
      continue;
    }
    assertTargetNotSymlink(item.target, item.rec.name);
    const data = readEntryData(buf, item.rec);
    mkdirSync(dirname(item.target), { recursive: true });
    writeFileSync(item.target, data, writeMode(item.rec));
    files += 1;
    bytes += data.length;
  }
  return { files, bytes };
}
