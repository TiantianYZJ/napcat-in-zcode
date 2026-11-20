import { createClient, type OneBotClient } from './onebot/client.js';
import { getLoginInfo } from './onebot/actions.js';
import type { OB11LoginInfo } from './onebot/types.js';
import { dataDir, loadConfigData, loadConfigWithRaw, saveConfig, type PluginConfig } from './config.js';

export interface StatusInfo {
  configured: boolean;
  connected: boolean;
  mode: 'external' | 'unconfigured';
  login?: OB11LoginInfo;
  error?: string;
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
 * 插件运行期状态：配置、OneBot 客户端、以及给测试用的注入位。
 *
 * 下游消费方：T10 的 `napcat_export` / `napcat_get_config`、T13 的面板。
 */
export class AppState {
  /** 配置快照：`loadConfigData()` = 文件内容 + env 兜底覆盖。 */
  config: PluginConfig = loadConfigData();
  /** 已建立的连接（懒建，失败时保持 null）。 */
  client: OneBotClient | null = null;
  /** 测试注入用：优先于 endpoint 构造。 */
  clientOverride: OneBotClient | null = null;
  /** 测试注入用：导出目录重定向（user 目录）。 */
  homeDirOverride?: string;
  /** 测试注入用：导出目录重定向（workspace 目录）。 */
  workspaceDirOverride?: string;

  /** 是否已经「配置过」：注入了测试客户端，或填了端点。 */
  get configured(): boolean {
    return this.clientOverride !== null || endpointOf(this.config) !== '';
  }

  /**
   * 出参脱敏：错误信息里可能夹带 token（例如上游把 token 原样回显在 wording 里）。
   *
   * token 明文只允许存在于 `config.json`；工具返回值、日志、面板都不许出现。
   */
  redact(text: string): string {
    const token = this.config.connection?.token ?? '';
    if (!token) return text;
    return text.split(token).join('***');
  }

  /**
   * 拿到可用的 OneBot 客户端（没有就按配置建一个）。
   *
   * 未配置端点时抛错——错误信息要能直接告诉用户下一步做什么。
   */
  async ensureClient(): Promise<OneBotClient> {
    if (this.clientOverride) return this.clientOverride;
    const endpoint = endpointOf(this.config);
    if (!endpoint) {
      throw new Error('未配置 OneBot 端点：请先调用 napcat_configure 填写地址与 token，或在插件设置里配置');
    }
    if (!this.client) {
      this.client = createClient({
        endpoint,
        token: this.config.connection.token || undefined,
      });
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
   * 顺序：**先校验端点 → 再落盘 → 再换连接 → 最后取登录信息**。
   * - 校验：`createClient` 只构造传输层（连接是懒的），但 scheme 不合法会在这一步抛出来。
   *   校验不过就**不写文件、不改内存态、不动已有连接**——否则一个写错的端点会把插件卡在不可用状态。
   * - 落盘失败：内存态与连接都不动（不会出现「内存已改、文件没改」的错位）。
   * - 端点合法但连不上：配置已按用户意图保存，错误由工具层转成 `isError` 返回。
   */
  async setConnection(endpoint: string, token: string): Promise<OB11LoginInfo> {
    // ① 端点校验（不通过就直接抛，文件与内存态都不动）
    const probed = createClient({ endpoint, token: token || undefined });

    // ② 校验通过 → patch 式落盘（只写 connection 段）
    this.saveConnection(endpoint, token);

    // ③ 换连接：关掉旧连接，用新端点重建
    const old = this.client;
    this.client = null;
    await old?.close();
    this.config.connection = { ...this.config.connection, endpoint, token };
    // 注入替身时用它（probed 不会被连接，直接丢弃）；否则用刚校验过的客户端
    this.client = this.clientOverride ? null : probed;

    // ④ 取登录信息（连不上会抛 → 工具层转 isError）
    const c = await this.ensureClient();
    return getLoginInfo(c);
  }

  /**
   * 连接状态。
   *
   * 「连不上」是**状态**而不是工具错误：`get_login_info` 返回 null / 上游超时等
   * 异常都在这里被吃掉，转成 `connected: false` + `error` 文案（错误信息脱敏）。
   */
  async status(): Promise<StatusInfo> {
    if (!this.configured) {
      return { configured: false, connected: false, mode: 'unconfigured' };
    }
    try {
      const c = await this.ensureClient();
      const login = await getLoginInfo(c);
      return { configured: true, connected: true, mode: 'external', login };
    } catch (e) {
      return {
        configured: true,
        connected: false,
        mode: 'external',
        error: this.redact(errText(e)),
      };
    }
  }
}

/** 进程级单例（stdio server 用它）。 */
export const appState = new AppState();
