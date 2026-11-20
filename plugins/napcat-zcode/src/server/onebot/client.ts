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

export function createClient(cfg: ClientConfig): OneBotClient {
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  // scheme 大小写不敏感：`HTTP://host` / `WS://host` 是合法端点，
  // 之前只匹配小写会被误判成「unsupported endpoint scheme」。
  if (/^https?:\/\//i.test(cfg.endpoint)) return new HttpTransport(cfg, timeoutMs);
  if (/^wss?:\/\//i.test(cfg.endpoint)) return new WsTransport(cfg, timeoutMs);
  throw new Error(`unsupported endpoint scheme: ${cfg.endpoint}`);
}
