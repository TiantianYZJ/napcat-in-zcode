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
   * 探测失败但**疑似需要 token** 的端点。
   *
   * 单列出来是因为它们不在 `live` 里（没连上），但面板仍要提示用户
   * 「该端点可能需要 token」——否则用户只会看到一句「没找到」。
   */
  tokenRequired: (DetectCandidate & { error?: string; needsToken: true })[];
  /** NapCat WebUI 有响应 → NapCat 在跑（哪怕 WebUI 开了鉴权、OneBot Server 没开）。 */
  napcatRunning: boolean;
  /** 探测到的 WebUI 端口（NapCat 在跑时才有）。 */
  webuiPort?: number;
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
  /** 单候选超时（默认 1200ms）。 */
  timeoutMs?: number;
  /** 整体时间预算（默认 5000ms）。 */
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
  return AUTH_TEXT.test(raw);
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
    const needsToken = isAuthFailure(err, raw);
    return {
      ok: false,
      error: `${label}：${redactSecrets(raw, secrets)}`,
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
  for (const raw of ports ?? []) {
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
 * 候选**并发**探测，单候选超时 `timeoutMs`，整体预算 `budgetMs`。
 * **永远 resolve**：失败只体现在结果里。
 */
export async function detectLocal(opts: DetectOptions): Promise<DetectResult> {
  const timeoutMs = positiveInt(opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS);
  const budgetMs = positiveInt(opts.budgetMs ?? DEFAULT_PROBE_BUDGET_MS, DEFAULT_PROBE_BUDGET_MS);
  const webuiPort = validPort(opts.webuiPort ?? NAPCAT_WEBUI_PORT) ?? NAPCAT_WEBUI_PORT;

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
  for (const raw of opts.installCandidates ?? []) {
    if (!raw) continue;
    addCandidate(toCandidate(raw.endpoint, 'install', raw.detail ?? '本机安装配置'));
  }

  // 4) NapCat WebUI 端口：既当 WebUI 探针，也当 OneBot 候选
  addCandidate(toCandidate(`http://127.0.0.1:${webuiPort}`, 'port', `NapCat WebUI 端口 ${webuiPort}`));

  const outcomes = new Map<string, DetectProbeResult>();
  const probes = candidates.map(async (c) => {
    const result = await probeEndpoint(c, timeoutMs);
    outcomes.set(c.endpoint, result);
  });

  let napcatRunning = false;
  const webuiProbe = probeWebUi(webuiPort, timeoutMs).then((alive) => {
    napcatRunning = alive;
  });

  // 整体预算：到点就用已有结果返回，不无限等
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  try {
    await Promise.race([Promise.allSettled([...probes, webuiProbe]), budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const live: DetectResult['live'] = [];
  const tokenRequired: DetectResult['tokenRequired'] = [];
  for (const c of candidates) {
    const outcome = outcomes.get(c.endpoint);
    if (!outcome) continue;
    if (outcome.ok) {
      live.push({ ...c, login: outcome.login });
    } else if (outcome.needsToken) {
      tokenRequired.push({ ...c, error: outcome.error, needsToken: true });
    }
  }

  return {
    found: live.length > 0,
    candidates,
    live,
    tokenRequired,
    napcatRunning,
    webuiPort: napcatRunning ? webuiPort : undefined,
    scanned: {
      ports,
      paths: Array.isArray(opts.installPaths) ? [...opts.installPaths] : [],
      extraEndpoints: extraCount,
    },
  };
}
