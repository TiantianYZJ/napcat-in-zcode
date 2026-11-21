import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket as WsConn } from 'ws';
import {
  detectLocal,
  normalizeEndpoint,
  probeEndpoint,
  type DetectCandidate,
} from '../src/server/onebot/detect.js';

/**
 * M2 Task 1：本机 NapCat 探测内核。
 *
 * 这里的假 OneBot 服务端都用 `node:http` / `ws` 在 127.0.0.1 上现起，
 * 端口取 0（随机），避免与本机真实 NapCat（3000/6099）撞车。
 */

const FAKE_TOKEN = 'super-secret-token';

interface FakeHttp {
  port: number;
  /** 服务端收到的请求（url + Authorization 头） */
  requests: { url: string; auth?: string }[];
  /** 服务端侧仍存活的 TCP 连接 */
  openSockets: Set<Socket>;
  close(): Promise<void>;
}

type FakeMode = 'ok' | 'unauthorized' | 'auth-body' | 'slow';

interface FakeHttpOptions {
  mode?: FakeMode;
  /** slow 模式下响应延迟多久（默认 5s，远大于探测超时） */
  delayMs?: number;
}

async function startFakeHttp(opts: FakeHttpOptions = {}): Promise<FakeHttp> {
  const mode = opts.mode ?? 'ok';
  const delayMs = opts.delayMs ?? 5000;
  const requests: { url: string; auth?: string }[] = [];
  const openSockets = new Set<Socket>();

  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', auth: req.headers.authorization });
    const action = (req.url ?? '').replace(/^\//, '').split('?')[0];

    const respond = (): void => {
      if (res.writableEnded || res.destroyed) return;
      try {
        if (mode === 'unauthorized') {
          res.statusCode = 401;
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              status: 'failed',
              retcode: 1404,
              data: null,
              wording: `鉴权失败：access_token=${FAKE_TOKEN}`,
            }),
          );
          return;
        }
        if (mode === 'auth-body') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              status: 'failed',
              retcode: 1404,
              data: null,
              wording: `鉴权失败：access_token=${FAKE_TOKEN}`,
            }),
          );
          return;
        }
        if (action === 'get_login_info') {
          res.setHeader('content-type', 'application/json');
          // 显式关闭连接：探测结束后服务端不应还挂着连接（undici 默认会 keep-alive 复用）
          res.setHeader('connection', 'close');
          res.end(
            JSON.stringify({
              status: 'ok',
              retcode: 0,
              data: { user_id: 2350355494, nickname: 'TestBot' },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.setHeader('connection', 'close');
        res.end('no route');
      } catch {
        /* 客户端已断开：忽略写失败 */
      }
    };

    if (mode === 'slow') {
      // 不 unref 会让用例结束后仍挂着定时器；unref 后即使没触发也不阻塞退出
      const timer = setTimeout(respond, delayMs);
      timer.unref?.();
    } else {
      respond();
    }
  });

  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });
  // ws:// 候选会打过来做 WS 握手：没有 upgrade 处理就直接掐掉
  server.on('upgrade', (_req, socket) => {
    socket.destroy();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    requests,
    openSockets,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

interface FakeWs {
  port: number;
  /** 服务端侧仍存活的 WS 连接 */
  conns: Set<WsConn>;
  close(): Promise<void>;
}

async function startFakeWs(): Promise<FakeWs> {
  const conns = new Set<WsConn>();
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.on('listening', r));
  const port = (wss.address() as { port: number }).port;

  wss.on('connection', (conn: WsConn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    conn.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { action: string; echo?: string };
      if (msg.action === 'get_login_info') {
        conn.send(
          JSON.stringify({
            status: 'ok',
            retcode: 0,
            data: { user_id: 2350355494, nickname: 'WsBot' },
            echo: msg.echo,
          }),
        );
        return;
      }
      conn.send(
        JSON.stringify({ status: 'failed', retcode: 1404, data: null, wording: 'not found', echo: msg.echo }),
      );
    });
  });

  return {
    port,
    conns,
    close: async () => {
      for (const conn of conns) conn.terminate();
      conns.clear();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

/** 轮询等待条件成立（带超时），用于等连接回落这类异步收尾。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => undefined);
  }
});

function track<T extends { close(): Promise<void> }>(resource: T): T {
  cleanups.push(() => resource.close());
  return resource;
}

/** 造一个必然连不上的端口（先占用再释放）。 */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe('normalizeEndpoint', () => {
  it('lowercases the scheme and strips the trailing slash', () => {
    expect(normalizeEndpoint('HTTP://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
    expect(normalizeEndpoint('ws://127.0.0.1:3000//')).toBe('ws://127.0.0.1:3000');
  });

  it('normalizes default ports away', () => {
    expect(normalizeEndpoint('http://127.0.0.1:80')).toBe('http://127.0.0.1');
    expect(normalizeEndpoint('https://127.0.0.1:443')).toBe('https://127.0.0.1');
    expect(normalizeEndpoint('ws://127.0.0.1:80')).toBe('ws://127.0.0.1');
  });

  it('drops credentials and query strings (they must never reach the panel or logs)', () => {
    expect(normalizeEndpoint('http://user:pass@127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(normalizeEndpoint(`http://127.0.0.1:3000/?access_token=${FAKE_TOKEN}`)).toBe(
      'http://127.0.0.1:3000',
    );
  });

  it('rejects unusable endpoints instead of throwing', () => {
    expect(normalizeEndpoint('')).toBeUndefined();
    expect(normalizeEndpoint('   ')).toBeUndefined();
    expect(normalizeEndpoint('127.0.0.1:3000')).toBeUndefined();
    expect(normalizeEndpoint('ftp://127.0.0.1:3000')).toBeUndefined();
  });
});

describe('probeEndpoint', () => {
  it('returns the login info of a reachable OneBot endpoint', async () => {
    const fake = track(await startFakeHttp());
    const result = await probeEndpoint(
      { endpoint: `http://127.0.0.1:${fake.port}`, transport: 'http', source: 'port' },
      800,
    );
    expect(result.ok).toBe(true);
    expect(result.login).toEqual({ user_id: '2350355494', nickname: 'TestBot' });
    expect(result.error).toBeUndefined();
  });

  it('does not send a token by default', async () => {
    const fake = track(await startFakeHttp());
    await probeEndpoint({ endpoint: `http://127.0.0.1:${fake.port}`, transport: 'http', source: 'port' }, 800);
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const req of fake.requests) expect(req.auth).toBeUndefined();
  });

  it('marks an auth failure as needsToken and never leaks the token', async () => {
    const fake = track(await startFakeHttp({ mode: 'unauthorized' }));
    const result = await probeEndpoint(
      { endpoint: `http://127.0.0.1:${fake.port}`, transport: 'http', source: 'port' },
      800,
    );
    expect(result.ok).toBe(false);
    expect(result.needsToken).toBe(true);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toContain(FAKE_TOKEN);
  });

  it('redacts a token echoed back by the server', async () => {
    const fake = track(await startFakeHttp({ mode: 'auth-body' }));
    const result = await probeEndpoint(
      { endpoint: `http://127.0.0.1:${fake.port}`, transport: 'http', source: 'port' },
      800,
    );
    expect(result.ok).toBe(false);
    expect(result.needsToken).toBe(true);
    expect(result.error).not.toContain(FAKE_TOKEN);
    expect(result.error).toContain('***');
  });

  it('reports a failure instead of throwing when the endpoint is unreachable', async () => {
    const port = await deadPort();
    const result = await probeEndpoint(
      { endpoint: `http://127.0.0.1:${port}`, transport: 'http', source: 'port' },
      800,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.needsToken).toBeFalsy();
  });

  it('closes the websocket connection when the probe finishes', async () => {
    const fake = track(await startFakeWs());
    const result = await probeEndpoint(
      { endpoint: `ws://127.0.0.1:${fake.port}`, transport: 'ws', source: 'port' },
      800,
    );
    expect(result.ok).toBe(true);
    expect(result.login?.nickname).toBe('WsBot');
    expect(await waitFor(() => fake.conns.size === 0, 2000)).toBe(true);
    expect(fake.conns.size).toBe(0);
  });
});

describe('detectLocal', () => {
  it('finds a local OneBot endpoint and reports the login nickname', async () => {
    const fake = track(await startFakeHttp());
    const result = await detectLocal({ ports: [fake.port], extraEndpoints: [], timeoutMs: 800 });
    expect(result.found).toBe(true);
    expect(result.live).toHaveLength(1);
    expect(result.live[0].endpoint).toBe(`http://127.0.0.1:${fake.port}`);
    expect(result.live[0].login).toEqual({ user_id: '2350355494', nickname: 'TestBot' });
    expect(result.live[0].source).toBe('port');
  });

  it('finds a local OneBot websocket endpoint', async () => {
    const fake = track(await startFakeWs());
    const result = await detectLocal({ ports: [fake.port], extraEndpoints: [], timeoutMs: 800 });
    expect(result.found).toBe(true);
    expect(result.live[0].transport).toBe('ws');
    expect(result.live[0].endpoint).toBe(`ws://127.0.0.1:${fake.port}`);
  });

  it('resolves with found:false for a port nobody listens on', async () => {
    const port = await deadPort();
    const result = await detectLocal({ ports: [port], extraEndpoints: [], timeoutMs: 500 });
    expect(result.found).toBe(false);
    expect(result.live).toHaveLength(0);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('never throws on garbage input', async () => {
    const result = await detectLocal({
      ports: [0, 70000, -1],
      extraEndpoints: ['', 'not a url', 'ftp://127.0.0.1:3000'],
      timeoutMs: 300,
    });
    expect(result.found).toBe(false);
    expect(result.live).toHaveLength(0);
  });

  it('probes the same endpoint only once even when it is written differently', async () => {
    const fake = track(await startFakeHttp());
    const result = await detectLocal({
      ports: [fake.port],
      extraEndpoints: [`http://127.0.0.1:${fake.port}/`, `HTTP://127.0.0.1:${fake.port}`],
      timeoutMs: 800,
    });
    const loginCalls = fake.requests.filter((r) => r.url.startsWith('/get_login_info'));
    expect(loginCalls).toHaveLength(1);
    const sameEndpoint = result.candidates.filter((c) => c.endpoint === `http://127.0.0.1:${fake.port}`);
    expect(sameEndpoint).toHaveLength(1);
    expect(sameEndpoint[0].transport).toBe('http');
    // 先到先得：用户显式配置的候选优先
    expect(sameEndpoint[0].source).toBe('config');
  });

  it('drops the connection after the probe', async () => {
    const fake = track(await startFakeHttp());
    await detectLocal({ ports: [fake.port], extraEndpoints: [], timeoutMs: 800 });
    expect(await waitFor(() => fake.openSockets.size === 0, 2000)).toBe(true);
    expect(fake.openSockets.size).toBe(0);
  });

  it('stays inside the time budget when an endpoint answers slowly', async () => {
    const fake = track(await startFakeHttp({ mode: 'slow', delayMs: 5000 }));
    const started = Date.now();
    const result = await detectLocal({
      ports: [fake.port],
      extraEndpoints: [],
      timeoutMs: 300,
      budgetMs: 1000,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2500);
    expect(result.found).toBe(false);
  });

  it('reports an endpoint that needs a token separately from the live ones', async () => {
    const fake = track(await startFakeHttp({ mode: 'unauthorized' }));
    const result = await detectLocal({ ports: [fake.port], extraEndpoints: [], timeoutMs: 800 });
    expect(result.found).toBe(false);
    expect(result.live).toHaveLength(0);
    expect(result.tokenRequired.map((c) => c.endpoint)).toContain(`http://127.0.0.1:${fake.port}`);
    expect(result.tokenRequired[0].needsToken).toBe(true);
  });

  it('detects the NapCat webui by any http response', async () => {
    const fake = track(await startFakeHttp());
    const result = await detectLocal({
      ports: [],
      extraEndpoints: [],
      timeoutMs: 800,
      webuiPort: fake.port,
    });
    expect(result.napcatRunning).toBe(true);
    expect(result.webuiPort).toBe(fake.port);
    // 6099 也是一个 OneBot 候选：真的试过才能区分「NapCat 在跑但没开 OneBot Server」
    expect(result.candidates.map((c) => c.endpoint)).toContain(`http://127.0.0.1:${fake.port}`);
  });

  it('treats a 401 from the webui as "napcat is running"', async () => {
    const fake = track(await startFakeHttp({ mode: 'unauthorized' }));
    const result = await detectLocal({
      ports: [],
      extraEndpoints: [],
      timeoutMs: 800,
      webuiPort: fake.port,
    });
    expect(result.napcatRunning).toBe(true);
  });

  it('reports napcatRunning:false when nothing answers on the webui port', async () => {
    const port = await deadPort();
    const result = await detectLocal({ ports: [], extraEndpoints: [], timeoutMs: 500, webuiPort: port });
    expect(result.napcatRunning).toBe(false);
    expect(result.webuiPort).toBeUndefined();
  });

  it('skips install candidates that are not on the loopback interface', async () => {
    const candidates: DetectCandidate[] = [
      { endpoint: 'http://192.0.2.1:3000', transport: 'http', source: 'install' },
    ];
    const result = await detectLocal({
      ports: [],
      extraEndpoints: [],
      timeoutMs: 300,
      installCandidates: candidates,
    });
    expect(result.candidates.map((c) => c.endpoint)).not.toContain('http://192.0.2.1:3000');
  });

  it('keeps an explicitly configured non-loopback endpoint', async () => {
    const result = await detectLocal({
      ports: [],
      // 192.0.2.0/24 是 RFC 5737 的文档保留段，不会打到真实主机
      extraEndpoints: ['http://192.0.2.1:3000'],
      timeoutMs: 300,
    });
    expect(result.candidates.map((c) => c.endpoint)).toContain('http://192.0.2.1:3000');
    expect(result.scanned.extraEndpoints).toBe(1);
  });
});
