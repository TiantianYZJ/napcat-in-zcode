import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsConn } from 'ws';
import { createClient, type OneBotClient } from '../src/server/onebot/client.js';
import type { IncomingMessage } from 'node:http';

interface ActionRequest {
  action: string;
  params: Record<string, unknown>;
  echo: string;
  send: (payload: unknown) => void;
}

type ActionHandler = (req: ActionRequest) => void;

let wss: WebSocketServer;
let port: number;
let conn: WsConn | undefined;
/** 服务端已接受的连接数（并发首调用例断言用） */
let connectionCount: number;
/** 握手请求 URL（access_token query 参数用例断言用） */
let requestUrl: string | undefined;
/** 服务端侧仍存活的连接 */
const serverConns = new Set<WsConn>();
/** 当前生效的动作处理器，单个用例可覆盖 */
let handler: ActionHandler;
/** 用例内创建的客户端，afterEach 统一关闭，避免残留 socket 挂住 vitest */
const clients: OneBotClient[] = [];

const defaultHandler: ActionHandler = (req) => {
  if (req.action === 'get_login_info') {
    req.send({ status: 'ok', retcode: 0, data: { user_id: 2350355494, nickname: 'TestBot' }, echo: req.echo });
  } else if (req.action === 'slow') {
    // 不响应，触发超时
  } else {
    req.send({ status: 'failed', retcode: 1404, data: null, wording: 'not found', echo: req.echo });
  }
};

function track(c: OneBotClient): OneBotClient {
  clients.push(c);
  return c;
}

beforeEach(async () => {
  connectionCount = 0;
  requestUrl = undefined;
  conn = undefined;
  serverConns.clear();
  handler = defaultHandler;
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.on('listening', r));
  port = (wss.address() as { port: number }).port;
  wss.on('connection', (c: WsConn, req: IncomingMessage) => {
    connectionCount += 1;
    conn = c;
    serverConns.add(c);
    requestUrl = req.url;
    c.on('close', () => serverConns.delete(c));
    c.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { action: string; params?: Record<string, unknown>; echo: string };
      handler({
        action: msg.action,
        params: msg.params ?? {},
        echo: msg.echo,
        send: (payload) => c.send(JSON.stringify(payload)),
      });
    });
  });
});

afterEach(async () => {
  for (const c of clients.splice(0)) {
    await c.close().catch(() => undefined);
  }
  for (const c of serverConns) c.terminate();
  serverConns.clear();
  await new Promise<void>((r) => wss.close(() => r()));
});

describe('ws transport', () => {
  it('matches responses by echo', async () => {
    const c = track(createClient({ endpoint: `ws://127.0.0.1:${port}` }));
    const data = await c.call<{ nickname: string }>('get_login_info');
    expect(data.nickname).toBe('TestBot');
    await c.close();
  });

  it('throws OneBotError on failure retcode', async () => {
    const c = track(createClient({ endpoint: `ws://127.0.0.1:${port}` }));
    await expect(c.call('missing')).rejects.toMatchObject({ retcode: 1404 });
    await c.close();
  });

  it('times out when no response', async () => {
    const c = track(createClient({ endpoint: `ws://127.0.0.1:${port}`, timeoutMs: 300 }));
    await expect(c.call('slow')).rejects.toThrow(/timeout/i);
    await c.close();
  });

  it('reuses one connection across calls', async () => {
    const c = track(createClient({ endpoint: `ws://127.0.0.1:${port}` }));
    await c.call('get_login_info');
    const first = conn;
    await c.call('get_login_info');
    expect(conn).toBe(first);
    await c.close();
  });

  it('establishes only one connection for concurrent first calls', async () => {
    const c = track(createClient({ endpoint: `ws://127.0.0.1:${port}` }));
    const results = await Promise.all([
      c.call<{ nickname: string }>('get_login_info'),
      c.call<{ nickname: string }>('get_login_info'),
      c.call<{ nickname: string }>('get_login_info'),
    ]);
    expect(results.map((r) => r.nickname)).toEqual(['TestBot', 'TestBot', 'TestBot']);
    expect(connectionCount).toBe(1);
  });

  it('matches each concurrent request to its own echo even when replies come back out of order', async () => {
    const queued: ActionRequest[] = [];
    handler = (req) => {
      queued.push(req);
      if (queued.length === 2) {
        const [first, second] = queued;
        second.send({ status: 'ok', retcode: 0, data: { which: 'second' }, echo: second.echo });
        first.send({ status: 'ok', retcode: 0, data: { which: 'first' }, echo: first.echo });
      }
    };
    const c = track(createClient({ endpoint: `ws://127.0.0.1:${port}` }));
    const [a, b] = await Promise.all([
      c.call<{ which: string }>('action_a'),
      c.call<{ which: string }>('action_b'),
    ]);
    expect(a.which).toBe('first');
    expect(b.which).toBe('second');
    await c.close();
  });

  it('passes the token as access_token query parameter', async () => {
    const c = track(createClient({ endpoint: `ws://127.0.0.1:${port}`, token: 'sekret-token' }));
    await c.call('get_login_info');
    expect(requestUrl).toContain('access_token=sekret-token');
    await c.close();
  });

  it('close() rejects pending requests instead of waiting for the timeout', async () => {
    const c = track(createClient({ endpoint: `ws://127.0.0.1:${port}`, timeoutMs: 30_000 }));
    const pending = c.call('slow');
    const assertion = expect(pending).rejects.toMatchObject({ name: 'OneBotError', retcode: -2 });
    await new Promise((r) => setTimeout(r, 50)); // 等请求发出去
    const started = Date.now();
    await c.close();
    await assertion;
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('close() during handshake rejects the call and leaves no connection behind', async () => {
    const c = track(createClient({ endpoint: `ws://127.0.0.1:${port}` }));
    const pending = c.call('get_login_info');
    const assertion = expect(pending).rejects.toMatchObject({ name: 'OneBotError', retcode: -2 });
    await c.close();
    await assertion;
    await new Promise((r) => setTimeout(r, 100));
    expect(serverConns.size).toBe(0);
  });
});
