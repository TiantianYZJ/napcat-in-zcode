/**
 * M3 Task 1：制品下载器（直连 + HTTP 代理 CONNECT 隧道）+ sha256 校验。
 *
 * 职责边界（硬约束）：
 * - **出网红线**：被请求的资源地址只允许 `http`/`https`，host 必须在**允许清单**内，
 *   且**拒绝回环 / 内网 / 保留地址**；重定向**每一跳**都要重新过同一道校验。
 *   代理是**用户显式配置的传输跳板**，只允许 `http`/`https` 且必须落在**本机回环**。
 * - **必须校验**：边下边算 sha256，校验不过 → 删除临时文件并报错，**绝不**留下未校验的包。
 * - **不伪造进度**：总大小未知（没有 Content-Length）时 `percent` 是 `undefined`，
 *   不是 0、也不是 100。
 * - **不留半成品**：先写 `destFile + '.part'`，校验通过才改名成 `destFile`；
 *   任何失败（超时 / 校验失败 / 地址被拒 / HTTP 错误）都会删掉临时文件。
 * - **超时必须覆盖连接阶段**：TCP 连接 / CONNECT 握手 / TLS 握手都在超时范围内——
 *   本机直连 GitHub 被墙、**必须**走代理，而代理「连上了但不回 CONNECT」这种半死状态
 *   会让后台安装作业永远挂着（面板永远转圈、用户还没有取消入口）。
 *
 * 实现说明：
 * - 直连走 `node:http` / `node:https`；
 * - 走代理时**手工发 CONNECT** 建立隧道，隧道内再按需套 TLS（https 资源），
 *   然后把这条 socket 通过 `createConnection` 交给 HTTP 客户端——
 *   ⚠️ 用 `createConnection` 时**不能**设置 `agent`（设了 agent，Node 就走 agent 自己的建连逻辑，
 *   我们的隧道就白建了）。
 * - 错误文案面向中文用户：说清「做了什么、为什么失败、用户下一步能做什么」，
 *   且**不泄露本地绝对路径**（路径只出现在调用方自己的字段里）。
 */

import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tcpConnect, isIP, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { connect as tlsConnect } from 'node:tls';

/** 下载进度（面板用它画进度条）。 */
export interface DownloadProgress {
  /** 已收到的字节数。 */
  bytesReceived: number;
  /** 总字节数（服务器没给 Content-Length 时**没有**这个字段）。 */
  totalBytes?: number;
  /**
   * 百分比（0–100）。
   *
   * **总大小未知时必须是 `undefined`**：伪造 0 或 100 都是在骗用户
   * （「已下载 100%」但文件其实还在下）。
   */
  percent?: number;
  /** 阶段。 */
  phase: 'connecting' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'failed';
  /** 面向用户的中文说明。 */
  message?: string;
}

/** 下载参数。 */
export interface DownloadOptions {
  /** 资源地址。 */
  url: string;
  /** 落盘的 zip 文件路径（先写 `.part`，校验通过后改名）。 */
  destFile: string;
  /** 期望的 sha256（小写十六进制，64 位）。 */
  sha256: string;
  /** 可选代理，如 `http://127.0.0.1:7897`（必须是本机回环地址）。 */
  proxy?: string;
  /** 允许的 host 清单（大小写不敏感）。 */
  allowedHosts: string[];
  /** 进度回调。 */
  onProgress?: (p: DownloadProgress) => void;
  /** 外部中止信号。 */
  signal?: AbortSignal;
  /** 超时（毫秒，默认 10 分钟）。 */
  timeoutMs?: number;
}

/** 下载结果。 */
export interface DownloadResult {
  /** 落盘后的文件路径。 */
  path: string;
  /** 字节数。 */
  bytes: number;
  /** 实际算出的 sha256（小写十六进制）。 */
  sha256: string;
}

/** 默认超时：10 分钟（124MB 制品在慢速代理下也不该超时）。 */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
/** 最多跟随的重定向跳数。 */
export const MAX_REDIRECTS = 5;
/** 进度回调的最小间隔（ms）：避免 124MB 下载把回调刷爆。 */
const PROGRESS_INTERVAL_MS = 50;

const USER_AGENT = 'NapCat-ZCode';

/** 内部错误：消息已经是给用户看的中文说明。 */
class DownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DownloadError';
  }
}

/**
 * 网络错误码 → 中文说明。
 *
 * 不做这层映射的话，用户会看到「下载失败：aborted」这种英文技术词——
 * 既看不懂也不知道下一步该干什么。
 */
const NETWORK_ERROR_TEXT: Record<string, string> = {
  ECONNRESET: '连接在传输过程中被断开（连接被重置）',
  ECONNABORTED: '连接在传输过程中被断开',
  EPIPE: '连接在传输过程中被断开（管道被关闭）',
  ERR_STREAM_PREMATURE_CLOSE: '连接在传输过程中被断开（数据没传完就断了）',
  ECONNREFUSED: '连接被拒绝（对方没有监听这个端口）',
  ETIMEDOUT: '连接超时（对方长时间没有回应）',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  ENOTFOUND: '域名解析失败（解析不到该地址）',
  EAI_AGAIN: '域名解析失败（DNS 暂时不可用）',
  ABORT_ERR: '操作被中止',
  ERR_TLS_CERT_ALTNAME_INVALID: '对方证书与域名不匹配',
  DEPTH_ZERO_SELF_SIGNED_CERT: '对方用的是自签证书（本机不信任）',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证对方证书的签名',
  CERT_HAS_EXPIRED: '对方证书已过期',
};

// ── host 分类 ──────────────────────────────────────────────────────

/** host 的性质。 */
export type HostKind =
  /** 公网地址（可下载）。 */
  | 'public'
  /** 回环地址（127/8、::1、localhost）。 */
  | 'loopback'
  /** 内网地址（10/8、172.16/12、192.168/16、169.254/16、fc00::/7 等）。 */
  | 'private'
  /** 保留地址（0.0.0.0、组播、文档网段等）。 */
  | 'reserved';

/** 解析 IPv4 四段点分十进制；不是合法 IPv4 → undefined。 */
function parseIPv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return undefined;
  const parts = m.slice(1).map((p) => Number(p));
  if (parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return undefined;
  return parts;
}

function classifyIPv4(host: string): HostKind {
  const parts = parseIPv4(host);
  if (!parts) return 'public';
  const [a, b, c] = parts;
  if (a === 127) return 'loopback'; // 127.0.0.0/8
  if (a === 10) return 'private'; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
  if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
  if (a === 169 && b === 254) return 'private'; // 169.254.0.0/16（链路本地）
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64.0.0/10（运营商级 NAT）
  if (a === 0) return 'reserved'; // 0.0.0.0/8（含 0.0.0.0）
  if (a >= 224 && a <= 239) return 'reserved'; // 组播
  if (a >= 240) return 'reserved'; // 保留 + 广播
  if (a === 192 && b === 0 && c === 2) return 'reserved'; // 文档网段
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // 基准测试网段
  if (a === 198 && b === 51 && c === 100) return 'reserved'; // 文档网段
  if (a === 203 && b === 0 && c === 113) return 'reserved'; // 文档网段
  return 'public';
}

/**
 * 把 IPv6 展开成 8 个 16 位组。
 *
 * `::` 会被补齐；末尾的 IPv4 写法（`::ffff:127.0.0.1`）会被折成 2 组。
 * 展开不了（不是 IPv6）→ undefined。
 */
function expandIPv6(host: string): number[] | undefined {
  let text = host.toLowerCase();
  if (!text.includes(':')) return undefined;
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone); // 去掉 zone id（fe80::1%eth0）
  const halves = text.split('::');
  if (halves.length > 2) return undefined;

  const parseSide = (side: string): number[] | undefined => {
    if (side === '') return [];
    const out: number[] = [];
    const items = side.split(':');
    for (let i = 0; i < items.length; i++) {
      const item = items[i] ?? '';
      if (item === '') return undefined;
      if (item.includes('.')) {
        if (i !== items.length - 1) return undefined; // IPv4 只允许出现在最后
        const v4 = parseIPv4(item);
        if (!v4) return undefined;
        out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0));
        out.push(((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(item)) return undefined;
      out.push(parseInt(item, 16));
    }
    return out;
  };

  const head = parseSide(halves[0] ?? '');
  const tail = parseSide(halves.length === 2 ? (halves[1] ?? '') : '');
  if (!head || !tail) return undefined;

  const groups: number[] = [...head];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return undefined;
    for (let i = 0; i < fill; i++) groups.push(0);
    groups.push(...tail);
  } else if (head.length !== 8) {
    return undefined;
  }
  return groups.length === 8 ? groups : undefined;
}

/**
 * IPv6 分类。
 *
 * ⚠️ 必须**展开成 8 组**再判：手写「首组是不是 fc/fd/fe80」的写法会漏掉
 * **IPv4-mapped** 写法（`::ffff:127.0.0.1`）——那正是回环地址，
 * 漏判 = SSRF 闸门被绕过（URL 解析器还会把 `::ffff:127.0.0.1` 规范化成 `::ffff:7f00:1`，
 * 字符串匹配更是不可能认出来）。
 */
function classifyIPv6(host: string): HostKind {
  const groups = expandIPv6(host);
  if (!groups) return 'public';
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  if (groups.every((v) => v === 0)) return 'reserved'; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && g7 === 1) {
    return 'loopback'; // ::1
  }
  // IPv4 映射（::ffff:a.b.c.d）/ 兼容（::a.b.c.d）：前 5 组为 0，第 6 组是 0xffff 或 0
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return classifyIPv4(`${(g6 ?? 0) >> 8}.${(g6 ?? 0) & 0xff}.${(g7 ?? 0) >> 8}.${(g7 ?? 0) & 0xff}`);
  }
  if ((g0 & 0xfe00) === 0xfc00) return 'private'; // fc00::/7（ULA）
  if ((g0 & 0xffc0) === 0xfe80) return 'private'; // fe80::/10（链路本地）
  if ((g0 & 0xff00) === 0xff00) return 'reserved'; // ff00::/8（组播）
  return 'public';
}

/**
 * 判断一个 host 是公网 / 回环 / 内网 / 保留。
 *
 * 主机名（非 IP）一律算「公网」——它不是 IP 字面量，本模块不做 DNS 解析
 * （解析了就可能被 DNS rebinding 骗过去）。
 */
export function classifyHost(hostname: string): HostKind {
  let host = String(hostname ?? '').trim().toLowerCase();
  if (!host) return 'reserved';
  host = host.replace(/^\[/, '').replace(/\]$/, '');
  host = host.split('%')[0]; // 去掉 IPv6 的 zone id（fe80::1%eth0）
  if (!host) return 'reserved';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (parseIPv4(host)) return classifyIPv4(host);
  if (host.includes(':')) return classifyIPv6(host);
  return 'public';
}

/** 规范化允许清单里的 host（去端口、去方括号、转小写）。 */
function normalizeHostEntry(entry: string): string {
  let host = String(entry ?? '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(1, end) : host.slice(1);
  }
  const idx = host.indexOf(':');
  if (idx >= 0 && host.indexOf(':', idx + 1) < 0) host = host.slice(0, idx); // 单个冒号 = 端口
  return host;
}

/** 资源地址策略。 */
type ResourcePolicy =
  /** 产品路径：只允许公网地址。 */
  | 'public'
  /** 仅测试：只允许回环地址（方向与产品路径相反，永远碰不到公网）。 */
  | 'loopback-only';

/**
 * 校验资源地址（出网红线的核心）。
 *
 * - scheme 必须是 `http`/`https`；
 * - **不允许**在地址里带账号密码（`user:pass@`）；
 * - host **不得**是回环 / 内网 / 保留地址；
 * - host 必须在允许清单内（大小写不敏感）。
 */
function assertResourceUrl(raw: string, allowedHosts: string[], policy: ResourcePolicy): URL {
  let url: URL;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new DownloadError(`下载被拒绝：「${raw}」不是合法的网址。请检查下载源配置。`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DownloadError(
      `下载被拒绝：只支持 http/https 下载地址，当前是「${url.protocol}」。请改用 http(s) 链接。`,
    );
  }
  if (url.username || url.password) {
    throw new DownloadError(
      '下载被拒绝：下载地址里不允许带账号密码（user:pass@…）。请改用不含凭据的下载链接。',
    );
  }
  const host = url.hostname.toLowerCase();
  const kind = classifyHost(host);
  if (kind === 'loopback' && policy === 'public') {
    throw new DownloadError(
      `下载被拒绝：「${host}」是本机回环地址，插件不允许从本机发起这类下载。请检查下载源配置。`,
    );
  }
  if (kind === 'private') {
    throw new DownloadError(
      `下载被拒绝：「${host}」属于内网地址，插件不允许下载内网资源。请检查下载源配置。`,
    );
  }
  if (kind === 'reserved') {
    throw new DownloadError(`下载被拒绝：「${host}」是保留地址，不能作为下载源。请检查下载源配置。`);
  }
  if (policy !== 'public' && kind !== 'loopback') {
    // 仅测试入口：只允许回环地址（放宽方向与产品路径相反）
    throw new DownloadError(`下载被拒绝：测试下载入口只允许本机回环地址，当前是「${host}」。`);
  }
  const allowed = new Set(
    (Array.isArray(allowedHosts) ? allowedHosts : []).map(normalizeHostEntry).filter((h) => h !== ''),
  );
  if (!allowed.has(normalizeHostEntry(host))) {
    throw new DownloadError(`下载被拒绝：这个下载地址不在允许的下载源里。`);
  }
  return url;
}

/**
 * 校验被请求的资源地址。
 *
 * - scheme 只允许 `http`/`https`；
 * - host 必须在 `allowedHosts` 内（大小写不敏感）；
 * - **拒绝**回环（`127.0.0.0/8`、`::1`、`localhost`）、内网（`10/8`、`172.16/12`、
 *   `192.168/16`、`169.254/16`、`fc00::/7`）与保留地址（`0.0.0.0` 等）。
 *
 * @returns 解析后的 `URL`（调用方直接用，不用再 parse 一次）。
 * @throws 不满足任一条时抛错（中文说明）。
 */
export function assertDownloadUrlAllowed(url: string, allowedHosts: string[]): URL {
  return assertResourceUrl(url, allowedHosts, 'public');
}

/**
 * 校验代理地址。
 *
 * 代理是**用户显式配置的传输跳板**，不是被请求的资源地址：
 * - scheme 只允许 `http`/`https`；
 * - host **必须是回环地址**（代理天然跑在本机；远程代理不受支持）。
 */
export function assertProxyUrlAllowed(proxy: string): URL {
  let url: URL;
  try {
    url = new URL(String(proxy ?? '').trim());
  } catch {
    throw new DownloadError(
      `代理地址无效：「${proxy}」。请填写形如 http://127.0.0.1:7897 的本机代理地址。`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DownloadError(
      `代理被拒绝：只支持 http/https 代理，当前是「${url.protocol}」。请改用 http(s) 代理地址。`,
    );
  }
  if (url.username || url.password) {
    throw new DownloadError('代理被拒绝：代理地址里不允许带账号密码。请改用不含凭据的代理地址。');
  }
  const host = url.hostname.toLowerCase();
  if (classifyHost(host) !== 'loopback') {
    throw new DownloadError(
      `代理被拒绝：代理必须落在本机回环地址（如 http://127.0.0.1:7897），当前是「${host}」。远程代理不受支持。`,
    );
  }
  return url;
}

// ── 进度上报 ───────────────────────────────────────────────────────

/** 百分比（总大小未知 → undefined，不伪造 0 / 100）。 */
function percentOf(bytes: number, total: number | undefined): number | undefined {
  if (!total || total <= 0) return undefined;
  return Math.round((bytes / total) * 1000) / 10;
}

interface Reporter {
  emit(p: DownloadProgress): void;
  downloading(bytesReceived: number, totalBytes: number | undefined): void;
}

function createReporter(onProgress?: (p: DownloadProgress) => void): Reporter {
  let lastEmit = 0;
  let lastPhase: DownloadProgress['phase'] | undefined;
  const emit = (p: DownloadProgress): void => {
    if (!onProgress) return;
    const now = Date.now();
    const phaseChanged = p.phase !== lastPhase;
    if (!phaseChanged && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    lastPhase = p.phase;
    try {
      onProgress(p);
    } catch {
      /* 进度回调抛异常不能影响下载本身 */
    }
  };
  return {
    emit,
    downloading(bytesReceived: number, totalBytes: number | undefined): void {
      emit({
        bytesReceived,
        totalBytes,
        percent: percentOf(bytesReceived, totalBytes),
        phase: 'downloading',
      });
    },
  };
}

// ── 传输层 ─────────────────────────────────────────────────────────

/**
 * 中止上下文：连接 / 握手阶段的超时与取消都靠它。
 *
 * `timedOut` 由外层的定时器置位——这样每一层都能说出「到底是超时了还是用户取消了」。
 */
interface AbortContext {
  signal: AbortSignal;
  /** 是否因为超时而中止。 */
  timedOut: boolean;
  /** 超时时长（文案要用）。 */
  timeoutMs: number;
}

function timeoutError(timeoutMs: number): DownloadError {
  return new DownloadError(
    `下载超时：超过 ${humanDuration(timeoutMs)} 仍未完成（连接下载源或代理阶段超时），已中止并清理临时文件。请检查网络连接或代理设置后重试。`,
  );
}

function cancelledError(): DownloadError {
  return new DownloadError('下载已取消：已中止并清理临时文件。');
}

/** 按上下文给出「超时」或「已取消」的错误。 */
function abortError(ctx: AbortContext): DownloadError {
  return ctx.timedOut ? timeoutError(ctx.timeoutMs) : cancelledError();
}

/** 去掉 IPv6 的方括号（Node 的 socket 连接要裸地址）。 */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[/, '').replace(/\]$/, '');
}

/** absolute-form 请求行（穿过 CONNECT 隧道时要用完整 URL）。 */
function absoluteForm(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}${url.search}`;
}

function connectTcp(host: string, port: number, ctx: AbortContext): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tcpConnect({ host, port });
    const cleanup = (): void => {
      ctx.signal.removeEventListener('abort', onAbort);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };
    // ⚠️ 用 `on` 而不是 `once`：settled 之后连接上再报错也必须有人接住
    // （没人接 = 未处理的 'error' 事件 = 整个进程崩掉）。
    const onError = (err: Error): void => {
      fail(new DownloadError(`连接失败：无法连到 ${host}:${port}（${err.message}）。请检查网络或代理设置。`));
    };
    const onConnect = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const onAbort = (): void => fail(abortError(ctx));
    socket.on('error', onError);
    socket.once('connect', onConnect);
    if (ctx.signal.aborted) {
      onAbort();
      return;
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 在已有 socket 上套一层 TLS（隧道内的 https 资源 / https 代理）。 */
function wrapTls(socket: Socket, host: string, ctx: AbortContext): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const tlsSocket = tlsConnect({
      socket,
      // IP 不能当 SNI 传（会被对端拒），域名必须传（证书校验要用）
      servername: isIP(host) ? undefined : host,
      ALPNProtocols: ['http/1.1'],
    });
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener('abort', onAbort);
      tlsSocket.destroy();
      reject(err);
    };
    const onError = (err: Error): void => {
      fail(new DownloadError(`TLS 握手失败：${err.message}。请检查代理设置与网络环境。`));
    };
    const onAbort = (): void => fail(abortError(ctx));
    tlsSocket.on('error', onError);
    tlsSocket.once('secureConnect', () => {
      if (settled) return;
      settled = true;
      ctx.signal.removeEventListener('abort', onAbort);
      tlsSocket.setTimeout(0); // 握手完了就不再用 socket 空闲超时（下载阶段由整体超时管）
      resolve(tlsSocket);
    });
    // 兜底：TLS 握手卡住（对端不回）也要能被超时打断
    tlsSocket.setTimeout(ctx.timeoutMs, () => fail(timeoutError(ctx.timeoutMs)));
    if (ctx.signal.aborted) {
      onAbort();
      return;
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 读一段 HTTP 响应头（到 `\r\n\r\n` 为止），多余字节放回 socket。 */
function readHead(socket: Socket, ctx: AbortContext): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      socket.setTimeout(0);
      socket.pause(); // 没有 'data' 监听者时数据会被直接丢掉
      ctx.signal.removeEventListener('abort', onAbort);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const leftover = buf.subarray(idx + 4);
      settled = true;
      cleanup();
      if (leftover.length > 0) socket.unshift(leftover);
      resolve(buf.subarray(0, idx).toString('latin1'));
    };
    const onEnd = (): void => {
      fail(new DownloadError('代理连接失败：代理没有返回 CONNECT 响应就断开了连接。请确认代理软件已启动。'));
    };
    const onError = (err: Error): void => fail(err);
    const onAbort = (): void => fail(abortError(ctx));
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.on('error', onError);
    // 兜底：代理连上了但不回 CONNECT（半死代理）——socket 空闲超时把它打断
    socket.setTimeout(ctx.timeoutMs, () => fail(timeoutError(ctx.timeoutMs)));
    if (ctx.signal.aborted) {
      onAbort();
      return;
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 建立到目标地址的 CONNECT 隧道（返回可用的 socket）。 */
async function openTunnel(url: URL, proxyUrl: URL, ctx: AbortContext): Promise<Socket> {
  const targetHost = bareHost(url);
  const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  const proxyHost = bareHost(proxyUrl);
  const proxyPort = Number(proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80));

  let socket = await connectTcp(proxyHost, proxyPort, ctx);
  try {
    if (proxyUrl.protocol === 'https:') {
      socket = await wrapTls(socket, proxyHost, ctx);
    }

    const handshake =
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
      `Host: ${targetHost}:${targetPort}\r\n` +
      'Proxy-Connection: keep-alive\r\n' +
      `User-Agent: ${USER_AGENT}\r\n\r\n`;
    socket.write(handshake);

    const head = await readHead(socket, ctx);
    const statusLine = head.split('\r\n')[0] ?? '';
    const m = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine);
    if (!m || Number(m[1]) !== 200) {
      socket.destroy();
      throw new DownloadError(
        `代理连接失败：代理返回「${statusLine || '空响应'}」，没能建立到 ${targetHost}:${targetPort} 的隧道。` +
          '请确认代理软件已启动、代理地址与端口填写正确。',
      );
    }

    // https 资源：隧道里再套一层 TLS
    if (url.protocol === 'https:') {
      return await wrapTls(socket, targetHost, ctx);
    }
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

/** 发一次请求（直连或穿过已有隧道）。 */
function requestOnce(url: URL, tunnel: Socket | undefined, signal: AbortSignal): Promise<IncomingMessage> {
  const isHttps = url.protocol === 'https:';
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: bareHost(url),
    port: url.port || (isHttps ? 443 : 80),
    // 直连用 origin-form；穿隧道用 absolute-form（代理隧道里要带完整 URL）
    path: tunnel ? absoluteForm(url) : `${url.pathname}${url.search}`,
    method: 'GET',
    headers: {
      // 显式带 Host（IPv6 要带方括号），并要求服务端不要压缩（否则 sha256 对不上）
      host: url.host,
      'accept-encoding': 'identity',
      'user-agent': USER_AGENT,
    },
    signal,
  };
  if (tunnel) {
    /**
     * ⚠️ 这里**不能**设置 `agent`。
     *
     * Node 的 HTTP 客户端只在「没有 agent」的时候才会调用 `createConnection`；
     * 一旦给了 agent（哪怕 `agent: false`），它就改走 agent 自己的建连逻辑，
     * 我们的 CONNECT 隧道会被晾在一边（下载会连到错误的地方去）。
     */
    options.createConnection = () => tunnel;
  } else {
    options.agent = false; // 直连：每次用新连接，别把连接留在池里
  }

  return new Promise((resolve, reject) => {
    const req = (isHttps ? httpsRequest : httpRequest)(options, resolve);
    req.on('error', reject);
    /**
     * 隧道 socket 在读 CONNECT 响应时被 `pause()` 过（防止响应头之后的字节被丢掉）。
     * Node 的 HTTP 客户端挂上 'data' 监听**不会**把暂停的 socket 恢复成流动模式
     * → 不手动 resume 的话，响应永远读不出来（下载会一直挂着直到超时）。
     */
    if (tunnel) tunnel.resume();
    req.end();
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseContentLength(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_DOWNLOAD_TIMEOUT_MS;
  return Math.floor(value);
}

/** 把时长说成人话（错误文案里用）。 */
function humanDuration(ms: number): string {
  if (ms % 60000 === 0) return `${ms / 60000} 分钟`;
  if (ms % 1000 === 0) return `${ms / 1000} 秒`;
  return `${ms} 毫秒`;
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* 删不掉也不能把原始错误盖掉 */
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────

/**
 * 下载并校验制品（**产品路径**）。
 *
 * - 资源地址走严格策略（`assertDownloadUrlAllowed`）：只允许清单内的公网 http/https 地址；
 * - 代理走 `assertProxyUrlAllowed`：只允许本机回环的 http/https 代理；
 * - 跟随重定向最多 5 跳，**每跳重新校验**；
 * - 边下边算 sha256，校验不过 → 删除临时文件并抛错；
 * - 超时（默认 10 分钟，覆盖 **TCP 连接 / CONNECT 握手 / TLS 握手 / 传输** 全程）→ 中止并清理临时文件。
 */
export async function downloadVerified(opts: DownloadOptions): Promise<DownloadResult> {
  return runDownload(opts, 'public');
}

/**
 * 下载并校验制品（**仅测试**）。
 *
 * 与产品路径的**唯一**差别：资源地址只允许**本机回环**（而不是只允许公网）。
 *
 * 为什么需要它：出网红线要求产品路径拒绝回环地址，而单测的假服务器只能跑在回环上——
 * 两者直接冲突。这个入口把放宽的方向**反过来**（只允许回环），
 * 所以它**永远不可能**被用来从公网拉东西。
 *
 * ⚠️ **运行时闸门**：非测试环境直接抛错（fail closed）。
 * 这个入口住在产品必引用的模块里，后续任务只要 import 一下就能把「本地文件服务器」
 * 变成下载源——所以必须靠环境变量把它焊死在测试环境里。
 */
export async function downloadVerifiedForTest(opts: DownloadOptions): Promise<DownloadResult> {
  if (!process.env.VITEST) {
    throw new DownloadError(
      '内部错误：测试专用下载入口在非测试环境不可用，产品路径必须调用 downloadVerified。',
    );
  }
  return runDownload(opts, 'loopback-only');
}

async function runDownload(opts: DownloadOptions, policy: ResourcePolicy): Promise<DownloadResult> {
  const expected = String(opts.sha256 ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new DownloadError('sha256 期望值无效：必须是 64 位十六进制字符串。请检查制品的校验值配置。');
  }
  const url = assertResourceUrl(opts.url, opts.allowedHosts, policy);
  const proxyUrl = opts.proxy ? assertProxyUrlAllowed(opts.proxy) : undefined;
  const timeoutMs = normalizeTimeout(opts.timeoutMs);

  const destFile = opts.destFile;
  const partFile = `${destFile}.part`;
  try {
    mkdirSync(dirname(destFile), { recursive: true });
  } catch {
    throw new DownloadError('下载失败：无法创建保存目录。请检查安装路径是否可写。');
  }
  removeQuietly(partFile); // 上一次残留的半成品

  const report = createReporter(opts.onProgress);
  report.emit({
    bytesReceived: 0,
    phase: 'connecting',
    message: proxyUrl ? '正在通过本机代理建立隧道…' : '正在连接下载源…',
  });

  const controller = new AbortController();
  const ctx: AbortContext = { signal: controller.signal, timedOut: false, timeoutMs };
  const timer = setTimeout(() => {
    ctx.timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onUserAbort = (): void => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onUserAbort, { once: true });
  }

  let bytesReceived = 0;
  try {
    // ── 请求（含重定向；每一跳都重新校验地址） ──
    let current = url;
    let response: IncomingMessage | undefined;
    for (let hop = 0; ; hop++) {
      const tunnel = proxyUrl ? await openTunnel(current, proxyUrl, ctx) : undefined;
      response = await requestOnce(current, tunnel, controller.signal);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (isRedirectStatus(status) && location) {
        response.on('error', () => {
          /* 被丢弃的重定向响应出错无关紧要 */
        });
        response.resume();
        // 这条隧道用完了：显式关掉（否则连跳几次重定向会攒下一堆半开连接）
        if (tunnel) tunnel.destroy();
        if (hop >= MAX_REDIRECTS) {
          throw new DownloadError(
            `下载失败：重定向跳数超过 ${MAX_REDIRECTS} 次仍没拿到文件。请检查下载源地址是否正确（版本号可能已失效）。`,
          );
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new DownloadError('下载失败：服务器给出的重定向地址不是合法网址。请检查下载源。');
        }
        // ⚠️ 每一跳都要重新过同一道校验（重定向到内网 = SSRF）
        current = assertResourceUrl(next.toString(), opts.allowedHosts, policy);
        continue;
      }
      break;
    }

    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      response.resume();
      throw new DownloadError(
        `下载失败：服务器返回 HTTP ${status}。请检查下载源地址与版本号是否正确（版本可能已下架）。`,
      );
    }

    // ── 落盘（先写 .part）+ 边下边算 sha256 ──
    const totalBytes = parseContentLength(response.headers['content-length']);
    const hash = createHash('sha256');
    const sink = createWriteStream(partFile);
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        bytesReceived += chunk.length;
        hash.update(chunk);
        report.downloading(bytesReceived, totalBytes);
        callback(null, chunk);
      },
    });
    report.downloading(0, totalBytes);
    await pipeline(response, counter, sink);

    if (totalBytes !== undefined && bytesReceived !== totalBytes) {
      throw new DownloadError(
        `下载失败：实际收到 ${bytesReceived} 字节，与服务器声明的 ${totalBytes} 字节不一致（连接在传输过程中被断开）。请检查网络连接或代理设置后重试。`,
      );
    }

    // ── 校验 ──
    report.emit({
      bytesReceived,
      totalBytes,
      percent: percentOf(bytesReceived, totalBytes),
      phase: 'verifying',
      message: '正在校验 sha256…',
    });
    const digest = hash.digest('hex');
    if (digest !== expected) {
      removeQuietly(partFile);
      throw new DownloadError(
        `校验失败：下载内容的 sha256（${digest}）与预期（${expected}）不一致，已丢弃临时文件，不会安装未经校验的包。` +
          '请重新下载；若反复失败，说明下载源可能被劫持或文件已损坏，请换一个下载源。',
      );
    }

    // ── 校验通过：改名成正式文件 ──
    renameSync(partFile, destFile);
    report.emit({
      bytesReceived,
      totalBytes,
      percent: totalBytes !== undefined ? 100 : undefined,
      phase: 'done',
      message: '下载完成，sha256 校验通过。',
    });
    return { path: destFile, bytes: bytesReceived, sha256: digest };
  } catch (err) {
    removeQuietly(partFile);
    const message = describeError(err, { timedOut: ctx.timedOut, timeoutMs, aborted: opts.signal?.aborted === true });
    report.emit({ bytesReceived, phase: 'failed', message });
    throw new DownloadError(message, { cause: err });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onUserAbort);
  }
}

/** 取错误码（`ECONNRESET` 之类）。 */
function errorCodeOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/**
 * 把内部错误翻译成给用户看的中文说明。
 *
 * ⚠️ 不能把 Node 的原始英文报错（「aborted」「socket hang up」）直接抛给用户：
 * 既看不懂也不知道下一步该干什么。
 */
function describeError(
  err: unknown,
  ctx: { timedOut: boolean; timeoutMs: number; aborted: boolean },
): string {
  if (err instanceof DownloadError) return err.message;
  if (ctx.timedOut) return timeoutError(ctx.timeoutMs).message;
  if (ctx.aborted) return cancelledError().message;
  const raw = err instanceof Error ? err.message : String(err);
  const code = errorCodeOf(err);
  const hint =
    NETWORK_ERROR_TEXT[code] ?? (/aborted|socket hang up|premature close/i.test(raw) ? NETWORK_ERROR_TEXT.ECONNRESET : '');
  return hint
    ? `下载失败：${hint}。请检查网络连接或代理设置后重试。`
    : `下载失败：${raw}。请检查网络连接或代理设置后重试。`;
}
