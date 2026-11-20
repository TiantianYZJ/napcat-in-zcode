import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppState } from '../src/server/state.js';
import { registerTools } from '../src/server/tools.js';
import { registerPanelResource } from '../src/server/uiresource.js';
import { createClient, type OneBotClient } from '../src/server/onebot/client.js';
import type { OB11Message } from '../src/server/onebot/types.js';

/**
 * 造一个 OneBot 客户端替身：`handler` 按 action 返回数据。
 *
 * `OneBotClient.call` 是泛型方法，实现里必须自己把返回值断言成 `T`。
 */
function stubClient(handler: (action: string, params?: object) => unknown): OneBotClient {
  return {
    async call<T>(action: string, params?: object): Promise<T> {
      return (await handler(action, params)) as unknown as T;
    },
    async close() {},
  };
}

function fakeClient(): OneBotClient {
  // NapCat 返回页内消息按时间正序（seq 1 最旧）；省略 message_seq 返回最新一页
  const msgs: OB11Message[] = Array.from({ length: 5 }, (_, i) => ({
    message_seq: i + 1, time: 1700000000 + i, sender: { user_id: 1, nickname: `u${i + 1}` },
    message: [{ type: 'text', data: { text: `m${i + 1}` } }],
  }));
  return stubClient((action, params) => {
    if (action === 'get_login_info') return { user_id: 2350355494, nickname: 'TestBot' };
    if (action === 'get_group_list') return [{ group_id: 123, group_name: '产品群' }];
    if (action === 'get_friend_list') return [{ user_id: 9, nickname: '张三' }];
    if (action === 'get_group_msg_history') {
      const p = params as { message_seq?: string };
      if (!p.message_seq) return { messages: msgs };
      return { messages: [] };
    }
    throw new Error(`unexpected ${action}`);
  });
}

async function makeClient() {
  const server = new McpServer({ name: 'napcat', version: '0.1.0' });
  const state = new AppState();
  state.clientOverride = fakeClient();
  registerTools(server, state);
  const client = new Client({ name: 'test', version: '0.0.1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return client;
}

/** 起一个只注册了工具的 server，调用 `napcat_configure` 并返回结果与 state。 */
async function configureEndpoint(endpoint: string, token = 'tok') {
  const server = new McpServer({ name: 'napcat', version: '0.1.0' });
  const state = new AppState();
  registerTools(server, state);
  const client = new Client({ name: 'test', version: '0.0.1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const r = await client.callTool({ name: 'napcat_configure', arguments: { endpoint, token } });
  return { r, state };
}

/** 工具返回体：成功时是 JSON 文本，出错时带 isError。 */
function toolText(r: unknown): string {
  const content = (r as { content: Array<{ type: string; text?: string }> }).content;
  expect(content[0]?.type).toBe('text');
  return content[0]?.text ?? '';
}
function payload(r: unknown): Record<string, any> {
  return JSON.parse(toolText(r));
}
function isError(r: unknown): boolean {
  return (r as { isError?: boolean }).isError === true;
}

// AppState 在构造时读插件数据目录（dataDir()），测试里统一指向临时目录，避免读到开发者本机的配置。
let tmp: string;
const ENV_KEYS = ['ZCODE_PLUGIN_DATA', 'NAPCAT_EXPORT_DIR', 'NAPCAT_INCLUDE_IMAGES'] as const;
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'napcat-mcp-'));
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ZCODE_PLUGIN_DATA = tmp;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('mcp tools', () => {
  it('napcat_status reports connected with login', async () => {
    const c = await makeClient();
    const r = await c.callTool({ name: 'napcat_status', arguments: {} });
    const payload = JSON.parse((r.content as [{ type: string; text: string }])[0].text);
    expect(payload.connected).toBe(true);
    expect(payload.login.nickname).toBe('TestBot');
  });

  it('napcat_list_chats returns groups', async () => {
    const c = await makeClient();
    const r = await c.callTool({ name: 'napcat_list_chats', arguments: { kind: 'group' } });
    const payload = JSON.parse((r.content as [{ type: string; text: string }])[0].text);
    expect(payload.chats[0]).toMatchObject({ id: '123', name: '产品群' });
  });

  it('napcat_get_history normalizes messages and exposes cursor', async () => {
    const c = await makeClient();
    const r = await c.callTool({ name: 'napcat_get_history', arguments: { chatKind: 'group', chatId: '123', count: 3 } });
    const payload = JSON.parse((r.content as [{ type: string; text: string }])[0].text);
    expect(payload.messages).toHaveLength(3);
    // 取窗「最新优先」：页内按 seq 降序挑 count 条，输出再按 seq 升序
    expect(payload.messages[0]).toMatchObject({ seq: 3, senderName: 'u3', text: 'm3' });
    expect(payload.messages[2]).toMatchObject({ seq: 5, senderName: 'u5', text: 'm5' });
    expect(payload.nextBeforeSeq).toBe(3); // 窗口内最小 seq，作为向更早翻页的游标
  });

  it('napcat_status reports unconfigured without endpoint', async () => {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    state.config.connection.endpoint = '';
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const r = await client.callTool({ name: 'napcat_status', arguments: {} });
    const payload = JSON.parse((r.content as [{ type: string; text: string }])[0].text);
    expect(payload.configured).toBe(false);
    expect(payload.connected).toBe(false);
  });
});

describe('mcp tool registration', () => {
  it('registers the four T9 tools with their descriptions', async () => {
    const c = await makeClient();
    const list = await c.listTools();
    // T10 追加了 search / format_selection / export / get_config 四个工具（见 tests/mcp-tools-extra.test.ts）
    expect(list.tools.map((t) => t.name).sort()).toEqual([
      'napcat_configure',
      'napcat_export',
      'napcat_format_selection',
      'napcat_get_config',
      'napcat_get_history',
      'napcat_list_chats',
      'napcat_search_messages',
      'napcat_status',
    ]);
    const byName = new Map(list.tools.map((t) => [t.name, t]));
    // description 里写明「连接失败返回 {connected:false, error} 且 isError 为 false」，避免下游当工具错误处理
    expect(byName.get('napcat_status')?.description).toContain('NapCat 连接状态与登录信息');
    expect(byName.get('napcat_status')?.description).toContain('isError 为 false');
    expect(byName.get('napcat_configure')?.description).toBe('配置 OneBot 端点（地址与 token），保存后重连');
    expect(byName.get('napcat_list_chats')?.description).toBe('列出群或好友');
    expect(byName.get('napcat_get_history')?.description).toBe('拉取会话历史消息（游标分页，时间正序返回）');
    // 入参 schema 形状固定（T10/T12 依赖）
    expect(byName.get('napcat_status')?.inputSchema).toMatchObject({ type: 'object' });
    const history = byName.get('napcat_get_history')?.inputSchema as { properties?: Record<string, unknown> };
    expect(Object.keys(history.properties ?? {}).sort()).toEqual(['beforeSeq', 'chatId', 'chatKind', 'count', 'since', 'until']);
  });
});

describe('napcat_configure', () => {
  it('saves the endpoint and returns the login info', async () => {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    state.clientOverride = fakeClient();
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const r = await client.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', token: 'tok-123' },
    });
    expect(isError(r)).toBe(false);
    const p = payload(r);
    expect(p).toMatchObject({ configured: true, connected: true });
    expect(p.login.nickname).toBe('TestBot');

    const onDisk = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf-8')) as {
      connection?: { endpoint?: string; token?: string };
    };
    expect(onDisk.connection?.endpoint).toBe('http://127.0.0.1:3000');
    expect(onDisk.connection?.token).toBe('tok-123');
  });

  it('never echoes the token back', async () => {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    state.clientOverride = fakeClient();
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const r = await client.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', token: 'super-secret-token' },
    });
    expect(toolText(r)).not.toContain('super-secret-token');

    const s = await client.callTool({ name: 'napcat_status', arguments: {} });
    expect(toolText(s)).not.toContain('super-secret-token');
  });

  it('writes only the changed connection fields, never the env fallback values', async () => {
    // 文件里已有的内容必须原样保留；env 兜底值不能被固化进文件。
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ export: { dir: 'user' }, custom: { keep: 1 } }));
    process.env.NAPCAT_EXPORT_DIR = 'workspace'; // env 优先 → 内存里是 workspace

    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    state.clientOverride = fakeClient();
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const r = await client.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://127.0.0.1:3000', token: 'tok' },
    });
    expect(isError(r)).toBe(false);

    const onDisk = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf-8')) as Record<string, unknown>;
    expect((onDisk.connection as { endpoint: string }).endpoint).toBe('http://127.0.0.1:3000');
    expect(onDisk.custom).toEqual({ keep: 1 }); // 无关字段原样保留
    expect((onDisk.export as { dir: string }).dir).toBe('user'); // env 的 workspace 没被固化进文件
    expect(Object.keys(onDisk).sort()).toEqual(['connection', 'custom', 'export']); // patch 式：没新增整段
  });

  it('reports an error instead of throwing when the endpoint is unusable', async () => {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const r = await client.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'ftp://127.0.0.1:3000', token: 'tok' },
    });
    expect(isError(r)).toBe(true);
    const p = payload(r);
    expect(typeof p.error).toBe('string');
    expect(p.error.length).toBeGreaterThan(0);
  });

  it('does not write an unusable endpoint into the config file', async () => {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const r = await client.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'ftp://127.0.0.1:3000', token: 'tok' },
    });
    expect(isError(r)).toBe(true);
    // 端点没校验过就不许落盘：否则插件会被一个写错的地址卡在不可用状态
    expect(existsSync(join(tmp, 'config.json'))).toBe(false);
    expect(state.config.connection.endpoint).toBe(''); // 内存态也没被改
  });

  it('keeps the previous endpoint when the new one is unusable', async () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ connection: { endpoint: 'http://127.0.0.1:3000', token: 'old' } }));
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const r = await client.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'ftp://127.0.0.1:3000', token: 'new' },
    });
    expect(isError(r)).toBe(true);
    const onDisk = JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf-8')) as {
      connection?: { endpoint?: string; token?: string };
    };
    expect(onDisk.connection?.endpoint).toBe('http://127.0.0.1:3000'); // 旧配置原样保留
    expect(onDisk.connection?.token).toBe('old');
  });

  // scheme 合法、但 URL 形状非法：光靠 scheme 白名单挡不住，必须再做一层 URL 解析
  it.each([
    ['http://', '空主机'],
    ['http://host:99999', '端口越界'],
    ['http://host:0', '端口为 0'],
    ['ws://', 'ws 空主机'],
  ])('rejects the malformed endpoint %s (%s)', async (endpoint) => {
    const { r, state } = await configureEndpoint(endpoint);
    expect(isError(r)).toBe(true);
    expect(payload(r).error).toContain('端点');
    expect(existsSync(join(tmp, 'config.json'))).toBe(false); // 没有落盘
    expect(state.config.connection.endpoint).toBe(''); // 内存态也没被改
  });

  it('keeps the token out of the endpoint validation error', async () => {
    // 端点里可能带 access_token（ws 约定）或 user:pass ——报错时不能原样回显
    const { r } = await configureEndpoint('http://[bad?access_token=super-secret-token');
    expect(isError(r)).toBe(true);
    expect(toolText(r)).not.toContain('super-secret-token');
    expect(payload(r).error).toContain('http://[bad'); // 只回显去掉 query / userinfo 的部分
  });
});

describe('napcat_status error handling', () => {
  it('reports not connected when get_login_info fails', async () => {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    state.clientOverride = stubClient(() => null); // get_login_info 返回 null → 前序任务会抛 OneBotError
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const r = await client.callTool({ name: 'napcat_status', arguments: {} });
    expect(isError(r)).toBe(false); // 状态查询失败也是「状态」，不是工具错误
    const p = payload(r);
    expect(p.connected).toBe(false);
    expect(p.configured).toBe(true);
    expect(typeof p.error).toBe('string');
  });

  it('redacts the token from error messages', async () => {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    state.config.connection.token = 'super-secret-token';
    state.clientOverride = stubClient(() => {
      throw new Error('upstream said: super-secret-token');
    });
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const r = await client.callTool({ name: 'napcat_status', arguments: {} });
    expect(toolText(r)).not.toContain('super-secret-token');
    expect(payload(r).error).toContain('***');
  });
});

describe('napcat_list_chats', () => {
  it('returns friends with the remark as the display name', async () => {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    state.clientOverride = stubClient((action) => {
      if (action === 'get_friend_list') return [{ user_id: 9, nickname: '张三', remark: '张三（同事）' }];
      throw new Error(`unexpected ${action}`);
    });
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const r = await client.callTool({ name: 'napcat_list_chats', arguments: { kind: 'friend' } });
    const p = payload(r);
    expect(p.chats[0]).toMatchObject({ id: '9', name: '张三（同事）', kind: 'friend' });
  });

  it('reports an error when the upstream call fails', async () => {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    state.clientOverride = stubClient(() => {
      throw new Error('upstream down');
    });
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const r = await client.callTool({ name: 'napcat_list_chats', arguments: { kind: 'group' } });
    expect(isError(r)).toBe(true);
    expect(payload(r).error).toContain('upstream down');
  });
});

describe('napcat_get_history', () => {
  /**
   * 模拟 NapCat：返回「不晚于 cursor 的最后 N 条」（含 cursor 本身），按 seq 正序。
   *
   * - `pageSize` 不给：N = 请求的 count（服务端守约）。
   * - `pageSize` 给了：N 固定（模拟服务端固定页大小）；相邻两页因此在边界上重叠一条。
   */
  function pagingClient(total: number, pageSize?: number): OneBotClient {
    const all: OB11Message[] = Array.from({ length: total }, (_, i) => ({
      message_seq: i + 1,
      time: 1700000000 + i,
      sender: { user_id: 1, nickname: `u${i + 1}` },
      message: [{ type: 'text', data: { text: `m${i + 1}` } }],
    }));
    return stubClient((action, params) => {
      if (action === 'get_group_msg_history') {
        const p = params as { message_seq?: string; count?: number };
        const count = pageSize ?? p.count ?? 50;
        const cursor = p.message_seq === undefined ? Number.POSITIVE_INFINITY : Number(p.message_seq);
        const slice = all.filter((m) => (m.message_seq ?? 0) <= cursor).slice(-count);
        return { messages: slice };
      }
      throw new Error(`unexpected ${action}`);
    });
  }

  async function historyClient(client: OneBotClient) {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    state.clientOverride = client;
    registerTools(server, state);
    const c = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await c.connect(ct);
    return c;
  }

  it('returns the newest page and exposes the cursor to older messages', async () => {
    const c = await historyClient(pagingClient(10));
    const r = await c.callTool({
      name: 'napcat_get_history',
      arguments: { chatKind: 'group', chatId: '123', count: 4 },
    });
    const p = payload(r);
    expect(p.messages.map((m: { seq: number }) => m.seq)).toEqual([7, 8, 9, 10]);
    expect(p.nextBeforeSeq).toBe(7);
    expect(p.exhausted).toBe(false);
  });

  it('walks back with the cursor and deduplicates overlapping page boundaries', async () => {
    // 固定页大小 2 → 相邻两页在边界上重叠一条；count=5 需要翻 4 页才够
    const c = await historyClient(pagingClient(10, 2));
    const r = await c.callTool({
      name: 'napcat_get_history',
      arguments: { chatKind: 'group', chatId: '123', count: 5 },
    });
    const p = payload(r);
    const seqs = p.messages.map((m: { seq: number }) => m.seq);
    expect(seqs).toEqual([6, 7, 8, 9, 10]); // 时间升序
    expect(new Set(seqs).size).toBe(seqs.length); // 页边界重叠的消息只出现一次
    expect(p.nextBeforeSeq).toBe(6);
    // 页是「短页」（固定页大小 2 < count 5），但窗口是攒满的 → 不能报 exhausted
    expect(p.exhausted).toBe(false);
  });

  it('filters by until and keeps walking back to older pages', async () => {
    const c = await historyClient(pagingClient(10));
    // until = m5 的时间：最新几页全被过滤掉，必须继续向更早翻页
    const r = await c.callTool({
      name: 'napcat_get_history',
      arguments: { chatKind: 'group', chatId: '123', count: 3, until: 1700000004 },
    });
    const p = payload(r);
    expect(p.messages.every((m: { time: number }) => m.time <= 1700000004)).toBe(true);
    expect(p.messages.length).toBeGreaterThan(0);
    // 取窗「最新优先」：窗口是时间窗内**最新的 3 条**，且连续（不再出现空洞）
    expect(p.messages.map((m: { seq: number }) => m.seq)).toEqual([3, 4, 5]);
  });

  it('stops at the since boundary and reports exhausted', async () => {
    const c = await historyClient(pagingClient(10));
    const r = await c.callTool({
      name: 'napcat_get_history',
      arguments: { chatKind: 'group', chatId: '123', count: 3, beforeSeq: 5, since: 1700000004 },
    });
    const p = payload(r);
    expect(p.messages.map((m: { seq: number }) => m.seq)).toEqual([5]);
    expect(p.exhausted).toBe(true);
    expect(p.nextBeforeSeq).toBe(5);
  });

  it('reports exhausted only when the window is not full', async () => {
    // 固定页大小 3 → 页里既有 >= since 的也有 < since 的；窗口被填满 → 不能报 exhausted
    const c = await historyClient(pagingClient(10, 3));
    const r = await c.callTool({
      name: 'napcat_get_history',
      arguments: { chatKind: 'group', chatId: '123', count: 2, beforeSeq: 6, since: 1700000004 },
    });
    const p = payload(r);
    expect(p.messages.map((m: { seq: number }) => m.seq)).toEqual([5, 6]); // 窗口是满的
    expect(p.exhausted).toBe(false); // 窗口满了 → exhausted 只能是 false
  });

  it('reports exhausted when the history runs out', async () => {
    const c = await historyClient(pagingClient(3));
    const r = await c.callTool({
      name: 'napcat_get_history',
      arguments: { chatKind: 'group', chatId: '123', count: 10 },
    });
    const p = payload(r);
    expect(p.messages).toHaveLength(3);
    expect(p.exhausted).toBe(true);
    expect(p.nextBeforeSeq).toBe(1);
  });

  it('applies the default count and clamps it to the documented range', async () => {
    const calls: Array<{ count?: number }> = [];
    const c = await historyClient(stubClient((action, params) => {
      if (action === 'get_group_msg_history') {
        calls.push(params as { count?: number });
        return { messages: [] };
      }
      throw new Error(`unexpected ${action}`);
    }));

    await c.callTool({ name: 'napcat_get_history', arguments: { chatKind: 'group', chatId: '1' } });
    expect(calls[0]?.count).toBe(100); // 默认 100
    await c.callTool({ name: 'napcat_get_history', arguments: { chatKind: 'group', chatId: '1', count: 500 } });
    expect(calls[1]?.count).toBe(200); // 上限 200
    await c.callTool({ name: 'napcat_get_history', arguments: { chatKind: 'group', chatId: '1', count: 0 } });
    expect(calls[2]?.count).toBe(1); // 下限 1
  });

  it('does not drop messages that have neither message_seq nor message_id', async () => {
    // 这类消息没有稳定标识：不能拿「页内下标」当去重键，否则跨页的同下标消息会被误判成重复而丢弃
    const page1: OB11Message[] = [
      { time: 1700000001, message: [{ type: 'text', data: { text: 'a' } }] },
      { message_seq: 2, time: 1700000002, message: [{ type: 'text', data: { text: 'b' } }] },
      { time: 1700000003, message: [{ type: 'text', data: { text: 'c' } }] },
    ];
    const page2: OB11Message[] = [
      { time: 1700000004, message: [{ type: 'text', data: { text: 'd' } }] },
      { message_seq: 2, time: 1700000002, message: [{ type: 'text', data: { text: 'b' } }] }, // 与上一页重叠
    ];
    let n = 0;
    const c = await historyClient(stubClient((action) => {
      if (action === 'get_group_msg_history') return { messages: n++ === 0 ? page1 : page2 };
      throw new Error(`unexpected ${action}`);
    }));
    const r = await c.callTool({
      name: 'napcat_get_history',
      arguments: { chatKind: 'group', chatId: '1', count: 10 },
    });
    const p = payload(r);
    const texts = p.messages.map((m: { text: string }) => m.text).sort();
    expect(texts).toEqual(['a', 'b', 'c', 'd']); // 三条无 seq 的消息都在
  });

  it('reports an error when the upstream call fails', async () => {
    const c = await historyClient(stubClient(() => {
      throw new Error('history exploded');
    }));
    const r = await c.callTool({
      name: 'napcat_get_history',
      arguments: { chatKind: 'group', chatId: '123' },
    });
    expect(isError(r)).toBe(true);
    expect(payload(r).error).toContain('history exploded');
  });

  it('reports a clear error when no endpoint is configured', async () => {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    const state = new AppState();
    state.config.connection.endpoint = '';
    registerTools(server, state);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    const r = await client.callTool({
      name: 'napcat_get_history',
      arguments: { chatKind: 'group', chatId: '123' },
    });
    expect(isError(r)).toBe(true);
    const p = payload(r);
    expect(p.error).toContain('端点');
    expect(p.error).not.toContain('undefined');
  });
});

describe('endpoint scheme handling', () => {
  it('accepts an uppercase scheme when building the client', () => {
    // scheme 判定必须大小写不敏感：`HTTP://` / `WS://` 是合法端点
    expect(() => createClient({ endpoint: 'HTTP://127.0.0.1:3000' })).not.toThrow();
    expect(() => createClient({ endpoint: 'WS://127.0.0.1:3001' })).not.toThrow();
    expect(() => createClient({ endpoint: 'ftp://127.0.0.1:3000' })).toThrow(/unsupported endpoint scheme/);
  });

  it('redacts the endpoint in the scheme error', () => {
    // 端点里可能带 access_token / user:pass —— 报错里不能原样回显
    let err: unknown;
    try {
      createClient({ endpoint: 'ftp://user:pass@127.0.0.1:3000?access_token=super-secret-token' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain('unsupported endpoint scheme'); // 结构不变
    expect(msg).not.toContain('super-secret-token');
    expect(msg).not.toContain('pass');
    expect(msg).toContain('127.0.0.1:3000'); // 只去掉 query 与 userinfo
  });

  it('keeps the token out of the scheme error returned by the tool', async () => {
    const { r } = await configureEndpoint('ftp://127.0.0.1:3000?access_token=super-secret-token');
    expect(isError(r)).toBe(true);
    expect(payload(r).error).toContain('unsupported endpoint scheme');
    expect(toolText(r)).not.toContain('super-secret-token');
  });

  it('connects with an uppercase scheme end to end', async () => {
    const server = createServer((req, res) => {
      let chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const action = req.url?.slice(1) ?? '';
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            status: 'ok',
            retcode: 0,
            data: action === 'get_login_info' ? { user_id: 2350355494, nickname: 'TestBot' } : { messages: [] },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const { r } = await configureEndpoint(`HTTP://127.0.0.1:${port}`);
      expect(isError(r)).toBe(false);
      expect(payload(r).login.nickname).toBe('TestBot');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('mcp panel resource', () => {
  async function resourceClient(htmlPath: string) {
    const server = new McpServer({ name: 'napcat', version: '0.1.0' });
    registerPanelResource(server, htmlPath);
    const client = new Client({ name: 'test', version: '0.0.1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    return client;
  }

  it('serves the panel html with the mcp-app mime type', async () => {
    const htmlPath = join(tmp, 'panel.html');
    writeFileSync(htmlPath, '<!doctype html><html><body>panel</body></html>');
    const c = await resourceClient(htmlPath);
    const list = await c.listResources();
    expect(list.resources.map((r) => r.uri)).toContain('ui://napcat-zcode/panel.html');

    const read = await c.readResource({ uri: 'ui://napcat-zcode/panel.html' });
    const content = read.contents[0] as { uri: string; mimeType?: string; text?: string };
    expect(content.mimeType).toBe('text/html;profile=mcp-app');
    expect(content.text).toContain('panel');
  });

  it('falls back to an error page when the panel file is missing', async () => {
    const c = await resourceClient(join(tmp, 'nope.html'));
    const read = await c.readResource({ uri: 'ui://napcat-zcode/panel.html' });
    const content = read.contents[0] as { mimeType?: string; text?: string };
    expect(content.mimeType).toBe('text/html;profile=mcp-app');
    expect(content.text).toContain('panel.html missing');
  });
});
