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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
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
    /**
     * M2 Task 5：`napcat_configure` **加法式**增加了可选参数 `paths`
     * （本机 NapCat 扫描根，绝对路径；不传 = 不改）。
     *
     * 这条断言锁的是「schema 的**全部**入参名」——加一个可选参数必然让它多一项，
     * 所以这里同步加 `paths`（断言的严格性不变：仍是**精确集合**比对，
     * 不是 `arrayContaining` 那种放宽）。
     * 既有参数一个没少、一个没改名。
     */
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'clearToken',
      'endpoint',
      'paths',
      'token',
    ]);
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

  // 微修轮 M3：超时后必须**显式复位**连接状态。
  // 老版 undici（Node 18/20）在 CONNECTING 态 close() 可能抛 InvalidStateError 而不触发
  // error 事件 → 复位就落空 → this.connecting 停在已 reject 的 promise 上 →
  // 后续调用会「立即」以超时失败，而不是重新建连。
  //
  // 这里用一个**假 WebSocket** 精确模拟老版行为（close() 不触发 error/close 事件），
  // 让断言不依赖宿主 Node 的 undici 版本（新版本会自愈，测不出差异）。
  it('握手超时后显式复位连接状态（老版 undici：close() 不触发 error 事件）', async () => {
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = FakeWebSocket.CONNECTING;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      constructor(public url: string | URL) {
        FakeWebSocket.instances.push(this);
      }
      /** 老版 undici 的关键行为：握手中 close() **不**触发 error / close 事件 */
      close(): void {
        this.readyState = FakeWebSocket.CLOSED;
      }
      send(): void {
        throw new Error('websocket is not open');
      }
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    FakeWebSocket.instances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    try {
      const c = createClient({ endpoint: 'ws://127.0.0.1:9/onebot', timeoutMs: 200 });
      await expect(c.call('get_login_info')).rejects.toThrow(/websocket connect timeout/);
      // 超时后：连接状态必须已被显式复位（否则后续调用会立刻失败而不重连）
      const internals = c as unknown as { connecting?: Promise<void>; socket?: unknown };
      expect(internals.connecting).toBeUndefined();
      expect(internals.socket).toBeUndefined();
      // 第二次调用 → 重新建连（新的 socket 实例）
      await expect(c.call('get_login_info')).rejects.toThrow(/websocket connect timeout/);
      expect(FakeWebSocket.instances.length).toBe(2);
      await c.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('握手超时后再次调用会重新建连（而不是立刻以超时失败）', async () => {
    const wss = new WebSocketServer({ noServer: true });
    const http = createHttpServer();
    /** 升级前的裸 socket（第一次那个永远不完成握手，必须手动 destroy，否则 http.close() 等不到） */
    const rawSockets = new Set<{ destroy(): void }>();
    let accepts = 0;
    http.on('upgrade', (req, socket, head) => {
      accepts += 1;
      rawSockets.add(socket);
      socket.on('close', () => rawSockets.delete(socket));
      socket.on('error', () => undefined);
      if (accepts === 1) {
        // 第一次：故意**不**完成握手 → 客户端的握手超时到期
        return;
      }
      wss.handleUpgrade(req, socket, head, (conn) => {
        conn.on('message', (raw) => {
          const msg = JSON.parse(String(raw)) as { action: string; echo: string };
          conn.send(
            JSON.stringify({
              status: 'ok',
              retcode: 0,
              data: { user_id: 1, nickname: 'TestBot' },
              echo: msg.echo,
            }),
          );
        });
      });
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    const p2 = (http.address() as { port: number }).port;
    try {
      const c = createClient({ endpoint: `ws://127.0.0.1:${p2}`, timeoutMs: 300 });
      await expect(c.call('get_login_info')).rejects.toThrow(/websocket connect timeout/);
      /**
       * 白盒断言：超时后连接状态必须**已被显式复位**。
       *
       * 老版 undici（Node 18/20）在 CONNECTING 态 close() 可能抛 InvalidStateError 而不触发
       * error 事件 → 复位就落空 → this.connecting 停在已 reject 的 promise 上 →
       * 后续调用会「立即」以超时失败，而不是重新建连。
       *
       * 这条断言在所有 Node 版本上都能咬住（不依赖 undici 的具体行为）；
       * 下面那条「第二次调用成功」则是行为层的验证（在新版 Node 上不依赖复位也能通过，
       * 因为 close() 会触发 onerror → onclose 自愈）。
       */
      const internals = c as unknown as { connecting?: Promise<void>; socket?: unknown };
      expect(internals.connecting).toBeUndefined();
      expect(internals.socket).toBeUndefined();
      // 第二次调用：重新建连 → 这次握手能完成 → 调用成功
      const data = await c.call<{ nickname: string }>('get_login_info');
      expect(data.nickname).toBe('TestBot');
      expect(accepts).toBeGreaterThanOrEqual(2);
      await c.close();
    } finally {
      wss.close();
      for (const s of rawSockets) s.destroy();
      rawSockets.clear();
      await new Promise<void>((r) => http.close(() => r()));
    }
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
