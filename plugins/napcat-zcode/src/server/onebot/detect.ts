/**
 * M2 Task 1：本机 NapCat 探测内核。
 *
 * 职责边界（硬约束）：
 * - **只连回环地址**（`127.0.0.1` / `::1` / `localhost`）与**用户显式配置**的端点。
 *   局域网/公网一律不扫——那既是隐私问题也是安全风险。
 * - **只读**：不改用户配置、不启动/结束任何进程。
 * - **不抛异常**：单个候选失败只体现在结果里，`detectLocal` 永远 resolve。
 * - **有时间预算**：单候选超时（默认 1200ms）+ 整体预算（默认 5000ms），候选并发探测。
 *
 * 凭据口径：探测**默认不带 token**（多数本机实例没设 token）。
 * 若端点返回鉴权类失败，标记 `needsToken`，由面板提示「该端点可能需要 token」。
 */

import { connect } from 'node:net';
import { getLoginInfo } from './actions.js';
import { createClient, safeEndpointLabel, type OneBotClient } from './client.js';
import { OneBotError } from './errors.js';

/** 候选端点（规范化之后）。 */
export interface DetectCandidate {
  /** 规范化后的端点（http://127.0.0.1:3000）；不含凭据与 query。 */
  endpoint: string;
  transport: 'http' | 'ws';
  /** 候选来源：用户显式配置 / 本机安装发现 / 端口扫描。 */
  source: 'config' | 'install' | 'port';
  /** 来源说明（如配置文件路径、端口号）。 */
  detail?: string;
}

/** OneBot 登录信息（user_id 统一成字符串，避免 number/string 在面板上跳变）。 */
export interface DetectLogin {
  user_id: string;
  nickname: string;
}

/** 单个候选的探测结论。 */
export interface DetectProbeResult {
  ok: boolean;
  login?: DetectLogin;
  /** 失败原因（已脱敏）。 */
  error?: string;
  /** 该端点疑似需要 access token。 */
  needsToken?: boolean;
}

export interface DetectResult {
  /** 是否找到可用的 OneBot 端点（= live.length > 0）。 */
  found: boolean;
  /** 全部尝试过的候选（去重后）。 */
  candidates: DetectCandidate[];
  /** 探测成功的端点。 */
  live: (DetectCandidate & { login?: DetectLogin; error?: string; needsToken?: boolean })[];
  /**
   * **探测失败**的全部端点（含错误原因）。
   *
   * 有了它，面板才能解释「为什么这个端点不行」——
   * 否则受 token 保护的端点（尤其 OneBot WebSocket Server）
   * 会从结果里彻底消失，用户只看到一句「未检测到本机 NapCat」。
   */
  failed: (DetectCandidate & { error?: string; needsToken?: boolean })[];
  /**
   * 探测失败但**疑似需要 token** 的端点（`failed` 的子集）。
   *
   * 单列出来是因为它们不在 `live` 里（没连上），但面板仍要提示用户
   * 「该端点可能需要 token」——否则用户只会看到一句「没找到」。
   */
  tokenRequired: (DetectCandidate & { error?: string; needsToken: true })[];
  /** NapCat WebUI 有响应 → NapCat 在跑（哪怕 WebUI 开了鉴权、OneBot Server 没开）。 */
  napcatRunning: boolean;
  /** 探测到的 WebUI 端口（NapCat 在跑时才有）。 */
  webuiPort?: number;
  /**
   * 整体预算到点时仍有候选没探完（或没探）→ true。
   *
   * 有了它，面板才能区分「扫过了但没找到」与「根本没扫完」——
   * 后者不能报成「未检测到本机 NapCat」（那是假阴性）。
   */
  budgetExhausted?: boolean;
  scanned: {
    /** 扫描的本机端口（去重后的用户配置端口；NapCat WebUI 端口另见 `webuiPort`）。 */
    ports: number[];
    /** 扫过的本机安装路径（Task 2 接入）。 */
    paths: string[];
    /** 参与扫描的用户显式配置端点数。 */
    extraEndpoints: number;
  };
}

export interface DetectOptions {
  /** 要扫的本机端口（回环）。 */
  ports: number[];
  /** 用户显式配置的额外端点（允许非回环——用户自己填的才算数）。 */
  extraEndpoints: string[];
  /**
   * 单候选超时（默认 1200ms）。
   *
   * **约束：不得超过整体预算 `budgetMs`**（实现里会钳到 `budgetMs - 200ms`）：
   * 否则预算到点时所有候选都还在跑，结果恒为空 → `found:false` 恒定（假阴性）。
   */
  timeoutMs?: number;
  /**
   * 整体时间预算（默认 5000ms）。
   *
   * 到点即返回**已完成**的结果，并用 `budgetExhausted` 标出「没扫完」。
   * 与并发闸门联动：闸门后面的排队也算在预算里。
   */
  budgetMs?: number;
  /** NapCat WebUI 端口（默认 6099）。 */
  webuiPort?: number;
  /** 本机安装发现的结果（Task 2 接入；只允许回环）。 */
  installCandidates?: DetectCandidate[];
  /** 扫过的安装路径（回显在 `scanned.paths`）。 */
  installPaths?: string[];
}

/** 单候选超时默认值（ms）。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 1200;
/** 整体时间预算默认值（ms）。 */
export const DEFAULT_PROBE_BUDGET_MS = 5000;
/** NapCat WebUI 默认端口。 */
export const NAPCAT_WEBUI_PORT = 6099;
/**
 * 并发探测闸门：同时最多打开这么多连接。
 *
 * 没有闸门时，几百个端口会一次开几千个 socket → fd 耗尽，
 * 连接失败还会被误报成「没找到」。
 */
export const MAX_CONCURRENT_PROBES = 16;
/**
 * 预算余量（ms）：单候选超时最多占用 `budgetMs - 余量`。
 *
 * 留余量是为了让「跑完的候选」在预算到点前就拿到结论——
 * 否则它们会被预算到点**静默丢掉**（面板上就成了「没找到」）。
 */
const BUDGET_MARGIN_MS = 200;

const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

/** 鉴权类失败：OneBot 约定的 retcode。 */
const AUTH_RETCODES = new Set([401, 1404]);
/** 鉴权类失败的文案特征（含中英文）。 */
const AUTH_TEXT = /(token|unauthoriz|unauthoris|forbidden|鉴权|认证|未授权|无权限|授权失败)/i;

/** `key = value` / `key: value` 形式的凭据：值一律替换成 `***`。 */
const SECRET_ASSIGNMENT =
  /\b(access[_-]?token|token|secret|password|passwd|pwd|api[_-]?key|apikey)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi;
/** `Bearer xxx`：值一律替换成 `***`。 */
const BEARER = /\b(bearer)\s+[^\s"',;]+/gi;

/**
 * 规范化端点：同一端点的不同写法折叠成同一个字符串，便于去重。
 *
 * 规则：scheme/host 小写、去掉尾斜杠、默认端口归一（`http://127.0.0.1:80` → `http://127.0.0.1`）。
 * 另外**去掉 userinfo 与 query**：那里常常就是 access token，原样留着等于把凭据
 * 写进面板、工具返回值与日志；而且 http 传输把动作拼在路径后面
 * （`${endpoint}/${action}`），带 query 会把动作吞进 query 里。
 *
 * 非法端点返回 `undefined`（跳过），不抛异常。
 */
export function normalizeEndpoint(raw: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (!SUPPORTED_SCHEMES.has(url.protocol)) return undefined;
  if (!url.hostname) return undefined;
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  // URL 解析器已经归一了默认端口（http:80 / https:443 / ws:80 / wss:443）
  return url.toString().replace(/\/+$/, '');
}

/**
 * 主机是不是本机回环。
 *
 * 与 `server/state.ts` 的 `isLoopbackEndpoint` 同一口径，但**不复用**：
 * `state.ts` 属于应用层（连带配置读写），而这里是传输层的探测内核——
 * 反向依赖会形成 `state.ts ↔ detect.ts` 的环（M2 Task 4 会让 state.ts 用上探测结果）。
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (host === 'localhost') return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // 127.0.0.0/8 整段都是回环
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** 端点是不是本机回环。 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    return isLoopbackHost(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

function transportOf(endpoint: string): 'http' | 'ws' {
  return endpoint.startsWith('ws') ? 'ws' : 'http';
}

/** 从端点里挖出「可能是凭据」的值，用于把回显出来的 token 抹掉。 */
function extractSecrets(endpoint: string): string[] {
  const secrets: string[] = [];
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return secrets;
  }
  if (url.password) secrets.push(url.password);
  for (const [key, value] of url.searchParams) {
    if (value && /token|secret|key|password|passwd/i.test(key)) secrets.push(value);
  }
  return secrets;
}

/** 把消息里的凭据抹掉：`Bearer xxx` / `token=xxx` / 已知的明文值。 */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = text.replace(BEARER, '$1 ***');
  out = out.replace(SECRET_ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}***`);
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join('***');
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** 这类失败是不是「鉴权类」（即该端点可能需要 access token）。 */
function isAuthFailure(err: unknown, raw: string): boolean {
  const retcode = err instanceof OneBotError ? err.retcode : undefined;
  if (retcode !== undefined && AUTH_RETCODES.has(retcode)) return true;
  /**
   * WS 握手被拒也是鉴权类。
   *
   * `OneBot WebSocket Server` 配了 access token 时，客户端不带 token 握手会被拒，
   * 抛的是 `OneBotError(-2, 'websocket connect failed' / 'websocket connect timeout')`——
   * **文案里没有 token/鉴权 字样**，光靠文案匹配会漏掉，
   * 于是这个端点既不在 `live` 也不在 `tokenRequired`，在面板上彻底消失。
   */
  if (isWsConnectFailure(err, raw)) return true;
  return AUTH_TEXT.test(raw);
}

/** 是不是「WS 握手失败」（连接建立阶段就挂了，不是动作被拒）。 */
function isWsConnectFailure(err: unknown, raw: string): boolean {
  const retcode = err instanceof OneBotError ? err.retcode : undefined;
  return retcode === -2 && /websocket connect/i.test(raw);
}

/**
 * 端口上有没有东西在监听（纯 TCP 探测）。
 *
 * 用来区分 WS 握手失败的两种截然不同的成因：
 * - 端口根本没有服务（连接被拒）→ 与 token 无关，不该标「可能需要 token」；
 * - 端口有服务但拒绝了握手 → 疑似 access token 保护（也可能是该端口压根不是 WS 服务）。
 *
 * 不区分的话，每个空端口都会进 `tokenRequired`，面板上的噪声会淹没真信号。
 */
function isPortListening(endpoint: string, timeoutMs: number): Promise<boolean> {
  let host: string;
  let port: number;
  try {
    const url = new URL(endpoint);
    host = url.hostname.replace(/^\[/, '').replace(/\]$/, '');
    const scheme = url.protocol;
    const def = scheme === 'https:' || scheme === 'wss:' ? 443 : 80;
    port = url.port ? Number(url.port) : def;
  } catch {
    return Promise.resolve(false);
  }
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

/**
 * 探测单个候选端点。
 *
 * 建连 → `get_login_info` → 成败都**关掉连接**。
 * 失败只体现在返回值里，**不抛异常**（探测失败不该打断整轮扫描）。
 */
export async function probeEndpoint(
  c: DetectCandidate,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<DetectProbeResult> {
  const label = safeEndpointLabel(c.endpoint) || c.endpoint;
  const secrets = extractSecrets(c.endpoint);

  let client: OneBotClient;
  try {
    // 探测**不带 token**：多数本机实例没设 token，带上反而可能被拒
    client = createClient({ endpoint: c.endpoint, timeoutMs });
  } catch (err) {
    const raw = errorMessage(err);
    return { ok: false, error: `${label}：${redactSecrets(raw, secrets)}` };
  }

  try {
    const info = await getLoginInfo(client);
    return {
      ok: true,
      login: { user_id: String(info.user_id ?? ''), nickname: String(info.nickname ?? '') },
    };
  } catch (err) {
    const raw = errorMessage(err);
    let needsToken = isAuthFailure(err, raw);
    let detail = raw;
    if (needsToken && isWsConnectFailure(err, raw)) {
      // WS 握手失败要分两种情况，否则每个空端口都会被标成「可能需要 token」
      const listening = await isPortListening(c.endpoint, Math.min(timeoutMs, 500));
      if (!listening) {
        needsToken = false;
        detail = `${raw}（该端口没有服务）`;
      } else {
        detail = `${raw}（该端口有服务但 WebSocket 握手被拒：可能是 access token 保护，也可能是该端口不是 WebSocket 服务）`;
      }
    }
    return {
      ok: false,
      error: `${label}：${redactSecrets(detail, secrets)}`,
      needsToken,
    };
  } finally {
    try {
      await client.close();
    } catch {
      /* 关不掉也不能影响探测结论 */
    }
  }
}

/**
 * 探 NapCat WebUI（默认 6099）：**只要有 HTTP 响应**（哪怕 401/404）就算 NapCat 在跑。
 *
 * 用途：区分「NapCat 压根没跑」与「NapCat 在跑但没开 OneBot Server」——
 * 后者要提示用户去 WebUI 的网络配置里开 HTTP Server。
 */
async function probeWebUi(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    try {
      await res.arrayBuffer();
    } catch {
      /* body 读失败不影响「有响应」这个结论 */
    }
    return true;
  } catch {
    return false;
  }
}

function normalizePorts(ports: number[] | undefined): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  // 非数组（配置被写坏、调用方传错）不能让它抛出去——探测必须永远 resolve
  for (const raw of Array.isArray(ports) ? ports : []) {
    const p = Number(raw);
    if (!Number.isInteger(p) || p < 1 || p > 65535) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function positiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function validPort(value: number): number | undefined {
  if (!Number.isInteger(value) || value < 1 || value > 65535) return undefined;
  return value;
}

/**
 * 造一个候选端点。
 *
 * **安全闸门**：非 `config` 来源的候选必须是回环地址——
 * 端口扫描与本机安装发现都不允许指向局域网/公网。
 */
function toCandidate(
  raw: string,
  source: DetectCandidate['source'],
  detail?: string,
): DetectCandidate | undefined {
  const endpoint = normalizeEndpoint(raw);
  if (!endpoint) return undefined;
  if (source !== 'config' && !isLoopbackEndpoint(endpoint)) return undefined;
  return { endpoint, transport: transportOf(endpoint), source, detail };
}

/**
 * 扫描本机 NapCat。
 *
 * 候选来源按顺序合并并去重（先到先得）：
 * 1. `config`：`extraEndpoints` 里的每条（用户显式配置，允许非回环）
 * 2. `port`：`ports` 每个端口 × `http://127.0.0.1:<port>` 与 `ws://127.0.0.1:<port>`
 * 3. `install`：本机安装发现的结果（Task 2 接入；只允许回环）
 * 4. NapCat WebUI 端口（6099）：既当 WebUI 探针，也当 OneBot 候选
 *
 * 候选**并发**探测（闸门 `MAX_CONCURRENT_PROBES`），单候选超时 `timeoutMs`，整体预算 `budgetMs`。
 * **永远 resolve**：失败只体现在结果里。
 */
export async function detectLocal(opts: DetectOptions): Promise<DetectResult> {
  const requestedTimeoutMs = positiveInt(opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);
  const budgetMs = positiveInt(opts.budgetMs ?? DEFAULT_PROBE_BUDGET_MS, DEFAULT_PROBE_BUDGET_MS);
  const webuiPort = validPort(opts.webuiPort ?? NAPCAT_WEBUI_PORT) ?? NAPCAT_WEBUI_PORT;
  /**
   * 单候选超时不得超过整体预算。
   *
   * 不钳的话：`timeoutMs > budgetMs` 时预算到点所有候选都还在跑 →
   * `outcomes` 为空 → `live` 空 → `found:false` 恒定（**假阴性**：
   * 用户明明开着 NapCat，插件却说「没找到」）。
   *
   * 钳到 `budgetMs - 余量` 之后：能在预算内应答的候选一定会被记进结果，
   * 已经开跑但来不及跑完的候选也会拿到「超时」结论（而不是静默丢掉）；
   * 真正没轮到的那批由 `budgetExhausted` 标出来。
   */
  const timeoutMs = Math.min(requestedTimeoutMs, Math.max(50, budgetMs - BUDGET_MARGIN_MS));

  const candidates: DetectCandidate[] = [];
  const seen = new Set<string>();
  const addCandidate = (c: DetectCandidate | undefined): void => {
    if (!c) return;
    if (seen.has(c.endpoint)) return; // 同一端点的不同写法只探测一次
    seen.add(c.endpoint);
    candidates.push(c);
  };

  // 1) 用户显式配置
  const extraEndpoints = Array.isArray(opts.extraEndpoints) ? opts.extraEndpoints : [];
  let extraCount = 0;
  for (const raw of extraEndpoints) {
    const label = safeEndpointLabel(String(raw ?? '').trim());
    const c = toCandidate(String(raw ?? ''), 'config', label ? `用户配置：${label}` : undefined);
    if (!c) continue;
    extraCount += 1;
    addCandidate(c);
  }

  // 2) 本机端口（回环）
  const ports = normalizePorts(opts.ports);
  for (const p of ports) {
    addCandidate(toCandidate(`http://127.0.0.1:${p}`, 'port', `本机端口 ${p}`));
    addCandidate(toCandidate(`ws://127.0.0.1:${p}`, 'port', `本机端口 ${p}`));
  }

  // 3) 本机安装发现（Task 2 接入）
  const installCandidates = Array.isArray(opts.installCandidates) ? opts.installCandidates : [];
  for (const raw of installCandidates) {
    if (!raw) continue;
    addCandidate(toCandidate(raw.endpoint, 'install', raw.detail ?? '本机安装配置'));
  }

  // 4) NapCat WebUI 端口：既当 WebUI 探针，也当 OneBot 候选
  addCandidate(toCandidate(`http://127.0.0.1:${webuiPort}`, 'port', `NapCat WebUI 端口 ${webuiPort}`));

  const outcomes = new Map<string, DetectProbeResult>();
  /**
   * 并发闸门：固定数量的 worker 轮流取候选。
   *
   * 没有闸门时，几百个端口会一次开几千个 socket → fd 耗尽，
   * 连接失败还会被误报成「没找到」。
   * 闸门后面的排队也算在预算里：预算到点就不再开新探测（见 `budgetExhausted`）。
   */
  let next = 0;
  let budgetFired = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (budgetFired) return; // 预算到点：不再开新连接
      const index = next++;
      if (index >= candidates.length) return;
      const c = candidates[index];
      const result = await probeEndpoint(c, timeoutMs);
      outcomes.set(c.endpoint, result);
    }
  };
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENT_PROBES, Math.max(candidates.length, 1)) },
    () => worker(),
  );

  let napcatRunning = false;
  const webuiProbe = probeWebUi(webuiPort, timeoutMs).then((alive) => {
    napcatRunning = alive;
  });

  // 整体预算：到点就用已有结果返回，不无限等
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      budgetFired = true;
      resolve();
    }, budgetMs);
  });
  try {
    await Promise.race([Promise.allSettled([...workers, webuiProbe]), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const live: DetectResult['live'] = [];
  const failed: DetectResult['failed'] = [];
  const tokenRequired: DetectResult['tokenRequired'] = [];
  for (const c of candidates) {
    const outcome = outcomes.get(c.endpoint);
    if (!outcome) continue; // 预算耗尽：压根没探到（由 budgetExhausted 表达）
    if (outcome.ok) {
      live.push({ ...c, login: outcome.login });
      continue;
    }
    failed.push({ ...c, error: outcome.error, needsToken: outcome.needsToken === true });
    if (outcome.needsToken) {
      tokenRequired.push({ ...c, error: outcome.error, needsToken: true });
    }
  }

  return {
    found: live.length > 0,
    candidates,
    live,
    failed,
    tokenRequired,
    napcatRunning,
    webuiPort: napcatRunning ? webuiPort : undefined,
    budgetExhausted: budgetFired && outcomes.size < candidates.length,
    scanned: {
      ports,
      paths: Array.isArray(opts.installPaths) ? [...opts.installPaths] : [],
      extraEndpoints: extraCount,
    },
  };
}
