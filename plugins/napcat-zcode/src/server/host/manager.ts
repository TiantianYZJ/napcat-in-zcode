/**
 * M3 Task 2：受管安装的**台账**（登记表）与**安装作业**（状态机）。
 *
 * 职责边界：
 * - **台账**（`managed-hosts.json`）：插件自己装过的 NapCat 都在册——安装目录、版本、模式、
 *   制品校验值、以及**插件自己拉起的进程 pid**。台账是「长期事实」，不是运行时缓存。
 * - **作业记录**（`managed-install-jobs.json`）：一次安装作业的进度与结果（有界保留）。
 *   它是「运行时状态」，可以随时清空而不影响台账；面板重开后靠它恢复进度显示。
 * - **私有凭据**（`managed-hosts.tokens.json`）：WebUI 登录 token **只**存在这里与受管安装目录的
 *   `webui.json` 里。台账里**绝不**出现凭据。
 *
 * 几条硬约束（改这个文件前先读）：
 * 1. **不引入运行时依赖**（可移植性红线）：只用 Node 内置模块。
 * 2. **不硬编码本机路径**：所有路径都从参数 / 环境变量推导。
 * 3. **失败不留半成品**：下载 / 校验 / 解压 / 写配置任一步失败 → 暂存目录与临时文件全部清掉，
 *    目标目录要么保持原样（覆盖安装时回滚旧目录），要么根本不存在。
 * 4. **进度不撒谎**：总大小未知时 `percent` 是 `undefined`，不是 0、也不是 100。
 * 5. **token 不外泄**：明文只落两个文件（安装目录的 `webui.json` + 私有凭据文件），
 *    对外一律给掩码；错误文案与说明里出现的 token 会被就地遮蔽。
 *
 * 与其它模块的分工：
 * - `host/download.ts`：下载 + sha256 校验（**产品路径拒绝回环/内网地址**，出网红线）。
 * - `host/unzip.ts`：最小 ZIP 解析与解包（Zip Slip / 符号链接防护）。
 * - `host/manager.ts`（本文件）：**编排**——暂存、换位、写配置、登记台账、推进状态机。
 * - `host/supervise.ts`（Task 3）：启停与状态判定，读写本文件的 pid。
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { downloadVerified, type DownloadOptions, type DownloadProgress, type DownloadResult } from './download.js';
import { extractZip, listZipEntries } from './unzip.js';

// ── 常量 ────────────────────────────────────────────────────────────

/** 台账文件名（落在 `${ZCODE_PLUGIN_DATA}` 下）。 */
export const REGISTRY_FILE_NAME = 'managed-hosts.json';
/** 安装作业记录文件名。 */
export const JOBS_FILE_NAME = 'managed-install-jobs.json';
/** 私有凭据文件名（**只**存 WebUI token，权限 0600）。 */
export const SECRETS_FILE_NAME = 'managed-hosts.tokens.json';

/** NapCat 默认 WebUI 端口。 */
export const DEFAULT_WEBUI_PORT = 6099;
/** NapCat 默认 OneBot HTTP 端口。 */
export const DEFAULT_ONEBOT_PORT = 3000;

/** 台账里最多保留的安装条目数（防止手改文件塞爆）。 */
export const MAX_INSTALLS = 64;
/** 作业记录最多保留的条数（超出丢最旧的）。 */
export const MAX_JOBS = 20;
/** 作业进度写盘的最小间隔（ms）：124MB 下载时别把磁盘刷爆。 */
export const JOB_FLUSH_INTERVAL_MS = 2000;
/** 单个作业最多保留多少条说明。 */
const MAX_JOB_NOTES = 20;
/** 台账 / 作业 / 凭据文件的 schema 版本（将来改结构时靠它区分）。 */
const SCHEMA_VERSION = 1;

// ── 类型 ────────────────────────────────────────────────────────────

/** 受管安装的运行模式。 */
export type ManagedMode =
  /** 独立模式：`node.exe index.js` 自己跑，完全不碰桌面 QQ（**默认且推荐**）。 */
  | 'standalone'
  /** 注入模式：`launcher-user.bat` → `NapCatWinBootMain.exe`（会注入桌面 QQ，有风险）。 */
  | 'inject';

/** 一个受管安装的登记条目。 */
export interface ManagedInstall {
  /** 稳定 id（由「版本 + 安装目录」派生，见 `deriveInstallId`）。 */
  id: string;
  /** 安装目录（绝对路径）。 */
  dir: string;
  /** 版本号（如 `4.18.42`）。 */
  version: string;
  /** 运行模式。 */
  mode: ManagedMode;
  /** 安装时间（ISO 8601）。 */
  installedAt: string;
  /** 制品的 sha256（小写十六进制）。 */
  artifactSha256: string;
  /**
   * **插件自己拉起的**进程 pid（Task 3 写入）。
   *
   * 没有这个字段 = 这个安装当前不是由本插件托管的进程 → 停止操作必须拒绝。
   */
  pid?: number;
  /** pid 的记录时间（ISO 8601）。 */
  pidRecordedAt?: string;
  /**
   * **接管**的安装（0.8.0）：来自 `napcat_adopt`——检测到的**用户自己装**的 NapCat，
   * 不是插件下载的。卸载时**只销号、不删目录**（那是用户的文件）。
   */
  adopted?: boolean;
  /** 接管时记录的 WebUI 端口（探测所得；`portsOf` 优先读它）。 */
  webuiPort?: number;
  /** 接管时记录的 OneBot 端口（探测所得；缺省用默认 3000）。 */
  onebotPort?: number;
}

/** 一次安装作业的请求（作业的输入）。 */
export interface InstallRequest {
  /** 目标安装目录（**必须**是绝对路径）。 */
  dir: string;
  /** 版本号。 */
  version: string;
  /** 运行模式。 */
  mode: ManagedMode;
  /** 制品下载地址。 */
  url: string;
  /** 期望的制品 sha256。 */
  sha256: string;
  /** 允许的下载源 host 清单（出网红线）。 */
  allowedHosts: string[];
  /** 可选代理（本机回环的 http/https 代理）。 */
  proxy?: string;
  /** 已知 QQ 号（uin）：有它才写 `onebot11_<uin>.json`。 */
  uin?: string;
  /** OneBot HTTP 端口（默认 3000）。 */
  onebotPort?: number;
  /** WebUI 端口（默认 6099）。 */
  webuiPort?: number;
  /** 桌面 QQ 的安装根（注入模式生成 `qqnt.json` 时用）。 */
  desktopQqRoots?: string[];
}

/** 一次安装作业。 */
export interface InstallJob {
  /** 作业 id（面板轮询用）。 */
  id: string;
  /** 开始时间（ISO 8601）。 */
  startedAt: string;
  /** 结束时间（ISO 8601；未结束没有这个字段）。 */
  finishedAt?: string;
  /** 作业状态。 */
  state: 'running' | 'succeeded' | 'failed';
  /** 当前阶段：`connecting → downloading → verifying → extracting → done | failed`。 */
  phase: DownloadProgress['phase'];
  /** 已下载字节数（真实字节，不是估算）。 */
  bytesReceived: number;
  /** 总字节数（服务器没给 Content-Length 时**没有**这个字段）。 */
  totalBytes?: number;
  /** 百分比（总大小未知时**必须**是 `undefined`，不许伪造 0 / 100）。 */
  percent?: number;
  /** 失败原因（中文人话，已脱敏）。 */
  error?: string;
  /** 成功时的安装登记条目。 */
  install?: ManagedInstall;
  /** 面向用户的中文说明（步骤性的：跳过了什么、为什么）。 */
  notes?: string[];
  /** 本次作业的请求（**已脱敏**：URL 里的 userinfo / query 被剥掉）。 */
  request?: InstallRequest;
}

/** 对外暴露的安装视图（`ManagedInstall` + 掩码后的 token）。 */
export interface ManagedInstallView {
  id: string;
  version: string;
  mode: ManagedMode;
  installedAt: string;
  artifactSha256: string;
  /** 安装目录（绝对路径）——这是**诊断字段**，路径只允许出现在这里。 */
  dir: string;
  /** 插件自己拉起的进程 pid。 */
  pid?: number;
  /** WebUI token 的**掩码**（永远不是明文）。 */
  webuiTokenMasked?: string;
  /** 接管的安装（用户自己装的；卸载只销号不删目录）。 */
  adopted?: boolean;
  /** 接管时记录的端口（探测所得）。 */
  webuiPort?: number;
  onebotPort?: number;
}

/** 对外暴露的作业视图。 */
export interface InstallJobView {
  id: string;
  startedAt: string;
  finishedAt?: string;
  state: InstallJob['state'];
  phase: InstallJob['phase'];
  bytesReceived: number;
  totalBytes?: number;
  percent?: number;
  error?: string;
  notes?: string[];
  install?: ManagedInstallView;
}

/** `ManagedHost` 的构造参数。 */
export interface ManagedHostOptions {
  /** 插件数据目录（`${ZCODE_PLUGIN_DATA}`）。 */
  dataDir: string;
  /** 台账路径（默认 `<dataDir>/managed-hosts.json`）。 */
  registryPath?: string;
  /** 作业记录路径（默认 `<dataDir>/managed-install-jobs.json`）。 */
  jobsPath?: string;
  /** 私有凭据路径（默认 `<dataDir>/managed-hosts.tokens.json`）。 */
  secretsPath?: string;
  /** 平台（测试注入；影响路径归一化与大小写口径）。 */
  platform?: NodeJS.Platform;
  /**
   * 下载器（默认产品路径 `downloadVerified`）。
   *
   * ⚠️ 产品代码**不得**传 `downloadVerifiedForTest`（它只允许回环地址）——
   * 这个注入位只给单测用（假源站只能跑在回环上）。
   */
  download?: (opts: DownloadOptions) => Promise<DownloadResult>;
  /** 作业状态变化回调（Task 4 用它把进度推给面板）。 */
  onJobUpdate?: (job: InstallJob) => void;
  /** 文本脱敏（Task 4 接 `state.redact`；不传则只做本模块自带的 token 遮蔽）。 */
  redact?: (text: string) => string;
  /** JSON 落盘实现（测试注入：模拟写到一半失败）。 */
  writeJson?: (path: string, value: unknown) => void;
}

// ── 小工具 ──────────────────────────────────────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 错误文案里不该出现的本机绝对路径（替换成占位符）。 */
const WINDOWS_PATH_RE = /(^|[^\w])([A-Za-z]:[\\/][^\s"'<>|。，、；：！？]*)/g;
const UNC_PATH_RE = /(^|[^\w])(\\\\[^\s"'<>|\\]+\\[^\s"'<>|\\]*)/g;
const POSIX_PATH_RE = /(^|[\s(])([/~][^\s"'()<>。，、；：！？]*)/g;

/** 把文案里的本机绝对路径替换掉（诊断字段之外的文案不许出现绝对路径）。 */
export function scrubLocalPaths(text: string, platform: NodeJS.Platform = process.platform): string {
  if (typeof text !== 'string' || text === '') return '';
  let out = text.replace(WINDOWS_PATH_RE, (_m, pre: string) => `${pre}<路径>`);
  out = out.replace(UNC_PATH_RE, (_m, pre: string) => `${pre}<路径>`);
  if (platform !== 'win32') {
    out = out.replace(POSIX_PATH_RE, (_m, pre: string) => `${pre}<路径>`);
  }
  return out;
}

/**
 * 凭据掩码：只留头 4 位与尾 4 位。
 *
 * 用途是「让用户认得出这是哪个 token」，**不是**让它可用。
 */
export function maskSecret(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/** 归一化目录路径（用于 id 派生与「同目录」判定）。 */
export function normalizeDirKey(dir: string, platform: NodeJS.Platform = process.platform): string {
  let abs: string;
  try {
    abs = resolve(dir);
  } catch {
    abs = String(dir ?? '');
  }
  const unified = abs.replace(/\\/g, '/');
  // Windows 上目录名不区分大小写 → 归一化时统一小写，否则 `D:\NapCat` 与 `d:\napcat`
  // 会被当成两个安装（台账里出现两条同目录记录）。
  return platform === 'win32' ? unified.toLowerCase() : unified;
}

/** 版本号里的杂字符换成 `-`（id 要能当文件名片段用）。 */
function sanitizeVersion(version: string): string {
  const cleaned = String(version ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned === '' ? 'unknown' : cleaned;
}

/**
 * 由「版本 + 安装目录」派生**稳定 id**。
 *
 * 同一个目录、同一个版本 → 永远是同一个 id → 重复安装不会在台账里堆出第二条。
 * 换了版本 → id 变（但台账仍然只保留该目录的一条，见 `ManagedHost.add`）。
 */
export function deriveInstallId(
  version: string,
  dir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const v = sanitizeVersion(version);
  const key = `${v}\n${normalizeDirKey(dir, platform)}`;
  const hash = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 10);
  return `napcat-${v}-${hash}`;
}

/** 生成一个新的作业 id。 */
export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

/** 生成 WebUI 登录 token（32 字节随机 → 64 位十六进制）。 */
export function generateWebuiToken(): string {
  return randomBytes(32).toString('hex');
}

/** 剥掉 URL 里的凭据（userinfo / query / fragment）——落盘的作业记录不许带凭据。 */
export function stripUrlCredentials(raw: string): string {
  try {
    const url = new URL(String(raw ?? '').trim());
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return String(raw ?? '')
      .split('#')[0]
      .split('?')[0];
  }
}

/** 写请求的脱敏副本（URL 去掉凭据）。 */
function sanitizeRequest(req: InstallRequest): InstallRequest {
  return { ...req, url: stripUrlCredentials(req.url) };
}

/** 删不掉的就算了——清理失败不能盖住原始错误。 */
function removeQuietly(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

/** 读 JSON；文件缺失 / 损坏 → undefined（**不抛错**：坏文件不能让插件起不来）。 */
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** 原子写 JSON 的可注入参数（测试用：模拟写到一半失败）。 */
export interface AtomicWriteOptions {
  /** 写临时文件的实现（默认 `writeFileSync`）。 */
  writeTmp?: (tmpPath: string, payload: string) => void;
  /** 临时文件名后缀（默认 `<pid>.<时间戳>`）。 */
  tmpSuffix?: string;
}

/**
 * **原子写** JSON：先写临时文件，再 `rename` 覆盖目标。
 *
 * - `rename` 在同一文件系统内是原子的 → 读方要么看到旧文件、要么看到完整的新文件，
 *   **不会**看到被截断了一半的 JSON。
 * - 序列化在写临时文件**之前**完成：序列化失败（循环引用等）时连临时文件都不会产生。
 * - 写临时文件失败 → 删掉可能写了一半的临时文件再重抛（旧文件原封不动）。
 * - 落盘后 `chmod 0600`：凭据文件只有本人可读（Windows 上 chmod 只是尽力而为）。
 */
export function writeJsonAtomic(
  path: string,
  value: unknown,
  opts: AtomicWriteOptions = {},
): void {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  const suffix = opts.tmpSuffix ?? `${process.pid}.${Date.now()}`;
  const tmp = `${path}.${suffix}.tmp`;
  const writeTmp =
    opts.writeTmp ??
    ((target: string, data: string): void => {
      writeFileSync(target, data, { encoding: 'utf-8', mode: 0o600 });
    });
  try {
    writeTmp(tmp, payload);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* 某些文件系统/平台不支持 chmod：不影响内容正确性 */
  }
}

/** 列目录；不可读 → 空数组。 */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ── 桌面 QQ 的发现（注入模式生成 qqnt.json 用） ────────────────────

/** 找到的桌面 QQ 应用信息。 */
export interface DesktopQqPackage {
  /** `resources/app/package.json` 的绝对路径。 */
  path: string;
  /** 解析出来的内容。 */
  packageJson: Record<string, unknown>;
  /** `version` 字段。 */
  version?: string;
  /** `buildVersion` 字段。 */
  buildVersion?: string;
  /** 所在版本目录名（`<root>/versions/<x>/…` 形态时是它）。 */
  versionDir?: string;
}

/**
 * 桌面 QQ 的**默认安装根**（按平台从环境变量推导，**不硬编码任何盘符**）。
 *
 * 形如 `<root>/resources/app/package.json` 或 `<root>/versions/<版本>/resources/app/package.json`。
 */
export function defaultDesktopQqRoots(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out: string[] = [];
  const add = (p: string | undefined): void => {
    if (typeof p === 'string' && p.trim() !== '') out.push(p.trim());
  };
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA, env.APPDATA]) {
      if (!base) continue;
      add(join(base, 'Tencent', 'QQ'));
      add(join(base, 'Tencent', 'QQNT'));
    }
    if (env.USERPROFILE) add(join(env.USERPROFILE, 'AppData', 'Roaming', 'Tencent', 'QQ'));
    if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, 'Tencent', 'QQ'));
  } else {
    add('/Applications/QQ.app');
    add(join(env.HOME ?? '', 'Applications', 'QQ.app'));
  }
  return Array.from(new Set(out.filter((p) => p !== '')));
}

/** 版本号比较（`9.9.37` 之类；解析不了就按字符串比）。 */
function compareVersionStrings(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a);
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  for (let i = 1; i <= 3; i++) {
    const na = Number(pa[i]);
    const nb = Number(pb[i]);
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * 在给定安装根下找桌面 QQ 的 `resources/app/package.json`。
 *
 * 支持两种形态：
 * - `<root>/resources/app/package.json`（root 本身就是 QQ 应用目录）；
 * - `<root>/versions/<版本>/resources/app/package.json`（root 是 QQ 安装根，
 *   启动器用的是里面的**最新版本目录**）。
 *
 * 找不到 → `undefined`（**不猜路径**：宁可跳过 `qqnt.json` 生成，也不能拿一个版本对不上的
 * `qqnt.json` 去覆盖制品自带的那个——QQ 启动器会对不上版本，直接报「文件已损坏」）。
 */
export function findDesktopQqPackage(roots: string[]): DesktopQqPackage | undefined {
  const candidates: { path: string; versionDir?: string }[] = [];
  for (const raw of Array.isArray(roots) ? roots : []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const root = raw.trim();
    candidates.push({ path: join(root, 'resources', 'app', 'package.json') });
    candidates.push({ path: join(root, 'Contents', 'Resources', 'app', 'package.json') });
    for (const versionDir of safeReaddir(join(root, 'versions'))) {
      candidates.push({
        path: join(root, 'versions', versionDir, 'resources', 'app', 'package.json'),
        versionDir,
      });
    }
  }
  // 版本目录里的优先（QQ 启动器用的是版本目录），同层按版本号从新到旧。
  candidates.sort((a, b) => {
    if (!!a.versionDir !== !!b.versionDir) return a.versionDir ? -1 : 1;
    if (a.versionDir && b.versionDir) return compareVersionStrings(b.versionDir, a.versionDir);
    return 0;
  });
  for (const candidate of candidates) {
    const json = readJsonFile(candidate.path);
    if (!isObj(json)) continue;
    const out: DesktopQqPackage = { path: candidate.path, packageJson: json };
    if (typeof json.version === 'string') out.version = json.version;
    if (typeof json.buildVersion === 'string') out.buildVersion = json.buildVersion;
    if (candidate.versionDir) out.versionDir = candidate.versionDir;
    return out;
  }
  return undefined;
}

// ── 台账条目的收敛（只保留已知字段） ────────────────────────────────

/**
 * 把读到的条目收敛成合法形状：**只**保留已知字段。
 *
 * 这么做有两个理由：
 * 1. 台账里**只**允许出现这些字段 → 手改文件塞进来的 `token` 之类不会被带进内存、
 *    也不会被下一次写盘固化回去；
 * 2. 字段类型不对时退回默认值，而不是把坏数据带进内存。
 */
export function sanitizeInstall(raw: unknown): ManagedInstall | undefined {
  if (!isObj(raw)) return undefined;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const dir = typeof raw.dir === 'string' ? raw.dir.trim() : '';
  const version = typeof raw.version === 'string' ? raw.version.trim() : '';
  if (id === '' || dir === '' || version === '') return undefined;
  const out: ManagedInstall = {
    id,
    dir,
    version,
    mode: raw.mode === 'inject' ? 'inject' : 'standalone',
    installedAt: typeof raw.installedAt === 'string' ? raw.installedAt : new Date(0).toISOString(),
    artifactSha256: typeof raw.artifactSha256 === 'string' ? raw.artifactSha256 : '',
  };
  if (typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0) out.pid = raw.pid;
  if (typeof raw.pidRecordedAt === 'string') out.pidRecordedAt = raw.pidRecordedAt;
  return out;
}

/** 把读到的作业收敛成合法形状。 */
export function sanitizeJob(raw: unknown): InstallJob | undefined {
  if (!isObj(raw)) return undefined;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (id === '') return undefined;
  const phases: DownloadProgress['phase'][] = [
    'connecting',
    'downloading',
    'verifying',
    'extracting',
    'done',
    'failed',
  ];
  const out: InstallJob = {
    id,
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : new Date(0).toISOString(),
    state: raw.state === 'succeeded' || raw.state === 'failed' ? raw.state : 'running',
    phase: phases.includes(raw.phase as DownloadProgress['phase'])
      ? (raw.phase as DownloadProgress['phase'])
      : 'connecting',
    bytesReceived:
      typeof raw.bytesReceived === 'number' && Number.isFinite(raw.bytesReceived)
        ? Math.max(0, Math.floor(raw.bytesReceived))
        : 0,
  };
  if (typeof raw.finishedAt === 'string') out.finishedAt = raw.finishedAt;
  if (typeof raw.totalBytes === 'number' && Number.isFinite(raw.totalBytes) && raw.totalBytes > 0) {
    out.totalBytes = raw.totalBytes;
  }
  // percent 只有在总大小已知时才有意义；总大小未知 → 不给百分比（不伪造）。
  if (out.totalBytes !== undefined && typeof raw.percent === 'number' && Number.isFinite(raw.percent)) {
    out.percent = Math.max(0, Math.min(100, raw.percent));
  }
  if (typeof raw.error === 'string' && raw.error !== '') out.error = raw.error;
  if (Array.isArray(raw.notes)) {
    const notes = raw.notes.filter((n): n is string => typeof n === 'string' && n !== '');
    if (notes.length > 0) out.notes = notes.slice(-MAX_JOB_NOTES);
  }
  const install = sanitizeInstall(raw.install);
  if (install) out.install = install;
  if (isObj(raw.request)) {
    const req = raw.request as Partial<InstallRequest>;
    out.request = {
      dir: typeof req.dir === 'string' ? req.dir : '',
      version: typeof req.version === 'string' ? req.version : '',
      mode: req.mode === 'inject' ? 'inject' : 'standalone',
      url: typeof req.url === 'string' ? req.url : '',
      sha256: typeof req.sha256 === 'string' ? req.sha256 : '',
      allowedHosts: Array.isArray(req.allowedHosts)
        ? req.allowedHosts.filter((h): h is string => typeof h === 'string')
        : [],
      ...(typeof req.proxy === 'string' ? { proxy: req.proxy } : {}),
      ...(typeof req.uin === 'string' ? { uin: req.uin } : {}),
    };
  }
  return out;
}

// ── 目录换位（覆盖安装时保住旧目录） ────────────────────────────────

/**
 * 一次「把暂存目录换到目标位置」的操作。
 *
 * 覆盖安装时先把旧目录挪到备份名，再把新目录换上去；
 * 后续步骤失败时 `rollback()` 把旧目录换回来 → **失败不留半成品**。
 */
class DirectorySwap {
  constructor(
    private readonly target: string,
    private readonly backup: string | undefined,
  ) {}

  /** 成功：删掉备份。 */
  commit(): void {
    if (this.backup) removeQuietly(this.backup);
  }

  /**
   * 失败：撤掉新目录，把旧目录换回来。
   *
   * @returns 换不回来时的说明（成功则 undefined）。旧目录会留在
   *          `<target>.napcat-old-<jobId>`，**必须**告诉用户 ——
   *          否则他的安装目录「凭空消失」而他毫不知情。
   */
  rollback(): string | undefined {
    if (!this.backup) {
      removeQuietly(this.target);
      return undefined;
    }
    if (!existsSync(this.backup)) return undefined;
    removeQuietly(this.target);
    try {
      renameSync(this.backup, this.target);
      return undefined;
    } catch {
      return `旧目录没能换回原位，它保留在 ${this.backup}，请手动改名回去。`;
    }
  }
}

export function assertInstallTargetSafe(dir: string, managed: boolean): void {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  if (stat.isSymbolicLink()) {
    throw new Error('安装目标不能是符号链接：请选择普通目录。');
  }
  if (managed) return;
  if (!stat.isDirectory()) {
    throw new Error('目标路径已存在且不是目录：为避免覆盖用户文件，请选择一个空目录。');
  }
  if (readdirSync(dir).length !== 0) {
    throw new Error('目标目录已存在且不属于插件受管安装：为避免覆盖用户文件，请选择一个空目录。');
  }
}

// ── 受管宿主 ────────────────────────────────────────────────────────

/**
 * 受管宿主的**台账 + 安装作业**。
 *
 * 用法：
 * ```ts
 * const host = new ManagedHost({ dataDir: dataDir() });
 * const job: InstallJob = { id: newJobId(), startedAt: new Date().toISOString(),
 *                            state: 'running', phase: 'connecting', bytesReceived: 0 };
 * host.startInstall(job, { dir, version, mode: 'standalone', url, sha256, allowedHosts });
 * // 面板轮询 host.getJob(job.id)
 * ```
 */
export class ManagedHost {
  /** 插件数据目录。 */
  readonly dataDir: string;
  /** 台账路径。 */
  readonly registryPath: string;
  /** 作业记录路径。 */
  readonly jobsPath: string;
  /** 私有凭据路径。 */
  readonly secretsPath: string;
  /** 平台（影响路径归一化）。 */
  readonly platform: NodeJS.Platform;

  private readonly opts: ManagedHostOptions;
  private readonly download: (opts: DownloadOptions) => Promise<DownloadResult>;
  /** 台账里的安装条目。 */
  private installs: ManagedInstall[] = [];
  /** 作业表（内存态始终最新；落盘按节流）。 */
  private readonly jobs = new Map<string, InstallJob>();
  /** 私有凭据：归一化目录 → WebUI token。 */
  private readonly secrets = new Map<string, string>();
  /** 本进程生成过的 token（用于就地遮蔽文案里的明文）。 */
  private readonly knownTokens = new Set<string>();
  /** 作业记录上次落盘的时间。 */
  private jobsFlushedAt = 0;

  constructor(opts: ManagedHostOptions) {
    if (!opts || typeof opts.dataDir !== 'string' || opts.dataDir.trim() === '') {
      throw new Error('受管宿主初始化失败：缺少插件数据目录。');
    }
    this.opts = opts;
    this.dataDir = resolve(opts.dataDir);
    this.registryPath = opts.registryPath ? resolve(opts.registryPath) : join(this.dataDir, REGISTRY_FILE_NAME);
    this.jobsPath = opts.jobsPath ? resolve(opts.jobsPath) : join(this.dataDir, JOBS_FILE_NAME);
    this.secretsPath = opts.secretsPath ? resolve(opts.secretsPath) : join(this.dataDir, SECRETS_FILE_NAME);
    this.platform = opts.platform ?? process.platform;
    this.download = opts.download ?? downloadVerified;
    this.installs = this.loadRegistry();
    this.loadJobs();
    this.loadSecrets();
  }

  // ── 台账 ──────────────────────────────────────────────────────────

  /** 全部受管安装（按登记顺序）。 */
  list(): ManagedInstall[] {
    return this.installs.map((i) => ({ ...i }));
  }

  /** 按 id 取一条。 */
  get(id: string): ManagedInstall | undefined {
    const found = this.installs.find((i) => i.id === id);
    return found ? { ...found } : undefined;
  }

  /** 按安装目录取一条（归一化比较；Windows 上不区分大小写）。 */
  findByDir(dir: string): ManagedInstall | undefined {
    const key = normalizeDirKey(dir, this.platform);
    const found = this.installs.find((i) => normalizeDirKey(i.dir, this.platform) === key);
    return found ? { ...found } : undefined;
  }

  /**
   * 登记一条安装（**幂等**）。
   *
   * - 同 id → 覆盖（同一条不会变成两条）；
   * - 同目录（不同 id，例如换了版本重装）→ 覆盖那一条：**一个目录在台账里永远只有一条**。
   *
   * 写盘失败会抛错，且**内存态不变**（磁盘是权威）。
   */
  add(install: ManagedInstall): void {
    const normalized = this.assertInstall(install);
    const dirKey = normalizeDirKey(normalized.dir, this.platform);
    const next: ManagedInstall[] = [];
    let replaced = false;
    for (const cur of this.installs) {
      if (cur.id === normalized.id) {
        next.push(normalized);
        replaced = true;
        continue;
      }
      if (normalizeDirKey(cur.dir, this.platform) === dirKey) {
        // 同目录 → 顶掉旧条目（换版本重装），但只顶一次
        if (!replaced) {
          next.push(normalized);
          replaced = true;
        }
        continue;
      }
      next.push(cur);
    }
    if (!replaced) next.push(normalized);
    this.persistRegistry(next.slice(-MAX_INSTALLS));
  }

  /**
   * 从台账里移除一条（**只**销号 + 清凭据，**不删目录**）。
   *
   * @returns 真的移除了才返回 true。
   */
  remove(id: string): boolean {
    const next = this.installs.filter((i) => i.id !== id);
    if (next.length === this.installs.length) return false;
    const removed = this.installs.find((i) => i.id === id);
    this.persistRegistry(next);
    if (removed) this.forgetSecret(removed.dir);
    return true;
  }

  /**
   * 卸载一个受管安装：**删除安装目录** + 销号 + 清凭据（台账 Task 4 的收尾）。
   *
   * 安全边界（与安装保护同一哲学）：
   * - **只接受台账 id**：目录取自台账登记值，不收调用方给的路径；
   * - **运行中的实例拒绝卸载**：先 `napcat_stop`（Windows 上运行中的文件本来就锁着）；
   * - **有指向同目录的进行中安装作业时拒绝**（下载/解压写到一半的目录不是稳定状态）；
   * - 目录若变成符号链接，拒绝跟随（防御台账文件被外部改动后的误删）；
   * - 目录已不存在时视为已卸载（幂等），照常销号并清凭据。
   *
   * @returns 卸载结果（`alreadyGone` 说明目录本来就不在了，台账已清理）。
   */
  uninstall(id: string): { id: string; dir: string; alreadyGone: boolean; kept: boolean } {
    const install = this.get(id);
    if (!install) {
      throw new Error('卸载失败：台账里没有这个安装 id（napcat_host_status 可看当前台账）。');
    }
    if (this.pidOf(id) !== undefined) {
      throw new Error('卸载失败：这个 NapCat 还在运行，请先停止（napcat_stop）再卸载。');
    }
    // 接管的安装（用户自己装的）：只销号，**绝不删用户的文件**
    if (install.adopted === true) {
      this.remove(id);
      return { id, dir: install.dir, alreadyGone: false, kept: true };
    }
    const dirKey = normalizeDirKey(install.dir, this.platform);
    const busy = this.listJobs().some(
      (job) =>
        job.state === 'running' &&
        job.request?.dir !== undefined &&
        normalizeDirKey(job.request.dir, this.platform) === dirKey,
    );
    if (busy) {
      throw new Error('卸载失败：这个目录有一个正在进行的安装作业，等它完成（或失败）后再卸载。');
    }
    let stat;
    try {
      stat = lstatSync(install.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`卸载失败：无法读取安装目录状态：${errText(err)}`);
      }
      // 目录已经不在（用户手动删过）→ 幂等：照常销号清凭据
      this.remove(id);
      return { id, dir: install.dir, alreadyGone: true, kept: false };
    }
    if (stat.isSymbolicLink()) {
      throw new Error('卸载失败：安装目录现在是符号链接。为避免误删链接目标，请人工检查后再处理。');
    }
    try {
      rmSync(install.dir, { recursive: true, force: true });
    } catch (err) {
      throw new Error(`卸载失败：删除安装目录时出错（可能有文件被占用）：${errText(err)}`);
    }
    this.remove(id);
    return { id, dir: install.dir, alreadyGone: false, kept: false };
  }

  /**
   * 记录 / 清除**插件自己拉起的**进程 pid（Task 3 用）。
   *
   * @param pid 传 `undefined` 表示清除（进程已经停了）。
   */
  setPid(id: string, pid: number | undefined): void {
    const index = this.installs.findIndex((i) => i.id === id);
    if (index < 0) return;
    const current = this.installs[index];
    const next = [...this.installs];
    const updated: ManagedInstall = { ...current };
    if (pid === undefined) {
      delete updated.pid;
      delete updated.pidRecordedAt;
    } else {
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error('记录进程 pid 失败：pid 必须是正整数。');
      }
      updated.pid = pid;
      updated.pidRecordedAt = new Date().toISOString();
    }
    next[index] = updated;
    this.persistRegistry(next);
  }

  /** 取某个安装当前记录的 pid（没有 → undefined：不是本插件启动的实例）。 */
  pidOf(id: string): number | undefined {
    return this.installs.find((i) => i.id === id)?.pid;
  }

  // ── 安装作业 ──────────────────────────────────────────────────────

  /**
   * 开始一次安装作业（**立刻返回**，不阻塞在 124MB 的下载上）。
   *
   * 状态机：`connecting → downloading → verifying → extracting → done | failed`。
   * 进度通过 `updateJob` 推进，面板用 `getJob(id)` 轮询。
   *
   * @param job 作业（没有 id 时会自动补一个）。
   * @param req  安装请求；不传则用 `job.request`。
   */
  startInstall(job: InstallJob, req?: InstallRequest): void {
    if (!job || typeof job !== 'object') {
      throw new Error('启动安装作业失败：作业对象无效。');
    }
    const request = req ?? job.request;
    const record: InstallJob = {
      ...job,
      id: typeof job.id === 'string' && job.id.trim() !== '' ? job.id : newJobId(),
      startedAt: typeof job.startedAt === 'string' ? job.startedAt : new Date().toISOString(),
      state: 'running',
      phase: 'connecting',
      bytesReceived: 0,
    };
    delete record.totalBytes;
    delete record.percent;
    delete record.finishedAt;
    delete record.error;
    delete record.install;
    if (request) record.request = sanitizeRequest(request);
    this.jobs.set(record.id, record);
    this.updateJob(record);

    if (!request) {
      record.state = 'failed';
      record.phase = 'failed';
      record.finishedAt = new Date().toISOString();
      record.error = '安装作业缺少安装请求（版本、安装目录、下载地址、校验值），无法开始。';
      this.updateJob(record);
      return;
    }
    void this.runInstall(record, request);
  }

  /**
   * 更新作业（进度 / 状态 / 说明）。
   *
   * 落盘是**节流**的（124MB 下载时不该把磁盘写爆），但内存态永远是最新的一份；
   * 作业进入终态（成功 / 失败）时一定落盘。
   */
  updateJob(job: InstallJob): void {
    if (!job || typeof job.id !== 'string' || job.id === '') return;
    const record: InstallJob = { ...job };
    if (record.error) record.error = this.redactText(record.error);
    if (record.notes) record.notes = record.notes.map((n) => this.redactText(n));
    this.jobs.set(record.id, record);
    this.flushJobs(record.state === 'running' ? false : true);
    try {
      this.opts.onJobUpdate?.({ ...record });
    } catch {
      /* 回调抛异常不能影响安装本身 */
    }
  }

  /** 按 id 取作业。 */
  getJob(id: string): InstallJob | undefined {
    const found = this.jobs.get(id);
    return found ? { ...found } : undefined;
  }

  /** 全部作业（按开始时间排序，最新在后）。 */
  listJobs(): InstallJob[] {
    return [...this.jobs.values()]
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
      .map((j) => ({ ...j }));
  }

  // ── 视图（对外暴露用，一律脱敏） ──────────────────────────────────

  /** 安装视图（token 永远是掩码）。 */
  view(install: ManagedInstall): ManagedInstallView {
    const masked = this.maskWebuiToken(install.dir);
    const out: ManagedInstallView = {
      id: install.id,
      version: install.version,
      mode: install.mode,
      installedAt: install.installedAt,
      artifactSha256: install.artifactSha256,
      dir: install.dir,
    };
    if (install.pid !== undefined) out.pid = install.pid;
    if (masked !== undefined) out.webuiTokenMasked = masked;
    if (install.adopted === true) out.adopted = true;
    if (install.webuiPort !== undefined) out.webuiPort = install.webuiPort;
    if (install.onebotPort !== undefined) out.onebotPort = install.onebotPort;
    return out;
  }

  /** 全部安装的视图。 */
  listViews(): ManagedInstallView[] {
    return this.installs.map((i) => this.view(i));
  }

  /** 作业视图（安装部分也走视图，明文 token 不会出现）。 */
  jobView(job: InstallJob): InstallJobView {
    const out: InstallJobView = {
      id: job.id,
      startedAt: job.startedAt,
      state: job.state,
      phase: job.phase,
      bytesReceived: job.bytesReceived,
    };
    if (job.finishedAt !== undefined) out.finishedAt = job.finishedAt;
    if (job.totalBytes !== undefined) out.totalBytes = job.totalBytes;
    if (job.percent !== undefined) out.percent = job.percent;
    if (job.error !== undefined) out.error = job.error;
    if (job.notes !== undefined) out.notes = [...job.notes];
    if (job.install !== undefined) out.install = this.view(job.install);
    return out;
  }

  // ── WebUI token ───────────────────────────────────────────────────

  /**
   * 取某个安装的 WebUI token **明文**（插件内部用；对外一律走 `maskWebuiToken`）。
   *
   * @param target 安装 id 或安装目录。
   */
  webuiTokenOf(target: string): string | undefined {
    const key = this.secretKeyOf(target);
    const cached = key ? this.secrets.get(key) : undefined;
    if (cached) return cached;
    // 接管的安装没有插件生成的 token——token 在它自己的 webui.json 里。
    // 这里只在服务端内存里用（调 WebUI API），不落台账、不给出参。
    const install = this.get(target);
    const dir = install?.dir ?? target;
    for (const rel of [
      ['napcat', 'config', 'webui.json'],
      ['config', 'webui.json'],
      ['webui.json'],
    ]) {
      try {
        const cfg = JSON.parse(readFileSync(join(dir, ...rel), 'utf8')) as { token?: unknown };
        if (typeof cfg.token === 'string' && cfg.token !== '') return cfg.token;
      } catch {
        /* 没有这个位置就试下一个 */
      }
    }
    return undefined;
  }

  /** 取某个安装的 WebUI token **掩码**（对外唯一允许的形态）。 */
  maskWebuiToken(target: string): string | undefined {
    return maskSecret(this.webuiTokenOf(target));
  }

  // ── 脱敏 ──────────────────────────────────────────────────────────

  /**
   * 脱敏一段文本：先过调用方的 `redact`（Task 4 接 `state.redact`），
   * 再遮蔽**本模块见过的 token**（插件自己生成的 WebUI token）。
   */
  redactText(text: string): string {
    if (typeof text !== 'string' || text === '') return '';
    let out = text;
    const external = this.opts.redact;
    if (typeof external === 'function') {
      try {
        out = external(out);
      } catch {
        /* 脱敏器抛异常也不能把原文放出去 —— 宁可丢内容，也不能泄凭据 */
        out = '[内容已省略]';
      }
    }
    for (const token of this.knownTokens) {
      if (token) out = out.split(token).join('***');
    }
    return out;
  }

  // ── 内部：安装流水线 ──────────────────────────────────────────────

  /** 校验安装请求（不合格就抛中文错误）。 */
  private assertRequest(req: InstallRequest): void {
    if (!req || typeof req !== 'object') {
      throw new Error('安装请求无效：缺少必要参数。');
    }
    if (typeof req.dir !== 'string' || req.dir.trim() === '') {
      throw new Error('安装请求无效：缺少安装目录。');
    }
    if (!isAbsolute(req.dir)) {
      throw new Error('安装目录必须是绝对路径：相对路径会随宿主的工作目录变化，无法复现。');
    }
    if (typeof req.version !== 'string' || req.version.trim() === '') {
      throw new Error('安装请求无效：缺少版本号。');
    }
    if (typeof req.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(req.sha256.trim())) {
      throw new Error('安装请求无效：制品校验值必须是 64 位 sha256 十六进制串。');
    }
    if (typeof req.url !== 'string' || req.url.trim() === '') {
      throw new Error('安装请求无效：缺少下载地址。');
    }
    if (req.mode !== 'standalone' && req.mode !== 'inject') {
      throw new Error('安装请求无效：模式只能是「独立」或「注入」。');
    }
    assertInstallTargetSafe(req.dir, Boolean(this.findByDir(req.dir)));
  }

  /** 校验并收敛一条安装条目。 */
  private assertInstall(install: ManagedInstall): ManagedInstall {
    if (!install || typeof install !== 'object') {
      throw new Error('登记安装失败：安装条目无效。');
    }
    const dir = typeof install.dir === 'string' ? install.dir.trim() : '';
    if (dir === '') throw new Error('登记安装失败：安装条目缺少安装目录。');
    if (!isAbsolute(dir)) throw new Error('登记安装失败：安装目录必须是绝对路径。');
    const version = typeof install.version === 'string' ? install.version.trim() : '';
    if (version === '') throw new Error('登记安装失败：安装条目缺少版本号。');
    const out: ManagedInstall = {
      id: typeof install.id === 'string' && install.id.trim() !== '' ? install.id.trim() : deriveInstallId(version, dir, this.platform),
      dir,
      version,
      mode: install.mode === 'inject' ? 'inject' : 'standalone',
      installedAt:
        typeof install.installedAt === 'string' && install.installedAt.trim() !== ''
          ? install.installedAt
          : new Date().toISOString(),
      artifactSha256: typeof install.artifactSha256 === 'string' ? install.artifactSha256.trim().toLowerCase() : '',
    };
    if (typeof install.pid === 'number' && Number.isInteger(install.pid) && install.pid > 0) {
      out.pid = install.pid;
    }
    if (typeof install.pidRecordedAt === 'string') out.pidRecordedAt = install.pidRecordedAt;
    if (install.adopted === true) out.adopted = true;
    if (typeof install.webuiPort === 'number' && Number.isInteger(install.webuiPort)) {
      out.webuiPort = install.webuiPort;
    }
    if (typeof install.onebotPort === 'number' && Number.isInteger(install.onebotPort)) {
      out.onebotPort = install.onebotPort;
    }
    return out;
  }

  /** 暂存目录：与目标目录**同父** → 换位是同文件系统内的 rename（原子）。 */
  private stagingDirFor(target: string, jobId: string): string {
    const abs = resolve(target);
    const parent = dirname(abs);
    mkdirSync(parent, { recursive: true });
    return join(parent, `.${basename(abs)}.napcat-install-${jobId}.tmp`);
  }

  /** 把暂存内容换到目标目录（覆盖安装时先备份旧目录）。 */
  private swapIntoPlace(payloadDir: string, target: string, jobId: string): DirectorySwap {
    const abs = resolve(target);
    let backup: string | undefined;
    if (existsSync(abs)) {
      backup = `${abs}.napcat-old-${jobId}`;
      removeQuietly(backup);
      try {
        renameSync(abs, backup);
      } catch (err) {
        throw new Error(
          `安装失败：无法把已有目录挪开（可能正被占用）。请关闭正在运行的 NapCat 后重试。（${errText(err)}）`,
        );
      }
    }
    try {
      renameSync(payloadDir, abs);
    } catch (err) {
      if (backup && existsSync(backup)) {
        try {
          renameSync(backup, abs);
        } catch {
          /* 换不回来也不能盖住原始错误 */
        }
      }
      throw new Error(`安装失败：无法把安装内容放到目标目录（${errText(err)}）。请检查安装路径是否可写。`);
    }
    return new DirectorySwap(abs, backup);
  }

  /** 往受管安装目录里写配置（WebUI / OneBot / qqnt.json）。 */
  private writeInstallConfig(payloadDir: string, job: InstallJob, req: InstallRequest): void {
    const napcatDir = join(payloadDir, 'napcat');
    const configDir = join(napcatDir, 'config');
    mkdirSync(configDir, { recursive: true });

    // ① WebUI 配置：token 由插件生成，只落两个地方（这里 + 私有凭据文件）
    const token = generateWebuiToken();
    this.knownTokens.add(token);
    const webui = {
      host: '127.0.0.1',
      port: req.webuiPort ?? DEFAULT_WEBUI_PORT,
      token,
      loginRate: 30,
      isLoginRate: false,
      enableAutoLogin: false,
    };
    this.writeJson(join(configDir, 'webui.json'), webui);

    // ② OneBot 配置：带 uin 写账号级配置；没有 uin 就写**全局** onebot11.json——
    // NapCat 在账号级配置缺失时回退读全局文件，登录后 OneBot Server 立即可用，
    // 不需要用户再去 WebUI 手动开启（初次体验的闭环关键）
    const uin = typeof req.uin === 'string' ? req.uin.trim() : '';
    const onebot = {
      network: {
        httpServers: [
          {
            name: 'napcat-zcode',
            enable: true,
            host: '127.0.0.1',
            port: req.onebotPort ?? DEFAULT_ONEBOT_PORT,
          },
        ],
        websocketServers: [],
      },
    };
    if (uin !== '') {
      this.writeJson(join(configDir, `onebot11_${uin}.json`), onebot);
    } else {
      this.writeJson(join(configDir, 'onebot11.json'), onebot);
      this.note(job, 'OneBot 已预配置：扫码登录后就能直接连接，无需再去 WebUI 手动开启。');
    }

    // ③ 注入模式：qqnt.json 必须以本机桌面 QQ 的 package.json 为底
    if (req.mode === 'inject') {
      this.writeQqntJson(napcatDir, job, req);
    }

    // ④ token 的第二份落点（私有凭据文件）——台账里永远不会有它
    this.rememberSecret(req.dir, token);
  }

  /** 生成注入模式需要的 `qqnt.json`。 */
  private writeQqntJson(napcatDir: string, job: InstallJob, req: InstallRequest): void {
    const target = join(napcatDir, 'qqnt.json');
    const roots =
      Array.isArray(req.desktopQqRoots) && req.desktopQqRoots.length > 0
        ? req.desktopQqRoots
        : defaultDesktopQqRoots(process.env, this.platform);
    const found = findDesktopQqPackage(roots);
    if (!found) {
      this.note(
        job,
        '注入模式：未找到本机桌面 QQ 的 resources/app/package.json，已保留制品自带的 qqnt.json。' +
          '若桌面 QQ 版本与制品不一致，QQ 启动器可能报「文件已损坏」——建议改用独立模式。',
      );
      return;
    }
    const base: Record<string, unknown> = { ...found.packageJson };
    base.main = './loadNapCat.js';
    this.writeJson(target, base);
    const versionText = found.version ?? found.versionDir ?? '未知版本';
    this.note(
      job,
      `注入模式：已按本机桌面 QQ（${versionText}）生成 qqnt.json（main = ./loadNapCat.js，版本与本机一致）。`,
    );
  }

  /** 安装流水线（下载 → 校验 → 解压 → 写配置 → 换位 → 登记）。 */
  private async runInstall(job: InstallJob, req: InstallRequest): Promise<void> {
    let staging: string | undefined;
    let swap: DirectorySwap | undefined;
    try {
      this.assertRequest(req);
      staging = this.stagingDirFor(req.dir, job.id);
      removeQuietly(staging);
      mkdirSync(staging, { recursive: true });

      // ① 下载 + sha256 校验
      const zipFile = join(staging, 'artifact.zip');
      this.setPhase(job, 'connecting', { bytesReceived: 0 });
      const downloaded = await this.download({
        url: req.url,
        destFile: zipFile,
        sha256: req.sha256,
        proxy: req.proxy,
        allowedHosts: req.allowedHosts,
        onProgress: (p) => this.onDownloadProgress(job, p),
      });

      // ② 解压（整包解开：制品顶层就是运行文件，`napcat/` 是它的子目录）
      //    注意：这里**不动** totalBytes / percent —— 服务器没给 Content-Length 时
      //    它们就一直是「未知」，不许用「下完了」反推一个 100% 出来。
      this.setPhase(job, 'extracting', { bytesReceived: downloaded.bytes });
      const buffer = readFileSync(downloaded.path);
      const entries = listZipEntries(buffer);
      const payloadDir = join(staging, 'payload');
      const extracted = extractZip(buffer, entries, payloadDir);

      // ③ 写配置
      this.writeInstallConfig(payloadDir, job, req);

      // 下载期间目标目录可能被外部进程改动；替换前重新确认未受管目录仍为空。
      assertInstallTargetSafe(req.dir, Boolean(this.findByDir(req.dir)));
      swap = this.swapIntoPlace(payloadDir, req.dir, job.id);

      // ⑤ 登记台账
      const install: ManagedInstall = {
        id: deriveInstallId(req.version, req.dir, this.platform),
        dir: resolve(req.dir),
        version: req.version,
        mode: req.mode,
        installedAt: new Date().toISOString(),
        artifactSha256: req.sha256.toLowerCase(),
      };
      this.add(install);

      job.install = install;
      job.state = 'succeeded';
      job.phase = 'done';
      job.finishedAt = new Date().toISOString();
      this.note(job, `安装完成：共解出 ${extracted.files} 个文件，${extracted.bytes} 字节。`);
      swap.commit();
      swap = undefined;
    } catch (err) {
      // 失败不留半成品：换位过就回滚（把旧目录换回来），暂存目录整个删掉
      if (swap) {
        const leftover = swap.rollback();
        if (leftover) {
          // 回滚失败必须让用户看见：他的旧安装目录可能已经不在原位了
          this.note(job, `注意：${leftover}`);
        }
      }
      // 安装没成 → 这次生成的 WebUI token 也不能留在凭据文件里（否则面板会给
      // 一个「根本不存在的安装」显示 token）
      this.forgetSecret(req.dir);
      job.state = 'failed';
      job.phase = 'failed';
      job.error = this.describeError(err);
      job.finishedAt = new Date().toISOString();
    } finally {
      if (staging) removeQuietly(staging);
      this.updateJob(job);
    }
  }

  /** 下载进度 → 作业进度。 */
  private onDownloadProgress(job: InstallJob, p: DownloadProgress): void {
    // 下载器在校验通过后发 `done`；作业状态机里对应的是 `verifying`（下一个阶段才是 extracting）。
    job.phase = p.phase === 'done' ? 'verifying' : p.phase;
    job.bytesReceived = p.bytesReceived;
    if (p.totalBytes !== undefined) job.totalBytes = p.totalBytes;
    else delete job.totalBytes;
    if (p.percent !== undefined) job.percent = p.percent;
    else delete job.percent;
    if (p.message) this.note(job, p.message);
    this.updateJob(job);
  }

  /**
   * 推进到某个阶段。
   *
   * `totalBytes` / `percent` **只在明确给出时才更新**（不给就保持原样）：
   * 服务器没声明 Content-Length 时它们就该一直是「未知」，
   * 不能因为「反正下完了」就反推一个 100% 出来（那是伪造进度）。
   */
  private setPhase(
    job: InstallJob,
    phase: DownloadProgress['phase'],
    progress: { bytesReceived: number; totalBytes?: number; percent?: number },
  ): void {
    job.phase = phase;
    job.bytesReceived = progress.bytesReceived;
    if (progress.totalBytes !== undefined) job.totalBytes = progress.totalBytes;
    if (progress.percent !== undefined) job.percent = progress.percent;
    this.updateJob(job);
  }

  /** 追加一条说明（只保留最近若干条）。 */
  private note(job: InstallJob, text: string): void {
    const value = this.redactText(text);
    if (!value) return;
    const notes = [...(job.notes ?? []), value];
    job.notes = notes.slice(-MAX_JOB_NOTES);
  }

  /** 把异常翻译成给用户看的中文说明。 */
  private describeError(err: unknown): string {
    const raw = errText(err);
    const cleaned = scrubLocalPaths(this.redactText(raw), this.platform).trim();
    if (cleaned === '') return '安装失败：原因未知，请重试。';
    // 已经是中文说明的（下载器 / 解包器的文案）直接用，别再套一层壳。
    if (/^[一-鿿]/.test(cleaned)) return cleaned;
    return `安装失败：${cleaned}。请检查安装路径是否可写、磁盘空间是否充足后重试。`;
  }

  // ── 内部：落盘 ────────────────────────────────────────────────────

  /** 读台账（文件缺失 / 损坏 → 空台账，不抛错）。 */
  private loadRegistry(): ManagedInstall[] {
    const raw = readJsonFile(this.registryPath);
    if (!isObj(raw)) return [];
    const list = Array.isArray(raw.installs) ? raw.installs : [];
    const out: ManagedInstall[] = [];
    for (const item of list) {
      const install = sanitizeInstall(item);
      if (install) out.push(install);
    }
    return out.slice(-MAX_INSTALLS);
  }

  /** 写台账（原子写）。 */
  private persistRegistry(next: ManagedInstall[]): void {
    this.writeJson(this.registryPath, { schemaVersion: SCHEMA_VERSION, installs: next });
    this.installs = next;
  }

  /** 读作业记录。 */
  private loadJobs(): void {
    const raw = readJsonFile(this.jobsPath);
    if (!isObj(raw)) return;
    const list = Array.isArray(raw.jobs) ? raw.jobs : [];
    for (const item of list) {
      const job = sanitizeJob(item);
      if (!job) continue;
      if (job.state === 'running') {
        // 上个进程被杀掉时作业还停在 running —— 恢复成 running 会让面板永远转圈
        job.state = 'failed';
        job.phase = 'failed';
        job.error = '上次安装在插件退出时被中断，未能完成。';
        job.finishedAt = job.finishedAt ?? new Date().toISOString();
      }
      this.jobs.set(job.id, job);
    }
  }

  /** 写作业记录（按节流；终态强制落盘）。 */
  private flushJobs(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.jobsFlushedAt < JOB_FLUSH_INTERVAL_MS) return;
    this.jobsFlushedAt = now;
    const jobs = [...this.jobs.values()].slice(-MAX_JOBS);
    try {
      this.writeJson(this.jobsPath, { schemaVersion: SCHEMA_VERSION, jobs });
    } catch {
      /* 作业记录写不进去不能影响安装本身（台账才是权威） */
    }
  }

  /** 读私有凭据。 */
  private loadSecrets(): void {
    const raw = readJsonFile(this.secretsPath);
    if (!isObj(raw)) return;
    const tokens = isObj(raw.tokens) ? raw.tokens : {};
    for (const [key, value] of Object.entries(tokens)) {
      if (typeof value === 'string' && value !== '') {
        this.secrets.set(key, value);
        this.knownTokens.add(value);
      }
    }
  }

  /** 写私有凭据（原子写，0600）。 */
  private persistSecrets(): void {
    const tokens: Record<string, string> = {};
    for (const [key, value] of this.secrets) tokens[key] = value;
    this.writeJson(this.secretsPath, { schemaVersion: SCHEMA_VERSION, tokens });
  }

  /** 凭据的键：优先用归一化目录，兼容按 id 查。 */
  private secretKeyOf(target: string): string | undefined {
    if (typeof target !== 'string' || target === '') return undefined;
    const byDir = normalizeDirKey(target, this.platform);
    if (this.secrets.has(byDir)) return byDir;
    const install = this.installs.find((i) => i.id === target);
    if (install) {
      const key = normalizeDirKey(install.dir, this.platform);
      if (this.secrets.has(key)) return key;
    }
    return undefined;
  }

  /** 记住某个安装目录的 token。 */
  private rememberSecret(dir: string, token: string): void {
    const key = normalizeDirKey(dir, this.platform);
    this.secrets.set(key, token);
    this.knownTokens.add(token);
    this.persistSecrets();
  }

  /** 忘掉某个安装目录的 token（卸载 / 销号时）。 */
  private forgetSecret(dir: string): void {
    const key = normalizeDirKey(dir, this.platform);
    if (!this.secrets.delete(key)) return;
    try {
      this.persistSecrets();
    } catch {
      /* 凭据清理失败不能盖住主流程 */
    }
  }

  /** 统一的 JSON 落盘入口（可注入，便于测试模拟写到一半失败）。 */
  private writeJson(path: string, value: unknown): void {
    if (this.opts.writeJson) {
      this.opts.writeJson(path, value);
      return;
    }
    writeJsonAtomic(path, value);
  }
}

/** 异常 → 文本。 */
function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? '');
}
