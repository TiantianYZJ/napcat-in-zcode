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
  /** 宿主支持 `ui/open-link`。 */
  openLinks?: boolean;
}

/** 宿主原始能力集（未知能力位也保留，面板可自行判断）。 */
export type RawHostCapabilities = Record<string, unknown>;

/** `ui/download-file` 的结果（宿主原始载荷 + 归一后的判定）。 */
export interface DownloadResult {
  /**
   * 宿主是否**报告**保存成功。
   *
   * 注意语义：当前宿主**不返回保存路径**，成功时返回 `{}`、失败与取消都返回 `{isError:true}`，
   * 所以这个位只说明「宿主那边没报失败」，**不代表插件知道文件存到哪了**。
   */
  success: boolean;
  /** 宿主写盘的路径。**当前宿主不返回**（字段保留只为兼容将来补上的宿主）。 */
  filePath?: string;
  /** 用户在宿主的另存为对话框里取消了。**当前宿主不返回**（宿主分不清取消与失败）。 */
  canceled?: boolean;
  /**
   * 失败原因。
   *
   * 宿主给了字符串就原样带出；没给时是**机器可读标记** `'download_not_confirmed'`
   *（不是人话，别原样显示给用户 —— 由面板自己措辞）。
   */
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
  /** `appInfo.version`。默认 '0.10.1'（与 plugin.json / package.json 保持一致）。 */
  appVersion?: string;
  /** 协议版本。默认 '2026-01-26'（官方 bundle 里的常量）。 */
  protocolVersion?: number | string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INIT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_APP_NAME = 'napcat-zcode';
const DEFAULT_APP_VERSION = '0.10.1';
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
 * 未知能力位（`experimental` / `logging` / …）直接忽略 —— 只认面板用到的能力键。
 */
function capEnabled(caps: RawHostCapabilities, key: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(caps, key)) return false;
  const value = caps[key];
  return value !== undefined && value !== null && value !== false;
}

/**
 * 把宿主的能力集收敛成面板要用的布尔位。
 *
 * 边界（都有测试覆盖）：
 * - 宿主返回**空能力集** → 所有能力位全 false（面板据此全部禁用并说明原因）；
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
    openLinks: capEnabled(caps, 'openLinks'),
  };
}

/** 宿主主题（`hostContext.theme`）。 */
export type HostTheme = 'light' | 'dark';

/** 面板视角的宿主展示上下文（MCP Apps `hostContext` 的子集）。 */
export interface HostContextView {
  theme?: HostTheme;
  /**
   * 宿主主题令牌映射成的 MCP Apps 标准样式变量（`hostContext.styles.variables`）。
   *
   * ZCode 把内部 token（`--color-background` 等）映射成标准键
   * （`--color-background-primary` 等）传给面板；面板把它写进 `documentElement`
   * 后，CSS 里的 `var(--color-background-primary, …)` 就消费宿主真值。
   */
  styleVariables: Record<string, string>;
}

/**
 * 归一 `hostContext`（initialize 响应 / host-context-changed 通知里的字段）。
 *
 * 边界：`theme` 只认 `'light' | 'dark'`（其余值忽略，面板回退浅色）；
 * `styles.variables` 只收字符串值；坏形状一律返回空对象位，不抛错。
 */
export function parseHostContext(raw: unknown): HostContextView {
  const view: HostContextView = { styleVariables: {} };
  if (!isRecord(raw)) return view;
  if (raw.theme === 'light' || raw.theme === 'dark') view.theme = raw.theme;
  const styles = isRecord(raw.styles) ? raw.styles : undefined;
  const variables = styles && isRecord(styles.variables) ? styles.variables : undefined;
  if (variables) {
    for (const [key, value] of Object.entries(variables)) {
      if (typeof value === 'string' && key.startsWith('--')) view.styleVariables[key] = value;
    }
  }
  return view;
}

/** 合并部分 hostContext（host-context-changed 只带变化字段）：只覆盖出现的键。 */
export function mergeHostContext(current: HostContextView, patch: unknown): HostContextView {
  const incoming = parseHostContext(patch);
  return {
    theme: incoming.theme ?? current.theme,
    styleVariables: { ...current.styleVariables, ...incoming.styleVariables },
  };
}

/**
 * 归一 `ui/download-file` 的结果。
 *
 * **宿主实测行为（ZCode `app.asar`，见 protocol-notes.md §6）**：
 * 宿主处理器是
 * `(await saveFile({data, suggestedName})).success || (r = true); return r ? {isError:true} : {}`
 * —— 也就是：
 * - 成功 → 返回 `{}`：**没有 `success`、没有 `filePath`、没有 `canceled`**（保存路径被宿主丢弃）；
 * - 失败**与**用户取消 → 都返回 `{isError:true}`（宿主分不清取消与失败）。
 *
 * 协议层的结果 schema 本来也只有 `{isError?: boolean}`（passthrough）。
 * 所以这里只能做「尽力归一」，不能编造宿主没给的信息：
 * - 宿主直接给了 `success` → 用它（未来的宿主可能补上）；
 * - 只给了 `isError` → `success = !isError`；
 * - 什么都没给 → 视为成功（宿主没报错）。
 *
 * `filePath` / `canceled` 保留在返回类型里（对外 API 形状不变），但**当前宿主不会填**。
 * `error` 只在宿主给了字符串时才原样带出；否则用**中性的机器可读标记**（不是面向用户的话术）。
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
  // 宿主没给 error 文案：不自造人话，只给一个机器可读标记，让面板自己措辞
  else if (record.isError === true) result.error = 'download_not_confirmed';
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
    openLinks: false,
  };
  private rawCaps: RawHostCapabilities = {};
  private hostContext: HostContextView = { styleVariables: {} };
  private contextListeners = new Set<(ctx: HostContextView) => void>();
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
      | {
          jsonrpc?: unknown;
          id?: unknown;
          method?: unknown;
          params?: unknown;
          result?: unknown;
          error?: HostErrorPayload;
        }
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

    /**
     * 宿主通知：`host-context-changed`（params 是**部分** hostContext，只带变化字段）。
     *
     * 必须在按 id 关联响应**之前**拦截 —— 通知没有 id，走到下面会被直接丢弃。
     * 通知到达时更新内部上下文并通知订阅者（App 层据此刷新 `<html data-theme>` 与样式变量）。
     */
    if (data.method === 'ui/notifications/host-context-changed') {
      if (this.handshakeDone) {
        this.hostContext = mergeHostContext(this.hostContext, data.params);
        for (const cb of [...this.contextListeners]) cb({ ...this.hostContext });
      }
      return;
    }

    const id = Number(data.id);
    if (!Number.isInteger(id)) return; // 其余通知没有 id，不参与关联

    /**
     * 带 `method` 的帧是**请求/通知**，不是响应 → 一律不当成响应处理。
     *
     * 这一条是防「自己给自己回话」：`post()` 在 `window.parent` 缺失时会回退到 `window`，
     * 于是桥发出去的请求帧会被自己的 message 监听器收到；
     * 若把它当响应（`result` 为 undefined），自己的请求会被自己的 pending 满足掉，
     * 凭空 resolve 出一个 `undefined`。
     */
    if (typeof data.method === 'string') return;

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
          appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
          protocolVersion: this.protocolVersion,
        })) as { hostCapabilities?: unknown; hostContext?: unknown } | undefined;

        const raw = isRecord(result) && isRecord(result.hostCapabilities) ? result.hostCapabilities : {};
        this.rawCaps = raw;
        this.caps = parseHostCapabilities(raw);
        // 宿主展示上下文（主题 + 主题令牌变量）：`getHostContext()` 消费，通知到达时合并更新
        this.hostContext = parseHostContext(isRecord(result) ? result.hostContext : undefined);
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
   * 读取当前服务的资源（低层 `resources/read`）。
   *
   * 结果**只给发起请求的页面，不进模型上下文** —— 图片代理资源依赖这一点。
   * 返回值是 MCP `ReadResourceResult`（`contents` 数组；二进制资源是 `blob` base64）。
   */
  async readResource(uri: string): Promise<unknown> {
    this.requireHandshake('readResource');
    return this.request('resources/read', { uri });
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
   * 在宿主浏览器中打开本机 WebUI。
   *
   * 仅允许 loopback HTTP(S) URL，避免把宿主浏览器当成任意外链跳板。
   */
  async openLocalLink(rawUrl: string): Promise<void> {
    this.requireHandshake('openLocalLink');
    this.requireCap('openLinks', 'ui/open-link');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error('本机 NapCat WebUI 地址无效。');
    }
    const host = url.hostname.replace('[', '').replace(']', '').toLowerCase();
    const pieces = host.split('.');
    const ipv4Loopback =
      pieces.length === 4 &&
      pieces[0] === '127' &&
      pieces.slice(1).every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255);
    const loopback =
      host === 'localhost' ||
      host === '::1' ||
      host === '0:0:0:0:0:0:0:1' ||
      ipv4Loopback;
    if (
      !loopback ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new Error('只允许打开本机 NapCat WebUI 地址。');
    }
    const result = await this.request('ui/open-link', { url: url.toString() });
    if (isRecord(result) && result.isError === true) {
      throw new Error('宿主未能打开本机 NapCat WebUI。');
    }
  }

  /**
   * 让宿主把一段文本另存为文件（宿主能力位 `downloadFile`）。
   *
   * 协议形状：`{contents:[{type:"resource", resource:{uri, mimeType, text}}]}`
   * —— 是**内容块**（`type:"resource"`），不是裸的资源对象（实测见 protocol-notes.md §6）。
   *
   * **宿主实测**：成功返回 `{}`，失败与用户取消都返回 `{isError:true}` ——
   * **插件拿不到保存路径，也分不清取消与失败**。
   * 所以这个方法只是「让用户自己另存一份」，不能拿它的结果去做「已保存到 X」的文案；
   * 要真实路径请用服务端工具 `napcat_export`。
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

  /** 宿主展示上下文（主题 + 令牌变量；未握手时是空视图，theme 回退浅色由调用方决定）。 */
  getHostContext(): HostContextView {
    return { theme: this.hostContext.theme, styleVariables: { ...this.hostContext.styleVariables } };
  }

  /**
   * 订阅宿主上下文变化（主题切换等）。返回取消订阅函数。
   *
   * 通知只在**握手完成**后处理；订阅前已发生的变化通过 initialize 后先读一次
   * `getHostContext()` 拿到。
   */
  onHostContextChanged(listener: (ctx: HostContextView) => void): () => void {
    this.contextListeners.add(listener);
    return () => this.contextListeners.delete(listener);
  }

  /** 握手是否已完成。 */
  get initialized(): boolean {
    return this.handshakeDone;
  }

  /** 在途请求数（正常情况下应恒为 0；用来断言「没有悬挂的 promise」）。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 断开：摘掉监听、拒掉所有在途请求（不留悬挂的 promise），并**清空握手状态与能力位**。
   *
   * 清能力位是必须的：销毁后的桥不该再声称自己拥有宿主能力（否则调用方会以为
   * `caps.downloadFile` 仍可用而放行按钮）。
   */
  dispose(): void {
    if (this.listenerAttached) {
      window.removeEventListener('message', this.handle);
      this.listenerAttached = false;
    }
    for (const [id, pending] of [...this.pending]) {
      this.settle(id, undefined, new Error('host bridge disposed'));
    }
    this.pending.clear();
    this.handshakeDone = false;
    this.lastInitError = undefined;
    this.caps = {
      message: false,
      updateModelContext: false,
      downloadFile: false,
      serverTools: false,
      openLinks: false,
    };
    this.rawCaps = {};
    this.hostContext = { styleVariables: {} };
    this.contextListeners.clear();
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
