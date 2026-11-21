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

/** 规范化消息（与服务端 `Message` 同构）。 */
export interface Msg {
  id: string;
  seq: number;
  time: number;
  senderId: string;
  senderName: string;
  segments: Seg[];
  text: string;
  replyTo?: { messageId: string; preview: string };
}

/**
 * 消息的**选择标识**（面板用来标选中态 / React key / testid）。
 *
 * 优先级：
 * 1. `m.id`（服务端给的 message_id / real_id）—— 最稳，直接用；
 * 2. 没有 id 时退回 `s{seq}`（**有** message_seq 的形态）：`s` 前缀与
 *    面板的跨调用去重键（`s` / `i` 双命名空间，见 `App.tsx` 的 `dedupeKey`）同构；
 * 3. 连 message_seq 都没有（服务端 `seq` 为 0）时，时间是唯一还能区分的线索 →
 *    `s{seq}@{time}` / `t{time}`（**同时**带上 seq 与 time，避免同一条消息在不同字段上撞车）；
 * 4. 连时间都不可信 → 返回 **null**：调用方必须**跳过**这一条。
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
}

/** `napcat_get_history` 的返回。 */
export interface HistoryResult {
  messages: Msg[];
  /** 窗口内最小 seq（= 下一次「加载更早」要带回去的游标）。 */
  nextBeforeSeq: number | null;
  /**
   * 三合一语义（历史耗尽 / 游标推不动 / 扫描页数触顶）。
   * **不能**读作「没有更早的消息了」——判断还有更早消息要看「再翻一页是否返回空」。
   */
  exhausted: boolean;
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
  exhausted: boolean;
  hitsTruncated: boolean;
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
  connection?: { endpoint?: string; token?: string };
  export?: { dir?: string; includeImages?: boolean };
  [key: string]: unknown;
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
   */
  configure: (endpoint: string, token: string, clearToken?: boolean) =>
    callToolJson<{
      configured: boolean;
      connected: boolean;
      login?: StatusInfo['login'];
      warning?: string;
    }>('napcat_configure', {
      endpoint,
      token,
      ...(clearToken === true ? { clearToken: true } : {}),
    }),

  /** 列群或好友。 */
  listChats: (kind: 'group' | 'friend') => callToolJson<{ chats: Chat[] }>('napcat_list_chats', { kind }),

  /**
   * 拉历史（时间正序）。
   *
   * `beforeSeq` 传上一页给的 `nextBeforeSeq`；**跨调用要按 seq 去重**
   * （服务端只在单次调用内去重，边界那条可能被重复返回）。
   */
  getHistory: (chatKind: 'group' | 'friend', chatId: string, beforeSeq?: number, count = PAGE_SIZE) =>
    callToolJson<HistoryResult>(
      'napcat_get_history',
      beforeSeq === undefined
        ? { chatKind, chatId, count }
        : { chatKind, chatId, beforeSeq, count },
    ),

  /** 会话内关键词搜索（服务端向更早方向有限扫描）。 */
  search: (chatKind: 'group' | 'friend', chatId: string, query: string, startSeq?: number) =>
    callToolJson<SearchResult>(
      'napcat_search_messages',
      startSeq === undefined ? { chatKind, chatId, query } : { chatKind, chatId, query, startSeq },
    ),

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
};
