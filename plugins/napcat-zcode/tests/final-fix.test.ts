/**
 * 最终修复波的服务端用例（MF-2 / MF-4 / MF-5 + should-fix #1 / #2 / #4 / #5）。
 *
 * 每个用例都对应最终评审里的一条承重结论：
 * - MF-2：空 token **不再**擦除已保存的凭据（清除要走显式 clearToken）。
 * - MF-4：导出文件 0600 / 导出目录 0700（与含 token 的 config.json 同口径）。
 * - MF-5：非回环端点 + 没有 token ⇒ 明确警告（spec §5.2 / §9 的安全承诺）。
 * - should-fix #1：HTTP 401/403 的文案要说清是 token 问题。
 * - should-fix #2：WS 握手有超时（服务端不完成握手时不能挂死）。
 * - should-fix #4：`napcat_status` 每次都重读配置（外部改过 config.json 要看得见）。
 * - should-fix #5：`Message.seq` 只承载 `message_seq`（不与 message_id 混用编号空间）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppState, closeConnection } from '../src/server/state.js';
import { registerTools } from '../src/server/tools.js';
import { createClient, type OneBotClient } from '../src/server/onebot/client.js';
import { normalizeMessage } from '../src/server/model/message.js';
import { exportSelection } from '../src/server/export/export.js';
import type { ChatRef, Message } from '../src/server/model/types.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'napcat-final-'));
  // 配置目录指向临时目录：绝不碰开发者本机的配置
  process.env.ZCODE_PLUGIN_DATA = tmp;
});

afterEach(() => {
  delete process.env.ZCODE_PLUGIN_DATA;
  rmSync(tmp, { recursive: true, force: true });
});

/** OneBot 客户端替身。 */
function stubClient(handler: (action: string, params?: object) => unknown): OneBotClient {
  return {
    async call<T>(action: string, params?: object): Promise<T> {
      return (await handler(action, params)) as unknown as T;
    },
    async close() {},
  };
}

function loginClient(): OneBotClient {
  return stubClient((action) => {
    if (action === 'get_login_info') return { user_id: 1, nickname: 'TestBot' };
    return null;
  });
}

async function makeClient(client: OneBotClient = loginClient()): Promise<{ c: Client; state: AppState }> {
  const server = new McpServer({ name: 'napcat', version: '0.1.0' });
  const state = new AppState();
  state.clientOverride = client;
  registerTools(server, state);
  const c = new Client({ name: 'test', version: '0.0.1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await c.connect(ct);
  return { c, state };
}

function payload(r: unknown): any {
  const content = (r as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content[0]?.text ?? '');
}

function isError(r: unknown): boolean {
  return (r as { isError?: boolean }).isError === true;
}

function diskConfig(): { connection?: { endpoint?: string; token?: string } } {
  return JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf-8'));
}

describe('MF-2：空 token 不擦除已保存的凭据', () => {
  it('已有 token → configure 不带 token → 磁盘上的 token 不变', async () => {
    const { c } = await makeClient();
    await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', token: 'keep-me' },
    });
    expect(diskConfig().connection?.token).toBe('keep-me');

    // 只换端点、不带 token（面板「重新配置端点」表单就是这个形状）
    const r = await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3100' },
    });
    expect(isError(r)).toBe(false);
    expect(diskConfig().connection?.endpoint).toBe('http://127.0.0.1:3100');
    expect(diskConfig().connection?.token).toBe('keep-me'); // ← 关键：没被擦掉
  });

  it('已有 token → configure 带 clearToken:true → token 被清空', async () => {
    const { c } = await makeClient();
    await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', token: 'keep-me' },
    });
    const r = await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', clearToken: true },
    });
    expect(isError(r)).toBe(false);
    expect(diskConfig().connection?.token).toBe('');
  });

  it('configure 带新 token → 覆盖旧值', async () => {
    const { c } = await makeClient();
    await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', token: 'old' },
    });
    await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', token: 'new' },
    });
    expect(diskConfig().connection?.token).toBe('new');
  });

  it('入参 schema 暴露 clearToken（agent 才知道怎么清除）', async () => {
    const { c } = await makeClient();
    const list = await c.listTools();
    const schema = list.tools.find((t) => t.name === 'napcat_configure')?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['clearToken', 'endpoint', 'token']);
  });
});

describe('MF-5：非回环端点 + 没有 token ⇒ 明确警告', () => {
  it('非回环端点且没有 token → configure 的返回里带 warning', async () => {
    const { c } = await makeClient();
    const r = await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://192.168.1.10:3000' },
    });
    const p = payload(r);
    expect(isError(r)).toBe(false);
    expect(typeof p.warning).toBe('string');
    expect(p.warning).toContain('token');
    expect(p.warning).toContain('192.168.1.10:3000');
  });

  it('回环端点且没有 token → 没有 warning', async () => {
    const { c } = await makeClient();
    const r = await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000' },
    });
    expect(payload(r).warning).toBeUndefined();
  });

  it('非回环端点但有 token → 没有 warning', async () => {
    const { c } = await makeClient();
    const r = await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://192.168.1.10:3000', token: 't' },
    });
    expect(payload(r).warning).toBeUndefined();
  });

  it('0.0.0.0（监听所有网卡）算非回环 → 有警告', async () => {
    const { c } = await makeClient();
    const r = await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://0.0.0.0:3000' },
    });
    expect(typeof payload(r).warning).toBe('string');
  });

  it('status 也带上同一判定结果', async () => {
    writeFileSync(
      join(tmp, 'config.json'),
      JSON.stringify({ connection: { endpoint: 'http://192.168.1.10:3000', token: '' } }),
    );
    const { c } = await makeClient();
    const r = await c.callTool({ name: 'napcat_status', arguments: {} });
    expect(typeof payload(r).warning).toBe('string');
  });
});

describe('should-fix #4：status 每次都重读配置', () => {
  it('state 建好之后改的 config.json，status 能看见', async () => {
    const { c, state } = await makeClient();
    // 建 state 时还没有配置文件
    expect(state.config.connection.endpoint).toBe('');
    writeFileSync(
      join(tmp, 'config.json'),
      JSON.stringify({ connection: { endpoint: 'http://192.168.1.10:3000', token: '' } }),
    );
    const r = await c.callTool({ name: 'napcat_status', arguments: {} });
    const p = payload(r);
    expect(p.configured).toBe(true); // 不刷新的话这里会是 false
    expect(typeof p.warning).toBe('string');
  });
});

describe('MF-4：导出文件与目录的权限', () => {
  const CHAT: ChatRef = { kind: 'group', id: '1', name: '产品群' };
  const MSG: Message = {
    id: '1',
    seq: 1,
    time: 1700000000,
    senderId: '2',
    senderName: 'Alice',
    segments: [{ kind: 'text', text: '你好' }],
    text: '你好',
  };

  it.skipIf(process.platform === 'win32')('导出文件是 0600、导出目录是 0700', async () => {
    const home = join(tmp, 'home');
    mkdirSync(home, { recursive: true });
    const r = await exportSelection({ messages: [MSG], chat: CHAT, dir: 'user', homeDir: home });
    expect(statSync(r.mdPath).mode & 0o777).toBe(0o600);
    expect(statSync(r.jsonPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.zcode', 'napcat', 'exports')).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')('覆盖导出时权限也会被收紧', async () => {
    const home = join(tmp, 'home');
    mkdirSync(home, { recursive: true });
    const first = await exportSelection({ messages: [MSG], chat: CHAT, dir: 'user', homeDir: home });
    // 模拟被别的东西放宽过权限
    const { chmodSync } = await import('node:fs');
    chmodSync(first.mdPath, 0o644);
    chmodSync(first.jsonPath, 0o644);
    await exportSelection({ messages: [MSG], chat: CHAT, dir: 'user', homeDir: home });
    expect(statSync(first.mdPath).mode & 0o777).toBe(0o600);
    expect(statSync(first.jsonPath).mode & 0o777).toBe(0o600);
  });
});

describe('should-fix #1：HTTP 401/403 的文案要说清是 token 问题', () => {
  let server: HttpServer;
  let port: number;

  beforeEach(async () => {
    server = createHttpServer((req, res) => {
      res.statusCode = 401;
      res.end('unauthorized');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('401 → 错误里明说是 token 校验失败', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}`, token: 'wrong' });
    await expect(c.call('get_login_info')).rejects.toThrow(/token 校验失败/);
    await c.close();
  });
});

describe('should-fix #2：WS 握手有超时', () => {
  let server: NetServer;
  let port: number;
  /** 服务端侧还开着的连接（清理时要主动 destroy，否则 server.close() 会一直等） */
  const sockets = new Set<Socket>();

  beforeEach(async () => {
    sockets.clear();
    // 只接受 TCP 连接、**不**完成 WS 握手 → 客户端会一直等 onopen
    server = createNetServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('服务端不完成握手时，调用会超时失败而不是挂死', async () => {
    const c = createClient({ endpoint: `ws://127.0.0.1:${port}`, timeoutMs: 300 });
    await expect(c.call('get_login_info')).rejects.toThrow(/websocket connect timeout/);
    await c.close();
  });
});

describe('should-fix #5：Message.seq 只承载 message_seq', () => {
  it('没有 message_seq 时 seq 是 0（不与 message_id 混编号空间）', () => {
    const m = normalizeMessage({ message_id: 9, time: 1, message: [] });
    expect(m.seq).toBe(0);
    expect(m.id).toBe('9');
  });

  it('有 message_seq 时 seq 就是它', () => {
    const m = normalizeMessage({ message_id: 9, message_seq: 42, time: 1, message: [] });
    expect(m.seq).toBe(42);
  });
});

describe('should-fix #3：关闭连接', () => {
  it('closeConnection 会关掉当前 OneBot 客户端', async () => {
    let closed = false;
    const state = new AppState();
    state.client = {
      async call<T>(): Promise<T> {
        return null as unknown as T;
      },
      async close() {
        closed = true;
      },
    };
    await closeConnection(state);
    expect(closed).toBe(true);
  });

  it('没有客户端时不报错', async () => {
    const state = new AppState();
    await expect(closeConnection(state)).resolves.toBeUndefined();
  });
});

describe('回归：导出产物落盘', () => {
  it('导出目录被创建且文件存在', async () => {
    const home = join(tmp, 'home');
    mkdirSync(home, { recursive: true });
    const r = await exportSelection({
      messages: [
        { id: '1', seq: 1, time: 1700000000, senderId: '2', senderName: 'A', segments: [], text: 'x' },
      ],
      chat: { kind: 'group', id: '1', name: '群' },
      dir: 'user',
      homeDir: home,
    });
    expect(existsSync(r.mdPath)).toBe(true);
    expect(existsSync(r.jsonPath)).toBe(true);
  });
});
