import { OneBotError } from './errors.js';
import type { OB11Return } from './types.js';
import type { ClientConfig, OneBotClient } from './client.js';

export class WsTransport implements OneBotClient {
  private socket: WebSocket | undefined;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private connecting: Promise<void> | undefined;

  constructor(
    private cfg: ClientConfig,
    private timeoutMs: number,
  ) {}

  private connect(): Promise<void> {
    this.connecting ??= new Promise<void>((resolve, reject) => {
      // Node 全局 WebSocket 不支持 headers 参数，token 走 OneBot 约定的 access_token query 参数
      const url = new URL(this.cfg.endpoint);
      if (this.cfg.token) url.searchParams.set('access_token', this.cfg.token);
      const ws = new WebSocket(url);
      ws.onopen = () => { this.socket = ws; resolve(); };
      ws.onerror = () => { this.connecting = undefined; reject(new OneBotError(-2, 'websocket connect failed')); };
      ws.onclose = () => {
        this.socket = undefined;
        this.connecting = undefined;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new OneBotError(-2, 'websocket closed')); }
        this.pending.clear();
      };
      ws.onmessage = (ev) => {
        const ret = JSON.parse(String(ev.data)) as OB11Return<unknown> & { echo?: string };
        if (!ret.echo) return;
        const p = this.pending.get(ret.echo);
        if (!p) return;
        this.pending.delete(ret.echo);
        clearTimeout(p.timer);
        if (ret.retcode !== 0) p.reject(new OneBotError(ret.retcode, ret.wording ?? ret.message ?? 'action failed'));
        else p.resolve(ret.data);
      };
    });
    return this.connecting;
  }

  async call<T>(action: string, params?: object): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.connecting = undefined;
      await this.connect();
    }
    const echo = `e${++this.seq}`;
    const socket = this.socket!;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new OneBotError(-3, `action ${action} timeout`));
      }, this.timeoutMs);
      this.pending.set(echo, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ action, params: params ?? {}, echo }));
    });
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.socket = undefined;
    this.connecting = undefined;
  }
}
