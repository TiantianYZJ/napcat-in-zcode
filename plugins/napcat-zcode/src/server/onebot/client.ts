import { OneBotError } from './errors.js';
import type { OB11Return } from './types.js';

export interface OneBotClient {
  call<T>(action: string, params?: object): Promise<T>;
  close(): Promise<void>;
}

export interface ClientConfig {
  endpoint: string;
  token?: string;
}

class HttpTransport implements OneBotClient {
  constructor(private cfg: ClientConfig) {}

  async call<T>(action: string, params?: object): Promise<T> {
    const res = await fetch(`${this.cfg.endpoint.replace(/\/$/, '')}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
      },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(30_000),
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
  if (/^https?:\/\//.test(cfg.endpoint)) return new HttpTransport(cfg);
  if (/^wss?:\/\//.test(cfg.endpoint)) throw new Error('ws transport: not implemented yet');
  throw new Error(`unsupported endpoint scheme: ${cfg.endpoint}`);
}
