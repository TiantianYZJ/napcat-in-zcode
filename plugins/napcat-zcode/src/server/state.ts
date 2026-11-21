import { createClient, safeEndpointLabel, type OneBotClient } from './onebot/client.js';
import { getLoginInfo } from './onebot/actions.js';
import type { OB11LoginInfo } from './onebot/types.js';
import { dataDir, loadConfigData, loadConfigWithRaw, saveConfig, type PluginConfig } from './config.js';

export interface StatusInfo {
  configured: boolean;
  connected: boolean;
  mode: 'external' | 'unconfigured';
  login?: OB11LoginInfo;
  error?: string;
  /**
   * 安全警告（如「端点不在本机且未设 token」）。
   * 有警告**不代表连接失败**——它是配置风险提示，面板单独展示。
   */
  warning?: string;
}

/**
 * 当前生效的 OneBot 端点。
 *
 * M1 只有「外部端点」一种连接模式（自动探测 / 内置 NapCat 尚未实现）：
 * `connection.endpoint` 为空串即「未配置」。
 */
export function endpointOf(cfg: PluginConfig): string {
  return cfg.connection?.endpoint ?? '';
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 端点里是否**显式写了空端口**（如 `http://host:`）。
 *
 * `new URL('http://host:')` 的 `port` 是空串 —— 与「没写端口」**无法区分**
 * （`http://host` 与 `http://host:80` 也都是空串：80 是默认端口，会被规范化掉）。
 * 因此只能回头看**原始字符串**：authority 段以 `:` 结尾 ⇒ 写了端口但端口为空。
 *
 * 这种写法是非规范形式（同一个端点有多种写法），落进 config.json 后用户很难看出问题，
 * 所以按非法处理（与端口越界同样的错误路径）。
 */
function hasExplicitEmptyPort(endpoint: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(endpoint);
  if (!m) return false;
  const authority = m[1];
  // userinfo 里的冒号不是端口分隔符 → 只看最后一个 '@' 之后的部分
  const at = authority.lastIndexOf('@');
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  return hostPort.endsWith(':');
}

/**
 * 端点**形状**校验（scheme 之外的第二道关）。
 *
 * `createClient` 的 scheme 判定只是正则白名单，**不做 URL 解析**：
 * `http://`（空主机）、`http://host:99999`（端口越界）都能通过那层检查，
 * 于是坏端点会被写进 `config.json`，插件从此卡在不可用状态。
 *
 * `new URL()` 才真正做形状解析：畸形写法、空主机、越界端口都会抛。
 * 校验不过 → 抛错，**不写文件、不改内存态**（与 scheme 校验失败的处理一致）。
 *
 * 对 `ws://` 同样生效：`new URL` 的解析规则对 ws/wss 与 http/https 一致。
 */
function assertUsableEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(
      `端点不是合法的 URL（需要 http(s)://主机:端口 或 ws(s)://主机:端口 形式）：${safeEndpointLabel(endpoint)}`,
    );
  }
  if (!url.hostname) {
    throw new Error(`端点缺少主机名：${safeEndpointLabel(endpoint)}`);
  }
  // 显式空端口（`http://host:`）在 URL 解析里与「没写端口」长得一样 → 看原始字符串
  if (hasExplicitEmptyPort(endpoint)) {
    throw new Error(`端点端口为空（需在 1-65535 之间）：${safeEndpointLabel(endpoint)}`);
  }
  const port = url.port ? Number(url.port) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) {
    throw new Error(`端点端口越界（需在 1-65535 之间）：${safeEndpointLabel(endpoint)}`);
  }
}

/**
 * 端点是不是「本机回环」。
 *
 * 回环 = `127.0.0.0/8`（含 127.0.0.1）、`::1`、`localhost`。
 * **`0.0.0.0` / `::` 不算回环**：它们表示「监听所有网卡」，恰恰是最需要 token 的那种暴露方式。
 */
export function isLoopbackEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // `new URL('http://[::1]:3000').hostname` 在 Node 里带方括号 → 去掉再比
  const host = url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (host === 'localhost') return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/**
 * 非回环端点 + 没有 token ⇒ 明确警告（spec §5.2 / §9 的安全要求）。
 *
 * 局域网里暴露的 NapCat（监听 `0.0.0.0`）若没有 access token，
 * **同网段的任何人**都能读到全部聊天记录——这是本插件最现实的泄漏场景，
 * 因此插件必须在这里说一句话（而不是只写在文档里）。
 *
 * 有 token → 不警告；回环端点 → 不警告（回环天然只有本机能连）。
 */
export function endpointSecurityWarning(endpoint: string, token: string): string | undefined {
  if (!endpoint) return undefined;
  if (token) return undefined;
  if (isLoopbackEndpoint(endpoint)) return undefined;
  return (
    `端点不在本机（${safeEndpointLabel(endpoint)}）且未设置 token：` +
    `同网段的其他人可能读到你的 QQ 聊天记录。建议在 NapCat 里设置 access token 并填到这里。`
  );
}

/**
 * 插件运行期状态：配置、OneBot 客户端、以及给测试用的注入位。
 *
 * 下游消费方：T10 的 `napcat_export` / `napcat_get_config`、T13 的面板。
 */
export class AppState {
  /** 配置快照：`loadConfigData()` = 文件内容 + env 兜底覆盖。 */
  config: PluginConfig = loadConfigData();
  /** 已建立的连接（懒建，失败时保持 null）。 */
  client: OneBotClient | null = null;
  /** 当前连接是按哪个端点建的（配置变了要重建，否则会连到旧端点）。 */
  clientEndpoint = '';
  /** 测试注入用：优先于 endpoint 构造。 */
  clientOverride: OneBotClient | null = null;
  /** 测试注入用：导出目录重定向（user 目录）。 */
  homeDirOverride?: string;
  /** 测试注入用：导出目录重定向（workspace 目录）。 */
  workspaceDirOverride?: string;
  /** 本进程见过的所有 token（脱敏用，见 `redact`）。 */
  private knownTokens = new Set<string>();

  constructor() {
    // 启动时配置里就有的 token 也要记住（之后任何出参里都要能遮蔽）
    this.rememberToken(this.config.connection?.token);
  }

  /** 是否已经「配置过」：注入了测试客户端，或填了端点。 */
  get configured(): boolean {
    return this.clientOverride !== null || endpointOf(this.config) !== '';
  }

  /**
   * 出参脱敏：错误信息里可能夹带 token（例如上游把 token 原样回显在 wording 里）。
   *
   * token 明文只允许存在于 `config.json`；工具返回值、日志、面板都不许出现。
   *
   * 脱敏覆盖**本进程见过的所有 token**（`knownTokens`），不只是「当前配置里那个」：
   * 配置会在每次 `status()` 时重读（运行期外部改了 config.json 也要看得见），
   * 重读会把内存里的 token 换成文件里的值——只按当前值脱敏就会出现
   * 「换了配置就漏出旧 token」的窗口。记住见过的每个 token 才能真正堵住。
   */
  redact(text: string): string {
    let out = text;
    for (const t of this.knownTokens) {
      if (t) out = out.split(t).join('***');
    }
    const cur = this.config.connection?.token ?? '';
    if (cur && !this.knownTokens.has(cur)) out = out.split(cur).join('***');
    return out;
  }

  /** 记住一个见过的 token（之后它出现在任何出参里都会被遮蔽）。 */
  private rememberToken(token: string | undefined): void {
    if (token) this.knownTokens.add(token);
  }

  /**
   * 拿到可用的 OneBot 客户端（没有就按配置建一个）。
   *
   * 未配置端点时抛错——错误信息要能直接告诉用户下一步做什么。
   *
   * 端点变了就重建连接：`config.json` 被外部改过（面板设置页 / 用户手改）时，
   * 继续用旧连接会「状态条报新端点、实际连旧端点」。
   */
  async ensureClient(): Promise<OneBotClient> {
    if (this.clientOverride) return this.clientOverride;
    const endpoint = endpointOf(this.config);
    if (!endpoint) {
      throw new Error('未配置 OneBot 端点：请先调用 napcat_configure 填写地址与 token，或在插件设置里配置');
    }
    if (this.client && this.clientEndpoint !== endpoint) {
      const old = this.client;
      this.client = null;
      this.clientEndpoint = '';
      await old.close();
    }
    if (!this.client) {
      this.client = createClient({
        endpoint,
        token: this.config.connection.token || undefined,
      });
      this.clientEndpoint = endpoint;
    }
    return this.client;
  }

  /**
   * patch 式保存连接配置：**只**把本次变化的 connection 字段写进文件。
   *
   * 不能直接 `saveConfig(dataDir(), this.config)`：`this.config` 来自 `loadConfigData()`，
   * 已被 env 兜底覆盖过，全量写会把 env 值固化进 `config.json`，
   * 也会凭空写出 `export.*` 等段（把「文件里没设置」变成「文件里显式设置」）。
   * 因此以文件原始内容为基底，只 patch `connection`。
   *
   * @param token **已解析好的** token（空 = 保留文件里的旧值，见 `setConnection`）。
   */
  private saveConnection(endpoint: string, token: string): void {
    const dir = dataDir();
    const { raw } = loadConfigWithRaw(dir);
    const conn = isPlainObject(raw.connection) ? raw.connection : {};
    const patched: Record<string, unknown> = { ...raw, connection: { ...conn, endpoint, token } };
    saveConfig(dir, patched as unknown as PluginConfig);
  }

  /**
   * 保存端点/令牌并重连，返回登录信息。
   *
   * 顺序：**先校验端点 → 再解析 token → 再落盘 → 再换连接 → 最后取登录信息**。
   * - 校验分两层：`createClient`（scheme 白名单）+ `assertUsableEndpoint`（URL 形状）。
   *   `createClient` 只构造传输层（连接是懒的），但 scheme 不合法会在这一步抛出来；
   *   URL 形状（空主机、越界端口、畸形写法）由第二层挡下。
   *   校验不过就**不写文件、不改内存态、不动已有连接**——否则一个写错的端点会把插件卡在不可用状态。
   * - 落盘失败：内存态与连接都不动（不会出现「内存已改、文件没改」的错位）。
   * - 端点合法但连不上：配置已按用户意图保存，错误由工具层转成 `isError` 返回。
   *
   * **token 的解析规则（防误删凭据）**：
   * - 传入非空 token → 用它（换 token）；
   * - 传入空 token 且**没有** `clearToken` → **保留文件里已存的 token**。
   *   空 token 不再等于「清除」：面板的「重新配置端点」表单无法回填 token
   *   （服务端只回 `'***'`），agent 调 `napcat_configure` 也常常不带 token——
   *   两种情况都会把用户已存的凭据无声擦掉。
   * - `clearToken: true` → 显式清除（唯一能置空的入口）。
   */
  async setConnection(
    endpoint: string,
    token: string,
    opts: { clearToken?: boolean } = {},
  ): Promise<OB11LoginInfo> {
    // ⓪ 解析出「真正要落盘 / 真正要用来连接」的 token
    const { raw } = loadConfigWithRaw(dataDir());
    const conn = isPlainObject(raw.connection) ? raw.connection : {};
    const storedToken = typeof conn.token === 'string' ? conn.token : '';
    const effectiveToken = opts.clearToken ? '' : token !== '' ? token : storedToken;
    this.rememberToken(effectiveToken);

    // ① 端点校验（不通过就直接抛，文件与内存态都不动）
    const probed = createClient({ endpoint, token: effectiveToken || undefined });
    assertUsableEndpoint(endpoint);

    // ② 校验通过 → patch 式落盘（只写 connection 段）
    this.saveConnection(endpoint, effectiveToken);

    // ③ 换连接：关掉旧连接，用新端点重建
    const old = this.client;
    this.client = null;
    this.clientEndpoint = '';
    await old?.close();
    this.config.connection = { ...this.config.connection, endpoint, token: effectiveToken };
    // 注入替身时用它（probed 不会被连接，直接丢弃）；否则用刚校验过的客户端
    this.client = this.clientOverride ? null : probed;
    if (this.client) this.clientEndpoint = endpoint;

    // ④ 取登录信息（连不上会抛 → 工具层转 isError）
    const c = await this.ensureClient();
    return getLoginInfo(c);
  }

  /**
   * 连接状态。
   *
   * 「连不上」是**状态**而不是工具错误：`get_login_info` 返回 null / 上游超时等
   * 异常都在这里被吃掉，转成 `connected: false` + `error` 文案（错误信息脱敏）。
   *
   * 每次都**重读配置**：`AppState.config` 原本是进程启动时的一次快照，
   * 运行期外部改了 `config.json`（面板设置页、用户手改文件）不会被感知，
   * 状态条就会一直显示启动时的旧端点/旧状态。
   */
  async status(): Promise<StatusInfo> {
    // 刷新前先记住内存里的 token：重读会把它换成文件里的值（脱敏要覆盖旧值，见 redact）
    this.rememberToken(this.config.connection?.token);
    this.config = loadConfigData();
    this.rememberToken(this.config.connection?.token);
    if (!this.configured) {
      return { configured: false, connected: false, mode: 'unconfigured' };
    }
    const endpoint = endpointOf(this.config);
    const warning = endpointSecurityWarning(endpoint, this.config.connection?.token ?? '');
    try {
      const c = await this.ensureClient();
      const login = await getLoginInfo(c);
      return { configured: true, connected: true, mode: 'external', login, warning };
    } catch (e) {
      return {
        configured: true,
        connected: false,
        mode: 'external',
        error: this.redact(errText(e)),
        warning,
      };
    }
  }
}

/** 进程级单例（stdio server 用它）。 */
export const appState = new AppState();

/**
 * 关闭当前 OneBot 连接（会话结束 / 进程退出时用）。
 *
 * 没有连接时什么都不做；关闭后 `client` 归零，下次调用会按配置重新建连。
 */
export async function closeConnection(state: AppState): Promise<void> {
  const client = state.client;
  state.client = null;
  state.clientEndpoint = '';
  await client?.close();
}
