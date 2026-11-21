/**
 * 面板侧的 API 层：把「宿主桥」包成「能直接用的工具调用」。
 *
 * 这一层存在的唯一理由是**防御式解析**（协议实测见 `protocol-notes.md` §3）：
 * 同一个 `tools/call` 的失败载荷有**两种形状**——
 * ① 工具自己抛错 → resolve `{content:[{type:'text',text:'{"error":"…"}'}], isError:true}`；
 * ② SDK / zod 入参校验失败 → **reject** `Error('MCP error -32602: …')`
 *    （`err.code === -32602`，`err.payload` 是原始 JSON-RPC 帧）。
 *
 * 解析顺序必须是「**先试 JSON.parse（失败则把原文当错误消息），再判 isError**」：
 * 先判 isError 再 parse 会把纯文本错误载荷变成 `Unexpected token` 之类的假信息，
 * 面板绝不能因为错误载荷不是 JSON 就自己崩掉。
 */
import { HostBridge, type HostCaps } from './bridge.js';

/** 面板与宿主之间的桥（进程内单例）。 */
export const bridge = new HostBridge();

/** 会话引用（与服务端 `ChatRef` 同构；`id` 一律是字符串）。 */
export interface Chat {
  kind: 'group' | 'friend';
  id: string;
  name: string;
}

/** 消息段（面板只用来做占位渲染，不解释每个 kind 的语义）。 */
export interface Seg {
  kind: string;
  text?: string;
  url?: string;
  fileName?: string;
  qq?: string;
  name?: string;
  messageId?: string;
}

/**
 * 规范化消息（与服务端 `Message` 同构，但 `time` 可能**缺失**）。
 *
 * `time` 可选的原因：服务端在消息**没有有效时间**时会把 `time` 置为 `undefined`，
 * 而 `JSON.stringify` 会**丢弃**值为 undefined 的字段 → 线上收到的消息可能压根没有 `time`。
 * （面板在把消息交给渲染层之前会过滤掉没有有效时间的消息，见 `App.tsx` 的 `renderable`。）
 */
export interface Msg {
  id: string;
  seq: number;
  /** 消息时间（epoch 秒）；**可能缺失** = 上游没给出可信的时间。 */
  time?: number;
  senderId: string;
  senderName: string;
  segments: Seg[];
  text: string;
  replyTo?: { messageId: string; preview: string };
}

/**
 * 消息的**选择标识**（面板用来标选中态 / React key / testid）。
 *
 * 按**代码的实际顺序**：
 * 1. 有 `m.id`（服务端给的 message_id / real_id）→ 直接用 id（最稳）；
 * 2. 没有 id、但有有效 `seq` **和**有效 `time` → `s{seq}@{time}`
 *    （**同时**带上 seq 与 time：只有 seq 时，多条消息可能撞同一个 seq）；
 * 3. 没有 id、只有有效 `seq`（时间不可信）→ `s{seq}`；
 * 4. 没有 id、没有有效 `seq`、只有有效 `time` → `t{time}`；
 * 5. 三者都没有 → 返回 **null**：调用方必须**跳过**这一条。
 *
 * `s` 前缀与面板的跨调用去重键（`s` / `i` 双命名空间，见 `App.tsx` 的 `dedupeKey`）同构。
 *
 * 为什么不能退化成 `seq:0`：服务端的 `seq` 只承载 `message_seq`（没有就是 0），
 * 多条「既无 message_id 又无 message_seq」的消息会共用同一个 key →
 * React 重复 key 警告、选中态串成一片、testid 撞车。
 */
export function msgKey(m: Msg): string | null {
  if (m.id) return m.id;
  const seq = typeof m.seq === 'number' && Number.isFinite(m.seq) && m.seq > 0 ? m.seq : undefined;
  const time = typeof m.time === 'number' && Number.isFinite(m.time) ? m.time : undefined;
  if (seq !== undefined && time !== undefined) return `s${seq}@${time}`;
  if (seq !== undefined) return `s${seq}`;
  if (time !== undefined) return `t${time}`;
  return null; // 无法区分 → 调用方跳过这一条
}

/** `napcat_status` 的返回。 */
export interface StatusInfo {
  configured: boolean;
  connected: boolean;
  mode: string;
  login?: { nickname?: string; user_id?: string };
  error?: string;
  /**
   * 安全警告（如「端点不在本机且未设 token」）。
   * 有警告不代表连接失败——面板单独展示，不当成错误。
   */
  warning?: string;
  /**
   * 最近一次 `napcat_detect_local` 的结论（**缓存**）。
   *
   * 没探测过时**不存在**这个字段——status 自己不会触发端口扫描。
   * `budgetExhausted: true` 表示扫描没扫完，**不能**当成「没找到本机 NapCat」。
   */
  detection?: {
    found: boolean;
    napcatRunning: boolean;
    endpoint?: string;
    budgetExhausted?: boolean;
  };
}

/** `napcat_get_history` 的返回。 */
export interface HistoryResult {
  messages: Msg[];
  /**
   * 更早消息的游标（**时间**，epoch 秒）：把它作为 `beforeTime` 传回服务端即可继续往前翻。
   *
   * 为什么是时间而不是 seq：服务端的 `message_seq` 是**随机短 id**（不是单调序号），
   * 拿它当游标比较是错的（实测 M1 的游标在真实 NapCat 上原地打转）。
   */
  nextBeforeTime: number | null;
  /**
   * 历史耗尽（真的没有更早的消息了）。
   *
   * **不等于**「本次没取满」——没取满可能是预算用尽 / 区间已覆盖 / 锚点失效，
   * 看 `stopReason` 与 `note`。
   */
  exhausted: boolean;
  /** 终止原因：count_reached / range_covered / history_exhausted / page_budget_exhausted。 */
  stopReason?: string;
  /** 人类可读说明（中文，区分历史耗尽 / 锚点失效 / 翻页预算用尽）。 */
  note?: string;
}

/** `napcat_search_messages` 的命中项。 */
export interface SearchHit {
  message: Msg;
  /** 命中消息在时间上紧邻其前（更早）的那条；扫描范围内没有则为 null。 */
  contextBefore: Msg | null;
}

/** `napcat_search_messages` 的返回。 */
export interface SearchResult {
  hits: SearchHit[];
  scanned: number;
  pages: number;
  /** 历史耗尽（真的翻到会话最开始）。 */
  exhausted: boolean;
  hitsTruncated: boolean;
  /** 终止原因：history_exhausted / page_budget_exhausted / hits_limit。 */
  stopReason?: string;
  note: string;
}

/** `napcat_format_selection` 的返回。 */
export interface FormatResult {
  text: string;
  count: number;
  truncated: boolean;
}

/** `napcat_export` 的返回。 */
export interface ExportResult {
  mdPath: string;
  jsonPath: string;
  gitignoreUpdated: boolean;
}

/**
 * `napcat_get_config` 的返回（**只读展示**）。
 *
 * token 已经是 `'***'`、endpoint 是脱敏形态 → 面板只展示，**不要回写**。
 */
export interface ConfigInfo {
  connection?: { mode?: string; endpoint?: string; token?: string };
  autoDetect?: { pathsCount?: number };
  managed?: {
    napcatVersion?: string;
    downloadMirror?: string;
    downloadProxyConfigured?: boolean;
    desktopQqPathConfigured?: boolean;
  };
  export?: { dir?: string; includeImages?: boolean };
  inject?: { maxInjectChars?: number };
  [key: string]: unknown;
}

/**
 * 探测候选端点（`napcat_detect_local` 的返回）。
 *
 * 与服务端 `onebot/detect.ts` 的 `DetectCandidate` 同构。
 */
export interface DetectCandidate {
  /** 规范化后的端点（不含凭据与 query）。 */
  endpoint: string;
  transport: 'http' | 'ws';
  /** 候选来源：用户显式配置 / 本机安装发现 / 端口扫描。 */
  source: 'config' | 'install' | 'port';
  /** 来源说明（如配置文件路径、端口号）。 */
  detail?: string;
}

/**
 * 带结论的探测条目（`live` / `failed` / `tokenRequired` 共用同一形状）。
 */
export interface DetectEntry extends DetectCandidate {
  /** 探测成功时的登录信息。 */
  login?: { user_id: string; nickname: string };
  /** 失败原因（服务端给的人话串，已脱敏）。 */
  error?: string;
  /** 该端点疑似需要 access token。 */
  needsToken?: boolean;
  /**
   * 失败原因是**超时/无响应**（区别于「连不上」）。
   *
   * 超时 ≠ 连不上：前者说明目标在那儿但不答话，后者说明端口上根本没服务。
   * 面板要把两者分开说，不能合并成一句。
   */
  unresponsive?: boolean;
}

/**
 * `napcat_detect_local` 的返回（**服务端已脱敏**）。
 *
 * 面板直接用它渲染，**不要自己重算数量**：
 * `candidates` / `scanned.ports` 被截到 20 条，`failed` / `tokenRequired` 每来源 5 条，
 * 裁剪计数与预算耗尽等说明都在 `notes` 里 → 一律原样渲染 `notes`。
 */
export interface DetectResult {
  /** 是否找到可用的 OneBot 端点（= `live.length > 0`）。 */
  found: boolean;
  candidates: DetectCandidate[];
  /** 探测成功的端点。 */
  live: DetectEntry[];
  /** 探测失败的端点（带失败原因）。 */
  failed: DetectEntry[];
  /** 探测失败但疑似需要 token 的端点（`failed` 的子集）。 */
  tokenRequired: DetectEntry[];
  /** NapCat WebUI 有响应 → NapCat 在跑（哪怕没开 OneBot Server）。 */
  napcatRunning: boolean;
  /** 探测到的 WebUI 端口（NapCat 在跑时才有）。 */
  webuiPort?: number;
  /**
   * 扫描预算耗尽 → **没扫完**。
   *
   * `true` 时**绝不可**说「未检测到本机 NapCat」（那是假阴性）。
   */
  budgetExhausted?: boolean;
  scanned: { ports: number[]; paths: string[]; extraEndpoints: number };
  /** 人类可读说明（裁剪计数、预算耗尽、被丢弃的端点、多个 WebUI 端口…）。 */
  notes: string[];
  /** 本机安装发现的摘要（`configDir` 是本机绝对路径，只给用户看）。 */
  installs: {
    configDir: string;
    endpoints: number;
    webuiPort?: number;
    webuiDisabled?: boolean;
    webuiHasToken?: boolean;
    nonLoopbackEndpoints: number;
    truncated?: boolean;
    notes?: string[];
  }[];
  /** 被回环闸门丢弃的端点。 */
  droppedEndpoints: { endpoint: string; reason: string; detail?: string }[];
}

// ── 受管宿主（M3）────────────────────────────────────────────────────

/** 受管安装（视图形态：WebUI token 只以掩码出现）。 */
export interface ManagedInstallView {
  id: string;
  version: string;
  /** `standalone`（独立，不影响桌面 QQ）/ `inject`（注入桌面 QQ）。 */
  mode: string;
  installedAt: string;
  artifactSha256: string;
  /** 安装目录（绝对路径）——只给用户看。 */
  dir: string;
  /** 插件自己拉起的进程 pid。 */
  pid?: number;
  /** WebUI token 的掩码（永远不是明文）。 */
  webuiTokenMasked?: string;
}

/** 受管实例的运行状态。 */
export interface HostStatus {
  state: 'not-installed' | 'stopped' | 'starting' | 'running' | 'degraded' | 'unknown';
  install?: ManagedInstallView;
  pid?: number;
  webuiPort?: number;
  webuiReachable?: boolean;
  onebotPort?: number;
  onebotPortReachable?: boolean;
  login?: { user_id: string; nickname: string };
  /** 面向用户的中文说明。 */
  message?: string;
}

/** 一次安装作业（进度与结果）。 */
export interface InstallJobView {
  id: string;
  startedAt: string;
  finishedAt?: string;
  state: 'running' | 'succeeded' | 'failed';
  /** `connecting` / `downloading` / `verifying` / `extracting` / `done` / `failed`。 */
  phase: string;
  bytesReceived: number;
  /** 服务器声明的总大小（未知时没有这个字段 → 百分比也给不出）。 */
  totalBytes?: number;
  percent?: number;
  error?: string;
  notes?: string[];
  install?: ManagedInstallView;
}

/** `napcat_host_status` 的返回。 */
export interface HostStatusResult {
  /** 插件自己装过的 NapCat。 */
  installs: ManagedInstallView[];
  /** 每个受管安装的运行状态。 */
  status: HostStatus[];
  /** 最近的安装作业（新的在后）。 */
  jobs: InstallJobView[];
  /** 当前平台可用的 NapCat 版本。 */
  versions: string[];
}

/**
 * 工具调用失败（面板侧统一错误类型）。
 *
 * 保留原始信息：`code` 是 JSON-RPC 错误码（如 -32602），
 * `payload` 是原始错误帧，`raw` 是宿主给的原始 `tools/call` 结果。
 */
export class ToolCallError extends Error {
  /** 失败的工具名。 */
  readonly tool: string;
  /** JSON-RPC 错误码（宿主以 error 帧失败时才有）。 */
  readonly code?: number;
  /** 原始错误帧。 */
  readonly payload?: unknown;
  /** 宿主给的原始 `tools/call` 结果（成功解析失败时也有）。 */
  readonly raw?: unknown;

  constructor(
    message: string,
    options: { tool: string; code?: number; payload?: unknown; raw?: unknown; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ToolCallError';
    this.tool = options.tool;
    if (options.code !== undefined) this.code = options.code;
    if (options.payload !== undefined) this.payload = options.payload;
    if (options.raw !== undefined) this.raw = options.raw;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 握手 promise（模块级单例）。
 *
 * **为什么要自己记着**：桥在握手完成前调用动作类方法会抛
 * `host bridge not initialized (…)`；而握手最坏要 3×15s + 2×500ms ≈ 46s。
 * 面板在这段时间里必须显示「正在连接宿主…」的中间态。
 *
 * 记忆化的另一个理由：`HostBridge.initialize()` 本身在握手完成后会直接返回已有结果，
 * 但**并发**调用会各发一次 `ui/initialize`（宿主会告警）。这里保证全进程只握手一次。
 */
let handshakePromise: Promise<HostCaps> | null = null;

/**
 * 确保握手完成，返回宿主能力位。
 *
 * 握手失败时把 promise 清掉 → 下次调用可以重试（而不是永远复用同一个 rejected promise）。
 */
export function handshake(): Promise<HostCaps> {
  if (!handshakePromise) {
    handshakePromise = bridge.initialize().catch((e: unknown) => {
      handshakePromise = null;
      throw e;
    });
  }
  return handshakePromise;
}

/** 错误消息里只保留前 N 个字符（错误文本可能很长，面板只显示摘要）。 */
function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 把任意抛出物收敛成 `ToolCallError`（**逐字保留原始消息**）。 */
function toToolError(tool: string, e: unknown): ToolCallError {
  if (e instanceof ToolCallError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const code = e instanceof Error ? (e as { code?: unknown }).code : undefined;
  const payload = e instanceof Error ? (e as { payload?: unknown }).payload : undefined;
  return new ToolCallError(message, {
    tool,
    code: typeof code === 'number' ? code : undefined,
    payload,
    cause: e,
  });
}

/**
 * 调用一个 MCP 工具并把结果解成 JSON。
 *
 * 失败时抛 `ToolCallError`（消息就是给用户看的那句人话）：
 * - 工具自抛的 `{error:"…"}` → 抛 `error` 字段的内容；
 * - 非 JSON 的错误载荷（`MCP error -32602: …`）→ 抛原文；
 * - 成功但内容不是 JSON → 抛「不是合法 JSON」（面板不崩，只是这一条失败）。
 */
export async function callToolJson<T>(name: string, args: object): Promise<T> {
  let raw: unknown;
  try {
    // 握手门控：没握手完就调工具会被桥拒掉（'host bridge not initialized'）。
    await handshake();
    raw = await bridge.callTool(name, args);
  } catch (e) {
    throw toToolError(name, e);
  }

  const result = isRecord(raw) ? raw : {};
  const text = Array.isArray(result.content) ? result.content[0]?.text : undefined;

  if (typeof text !== 'string') {
    if (result.isError === true) throw new ToolCallError('工具返回了空的错误载荷', { tool: name, raw });
    throw new ToolCallError('工具返回了空结果', { tool: name, raw });
  }

  // 先试 JSON.parse（顺序不能反：先判 isError 会把纯文本错误变成解析假象）
  let parsed: unknown;
  let parsedOk = false;
  try {
    parsed = JSON.parse(text);
    parsedOk = true;
  } catch {
    parsedOk = false;
  }

  if (result.isError === true) {
    const message =
      parsedOk && isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : text;
    throw new ToolCallError(message, { tool: name, raw });
  }

  if (!parsedOk) {
    throw new ToolCallError(`工具 ${name} 返回的不是合法 JSON：${truncate(text)}`, { tool: name, raw });
  }
  return parsed as T;
}

/**
 * 面板自证：`messages` 必须是数组，且每条都带有效的 `time`（epoch 秒）。
 *
 * 工具侧的 `messages` 入参**没有 schema 约束**（`z.any()`）→ 面板自己保证形状，
 * 否则服务端会拿缺 `time` 的消息算出 `NaN-NaN-NaN` 的时间。
 */
function assertMessages(messages: unknown): asserts messages is Msg[] {
  if (!Array.isArray(messages)) throw new Error('messages 必须是数组');
  messages.forEach((m, i) => {
    if (!isRecord(m)) throw new Error(`第 ${i + 1} 条消息不是对象`);
    const t = m.time;
    const ok = typeof t === 'number' ? Number.isFinite(t) : typeof t === 'string' && t.trim() !== '' && Number.isFinite(Number(t));
    if (!ok) throw new Error(`第 ${i + 1} 条消息缺少有效的 time 字段（epoch 秒）`);
  });
}

/** 单次翻页的条数（服务端上限 200）。 */
const PAGE_SIZE = 100;

export const api = {
  /** 连接状态（连接失败时是「状态」而不是工具错误：`isError` 为 false）。 */
  status: () => callToolJson<StatusInfo>('napcat_status', {}),

  /**
   * 配置 OneBot 端点并重连。
   *
   * `token` 留空 = **保留已保存的 token**（服务端语义）；要清除已存的 token
   * 显式传 `clearToken: true`。
   *
   * `paths` 是**加法式**的可选参数：本机 NapCat 扫描根（**绝对路径**）。
   * 不传 = 不改（既有调用逐字不变）。
   * `endpoint` 传空串 = **只更新扫描路径**，不动已有连接
   * （用户还没配端点时也要能改路径；服务端据此走「只存 paths」的分支）。
   */
  configure: (endpoint: string, token: string, clearToken?: boolean, paths?: string[]) =>
    callToolJson<{
      configured: boolean;
      connected: boolean;
      login?: StatusInfo['login'];
      warning?: string;
      /** 本次调用带了 `paths` 且已落盘。 */
      pathsSaved?: boolean;
      /** 实际保存的扫描路径（去重后的绝对路径）。 */
      paths?: string[];
    }>('napcat_configure', {
      endpoint,
      token,
      ...(clearToken === true ? { clearToken: true } : {}),
      ...(paths !== undefined ? { paths } : {}),
    }),

  /**
   * 本机 NapCat 探测（**无参**）。
   *
   * 只探测回环地址与用户显式配置的端点，不扫描网络。
   * 探测**不带 token**（多数本机实例没设 token）。
   *
   * 结论会被服务端缓存，`napcat_status` 会顺带带出摘要。
   */
  detectLocal: () => callToolJson<DetectResult>('napcat_detect_local', {}),

  /** 列群或好友。 */
  listChats: (kind: 'group' | 'friend') => callToolJson<{ chats: Chat[] }>('napcat_list_chats', { kind }),

  /**
   * 拉历史（时间正序）。
   *
   * `beforeTime` 传上一页给的 `nextBeforeTime`；**跨调用要按消息 id 去重**
   * （服务端只在单次调用内去重，边界那条可能被重复返回）。
   */
  getHistory: (chatKind: 'group' | 'friend', chatId: string, beforeTime?: number, count = PAGE_SIZE) =>
    callToolJson<HistoryResult>(
      'napcat_get_history',
      beforeTime === undefined
        ? { chatKind, chatId, count }
        : { chatKind, chatId, beforeTime, count },
    ),

  /** 会话内关键词搜索（服务端从最新往更早有限扫描）。 */
  search: (chatKind: 'group' | 'friend', chatId: string, query: string) =>
    callToolJson<SearchResult>('napcat_search_messages', { chatKind, chatId, query }),

  /** 把选定消息格式化成注入文本（首行是不可信声明，服务端不改写）。 */
  formatSelection: async (messages: Msg[], chatName: string) => {
    assertMessages(messages);
    return callToolJson<FormatResult>('napcat_format_selection', { messages, chatName });
  },

  /**
   * 导出选定消息（md + json）。
   *
   * `chat` 只带 `{kind, id, name}` 三个字段：服务端 schema 会**静默剥离**额外字段，
   * 多传没有意义、还容易让人误以为额外字段生效。
   */
  exportSel: async (messages: Msg[], chat: Chat, dir?: 'user' | 'workspace') => {
    assertMessages(messages);
    const args: Record<string, unknown> = {
      messages,
      chat: { kind: chat.kind, id: chat.id, name: chat.name },
    };
    if (dir !== undefined) args.dir = dir;
    return callToolJson<ExportResult>('napcat_export', args);
  },

  /** 读配置（token 已是 `'***'`、endpoint 已脱敏 → 只展示，不回写）。 */
  getConfig: () => callToolJson<ConfigInfo>('napcat_get_config', {}),

  // ── 受管宿主（M3）：装 / 启 / 停 ───────────────────────────────────

  /** 受管宿主状态（装过的 NapCat、每个的运行状态、最近的安装作业）。 */
  hostStatus: () => callToolJson<HostStatusResult>('napcat_host_status', {}),

  /** 启动一次安装作业（**立即返回** jobId；进度用 `installStatus` 轮询）。 */
  installNapcat: (opts: { dir?: string; version?: string; mode?: 'standalone' | 'inject'; proxy?: string } = {}) =>
    callToolJson<{ jobId: string; version: string; dir: string; mode: string }>(
      'napcat_install',
      Object.keys(opts).length ? { ...opts } : {},
    ),

  /** 安装作业进度（不传 jobId = 最近一次）。 */
  installStatus: (jobId?: string) =>
    callToolJson<InstallJobView>(
      'napcat_install_status',
      jobId === undefined ? {} : { jobId },
    ),

  /** 启动一个受管的 NapCat，沿用安装台账中记录的模式。 */
  startHost: (id?: string) =>
    callToolJson<{ started: boolean; pid: number; mode: string; message: string; warning?: string }>(
      'napcat_start',
      id === undefined ? {} : { id },
    ),

  /** 停止一个受管的 NapCat（只停本插件自己启动的进程）。 */
  stopHost: (id?: string) =>
    callToolJson<{ stopped: boolean; message: string }>(
      'napcat_stop',
      id === undefined ? {} : { id },
    ),

  /**
   * 卸载一个受管安装：删除安装目录（不可恢复）并清理台账与凭据。
   *
   * 运行中的实例服务端会拒绝 —— 面板负责「先停止再卸载」的组合动作。
   */
  uninstallHost: (id?: string) =>
    callToolJson<{
      uninstalled: boolean;
      id: string;
      dir: string;
      alreadyGone: boolean;
      message: string;
    }>('napcat_uninstall', id === undefined ? {} : { id }),
};
