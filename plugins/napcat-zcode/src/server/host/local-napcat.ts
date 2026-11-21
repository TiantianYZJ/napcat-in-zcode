/**
 * M2 Task 2：本机 NapCat 安装与配置发现。
 *
 * 职责边界（硬约束）：
 * - **只读**：只读文件系统，不改用户文件、不启动/结束进程、不改 NapCat 配置。
 * - **有界**：每个根目录最多找**两层深**（`readdirSync` 两层），**绝不**全盘递归。
 * - **不抛错**：目录/文件不可读、JSON 损坏、路径不存在 → 跳过（跳过，不是抛错）。
 * - **不泄露凭据**：OneBot access token 与 WebUI token 的**明文都不进返回值**。
 *
 * 端点口径（与 Task 1 的探测内核 `onebot/detect.ts` 对齐）：
 * - `0.0.0.0` / `::`（监听所有网卡）→ **改写成回环**（`127.0.0.1` / `[::1]`）。
 *   不改写的话，Task 1 的回环闸门会把它**静默丢弃** → 明明 NapCat 在跑却报「没找到」（假阴性）。
 * - 其它非回环 host（如 `192.168.x.x`）→ **原样保留并标记** `nonLoopback`，
 *   由 Task 1 的闸门丢弃——在这里偷偷改成回环是**误导**（探到的不是用户配的那个地址）。
 * - endpoint 字符串的 **scheme 才是权威**（Task 1 会按 scheme 重算 `transport`），
 *   同一端口的 http 与 ws 是**两个**候选，不合并。
 *
 * 数量上限：install 候选排在端口候选**之后**进 Task 1 的 16 槽位并发闸门，
 * 超预算的候选**根本没被探到**（静默消失）。故这里限量并在结果里说明「已截断」。
 */

import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import { isLoopbackHost, normalizeEndpoint, type DetectCandidate } from '../onebot/detect.js';

/** 每个安装目录（根）最多采纳的端点数。 */
export const MAX_ENDPOINTS_PER_INSTALL = 6;
/** 全部安装目录合计最多采纳的端点数。 */
export const MAX_ENDPOINTS_TOTAL = 10;
/**
 * 查找深度：根目录下面最多两层（`<root>/xxx.json`、`<root>/<dir>/xxx.json`）。
 *
 * NapCat 的真实布局是 `<安装目录>/config/onebot11_<uin>.json`——两层正好够；
 * 再深就是「别的程序的东西」，且递归下去会拖垮进程。
 */
const MAX_SCAN_DEPTH = 2;

/** NapCat 的账号配置文件：`onebot11_<uin>.json`。 */
const ONEBOT_CONFIG_RE = /^onebot11.*\.json$/i;
/** NapCat 的 WebUI 配置文件。 */
const WEBUI_CONFIG_RE = /^webui\.json$/i;

/** 从配置里读到的 OneBot 端点。 */
export interface InstalledEndpoint {
  /** 规范化后的端点（`http://127.0.0.1:3000`）；不含凭据与 query。 */
  endpoint: string;
  /** 传输类型；**由 endpoint 的 scheme 决定**（Task 1 会按 scheme 再算一次）。 */
  transport: 'http' | 'ws';
  /** 来源说明：配置文件绝对路径（Task 1 把它带进候选的 `detail`）。 */
  detail: string;
  /** NapCat 里这个 server 项的名字（`name`），便于面板区分多个 server。 */
  serverName?: string;
  /** 监听所有网卡的 host 被改写成了回环（`0.0.0.0`→`127.0.0.1`、`::`→`[::1]`）。 */
  rewrittenToLoopback?: boolean;
  /** 该端点不是回环地址（Task 1 的 install 闸门会丢弃它）。 */
  nonLoopback?: boolean;
}

/** NapCat WebUI 的配置（**注意：WebUI token 不是 OneBot access token**）。 */
export interface InstalledNapCatWebUi {
  /** WebUI 端口（NapCat 可改，不是恒 6099）——Task 4 喂给 `detectLocal` 的 `webuiPort`。 */
  port: number;
  /**
   * WebUI 是否配置了登录 token（**只给「有没有」，不给明文**）。
   *
   * ⚠️ 这是 **NapCat WebUI 的登录 token**，**不是** OneBot access token，两者不能混用，
   * 也不能拿它当端点凭据。
   */
  tokenRequired?: boolean;
  /**
   * 恒为 `undefined`：WebUI token 的**明文不进返回值**。
   *
   * 保留这个字段只是为了与 plan 的接口签名兼容；请用 `tokenRequired` 判断。
   */
  token?: string;
  /** `webui.json` 里 `disableWebUI: true` → WebUI 被关掉了。 */
  disabled?: boolean;
}

/** 一个找到的 NapCat 安装。 */
export interface InstalledNapCat {
  /** 找到的 NapCat 配置目录（放 `onebot11_*.json` / `webui.json` 的那个目录）。 */
  configDir: string;
  /** `onebot11*.json` 的绝对路径。 */
  onebotConfigs: string[];
  /** 从配置里读到的端点。 */
  endpoints: InstalledEndpoint[];
  /** WebUI 配置（没有 `webui.json` 或读不出来时为 undefined）。 */
  webui?: InstalledNapCatWebUi;
  /** 端点数超出上限、被截断过。 */
  truncated?: boolean;
  /** 人类可读的补充说明（截断原因等）。 */
  notes?: string[];
}

interface FoundFile {
  path: string;
  dir: string;
  depth: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 列目录；不存在 / 不可读 / 不是目录 → undefined（跳过，不抛错）。 */
function safeReaddir(dir: string): Dirent[] | undefined {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
}

/** 读并解析 JSON；文件缺失 / 不可读 / 占用 / 损坏 → undefined（跳过，不抛错）。 */
function safeReadJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

/** 目录项是不是目录（软链要跟一次，否则 `/usr/local` 这种链接目录会被漏掉）。 */
function entryIsDir(entry: Dirent, fullPath: string): boolean {
  try {
    if (entry.isDirectory()) return true;
    if (entry.isSymbolicLink()) return statSync(fullPath).isDirectory();
  } catch {
    /* stat 失败 → 当成不是目录 */
  }
  return false;
}

/**
 * 在一个根目录下找 NapCat 配置文件。
 *
 * **最多两层深**：`<root>/x.json`（1 层）与 `<root>/<dir>/x.json`（2 层）会被找到，
 * `<root>/<dir>/<dir>/x.json`（3 层）**不会**——不做全盘递归。
 */
function scanRoot(root: string): { onebot: FoundFile[]; webui: FoundFile[] } {
  const onebot: FoundFile[] = [];
  const webui: FoundFile[] = [];
  const level1 = safeReaddir(root);
  if (!level1) return { onebot, webui };

  const visit = (dir: string, entries: Dirent[], depth: number): void => {
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entryIsDir(entry, full)) {
        if (depth >= MAX_SCAN_DEPTH) continue; // 再深就不看了
        const sub = safeReaddir(full);
        if (!sub) continue; // 不可读 → 跳过
        visit(full, sub, depth + 1);
        continue;
      }
      if (ONEBOT_CONFIG_RE.test(entry.name)) onebot.push({ path: full, dir, depth });
      else if (WEBUI_CONFIG_RE.test(entry.name)) webui.push({ path: full, dir, depth });
    }
  };
  visit(root, level1, 1);

  // 稳定的顺序：浅的在前，同深按路径排序（结果可复现）
  const byDepthThenPath = (a: FoundFile, b: FoundFile): number =>
    a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  onebot.sort(byDepthThenPath);
  webui.sort(byDepthThenPath);
  return { onebot, webui };
}

/**
 * server 项是不是启用。
 *
 * 只排除**显式关闭**（`false` / `0` / `'false'` / `'0'` / `''`）。
 * `enable` 缺失时按启用处理：NapCat 各版本都写 `enable`，
 * 但宁可多给一个候选（探不通只是失败一条），也不要因为字段缺失而漏掉正在跑的 NapCat。
 */
function isEnabled(value: unknown): boolean {
  if (value === false || value === 0 || value === 'false' || value === '0' || value === '') return false;
  return true;
}

/**
 * 监听所有网卡的 host → 回环。
 *
 * - `0.0.0.0`（或空）→ `127.0.0.1`
 * - `::` / `::0` → `::1`（拼进 URL 时加方括号）
 *
 * 其它 host 原样返回（**不**偷偷改成回环）。
 */
function rewriteHost(raw: string): { host: string; rewritten: boolean } {
  const h = raw.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (h === '' || h === '0.0.0.0' || h === '*') return { host: '127.0.0.1', rewritten: true };
  if (h === '::' || h === '::0' || h === '0:0:0:0:0:0:0:0') return { host: '::1', rewritten: true };
  return { host: h, rewritten: false };
}

/** 把 host 拼进 URL：IPv6 要加方括号。 */
function urlHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * 端口取值：只接受数字或数字字符串。
 *
 * `Number(true) === 1` 会把一个被写坏的 `port: true` 变成「端口 1」——
 * 宁可跳过（少一个候选），也不要造出一个指向错误端口的端点。
 */
function parsePort(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/**
 * 从 `network.httpServers` / `network.websocketServers` 里取启用项，拼成端点。
 *
 * **token 明文绝不进端点**：OneBot 的 access token 既不进 URL（凭据不进端点字符串），
 * 也不进返回值（探测本来就不带 token）。
 */
function collectServers(
  out: InstalledEndpoint[],
  raw: unknown,
  scheme: 'http' | 'ws',
  file: string,
): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (!isObj(item)) continue;
    if (!isEnabled(item.enable)) continue;
    const port = parsePort(item.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const { host, rewritten } = rewriteHost(typeof item.host === 'string' ? item.host : '');
    const endpoint = normalizeEndpoint(`${scheme}://${urlHost(host)}:${port}`);
    if (!endpoint) continue; // 非法端点 → 跳过
    const entry: InstalledEndpoint = {
      endpoint,
      transport: scheme, // scheme 是权威
      detail: file,
    };
    if (typeof item.name === 'string' && item.name.trim() !== '') entry.serverName = item.name.trim();
    if (rewritten) entry.rewrittenToLoopback = true;
    if (!isLoopbackHost(host)) entry.nonLoopback = true;
    out.push(entry);
  }
}

/** 从一个 `onebot11_*.json` 里读出端点。 */
function readOnebotEndpoints(file: string): InstalledEndpoint[] {
  const json = safeReadJson(file);
  if (!isObj(json)) return [];
  const network = isObj(json.network) ? json.network : {};
  const out: InstalledEndpoint[] = [];
  collectServers(out, network.httpServers, 'http', file);
  collectServers(out, network.websocketServers, 'ws', file);
  return out;
}

/** 从 `webui.json` 里读端口与「有没有 token」（**明文不进返回值**）。 */
function readWebUi(file: string): InstalledNapCatWebUi | undefined {
  const json = safeReadJson(file);
  if (!isObj(json)) return undefined;
  const port = parsePort(json.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const out: InstalledNapCatWebUi = { port };
  const token = typeof json.token === 'string' ? json.token.trim() : '';
  if (token !== '') out.tokenRequired = true;
  if (json.disableWebUI === true) out.disabled = true;
  return out;
}

/** 把一个根目录扫出来的结果组装成一条 `InstalledNapCat`。 */
function buildInstall(scan: { onebot: FoundFile[]; webui: FoundFile[] }): InstalledNapCat | undefined {
  if (scan.onebot.length === 0 && scan.webui.length === 0) return undefined;

  const onebotConfigs = scan.onebot.map((f) => f.path);
  const configDir = scan.onebot.length > 0 ? scan.onebot[0].dir : (scan.webui[0]?.dir ?? '');

  const endpoints: InstalledEndpoint[] = [];
  for (const file of scan.onebot) endpoints.push(...readOnebotEndpoints(file.path));

  const notes: string[] = [];
  let truncated = false;
  if (endpoints.length > MAX_ENDPOINTS_PER_INSTALL) {
    const dropped = endpoints.length - MAX_ENDPOINTS_PER_INSTALL;
    endpoints.length = MAX_ENDPOINTS_PER_INSTALL;
    truncated = true;
    notes.push(
      `端点数超过每个安装目录的上限（${MAX_ENDPOINTS_PER_INSTALL}），已截断（另有 ${dropped} 个端点未纳入）`,
    );
  }

  const inst: InstalledNapCat = { configDir, onebotConfigs, endpoints };
  const webui = scan.webui.length > 0 ? readWebUi(scan.webui[0].path) : undefined;
  if (webui) inst.webui = webui;
  if (truncated) inst.truncated = true;
  if (notes.length > 0) inst.notes = notes;
  return inst;
}

/**
 * 在给定的根目录里找本机 NapCat 安装，读出它配置的 OneBot 端点。
 *
 * - 找不到任何 NapCat → 返回**空数组**（不抛错）。
 * - 目录/文件不可读、JSON 损坏 → **跳过**（不抛错）。
 * - 只找两层深，不做全盘递归。
 * - 端点数有上限（每目录 / 全局），超了会截断并说明。
 */
export function findLocalNapCat(roots: string[]): InstalledNapCat[] {
  if (!Array.isArray(roots)) return [];
  const seen = new Set<string>();
  const results: InstalledNapCat[] = [];

  for (const raw of roots) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    let root: string;
    try {
      root = resolve(raw.trim());
    } catch {
      continue; // 非法路径 → 跳过
    }
    if (seen.has(root)) continue; // 同一个目录只扫一次
    seen.add(root);

    const inst = buildInstall(scanRoot(root));
    if (inst) results.push(inst);
  }

  // 全局上限：install 候选排在端口候选之后进并发闸门，超预算的压根不会被探到
  let remaining = MAX_ENDPOINTS_TOTAL;
  for (const inst of results) {
    if (inst.endpoints.length > remaining) {
      const dropped = inst.endpoints.length - remaining;
      inst.endpoints.length = Math.max(remaining, 0);
      inst.truncated = true;
      inst.notes = [
        ...(inst.notes ?? []),
        `端点数超过全局上限（${MAX_ENDPOINTS_TOTAL}），已截断（另有 ${dropped} 个端点未纳入）`,
      ];
    }
    remaining -= inst.endpoints.length;
  }

  return results;
}

/**
 * 把发现结果转成 Task 1 的 install 候选（`source: 'install'`）。
 *
 * Task 4 直接把它喂给 `detectLocal({ installCandidates, installPaths })`——
 * `DetectCandidate.source` 是必填的，而本模块的 `endpoints` 不带 `source`，
 * 由这里统一补上，避免各处映射时漏填或填错（Task 1 报告 §8.4 的遗留结论）。
 *
 * - `detail` = 配置文件绝对路径（面板要说明「这个端点是从哪个配置来的」）；
 * - `transport` 直接沿用（它由 endpoint 的 scheme 决定，与 Task 1 的重算口径一致）。
 */
export function toInstallCandidates(installed: InstalledNapCat[]): DetectCandidate[] {
  if (!Array.isArray(installed)) return [];
  const out: DetectCandidate[] = [];
  for (const inst of installed) {
    if (!inst || !Array.isArray(inst.endpoints)) continue;
    for (const e of inst.endpoints) {
      if (!e || typeof e.endpoint !== 'string' || e.endpoint === '') continue;
      out.push({
        endpoint: e.endpoint,
        transport: e.transport,
        source: 'install',
        detail: e.detail,
      });
    }
  }
  return out;
}

/**
 * 扫过的安装路径（配置文件路径 + 配置目录），供 Task 4 回显在 `scanned.paths`。 */
export function installPathsOf(installed: InstalledNapCat[]): string[] {
  if (!Array.isArray(installed)) return [];
  const out = new Set<string>();
  for (const inst of installed) {
    if (!inst) continue;
    if (inst.configDir) out.add(inst.configDir);
    for (const p of inst.onebotConfigs) if (p) out.add(p);
  }
  return [...out];
}

/**
 * 候选根目录（默认安装位置）。
 *
 * - 全部平台：`<home>/.napcat`、`<home>/NapCat`、`<home>/.config/napcat`
 * - Windows：`<APPDATA>/NapCat`、`<LOCALAPPDATA>/NapCat`、`<ProgramFiles>/NapCat`、
 *   `<ProgramFiles(x86)>/NapCat`、`<USERPROFILE>/AppData/Roaming/NapCatQQ`
 * - macOS/Linux：`<home>/Library/Application Support/NapCat`、`<home>/.local/share/NapCat`
 *
 * `env` 可注入（测试用）；不传时读 `process.env`。
 */
export function defaultNapCatRoots(
  homeDir: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = typeof homeDir === 'string' ? homeDir : '';
  const out: string[] = [];
  const add = (p: string | undefined): void => {
    if (typeof p === 'string' && p.trim() !== '') out.push(p.trim());
  };

  // 全部平台
  if (home) {
    add(join(home, '.napcat'));
    add(join(home, 'NapCat'));
    add(join(home, '.config', 'napcat'));
  }

  if (platform === 'win32') {
    if (env.APPDATA) add(join(env.APPDATA, 'NapCat'));
    if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, 'NapCat'));
    if (env.ProgramFiles) add(join(env.ProgramFiles, 'NapCat'));
    if (env['ProgramFiles(x86)']) add(join(env['ProgramFiles(x86)'], 'NapCat'));
    // <USERPROFILE>/AppData/Roaming/NapCatQQ
    if (home) add(join(home, 'AppData', 'Roaming', 'NapCatQQ'));
    if (env.USERPROFILE) add(join(env.USERPROFILE, 'AppData', 'Roaming', 'NapCatQQ'));
  } else {
    // macOS / Linux
    if (home) {
      add(join(home, 'Library', 'Application Support', 'NapCat'));
      add(join(home, '.local', 'share', 'NapCat'));
    }
  }

  return Array.from(new Set(out));
}
