import { OneBotError } from './errors.js';
import type { OB11Return } from './types.js';
import { WsTransport } from './ws.js';

export interface OneBotClient {
  call<T>(action: string, params?: object): Promise<T>;
  close(): Promise<void>;
}

export interface ClientConfig {
  endpoint: string;
  token?: string;
  timeoutMs?: number;
}

class HttpTransport implements OneBotClient {
  constructor(
    private cfg: ClientConfig,
    private timeoutMs: number,
  ) {}

  async call<T>(action: string, params?: object): Promise<T> {
    const res = await fetch(`${this.cfg.endpoint.replace(/\/$/, '')}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new OneBotError(-1, `HTTP ${res.status} on ${action}`);
    }
    const ret = (await res.json()) as OB11Return<T>;
    if (ret.retcode !== 0) {
      throw new OneBotError(ret.retcode, ret.wording ?? ret.message ?? `action ${action} failed (retcode ${ret.retcode})`);
    }
    return ret.data;
  }

  async close(): Promise<void> {}
}

/**
 * 端点标签（用于错误信息）：去掉 query 与 userinfo。
 *
 * 端点里可能带 access_token（OneBot 的 ws 约定走 query）或 `user:pass`——
 * 原样回显等于把凭据写进工具返回值、模型上下文与日志。
 *
 * 共享给 `state.ts` 的端点校验用，保证两处错误信息的脱敏口径一致。
 */
export function safeEndpointLabel(endpoint: string): string {
  const [noQuery] = endpoint.split('?');
  const at = noQuery.lastIndexOf('@');
  return at >= 0 ? noQuery.slice(at + 1) : noQuery;
}

export function createClient(cfg: ClientConfig): OneBotClient {
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  // scheme 大小写不敏感：`HTTP://host` / `WS://host` 是合法端点，
  // 之前只匹配小写会被误判成「unsupported endpoint scheme」。
  if (/^https?:\/\//i.test(cfg.endpoint)) return new HttpTransport(cfg, timeoutMs);
  if (/^wss?:\/\//i.test(cfg.endpoint)) return new WsTransport(cfg, timeoutMs);
  throw new Error(`unsupported endpoint scheme: ${safeEndpointLabel(cfg.endpoint)}`);
}
