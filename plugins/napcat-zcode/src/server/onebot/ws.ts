import { OneBotError } from './errors.js';
import type { OB11Return } from './types.js';
import type { ClientConfig, OneBotClient } from './client.js';

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  /** 请求是在哪条连接上发出的：连接断开时只拒绝它自己的 pending */
  socket: WebSocket;
}

/** 关闭握手兜底：超过该时长即认为关闭完成，避免 close() 挂死 */
const CLOSE_FALLBACK_MS = 1000;

export class WsTransport implements OneBotClient {
  private socket: WebSocket | undefined;
  /** 所有在途连接（已断开/失败的会被移除），close() 时统一收拢，避免孤儿连接挂住事件循环 */
  private sockets = new Set<WebSocket>();
  private seq = 0;
  private pending = new Map<string, PendingRequest>();
  /** in-flight 建连 promise：并发首连共用同一条连接 */
  private connecting: Promise<void> | undefined;
  /** in-flight 建连的 reject 句柄：close() 期间用于立即终止正在建连的调用 */
  private rejectConnecting: ((e: Error) => void) | undefined;
  private closed = false;

  constructor(
    private cfg: ClientConfig,
    private timeoutMs: number,
  ) {}

  private connect(): Promise<void> {
    if (this.closed) return Promise.reject(new OneBotError(-2, 'websocket client closed'));
    // 复用 in-flight promise：并发首次调用共用同一条连接，不会各自新建 socket
    if (this.connecting) return this.connecting;
    let rejectConnect: (e: Error) => void = () => undefined;
    const promise = new Promise<void>((resolve, reject) => {
      rejectConnect = reject;
      // Node 全局 WebSocket 不支持 headers 参数，token 走 OneBot 约定的 access_token query 参数
      const url = new URL(this.cfg.endpoint);
      if (this.cfg.token) url.searchParams.set('access_token', this.cfg.token);
      const ws = new WebSocket(url);
      this.sockets.add(ws);
      // 握手期即持有：close() 才能中断握手中的连接
      this.socket = ws;
      ws.onopen = () => {
        if (this.closed) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new OneBotError(-2, 'websocket client closed'));
          return;
        }
        this.socket = ws;
        resolve();
      };
      ws.onerror = () => {
        this.sockets.delete(ws);
        if (this.socket === ws) {
          this.socket = undefined;
          this.connecting = undefined;
          this.rejectConnecting = undefined;
        }
        reject(new OneBotError(-2, 'websocket connect failed'));
      };
      ws.onclose = () => {
        this.sockets.delete(ws);
        if (this.socket === ws) {
          this.socket = undefined;
          this.connecting = undefined;
          this.rejectConnecting = undefined;
        }
        this.rejectPendingFor(ws, new OneBotError(-2, 'websocket closed'));
      };
      ws.onmessage = (ev) => {
        let ret: OB11Return<unknown> & { echo?: string };
        try {
          ret = JSON.parse(String(ev.data)) as OB11Return<unknown> & { echo?: string };
        } catch {
          // 非 JSON 帧：绝不能让解析异常打挂事件循环；按协议违例处理
          this.rejectPending(new OneBotError(-2, 'invalid websocket response'));
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        if (!ret.echo) return;
        const p = this.pending.get(ret.echo);
        if (!p) return;
        this.pending.delete(ret.echo);
        clearTimeout(p.timer);
        if (ret.retcode !== 0) p.reject(new OneBotError(ret.retcode, ret.wording ?? ret.message ?? 'action failed'));
        else p.resolve(ret.data);
      };
    });
    this.connecting = promise;
    this.rejectConnecting = rejectConnect;
    return promise;
  }

  async call<T>(action: string, params?: object): Promise<T> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    const socket = this.socket;
    if (!socket) throw new OneBotError(-2, 'websocket not connected');
    const echo = `e${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new OneBotError(-3, `action ${action} timeout`));
      }, this.timeoutMs);
      this.pending.set(echo, { resolve: resolve as (v: unknown) => void, reject, timer, socket });
      try {
        socket.send(JSON.stringify({ action, params: params ?? {}, echo }));
      } catch (err) {
        // 发送失败：清掉 pending 与定时器，按 OneBot 错误抛出，避免残留
        this.pending.delete(echo);
        clearTimeout(timer);
        reject(new OneBotError(-2, `websocket send failed: ${(err as Error).message}`));
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const sockets = [...this.sockets];
    this.sockets.clear();
    this.socket = undefined;
    this.connecting = undefined;
    // 同步拒绝所有 pending：不依赖对端完成关闭握手，也不让调用方干等到超时
    this.rejectPending(new OneBotError(-2, 'websocket closed'));
    // 终止正在建连的调用
    this.rejectConnecting?.(new OneBotError(-2, 'websocket client closed'));
    this.rejectConnecting = undefined;
    await Promise.all(sockets.map((ws) => this.closeSocket(ws)));
  }

  /** 关闭单条连接并等待其 close 事件；对端不配合时有兜底超时，不会挂住 close() */
  private closeSocket(ws: WebSocket): Promise<void> {
    return new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, CLOSE_FALLBACK_MS);
      timer.unref?.();
      ws.addEventListener('close', finish, { once: true });
      try {
        ws.close();
      } catch {
        finish();
      }
    });
  }

  /** 拒绝全部 pending 请求 */
  private rejectPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** 只拒绝某条连接上发出的 pending 请求 */
  private rejectPendingFor(ws: WebSocket, err: Error): void {
    for (const [echo, p] of this.pending) {
      if (p.socket !== ws) continue;
      this.pending.delete(echo);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }
}
