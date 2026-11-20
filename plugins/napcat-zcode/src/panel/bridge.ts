/**
 * 面板 ↔ 宿主桥（MCP-UI 扩展协议子集）。
 *
 * **协议形状是逆向验证出来的**（MCP-UI 没有公开文档）：结论见同目录 `protocol-notes.md`，
 * 里面的每条都对应官方 `documents` 插件 bundle / ZCode 宿主实现里的实测片段。
 * 改动这里的字段名之前先读那份笔记。
 *
 * 本文件**只做传输，不做业务**：
 * - 工具调用（`tools/call`）由宿主代理到同一个 MCP server，桥不解析消息、不做格式化；
 * - 错误载荷**原样透传**，「解析成 JSON / 判成一句人话」的责任在面板的 API 层；
 * - 每个请求都有超时，宿主不响应时 reject，不会留下悬挂的 promise。
 *
 * 运行环境：面板被打进沙箱 iframe（单文件 `dist/ui/panel.html`），
 * 因此这里只用浏览器 API，**不依赖任何 Node API**。
 */

/** 宿主能力位（对应 `ui/initialize` 响应里的 `hostCapabilities`）。 */
export interface HostCaps {
  /** 宿主支持 `ui/message`（把内容作为用户消息发进对话）。 */
  message: boolean;
  /** 宿主支持 `ui/update-model-context`（把内容设为模型上下文）。 */
  updateModelContext: boolean;
  /** 宿主支持 `ui/download-file`（宿主弹另存为对话框并写盘）。 */
  downloadFile: boolean;
  /** 宿主能把 `tools/call` 代理到 MCP server。 */
  serverTools: boolean;
}

/** 宿主原始能力集（未知能力位也保留，面板可自行判断）。 */
export type RawHostCapabilities = Record<string, unknown>;

/** `ui/download-file` 的结果（宿主原始载荷 + 归一后的判定）。 */
export interface DownloadResult {
  /** 是否成功保存。 */
  success: boolean;
  /** 宿主写盘的路径。 */
  filePath?: string;
  /** 用户在宿主的另存为对话框里取消了。 */
  canceled?: boolean;
  /** 失败原因（宿主给的话）。 */
  error?: string;
  /** 宿主返回的原始载荷（原样保留，未知字段不丢）。 */
  raw?: unknown;
}

/** 宿主回的 JSON-RPC 错误帧。 */
export interface HostErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

/** 宿主回的 JSON-RPC 错误帧抛出来的 Error（message 逐字保留宿主的原文）。 */
export interface HostRequestError extends Error {
  /** JSON-RPC error code（如 -32602 = InvalidParams）。 */
  code?: number;
  /** JSON-RPC error data。 */
  data?: unknown;
  /** 原始 error 帧。 */
  payload?: HostErrorPayload;
}

/** 桥的可调参数（测试用得上；生产用默认值即可）。 */
export interface HostBridgeOptions {
  /** 单个请求的超时（毫秒）。默认 15000。 */
  timeoutMs?: number;
  /** `ui/initialize` 的尝试次数。默认 3。 */
  initAttempts?: number;
  /** `ui/initialize` 重试间隔（毫秒）。默认 500。 */
  retryDelayMs?: number;
  /** `appInfo.name`。默认 'napcat-zcode'。 */
  appName?: string;
  /** `appInfo.version`。默认 '0.1.0'（与 plugin.json / package.json 保持一致）。 */
  appVersion?: string;
  /** 协议版本。默认 '2026-01-26'（官方 bundle 里的常量）。 */
  protocolVersion?: number | string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INIT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_APP_NAME = 'napcat-zcode';
const DEFAULT_APP_VERSION = '0.1.0';
const DEFAULT_PROTOCOL_VERSION = '2026-01-26';

/** 一个在途请求。 */
interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 能力位是否开启。
 *
 * 实测语义（`hostCapabilities` schema + 宿主的能力构造）：**键存在 = 宿主支持**，
 * 值是个描述子对象（可含 `text` / `image` / `structuredContent` 等子开关）。
 * 值是 `null` / `undefined` / `false` 时按「不支持」算。
 *
 * 未知能力位（`experimental` / `openLinks` / `logging` / …）直接忽略 —— 只认已知的那几个键。
 */
function capEnabled(caps: RawHostCapabilities, key: keyof HostCaps): boolean {
  if (!Object.prototype.hasOwnProperty.call(caps, key)) return false;
  const value = caps[key];
  return value !== undefined && value !== null && value !== false;
}

/**
 * 把宿主的能力集收敛成面板要用的四个布尔位。
 *
 * 边界（都有测试覆盖）：
 * - 宿主返回**空能力集** → 四个位全 false（面板据此全部禁用并说明原因）；
 * - 宿主返回**未知能力位** → 忽略，不崩，已知位照常解析；
 * - 某个位是 `null` / `false` → 视为不支持。
 */
export function parseHostCapabilities(raw: unknown): HostCaps {
  const caps: RawHostCapabilities = isRecord(raw) ? raw : {};
  return {
    message: capEnabled(caps, 'message'),
    updateModelContext: capEnabled(caps, 'updateModelContext'),
    downloadFile: capEnabled(caps, 'downloadFile'),
    serverTools: capEnabled(caps, 'serverTools'),
  };
}

/**
 * 归一 `ui/download-file` 的结果。
 *
 * 协议层的结果 schema 只有 `{isError?: boolean}`（passthrough）；
 * `success` / `filePath` / `canceled` 是**宿主私有扩展**（ZCode 宿主实现是 `showSaveDialog` + 写盘）。
 * 两种形状都要认：
 * - 宿主直接给了 `success` → 用它；
 * - 只给了 `isError` → `success = !isError`；
 * - 什么都没给 → 视为成功（宿主没报错）。
 */
function normalizeDownloadResult(raw: unknown): DownloadResult {
  const record = isRecord(raw) ? raw : {};
  const success =
    typeof record.success === 'boolean'
      ? record.success
      : typeof record.isError === 'boolean'
        ? !record.isError
        : true;
  const result: DownloadResult = { success, raw };
  if (typeof record.filePath === 'string') result.filePath = record.filePath;
  if (typeof record.canceled === 'boolean') result.canceled = record.canceled;
  if (typeof record.error === 'string') result.error = record.error;
  else if (record.isError === true) result.error = 'host reported a failed download';
  return result;
}

/**
 * 面板与宿主之间的 JSON-RPC 桥。
 *
 * 用法：
 * ```ts
 * const bridge = new HostBridge();
 * const caps = await bridge.initialize();   // 必须先握手
 * const r = await bridge.callTool('napcat_status', {});
 * ```
 */
export class HostBridge {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listenerAttached = false;
  private caps: HostCaps = {
    message: false,
    updateModelContext: false,
    downloadFile: false,
    serverTools: false,
  };
  private rawCaps: RawHostCapabilities = {};
  private handshakeDone = false;
  private lastInitError: unknown;
  private readonly timeoutMs: number;
  private readonly initAttempts: number;
  private readonly retryDelayMs: number;
  private readonly appName: string;
  private readonly appVersion: string;
  private readonly protocolVersion: string;

  constructor(options: HostBridgeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.initAttempts = options.initAttempts ?? DEFAULT_INIT_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.appName = options.appName ?? DEFAULT_APP_NAME;
    this.appVersion = options.appVersion ?? DEFAULT_APP_VERSION;
    this.protocolVersion = String(options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION);
  }

  /** 收到的消息 → 按 id 找回在途请求。 */
  private handle = (ev: MessageEvent): void => {
    const data = ev.data as
      | { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: HostErrorPayload }
      | undefined;
    if (!isRecord(data)) return;
    if (data.jsonrpc !== '2.0') return; // 不是 JSON-RPC 2.0（别的扩展消息）→ 忽略

    /**
     * 来源过滤：只认宿主窗口发来的消息。
     *
     * 官方 SDK 是严格过滤（`o.source !== this.eventSource`）。这里放宽成「有 source 且不是宿主就丢」——
     * 测试里造的消息没有 `source`（jsdom 合成事件），严格过滤会把它们全丢掉。
     */
    const source = (ev as MessageEvent & { source?: unknown }).source;
    if (source !== undefined && source !== null && source !== window.parent) return;

    const id = Number(data.id);
    if (!Number.isInteger(id)) return; // 通知没有 id，不参与关联
    const pending = this.pending.get(id);
    if (!pending) return; // 未知 id（迟到的响应 / 别的请求）→ 忽略，不能误伤在途请求

    if (data.error !== undefined && data.error !== null) {
      const payload = isRecord(data.error)
        ? (data.error as unknown as HostErrorPayload)
        : { code: -32000, message: String(data.error) };
      const error: HostRequestError = new Error(payload.message ?? 'host request failed');
      error.code = payload.code;
      error.data = payload.data;
      error.payload = payload;
      this.settle(id, undefined, error);
      return;
    }
    this.settle(id, data.result);
  };

  /** 结束一个在途请求：清掉定时器 + 从 pending 里摘掉（成功失败都走这里）。 */
  private settle(id: number, value?: unknown, error?: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  /** 发一条请求；宿主不响应时按超时 reject（不会留下悬挂的 promise）。 */
  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return; // 已经结算过了
        this.pending.delete(id);
        reject(new Error(`host request timeout: ${method}`));
      }, this.timeoutMs);
      // Node 环境下不让定时器吊住事件循环（浏览器里没有 unref，无害）
      const maybeUnref = timer as unknown as { unref?: () => void };
      if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.post({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this.settle(id, undefined, new Error(`failed to post ${method} to host: ${errText(e)}`));
      }
    });
  }

  /** 发一条通知（没有 id，宿主不会回）。 */
  private notify(method: string, params?: unknown): void {
    this.post({ jsonrpc: '2.0', method, params });
  }

  private post(message: unknown): void {
    const target = (typeof window !== 'undefined' && window.parent) || window;
    target.postMessage(message, '*');
  }

  private attach(): void {
    if (this.listenerAttached) return;
    window.addEventListener('message', this.handle);
    this.listenerAttached = true;
  }

  /** 握手没完成就不许调动作类方法（避免拿一个没协商过的连接去发消息）。 */
  private requireHandshake(method: string): void {
    if (this.handshakeDone) return;
    const reason = this.lastInitError ? `: ${errText(this.lastInitError)}` : '';
    throw new Error(`host bridge not initialized (call initialize() before ${method})${reason}`);
  }

  /** 能力位缺失时给出明确原因，不静默失败。 */
  private requireCap(cap: keyof HostCaps, method: string): void {
    if (this.caps[cap]) return;
    throw new Error(`host does not support ${method} (missing host capability: ${cap})`);
  }

  /**
   * 握手：发 `ui/initialize`，读宿主能力位，再发 `ui/notifications/initialized`。
   *
   * 失败会按 `initAttempts`（默认 3 次）重试，间隔 `retryDelayMs`（默认 500ms）；
   * 全部失败则 reject，**不会**留下悬挂的 promise。
   */
  async initialize(attempts: number = this.initAttempts): Promise<HostCaps> {
    if (this.handshakeDone) return { ...this.caps }; // 重复握手会被宿主告警，直接用已有结果
    this.attach();
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const result = (await this.request('ui/initialize', {
          appInfo: { name: this.appName, version: this.appVersion },
          appCapabilities: {},
          protocolVersion: this.protocolVersion,
        })) as { hostCapabilities?: unknown } | undefined;

        const raw = isRecord(result) && isRecord(result.hostCapabilities) ? result.hostCapabilities : {};
        this.rawCaps = raw;
        this.caps = parseHostCapabilities(raw);
        this.notify('ui/notifications/initialized');
        this.handshakeDone = true;
        this.lastInitError = undefined;
        return { ...this.caps };
      } catch (e) {
        lastError = e;
        this.lastInitError = e;
        if (i < attempts - 1) await delay(this.retryDelayMs);
      }
    }
    throw new Error(`host bridge initialize failed after ${attempts} attempt(s): ${errText(lastError)}`);
  }

  /**
   * 通过宿主代理调用 MCP 工具（落到同一个 MCP server）。
   *
   * 返回值是**宿主给的原始载荷**（通常是 `{content:[{type:"text",text}], isError?}`）：
   * 桥不解析、不改写、不吞错误 —— 工具自抛的 `{error}` JSON 与 SDK 的
   * `MCP error -32602: …` 纯文本都原样留给面板的 API 层去防御式解析。
   */
  async callTool(name: string, args: object): Promise<unknown> {
    this.requireHandshake('callTool');
    this.requireCap('serverTools', 'tools/call');
    return this.request('tools/call', { name, arguments: args });
  }

  /**
   * 把内容作为一条用户消息发进对话（宿主能力位 `message`）。
   *
   * 宿主拒收 / 投递失败时（结果里的 `isError:true`）会 reject —— 不静默吞掉。
   */
  async uiMessage(text: string): Promise<void> {
    this.requireHandshake('uiMessage');
    this.requireCap('message', 'ui/message');
    const result = await this.request('ui/message', {
      role: 'user',
      content: [{ type: 'text', text }],
    });
    if (isRecord(result) && result.isError === true) {
      const detail = typeof result.error === 'string' ? `: ${result.error}` : '';
      throw new Error(`host rejected ui/message${detail}`);
    }
  }

  /** 把内容设为模型上下文（宿主能力位 `updateModelContext`）。 */
  async updateModelContext(text: string): Promise<void> {
    this.requireHandshake('updateModelContext');
    this.requireCap('updateModelContext', 'ui/update-model-context');
    const result = await this.request('ui/update-model-context', {
      content: [{ type: 'text', text }],
    });
    // 协议层的结果是严格空对象；宿主若给了 isError 也照样当失败处理
    if (isRecord(result) && result.isError === true) {
      const detail = typeof result.error === 'string' ? `: ${result.error}` : '';
      throw new Error(`host rejected ui/update-model-context${detail}`);
    }
  }

  /**
   * 让宿主把一段文本另存为文件（宿主能力位 `downloadFile`）。
   *
   * 协议形状：`{contents:[{type:"resource", resource:{uri, mimeType, text}}]}`
   * —— 是**内容块**（`type:"resource"`），不是裸的资源对象（实测见 protocol-notes.md §6）。
   */
  async downloadFile(
    filename: string,
    text: string,
    mimeType: string,
  ): Promise<DownloadResult> {
    this.requireHandshake('downloadFile');
    this.requireCap('downloadFile', 'ui/download-file');
    const raw = await this.request('ui/download-file', {
      contents: [
        {
          type: 'resource',
          resource: {
            uri: `ui://napcat-zcode/${encodeURIComponent(filename)}`,
            mimeType,
            text,
          },
        },
      ],
    });
    return normalizeDownloadResult(raw);
  }

  /**
   * 写剪贴板（尽力而为）。
   *
   * 面板跑在**沙箱 iframe** 里，`navigator.clipboard` 经常拿不到（没有用户手势 / 权限被拒）。
   * 所以这里**不抛错**：写成功返回 true，写不进去返回 false ——
   * 调用方据此降级（例如 toast 里改成「复制」按钮让用户自己点）。
   */
  async writeClipboard(text: string): Promise<boolean> {
    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') return false;
      await clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /** 协商出来的宿主能力位（返回副本，外部改不动内部状态）。 */
  get capabilities(): HostCaps {
    return { ...this.caps };
  }

  /** 宿主给的**原始**能力集（未知能力位也在，面板可自行判断）。 */
  get hostCapabilities(): RawHostCapabilities {
    return { ...this.rawCaps };
  }

  /** 握手是否已完成。 */
  get initialized(): boolean {
    return this.handshakeDone;
  }

  /** 在途请求数（正常情况下应恒为 0；用来断言「没有悬挂的 promise」）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** 断开：摘掉监听、拒掉所有在途请求（不留悬挂的 promise）。 */
  dispose(): void {
    if (this.listenerAttached) {
      window.removeEventListener('message', this.handle);
      this.listenerAttached = false;
    }
    for (const [id, pending] of [...this.pending]) {
      this.settle(id, undefined, new Error('host bridge disposed'));
    }
    this.pending.clear();
  }
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return String(JSON.stringify(e));
  } catch {
    return String(e);
  }
}
