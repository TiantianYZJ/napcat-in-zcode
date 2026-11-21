/**
 * M2 Task 4：本机探测的**编排层**（把「配置 + 安装发现」合并成一次 `detectLocal` 调用）。
 *
 * 与 Task 1 的探测内核（`onebot/detect.ts`）的分工：
 * - 内核只管「怎么探一个端点」；
 * - 这里管「探哪些端点」与「结果怎么呈现」：
 *   1. 合并三种根来源（用户显式路径 → 默认位置 → 盘根发现），顺序即优先级；
 *   2. 从安装发现结果里挑 NapCat WebUI 端口（不硬编 6099）；
 *   3. **脱敏**：`DetectResult` 里的错误串是**返回值**（不是异常），
 *      工具层的 `fail()` 只脱敏异常 → 这一层必须自己把错误串过一遍 `state.redact()`；
 *   4. **裁剪**失败桶（每来源前 N 条 + 其余只给计数），否则返回值会爆炸；
 *   5. **区分**「扫完了没找到」与「没扫完（预算耗尽）」/「目标无响应（超时）」。
 *
 * 硬约束：
 * - **只读**：不改用户配置、不启动/结束进程；
 * - **不扫描网络**：只探回环地址与用户显式配置的端点；
 * - **不抛异常**：探测失败只体现在结果里（`detectLocal` 本身也是这个契约）。
 */

import { homedir } from 'node:os';
import {
  detectLocal,
  DEFAULT_PROBE_BUDGET_MS,
  NAPCAT_WEBUI_PORT,
  type DetectCandidate,
  type DetectResult,
} from '../onebot/detect.js';
import {
  defaultNapCatRoots,
  discoverNapCatInstallRootsDetailed,
  findLocalNapCat,
  installPathsOf,
  toInstallCandidates,
  MAX_DISCOVERED_ROOTS,
  MAX_ROOTS_TOTAL,
  type InstalledNapCat,
} from './local-napcat.js';
import type { PluginConfig } from '../config.js';
import type { AppState } from '../state.js';

/** 每个来源的失败候选最多展示几条（其余只给计数，见「失败桶裁剪」）。 */
export const FAILED_PER_SOURCE_LIMIT = 5;

/**
 * 候选端点最多展示几条（其余只给计数，见「出参上界」）。
 *
 * 候选数 = `2 × autoDetect.ports 的条数 + 显式端点数 + 安装发现数`，
 * 而 `config.ts` 的 `pickPorts` 只过滤端口值合法性、**不限个数**——
 * 配置里写多端口时，单次工具调用能产出 MB 级文本，直接撑爆模型上下文。
 */
export const MAX_CANDIDATES = 20;

/**
 * 探测成功的端点最多展示几条（其余只给计数，见「出参上界」）。
 *
 * `live` 之前**没有**裁剪：`live` 的条数 = 能连上的 OneBot 端点数，
 * 端口配得多时（每个端口一个 http + 一个 ws）它也能上百条——
 * 与 `candidates` / `scanned.ports` 一样必须封顶（spec §5.2 的出参上界）。
 */
export const MAX_LIVE = 20;

/** 扫描端口最多展示几个（其余只给计数，见「出参上界」）。 */
export const MAX_SCANNED_PORTS = 20;

/**
 * 「目标无响应」的特征词。
 *
 * 超时（目标在那儿但不答话）与「连不上」（端口上根本没服务）是**两回事**：
 * 前者不能读作「没找到 NapCat」。面板要能区分，故单列 `unresponsive` 标记。
 */
const TIMEOUT_TEXT = /(timeout|timed out|超时|ETIMEDOUT|ECONNABORTED|aborted)/i;

/** 单个失败候选（比 `DetectResult.failed` 多一个「无响应」标记）。 */
export interface DetectFailedEntry extends DetectCandidate {
  error?: string;
  needsToken?: boolean;
  /** 失败原因是超时/无响应（区别于「连不上」）。 */
  unresponsive?: boolean;
}

/** 一个本机安装的摘要（供面板解释「端点从哪来」）。 */
export interface DetectInstallSummary {
  /** 找到的 NapCat 配置目录。 */
  configDir: string;
  /** 该安装里的端点数。 */
  endpoints: number;
  /** 该安装的 WebUI 端口。 */
  webuiPort?: number;
  /** WebUI 被关掉了（`disableWebUI: true`）。 */
  webuiDisabled?: boolean;
  /** WebUI 配了登录 token（**只给「有没有」，不给明文**）。 */
  webuiHasToken?: boolean;
  /** 该安装里**不是回环地址**、被回环闸门丢弃的端点数。 */
  nonLoopbackEndpoints: number;
  /** 端点数被上限截断过。 */
  truncated?: boolean;
  /** 安装发现模块自己给的说明。 */
  notes?: string[];
}

/** 被丢弃的端点（面板要能解释「为什么我配的端点没出现」）。 */
export interface DroppedEndpoint {
  /** 被丢弃的端点（规范化形态）。 */
  endpoint: string;
  /** 丢弃原因（目前只有回环闸门一种）。 */
  reason: 'nonLoopback';
  /** 来源（配置文件路径）。 */
  detail?: string;
}

/** `napcat_detect_local` 的返回值。 */
export interface DetectLocalPayload extends Omit<DetectResult, 'failed'> {
  failed: DetectFailedEntry[];
  /** 人类可读说明（预算耗尽、裁剪计数、多个 WebUI 端口、丢弃的端点…）。 */
  notes: string[];
  /** 本机安装发现的摘要。 */
  installs: DetectInstallSummary[];
  /** 被回环闸门丢弃的端点。 */
  droppedEndpoints: DroppedEndpoint[];
}

/** 根来源合并的入参。 */
export interface MergeRootsOptions {
  /** 用户主目录。 */
  home: string;
  platform: NodeJS.Platform;
  /** 环境变量（默认位置要用 APPDATA 等）。 */
  env?: NodeJS.ProcessEnv;
  /** 盘根列表（测试注入；不传则按平台推导）。 */
  driveRoots?: string[];
}

/** 根来源合并的结果。 */
export interface MergedRoots {
  /** 全部候选根（顺序 = 优先级：用户显式 → 默认位置 → 盘根发现）。 */
  roots: string[];
  /** 其中来自盘根发现的部分。 */
  driveRoots: string[];
  /** 盘根发现是否触顶（可能漏掉某些安装目录）。 */
  truncated: boolean;
  notes: string[];
}

/**
 * 合并三种根来源。
 *
 * **顺序有实际意义**：端点预算先到先得（`findLocalNapCat` 有全局端点上限），
 * 用户显式配置的路径必须排最前——那是覆盖「装在任意命名目录里的 NapCat」最可靠的途径。
 *
 * 1. `cfg.paths`：用户显式（最高优先）；
 * 2. `defaultNapCatRoots(home, platform)`：默认安装位置；
 * 3. 盘根发现（`scanDrives !== false` 且 `maxRoots > 0` 时才做）。
 *
 * `cfg.maxRoots` 的**生效值** = `min(cfg.maxRoots, MAX_ROOTS_TOTAL)`：
 * `MAX_ROOTS_TOTAL` 是跨盘总量的最终闸门（每盘上限 × 盘数仍可能远超总量）。
 * `maxRoots = 0` = 禁用盘根发现。
 */
export function mergeDetectionRoots(
  cfg: PluginConfig['autoDetect'],
  opts: MergeRootsOptions,
): MergedRoots {
  const notes: string[] = [];
  const env = opts.env ?? process.env;
  const roots: string[] = [];

  // ① 用户显式路径（优先级最高）
  for (const p of cfg?.paths ?? []) {
    if (typeof p === 'string' && p.trim() !== '') roots.push(p.trim());
  }
  // ② 默认安装位置
  roots.push(...defaultNapCatRoots(opts.home, opts.platform, env));

  // ③ 盘根发现
  let driveRoots: string[] = [];
  let truncated = false;
  const rawMax = cfg?.maxRoots;
  const requested =
    typeof rawMax === 'number' && Number.isInteger(rawMax) && rawMax >= 0 ? rawMax : MAX_DISCOVERED_ROOTS;
  const maxRoots = Math.min(requested, MAX_ROOTS_TOTAL);
  if (cfg?.scanDrives === false) {
    notes.push('盘根自动发现已关闭（autoDetect.scanDrives=false）');
  } else if (maxRoots === 0) {
    notes.push('盘根自动发现已禁用（autoDetect.maxRoots=0）');
  } else {
    /**
     * **生效上限**要写进 notes：台账要求「面板展示生效值」，
     * 而 `autoDetect.maxRoots` 的**原始值**不等于生效值
     * （生效值 = `min(maxRoots, 64)`，默认 `maxRoots=32` → 32 个候选根）。
     * 面板只渲染 notes → 说明写在这里面板才看得见。
     */
    notes.push(
      `盘根发现生效上限 ${maxRoots} 个候选根（autoDetect.maxRoots=${requested}，跨盘总量闸门 ${MAX_ROOTS_TOTAL}）`,
    );
    const disc = discoverNapCatInstallRootsDetailed(opts.platform, { maxRoots, driveRoots: opts.driveRoots });
    driveRoots = disc.roots;
    truncated = disc.truncated;
    if (truncated) notes.push('盘根发现的候选根达到上限，可能漏掉某些 NapCat 安装目录');
  }
  roots.push(...driveRoots);

  return { roots, driveRoots, truncated, notes };
}

/**
 * 从安装发现结果里挑 NapCat WebUI 端口。
 *
 * **不硬编 6099**：NapCat 的 WebUI 端口可改（`webui.json` 的 `port`）。
 *
 * 选取规则：
 * 1. 装了 OneBot server（有 endpoints）的安装优先——它更可能是用户真正在用的那个；
 * 2. `webui.disabled === true`（`disableWebUI: true`）的**不作为探针**：
 *    端口是事实，但没人应答 → 探它只会得到一条误导性的失败；
 * 3. 都没有才用默认端口 6099。
 *
 * 发现多个不同端口的 WebUI 时在 notes 里说明（面板要能解释「为什么只探了这一个」）。
 */
export function pickWebuiPort(installed: InstalledNapCat[]): { port: number; notes: string[] } {
  const notes: string[] = [];
  const withWebui = (Array.isArray(installed) ? installed : []).filter(
    (i) =>
      i &&
      i.webui &&
      Number.isInteger(i.webui.port) &&
      i.webui.port > 0 &&
      i.webui.port <= 65535,
  );
  const enabled = withWebui.filter((i) => i.webui?.disabled !== true);
  const disabled = withWebui.filter((i) => i.webui?.disabled === true);
  const ports = [...new Set(withWebui.map((i) => i.webui!.port))];

  const chosen = enabled.find((i) => (i.endpoints?.length ?? 0) > 0) ?? enabled[0];
  if (chosen) {
    const port = chosen.webui!.port;
    if (ports.length > 1) {
      notes.push(`发现多个 NapCat WebUI 端口（${ports.join('、')}），本轮只探测 ${port}`);
    }
    if (disabled.length > 0) {
      notes.push(`有 ${disabled.length} 个安装的 WebUI 已被禁用（disableWebUI），不作为探测端口`);
    }
    return { port, notes };
  }
  if (disabled.length > 0) {
    notes.push(
      `发现的 NapCat WebUI 已被禁用（disableWebUI），不作为探测端口，改用默认端口 ${NAPCAT_WEBUI_PORT}`,
    );
  }
  return { port: NAPCAT_WEBUI_PORT, notes };
}

/**
 * 从**原始**端点串里挖出「可能是凭据」的值（userinfo 密码 / query 里的 token 形态值）。
 *
 * **必须从原始串取**：`normalizeEndpoint` 会把 userinfo 与 query 全部剥掉
 * （那里常常就是 access token），等候选建好之后再找就什么都找不到了。
 *
 * 抽出来的值交给 `state.rememberSecret()` 登记成脱敏样本：
 * 上游**裸回显**它自己持有的 token（没有 `token=` / `Bearer` 前缀）时，
 * `detect.ts` 的三种形态规则挡不住，只有「本进程见过这个值」才能挡住。
 */
export function extractEndpointSecrets(raw: string): string[] {
  const out: string[] = [];
  if (typeof raw !== 'string' || raw.trim() === '') return out;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return out; // 不是合法 URL：没有可解析的 userinfo / query
  }
  if (url.password) out.push(url.password);
  for (const [key, value] of url.searchParams) {
    if (value && /token|secret|key|password|passwd|pwd/i.test(key)) out.push(value);
  }
  return out;
}

/**
 * 鉴权失败语境下的「长串」形态（裸 token 的典型长相）。
 *
 * 只在**已被判定为鉴权失败**的条目上用（误伤面小）：
 * 上游可能裸回显它自己持有的 token——没有 `token=` / `Bearer` 前缀，
 * `detect.ts` 的 `SECRET_ASSIGNMENT` / `BEARER` 都挡不住。
 */
const AUTH_LONG_SECRET = /[A-Za-z0-9_\-]{16,}/g;

/**
 * 鉴权失败时的额外遮蔽：把「独立的长串」换成 `***`。
 *
 * 只遮**端点标签之后**的部分（错误串的形状是 `标签：细节`）：
 * 端点标签（主机名/端口）是用户要看的信息，不该被顺手抹掉。
 */
function maskAuthFailureSecrets(text: string): string {
  const sep = text.indexOf('：');
  const head = sep >= 0 ? text.slice(0, sep + 1) : '';
  const body = sep >= 0 ? text.slice(sep + 1) : text;
  return head + body.replace(AUTH_LONG_SECRET, '***');
}

/**
 * 把 `DetectResult` 里**每一个**用户可控文本过一遍 `state.redact()`。
 *
 * 为什么必须在这里做（`detect.ts` 内部挡不住）：
 * - 探测内核只挡 `Bearer xxx` / `key=value` / `key:value` 三种形态；
 *   上游**裸回显**用户 token（无键名前缀）时，会原样漏出；
 * - 工具层的 `fail()` 只脱敏**抛出的异常**，而 `DetectResult` 里的错误串是**返回值**
 *   —— 这条路径上没有任何保护。
 */
export function redactDetectResult(state: AppState, result: DetectResult): DetectResult {
  const r = (text: string | undefined): string | undefined =>
    text === undefined ? undefined : state.redact(text);
  /**
   * 鉴权失败条目的错误串：额外做一次「长串遮蔽」。
   *
   * 这一步补的是**首次探测**的缺口：用户还没配 token 时，本进程没见过上游持有的那个 token，
   * `state.redact` 没有可替换的样本 → 裸回显会直接进返回值。
   */
  const authError = (text: string | undefined, needsToken: boolean): string | undefined => {
    if (text === undefined) return undefined;
    const redacted = state.redact(text);
    return needsToken ? maskAuthFailureSecrets(redacted) : redacted;
  };
  return {
    ...result,
    candidates: (result.candidates ?? []).map((c) => ({ ...c, detail: r(c.detail) })),
    live: (result.live ?? []).map((c) => ({
      ...c,
      detail: r(c.detail),
      error: r(c.error),
      login: c.login ? { ...c.login, nickname: r(c.login.nickname) ?? '' } : undefined,
    })),
    failed: (result.failed ?? []).map((c) => ({
      ...c,
      detail: r(c.detail),
      error: authError(c.error, c.needsToken === true),
    })),
    tokenRequired: (result.tokenRequired ?? []).map((c) => ({
      ...c,
      detail: r(c.detail),
      error: authError(c.error, true),
    })),
  };
}

/**
 * 按来源分组裁剪（每组取前 `limit` 条，其余只给计数）。
 *
 * 不裁剪的话返回值会爆炸：每个端口 2 条（http + ws）候选 + 安装候选 + WebUI 候选，
 * 扫几十个端口就是上百条失败记录——模型上下文会被噪声淹没。
 */
export function trimFailedBySource<T extends { source: DetectCandidate['source'] }>(
  items: T[],
  limit: number,
): { kept: T[]; dropped: number; total: number } {
  const list = Array.isArray(items) ? items : [];
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  const kept: T[] = [];
  const counts = new Map<string, number>();
  let dropped = 0;
  for (const item of list) {
    const n = counts.get(item.source) ?? 0;
    if (n < max) {
      kept.push(item);
      counts.set(item.source, n + 1);
    } else {
      dropped += 1;
    }
  }
  return { kept, dropped, total: list.length };
}

/** 错误串是不是「超时/无响应」。 */
function isTimeoutText(text: string | undefined): boolean {
  return typeof text === 'string' && TIMEOUT_TEXT.test(text);
}

/**
 * 端点的 `host:port` 键（忽略 scheme 与路径）。
 *
 * 用来识别「同一台机器上的同一个端口」——`http://127.0.0.1:3000` 与 `ws://127.0.0.1:3000`
 * 是同一个端口的两种协议视图。
 */
function hostPortKey(endpoint: string): string | undefined {
  try {
    const url = new URL(endpoint);
    const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
    const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
    if (!host) return undefined;
    return `${host}:${port}`;
  } catch {
    return undefined;
  }
}

/** 一次探测的入参（`opts` 主要是测试注入位，生产路径不传）。 */
export interface DetectLocalRunOptions {
  /** 整体时间预算（ms）。生产路径用默认值；测试用它把扫描压到毫秒级。 */
  budgetMs?: number;
  /** 平台（测试注入）。 */
  platform?: NodeJS.Platform;
  /** 环境变量（测试注入）。 */
  env?: NodeJS.ProcessEnv;
  /** 用户主目录（测试注入）。 */
  home?: string;
  /** 盘根列表（测试注入）。 */
  driveRoots?: string[];
}

/**
 * 跑一次本机探测（配置 + 安装发现 → `detectLocal` → 脱敏/裁剪/说明）。
 *
 * **只读**：不改配置、不启停进程、不扫描网络。
 */
export async function detectLocalWithInstalls(
  state: AppState,
  opts: DetectLocalRunOptions = {},
): Promise<DetectLocalPayload> {
  const cfg = state.config.autoDetect;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? state.homeDirOverride ?? homedir();

  const merged = mergeDetectionRoots(cfg, { home, platform, env, driveRoots: opts.driveRoots });
  const installed = findLocalNapCat(merged.roots);
  const { port: webuiPort, notes: webuiNotes } = pickWebuiPort(installed);

  /**
   * 用户显式端点：`autoDetect.endpoints` + **当前已配置的连接端点**。
   *
   * 连接端点也是用户显式填的（面板/agent 写的），它非回环时同样允许探——
   * 「只探回环与用户显式端点」的口径在这里保持一致。
   */
  const extraEndpoints: string[] = [];
  for (const e of cfg?.endpoints ?? []) {
    if (typeof e === 'string' && e.trim() !== '') extraEndpoints.push(e.trim());
  }
  const configured = state.config.connection?.endpoint ?? '';
  if (configured.trim() !== '') extraEndpoints.push(configured.trim());

  /**
   * 登记原始端点里的凭据（userinfo 密码 / query 里的 token 形态值）。
   *
   * 这些值在 `normalizeEndpoint` 之后就没了，但上游可能把它们**裸回显**出来
   * （没有 `token=` / `Bearer` 前缀 → 探测内核的三种形态规则挡不住）。
   * 登记成脱敏样本后，`state.redact` 就能把回显里的明文换成 `***`。
   */
  for (const raw of extraEndpoints) {
    for (const secret of extractEndpointSecrets(raw)) state.rememberSecret(secret);
  }

  const result = await detectLocal({
    ports: Array.isArray(cfg?.ports) ? cfg.ports : [],
    extraEndpoints,
    installCandidates: toInstallCandidates(installed),
    installPaths: installPathsOf(installed),
    timeoutMs: cfg?.probeTimeoutMs,
    budgetMs: opts.budgetMs ?? DEFAULT_PROBE_BUDGET_MS,
    webuiPort,
  });

  const redacted = redactDetectResult(state, result);

  // 失败桶：标出「无响应」，再按来源裁剪
  const failedAll: DetectFailedEntry[] = redacted.failed.map((f) => {
    const unresponsive = isTimeoutText(f.error);
    return unresponsive ? { ...f, unresponsive: true } : { ...f };
  });
  /**
   * **降噪：活着的 HTTP 端口，它的 `ws://` 孪生端点不进候选。**
   *
   * 降噪层只做 TCP 可达性检查 → `ws://127.0.0.1:3000` 打到 HTTP 服务时端口**确实在监听**
   * → 标成「可能需要 token」→ 进 `tokenRequired` → 面板把它列为带「使用这个」的候选。
   * 在默认路径上（NapCat HTTP 在 3000、WebUI 在 6099）用户会看到 3 个候选、其中 2 个是假的。
   *
   * 判定（**确定性的，不需要额外网络往返**）：同一 `host:port` 上，
   * `http://` 变体**探测成功**（在 `live` 里）→ 该端口上的 `ws://` 变体
   * **探测未通过** → 从候选里剔除。
   *
   * **取舍**：同一个端口**同时**跑 HTTP 与 WS（NapCat 默认分两个端口）时，
   * WS 变体会被一并剔除（假阴性）。这是刻意的：多一个假候选比少一个真候选更吵，
   * 而被剔除的那条**仍留在失败列表里**（用户看得见它、也拿得到完整错误）。
   *
   * ⚠️ 因此**不能**断言「该端口的 WebSocket 变体不是 WebSocket 服务」——
   * 同端口双协议时它是合法的，只是探测没通过。notes 里只说「探测未通过 + 该候选不可用」。
   */
  const liveHttpKeys = new Set<string>();
  for (const l of redacted.live ?? []) {
    if (l.transport !== 'http') continue;
    const key = hostPortKey(l.endpoint);
    if (key) liveHttpKeys.add(key);
  }
  const notWebSocket: string[] = [];
  const tokenAll = redacted.tokenRequired
    .filter((f) => {
      if (f.transport !== 'ws') return true;
      const key = hostPortKey(f.endpoint);
      if (key && liveHttpKeys.has(key)) {
        notWebSocket.push(f.endpoint);
        return false;
      }
      return true;
    })
    .map((f) => {
      const unresponsive = isTimeoutText(f.error);
      return unresponsive ? { ...f, unresponsive: true } : { ...f };
    });
  const failedTrimmed = trimFailedBySource(failedAll, FAILED_PER_SOURCE_LIMIT);
  const tokenTrimmed = trimFailedBySource(tokenAll, FAILED_PER_SOURCE_LIMIT);

  // 被回环闸门丢弃的安装端点（非回环 host：探过去探到的不是用户配的那个地址）
  const droppedEndpoints: DroppedEndpoint[] = [];
  for (const inst of installed) {
    for (const e of inst.endpoints ?? []) {
      if (e.nonLoopback !== true) continue;
      droppedEndpoints.push({
        endpoint: state.redact(e.endpoint),
        reason: 'nonLoopback',
        detail: e.detail ? state.redact(e.detail) : undefined,
      });
    }
  }

  const notes: string[] = [...merged.notes, ...webuiNotes];

  /**
   * 安装发现自己的说明（截断等）**并入顶层 notes**。
   *
   * 面板只渲染 `installs[].configDir` 与 `webuiPort`——`installs[].notes` 里的
   * 「端点数超过全局上限（10），已截断」这类信息**到不了面板**，
   * spec 的「裁剪计数写在 notes」规则对这个桶就失效了。
   * 顶层 notes 是面板唯一会渲染的地方 → 在这里汇合。
   */
  for (const inst of installed) {
    for (const n of inst.notes ?? []) {
      notes.push(`本机安装（${inst.configDir}）：${n}`);
    }
  }

  if (redacted.budgetExhausted) {
    notes.push(
      '扫描未完成（预算耗尽），结果可能不全：不能据此判断「本机没有 NapCat」，' +
        '请调大 autoDetect.probeTimeoutMs 或减少扫描端口后重试',
    );
  }
  if (failedTrimmed.dropped > 0) {
    notes.push(
      `失败候选共 ${failedTrimmed.total} 条（其中 ${tokenTrimmed.total} 条疑似需要 token），` +
        `已按来源各取前 ${FAILED_PER_SOURCE_LIMIT} 条展示，其余 ${failedTrimmed.dropped} 条仅计数`,
    );
  }
  if (tokenTrimmed.dropped > 0) {
    notes.push(`疑似需要 token 的候选共 ${tokenTrimmed.total} 条，仅展示前 ${tokenTrimmed.kept.length} 条`);
  }
  if (droppedEndpoints.length > 0) {
    notes.push(
      `安装配置里有 ${droppedEndpoints.length} 个端点不是回环地址，已被回环闸门丢弃（未探测）：` +
        droppedEndpoints.map((d) => d.endpoint).join('、'),
    );
  }
  if (installed.length === 0) {
    notes.push('未在本机常见位置发现 NapCat 安装目录（只扫了配置里的路径与默认位置）');
  }
  if (notWebSocket.length > 0) {
    notes.push(
      `同一端口的 HTTP 端点可用 → 该端口上的 WebSocket 变体探测未通过（同端口双协议时可能被误剔），` +
        `已从候选中剔除（该候选不可用）：` +
        notWebSocket.join('、'),
    );
  }

  /**
   * 出参上界：候选端点、探测成功的端点与扫描端口都要截断（其余只给计数，计数写进 notes）。
   *
   * 不截断的话，配置里写多端口（`pickPorts` 只过滤合法性、不限个数）时
   * 单次工具调用能产出 MB 级文本，直接撑爆模型上下文。
   */
  const candidatesAll = redacted.candidates ?? [];
  const candidatesKept = candidatesAll.slice(0, MAX_CANDIDATES);
  const candidatesDropped = candidatesAll.length - candidatesKept.length;
  if (candidatesDropped > 0) {
    notes.push(
      `候选端点共 ${candidatesAll.length} 条，已展示前 ${MAX_CANDIDATES} 条，` +
        `其余 ${candidatesDropped} 条仅计数`,
    );
  }
  const liveAll = redacted.live ?? [];
  const liveKept = liveAll.slice(0, MAX_LIVE);
  const liveDropped = liveAll.length - liveKept.length;
  if (liveDropped > 0) {
    notes.push(
      `探测成功的端点共 ${liveAll.length} 条，已展示前 ${MAX_LIVE} 条，` +
        `其余 ${liveDropped} 条仅计数`,
    );
  }
  const portsAll = redacted.scanned?.ports ?? [];
  const portsKept = portsAll.slice(0, MAX_SCANNED_PORTS);
  const portsDropped = portsAll.length - portsKept.length;
  if (portsDropped > 0) {
    notes.push(
      `扫描端口共 ${portsAll.length} 个，已展示前 ${MAX_SCANNED_PORTS} 个，` +
        `其余 ${portsDropped} 个仅计数`,
    );
  }

  return {
    found: redacted.found,
    candidates: candidatesKept,
    live: liveKept,
    failed: failedTrimmed.kept,
    tokenRequired: tokenTrimmed.kept,
    napcatRunning: redacted.napcatRunning,
    webuiPort: redacted.webuiPort,
    budgetExhausted: redacted.budgetExhausted,
    scanned: {
      ...redacted.scanned,
      ports: portsKept,
      paths: (redacted.scanned?.paths ?? []).map((p) => state.redact(p)),
    },
    // notes 整体再过一遍 redact：每条单独处理容易漏（未来新增含用户文本的说明就会漏）
    notes: notes.map((n) => state.redact(n)),
    installs: installed.map((inst) => ({
      configDir: state.redact(inst.configDir ?? ''),
      endpoints: inst.endpoints?.length ?? 0,
      webuiPort: inst.webui?.port,
      webuiDisabled: inst.webui?.disabled === true ? true : undefined,
      webuiHasToken: inst.webui?.hasToken === true ? true : undefined,
      nonLoopbackEndpoints: (inst.endpoints ?? []).filter((e) => e.nonLoopback === true).length,
      truncated: inst.truncated === true ? true : undefined,
      notes: inst.notes?.map((n) => state.redact(n)),
    })),
    droppedEndpoints,
  };
}

/**
 * 正在进行的探测（**模块级**单例）。
 *
 * MCP SDK 是**并发**处理请求的：两次并发的 `napcat_detect_local` = 两次完整盘根枚举
 * + 两次全量扫描（各自一份 5s 预算），缓存还会「后写覆盖先写」。
 * 这里让并发调用复用同一个探测。
 */
let detectionInFlight: Promise<DetectLocalOutcome> | null = null;

/**
 * 一次探测的结论 + 它**运行时用的配置指纹**。
 *
 * 指纹的用处：探测期间（≤5s）用户改了配置 → 结论是**按旧配置**算出来的 →
 * 写回缓存前比对指纹，不一致就丢弃（见 `AppState.setDetection`）。
 */
export interface DetectLocalOutcome {
  /** 探测结论。 */
  payload: DetectLocalPayload;
  /** 探测运行时用的配置指纹。 */
  fingerprint: string;
}

/**
 * 跑一次本机探测；**并发调用复用同一个 promise**。
 *
 * - 复用：第二个调用直接拿第一个的结果，不重复扫盘（省一次全盘枚举 + 一次扫描预算）。
 * - 清理：探测结束（成功或失败）后在 `finally` 里清空 in-flight → 下一次调用重新探测。
 *
 * 注意：复用期间**后到的调用拿到的是先到那次的结论**（含它当时的配置快照）。
 * 这是有意的：并发两次探测的结果本来就该是同一份结论。
 */
export function detectLocalOnce(
  state: AppState,
  opts: DetectLocalRunOptions = {},
): Promise<DetectLocalOutcome> {
  if (detectionInFlight) return detectionInFlight;
  /**
   * 指纹在**探测开始前**取（与 `detectLocalWithInstalls` 读 `state.config` 是同一时刻，
   * 中间没有 await）→ 指纹就是这份结论真正依据的那份配置。
   */
  const fingerprint = state.currentFingerprint();
  const wrapped: Promise<DetectLocalOutcome> = detectLocalWithInstalls(state, opts)
    .then((payload) => ({ payload, fingerprint }))
    .finally(() => {
      // 只清自己发起的那次（期间若已有新的探测在跑，别把它清掉）
      if (detectionInFlight === wrapped) detectionInFlight = null;
    });
  detectionInFlight = wrapped;
  return wrapped;
}
