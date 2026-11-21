import { isAbsolute } from 'node:path';
import { createClient, safeEndpointLabel, type OneBotClient } from './onebot/client.js';
import { getLoginInfo } from './onebot/actions.js';
import { normalizeEndpoint } from './onebot/detect.js';
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
  /**
   * 最近一次 `napcat_detect_local` 的结论（**缓存**，读取它不会触发任何扫描）。
   *
   * 没探测过时这个字段**不存在**——`status` 绝不会自己去扫端口
   * （状态条每刷新一次就等几秒是不能接受的）。
   */
  detection?: DetectionSummary;
}

/**
 * 本机探测的结论（`napcat_detect_local` 的摘要）。
 *
 * 面板用它解释「面板上那个『检测到本机 NapCat』的结论是哪来的」——
 * 结论**只在用户显式调用探测工具之后**才存在。
 */
export interface DetectionSummary {
  /** 是否找到可用的 OneBot 端点。 */
  found: boolean;
  /** NapCat WebUI 有响应 → NapCat 在跑。 */
  napcatRunning: boolean;
  /** 探测到的第一个可用端点。 */
  endpoint?: string;
  /**
   * 扫描预算耗尽 → **没扫完**。
   *
   * `true` 时不能读作「没找到本机 NapCat」（那是假阴性）。
   */
  budgetExhausted?: boolean;
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
 * 稳定序列化（对象键排序）→ 用来比较两段配置**是否真的变了**。
 *
 * `JSON.stringify` 的键序取决于对象构造顺序，两次独立解析出来的同一个配置可能键序不同
 * （`sanitize` 固定了键序，但 `setConnection` 是往内存对象上补键的）——
 * 用它做「变了没有」的判断会误报。排序后键序固定，比较才可靠。
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 配置指纹：**只**取会影响探测结论的两段。
 *
 * - `autoDetect`：决定探测范围（端口 / 端点 / 路径 / 超时）；
 * - `connection`：决定探测目标之一（当前已配置的端点）。
 *
 * 指纹变了 = 探测范围或目标变了 → 之前那次探测的结论不再适用 → 必须清缓存。
 */
function configFingerprint(cfg: PluginConfig): string {
  return stableStringify({ autoDetect: cfg.autoDetect, connection: cfg.connection });
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
 * 端点里的 query 段（`?access_token=…`）；没有 query 时是空串。
 *
 * OneBot 的 WebSocket Server 约定把 access token 放在 URL 的 query 里，
 * 所以这一段常常就是**唯一的凭据**。
 */
function queryOf(endpoint: string): string {
  const i = endpoint.indexOf('?');
  return i < 0 ? '' : endpoint.slice(i);
}

/**
 * 端点里有没有 userinfo（`http://user:pass@host`）——同样是凭据。
 *
 * `normalizeEndpoint` 会把它剥掉，规范化候选里看不见。
 */
function hasUserInfo(endpoint: string): boolean {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(endpoint);
  if (!m) return false;
  return m[1].lastIndexOf('@') >= 0;
}

/**
 * 保留「已存端点」里的凭据（query / userinfo）。
 *
 * **为什么需要它**：面板的「使用这个」按钮传的是**规范化**候选
 * （`normalizeEndpoint` 会剥掉 query 与 userinfo）——
 * 用户配的 `ws://127.0.0.1:3001?access_token=abc` 在候选里显示成 `ws://127.0.0.1:3001`，
 * 点一下 `api.configure(ep, '')` 就会把**本来能用的**配置换成没有凭据的 URL：
 * 凭据若只存在于 query（不在 `connection.token` 里），连接随即失败，**而原 URL 已经丢了**。
 *
 * **怎么修（服务端做，不把凭据暴露给面板）**：比较「传入端点的规范化形式」与
 * 「已存端点的规范化形式」——
 * - 两者**相同**（= 同一个端点）且**传入的没有 query 而已存的有** → 沿用**已存的完整端点串**；
 * - 端点**确实变了**（规范化形式不同）→ 一律用传入的（用户明确要换端点，不该保留旧凭据）；
 * - 传入的自己有 query → 用传入的（它自己带了凭据）。
 *
 * userinfo 走同一套口径（它是同一类凭据）：传入的没有 userinfo 而已存的有 → 沿用已存的。
 */
function preserveStoredQuery(incoming: string, stored: string): string {
  if (!stored) return incoming;
  const a = normalizeEndpoint(incoming);
  const b = normalizeEndpoint(stored);
  // 规范化失败（不是合法 URL）→ 无法比较 → 用传入的（后续的端点校验会把它拦下来）
  if (!a || !b || a !== b) return incoming;
  if (queryOf(incoming)) return incoming; // 传入的自带 query → 用传入的
  if (queryOf(stored)) return stored; // 已存的有 query → 沿用已存的完整端点（保住凭据）
  if (hasUserInfo(incoming)) return incoming; // 传入的自带 userinfo → 用传入的
  if (hasUserInfo(stored)) return stored; // 已存的有 userinfo → 沿用已存的完整端点
  return incoming; // 两边都没有凭据 → 不变
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
  /** 测试注入用：导出目录重定向（user 目录；也用作本机安装发现的 home 根）。 */
  homeDirOverride?: string;
  /** 测试注入用：导出目录重定向（workspace 目录）。 */
  workspaceDirOverride?: string;
  /**
   * 最近一次本机探测的结论（**仅内存**，进程重启即失效）。
   *
   * `napcat_status` 读它来展示「探测到本机 NapCat」，
   * 但**不会**为了拿它去触发一次端口扫描（那会让状态条每刷新一次就等几秒）。
   * 结论只在用户显式调用 `napcat_detect_local` 之后才产生。
   */
  detection?: DetectionSummary;
  /** 本进程见过的所有凭据值（token 及其他片段，脱敏用，见 `redact`）。 */
  private knownSecrets = new Set<string>();
  /**
   * 上次加载到的配置指纹（`autoDetect` + `connection`）。
   *
   * 指纹变了 = 探测范围或探测目标变了 → 之前那次探测的结论不再适用 → 必须清缓存。
   */
  private loadedFingerprint = configFingerprint(this.config);

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
   * 脱敏覆盖**本进程见过的所有凭据值**（`knownSecrets`：access token 与
   * 端点里带出来的密码/token 片段），不只是「当前配置里那个」：
   * 配置会在每次 `status()` 时重读（运行期外部改了 config.json 也要看得见），
   * 重读会把内存里的 token 换成文件里的值——只按当前值脱敏就会出现
   * 「换了配置就漏出旧 token」的窗口。记住见过的每个凭据值才能真正堵住。
   */
  redact(text: string): string {
    let out = text;
    for (const t of this.knownSecrets) {
      if (t) out = out.split(t).join('***');
    }
    const cur = this.config.connection?.token ?? '';
    if (cur && !this.knownSecrets.has(cur)) out = out.split(cur).join('***');
    return out;
  }

  /** 记住一个见过的 token（之后它出现在任何出参里都会被遮蔽）。 */
  private rememberToken(token: string | undefined): void {
    if (token) this.knownSecrets.add(token);
  }

  /**
   * 记住一个见过的**凭据片段**（之后它出现在任何出参里都会被遮蔽）。
   *
   * 与 access token 共用同一个脱敏池：`redact` 的语义是「替换**本进程见过**的所有凭据值」。
   *
   * 典型来源：用户写在端点里的 userinfo 密码、query 里的 `?access_token=xxx`。
   * 这些值在端点**规范化之后就没了**（`normalizeEndpoint` 会剥掉 userinfo 与 query），
   * 所以必须从**原始串**里取出来登记——否则上游一旦把它们**裸回显**（没有 `token=` 前缀），
   * 明文就会直接进工具返回值。
   */
  rememberSecret(secret: string | undefined): void {
    if (typeof secret !== 'string') return;
    const t = secret.trim();
    // 太短的值挡不住任何东西，却会误伤正常文本（如用户名 `a`、主机名片段）
    if (t.length < 4) return;
    this.knownSecrets.add(t);
  }

  /**
   * 重读配置文件（运行期外部改了 `config.json` 也要看得见）。
   *
   * 刷新前先记住内存里的 token：重读会把内存里的 token 换成文件里的值，
   * 只按新值脱敏就会出现「换了配置就漏出旧 token」的窗口。
   *
   * **配置变了就清掉探测结论**：探测结论是**针对某一份配置**得出的
   * （扫哪些端口、探哪些端点都由 `autoDetect` / `connection` 决定）。
   * 用户手改了 `config.json`（换了端口/路径/端点）之后，旧结论已经对不上当前配置——
   * 不清的话，`napcat_status` 会继续拿旧结论说「检测到本机 NapCat」。
   */
  reloadConfig(): void {
    this.rememberToken(this.config.connection?.token);
    const next = loadConfigData();
    this.rememberToken(next.connection?.token);
    const fingerprint = configFingerprint(next);
    if (fingerprint !== this.loadedFingerprint) {
      this.loadedFingerprint = fingerprint;
      this.clearDetection();
    }
    this.config = next;
  }

  /**
   * 当前配置的**指纹**（探测结论的「适用范围」）。
   *
   * 探测开始时记下它、结束时比对：指纹变了 = 探测期间配置变了 →
   * 那份结论是**按旧配置**算出来的，不能写回缓存（见 `setDetection`）。
   */
  currentFingerprint(): string {
    return configFingerprint(this.config);
  }

  /**
   * 记录最近一次本机探测的结论（供 `napcat_status` 读取）。
   *
   * @param fingerprint 探测**运行时**用的配置指纹（可选）：
   *   传了就先跟当前指纹比对——不一致说明**探测期间配置变了**，
   *   那份结论是针对旧配置的，**丢弃**（不能写回缓存，否则会拿旧结论说「检测到本机 NapCat」）。
   *   不传 = 无条件写入（老调用方 / 手工塞结论的测试）。
   * @returns 是否真的写入了（false = 已丢弃）
   */
  setDetection(detection: DetectionSummary, fingerprint?: string): boolean {
    if (fingerprint !== undefined && fingerprint !== this.currentFingerprint()) {
      // 过期结论**不写**（也不去动已有的结论——配置变更路径已经清过缓存了）
      return false;
    }
    this.detection = detection;
    return true;
  }

  /**
   * 清除探测结论缓存。
   *
   * 配置改了（端点/端口/路径都变了）之后，旧结论已经对不上 → 必须清掉，
   * 否则面板会拿一个过期结论说「检测到本机 NapCat」。
   *
   * 两个触发点：
   * - `setConnection`：配置**落盘**之后（端点合法但连不上时同样要清）；
   * - `reloadConfig`：外部改了 `config.json`（`autoDetect` / `connection` 变了）。
   */
  clearDetection(): void {
    this.detection = undefined;
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
   * 保存 `autoDetect.paths`（本机 NapCat 扫描根）。
   *
   * **patch 式**：以文件原始内容为基底，只改 `autoDetect.paths`——
   * 全量写会把 env 兜底值固化进文件，也会凭空写出别的段（见 `saveConnection` 的同款理由）。
   *
   * 只收**绝对路径**（与 `config.ts` 的 `pickPaths` 同一口径）：相对路径会随宿主的工作目录
   * 变化，语义含糊且不可复现。重复路径去重、空串丢弃。
   *
   * **落盘即失效**：路径变了 = 探测范围变了 → 之前那次探测的结论不再适用 → 清缓存
   * （与 `setConnection` 同一口径：配置一变，旧结论就对不上了）。
   */
  setAutoDetectPaths(paths: string[]): string[] {
    const dir = dataDir();
    const { raw } = loadConfigWithRaw(dir);
    const auto = isPlainObject(raw.autoDetect) ? raw.autoDetect : {};
    const cleaned: string[] = [];
    for (const p of paths) {
      if (typeof p !== 'string') continue;
      const t = p.trim();
      if (t === '') continue;
      if (!isAbsolute(t)) continue; // 相对路径 → 丢弃（工具层会先报错，不该走到这里）
      if (cleaned.includes(t)) continue;
      cleaned.push(t);
    }
    const patched: Record<string, unknown> = { ...raw, autoDetect: { ...auto, paths: cleaned } };
    saveConfig(dir, patched as unknown as PluginConfig);
    this.config.autoDetect = { ...this.config.autoDetect, paths: [...cleaned] };
    this.clearDetection();
    this.loadedFingerprint = configFingerprint(this.config);
    return [...cleaned];
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
   * - **落盘即失效**：配置一旦落盘，本机探测的结论缓存就被清掉（见 `clearDetection`）——
   *   探测结论是针对某一份配置得出的，配置变了它就对不上了。
   *
   * **端点的解析规则（防误删凭据）**：
   * 传入的端点是**规范化**形态时（面板的「使用这个」按钮传的就是它），
   * 它已经**没有 query** 了——而凭据可能只存在于 query 里
   * （OneBot 的 WS 约定：`ws://host:port?access_token=…`）。
   * 因此：传入端点与**已存端点**规范化后相同、且已存的那个带 query 时，
   * **沿用已存的完整端点串**（见 `preserveStoredQuery`）。
   * 端点确实变了 → 一律用传入的。
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
    // ⓪ 解析出「真正要落盘 / 真正要用来连接」的 token 与端点
    const { raw } = loadConfigWithRaw(dataDir());
    const conn = isPlainObject(raw.connection) ? raw.connection : {};
    const storedToken = typeof conn.token === 'string' ? conn.token : '';
    const storedEndpoint = typeof conn.endpoint === 'string' ? conn.endpoint : '';
    const effectiveToken = opts.clearToken ? '' : token !== '' ? token : storedToken;
    this.rememberToken(effectiveToken);
    /**
     * 端点：规范化形态的传入值**可能**丢掉了 query 里的凭据
     * （面板「使用这个」按钮传的就是规范化候选）→ 同一个端点时沿用已存的完整串。
     */
    const effectiveEndpoint = preserveStoredQuery(endpoint, storedEndpoint);

    // ① 端点校验（不通过就直接抛，文件与内存态都不动）
    const probed = createClient({ endpoint: effectiveEndpoint, token: effectiveToken || undefined });
    assertUsableEndpoint(effectiveEndpoint);

    // ② 校验通过 → patch 式落盘（只写 connection 段）
    this.saveConnection(effectiveEndpoint, effectiveToken);
    /**
     * 配置**一旦落盘**，之前的探测结论就失效了 → 立刻清缓存。
     *
     * 清在这里（而不是工具层的成功分支）：端点合法但**连不上**时，
     * 配置已经写进文件、内存态也换了，此时若不清缓存，面板会继续拿
     * **针对旧配置**的探测结论说「检测到本机 NapCat」——那个结论根本不是当前配置的结论。
     *
     * 落盘失败（上一行抛错）不会走到这里 → 配置没变 → 旧结论仍然有效。
     */
    this.clearDetection();

    // ③ 换连接：关掉旧连接，用新端点重建
    const old = this.client;
    this.client = null;
    this.clientEndpoint = '';
    await old?.close();
    this.config.connection = { ...this.config.connection, endpoint: effectiveEndpoint, token: effectiveToken };
    // 指纹跟着内存态走（文件已落盘，两边一致）→ 之后的 reloadConfig 不会误判成「外部改了配置」
    this.loadedFingerprint = configFingerprint(this.config);
    // 注入替身时用它（probed 不会被连接，直接丢弃）；否则用刚校验过的客户端
    this.client = this.clientOverride ? null : probed;
    if (this.client) this.clientEndpoint = effectiveEndpoint;

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
    this.reloadConfig();
    // 探测结论是**缓存**：读它不会触发任何扫描；没探测过就没有这个字段
    const detection = this.detection;
    if (!this.configured) {
      return {
        configured: false,
        connected: false,
        mode: 'unconfigured',
        ...(detection ? { detection } : {}),
      };
    }
    const endpoint = endpointOf(this.config);
    const warning = endpointSecurityWarning(endpoint, this.config.connection?.token ?? '');
    try {
      const c = await this.ensureClient();
      const login = await getLoginInfo(c);
      return {
        configured: true,
        connected: true,
        mode: 'external',
        login,
        warning,
        ...(detection ? { detection } : {}),
      };
    } catch (e) {
      return {
        configured: true,
        connected: false,
        mode: 'external',
        error: this.redact(errText(e)),
        warning,
        ...(detection ? { detection } : {}),
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
