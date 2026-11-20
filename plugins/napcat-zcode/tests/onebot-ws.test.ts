import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsConn } from 'ws';
import { createClient } from '../src/server/onebot/client.js';
import type { IncomingMessage } from 'node:http';

let wss: WebSocketServer;
let port: number;
let conn: WsConn | undefined;

beforeEach(async () => {
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.on('listening', r));
  port = (wss.address() as { port: number }).port;
  wss.on('connection', (c: WsConn) => {
    conn = c;
    c.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.action === 'get_login_info') {
        c.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 2350355494, nickname: 'TestBot' }, echo: msg.echo }));
      } else if (msg.action === 'slow') {
        // 不响应，触发超时
      } else {
        c.send(JSON.stringify({ status: 'failed', retcode: 1404, data: null, wording: 'not found', echo: msg.echo }));
      }
    });
  });
});

afterEach(async () => {
  await new Promise<void>((r) => wss.close(() => r()));
});

describe('ws transport', () => {
  it('matches responses by echo', async () => {
    const c = createClient({ endpoint: `ws://127.0.0.1:${port}` });
    const data = await c.call<{ nickname: string }>('get_login_info');
    expect(data.nickname).toBe('TestBot');
    await c.close();
  });

  it('throws OneBotError on failure retcode', async () => {
    const c = createClient({ endpoint: `ws://127.0.0.1:${port}` });
    await expect(c.call('missing')).rejects.toMatchObject({ retcode: 1404 });
    await c.close();
  });

  it('times out when no response', async () => {
    const c = createClient({ endpoint: `ws://127.0.0.1:${port}`, timeoutMs: 300 });
    await expect(c.call('slow')).rejects.toThrow(/timeout/i);
    await c.close();
  });

  it('reuses one connection across calls', async () => {
    const c = createClient({ endpoint: `ws://127.0.0.1:${port}` });
    await c.call('get_login_info');
    const first = conn;
    await c.call('get_login_info');
    expect(conn).toBe(first);
    await c.close();
  });
});
