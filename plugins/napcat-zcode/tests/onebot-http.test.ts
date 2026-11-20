import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createClient } from '../src/server/onebot/client.js';
import { OneBotError } from '../src/server/onebot/errors.js';

let server: Server;
let port: number;
let lastAuth: string | undefined;
let lastBody: unknown;

beforeEach(async () => {
  server = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    let chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      lastBody = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const action = req.url?.slice(1) ?? '';
      if (action === 'get_login_info') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 2350355494, nickname: 'TestBot' } }));
      } else if (action === 'boom') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'failed', retcode: 1200, data: null, wording: '内部错误' }));
      } else if (action === 'get_group_msg_history') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { messages: [] } }));
      } else {
        res.statusCode = 404;
        res.end('no route');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('http transport', () => {
  it('calls action and returns data', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}`, token: 'sekret' });
    const data = await c.call<{ user_id: number }>('get_login_info');
    expect(data.user_id).toBe(2350355494);
    expect(lastAuth).toBe('Bearer sekret');
    await c.close();
  });

  it('sends params as json body', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    await c.call('get_group_msg_history', { group_id: 123, count: 20 });
    expect(lastBody).toEqual({ group_id: 123, count: 20 });
    expect(lastAuth).toBeUndefined();
    await c.close();
  });

  it('throws OneBotError on non-zero retcode', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    await expect(c.call('boom')).rejects.toMatchObject({ name: 'OneBotError', retcode: 1200 });
    await c.close();
  });

  it('throws OneBotError on http error status', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    await expect(c.call('nope')).rejects.toBeInstanceOf(OneBotError);
    await c.close();
  });
});
