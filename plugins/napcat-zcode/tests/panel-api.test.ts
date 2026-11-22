/**
 * 面板 API 层的防御式解析测试。
 *
 * 交接约定（来自 T10/T11 审查结论）：
 * - 错误载荷有**两种形状**：
 *   ① 工具自己抛错 → resolve `{content:[{type:'text',text:'{"error":"…"}'}], isError:true}`；
 *   ② SDK/zod 入参校验失败 → **reject** `Error('MCP error -32602: …')`（`err.code === -32602`）。
 * - 解析顺序必须是「先试 JSON.parse（失败则把原文当错误消息），再判 isError」。
 * - 面板绝不能因为错误载荷不是 JSON 就自己崩掉。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Msg } from '../src/panel/api.js';

const CAPS = { message: false, updateModelContext: false, downloadFile: false, serverTools: true };

/** 假宿主：只提供 api.ts 用到的两个动作。 */
const host = vi.hoisted(() => ({
  initialize: vi.fn(),
  callTool: vi.fn(),
}));

vi.mock('../src/panel/bridge.js', () => ({
  HostBridge: class {
    capabilities = CAPS;
    async initialize() {
      return host.initialize();
    }
    async callTool(name: string, args: object) {
      return host.callTool(name, args);
    }
  },
}));

/** 每个用例都拿到全新的 api 模块实例（握手 promise 是模块级的，跨用例会串味）。 */
type ApiModule = typeof import('../src/panel/api.js');
let mod: ApiModule;

beforeEach(async () => {
  vi.resetModules();
  host.initialize.mockReset();
  host.callTool.mockReset();
  host.initialize.mockResolvedValue(CAPS);
  mod = await import('../src/panel/api.js');
});

function textResult(text: string, isError?: boolean) {
  return { content: [{ type: 'text', text }], ...(isError === undefined ? {} : { isError }) };
}

describe('callToolJson 错误解析', () => {
  it('isError + JSON 载荷 → 抛出 JSON 里的 error 字段', async () => {
    const raw = textResult(JSON.stringify({ error: '未配置 OneBot 端点' }), true);
    host.callTool.mockResolvedValue(raw);
    await expect(mod.callToolJson('napcat_status', {})).rejects.toThrow('未配置 OneBot 端点');
    // 原始载荷不丢：`raw` 保留宿主给的原样结果，`tool` 标出是哪个工具失败
    await expect(mod.callToolJson('napcat_status', {})).rejects.toMatchObject({ tool: 'napcat_status', raw });
  });

  it('isError + 非 JSON 载荷 → 把原文当错误消息（不崩）', async () => {
    host.callTool.mockResolvedValue(textResult('MCP error -32602: Input validation error: bad args', true));
    await expect(mod.callToolJson('napcat_status', {})).rejects.toThrow(
      'MCP error -32602: Input validation error: bad args',
    );
  });

  it('工具调用 reject（SDK/zod 校验失败）→ 逐字保留原始文案', async () => {
    // 形状与桥一致（protocol-notes §3）：reject 的 Error 带 `code` 与 `payload`（原始 JSON-RPC 帧）
    const frame = {
      code: -32602,
      message: 'MCP error -32602: Input validation error: chatId',
      data: { tool: 'napcat_get_history' },
    };
    const err = Object.assign(new Error(frame.message), { code: frame.code, payload: frame });
    host.callTool.mockRejectedValue(err);
    await expect(mod.callToolJson('napcat_get_history', {})).rejects.toThrow(
      'MCP error -32602: Input validation error: chatId',
    );
    await expect(mod.callToolJson('napcat_get_history', {})).rejects.toMatchObject({ code: -32602 });
    // 交接 #1：原始帧（payload）必须原样带出，不能被压扁成一句话
    await expect(mod.callToolJson('napcat_get_history', {})).rejects.toMatchObject({
      tool: 'napcat_get_history',
      code: -32602,
      payload: frame,
    });
  });

  it('成功载荷不是 JSON → 抛错而不是让面板崩掉', async () => {
    host.callTool.mockResolvedValue(textResult('not json at all'));
    await expect(mod.callToolJson('napcat_status', {})).rejects.toThrow(/JSON/);
  });

  it('空载荷 → 抛错', async () => {
    host.callTool.mockResolvedValue({});
    await expect(mod.callToolJson('napcat_status', {})).rejects.toThrow();
  });

  it('成功载荷 → 解析 JSON 返回', async () => {
    host.callTool.mockResolvedValue(textResult(JSON.stringify({ configured: true, connected: true })));
    await expect(mod.callToolJson('napcat_status', {})).resolves.toEqual({ configured: true, connected: true });
  });
});

describe('callToolJson 握手门控', () => {
  it('工具调用之前必须先握手（未握手不发请求）', async () => {
    let release: (v: typeof CAPS) => void = () => {};
    host.initialize.mockReturnValue(
      new Promise<typeof CAPS>((res) => {
        release = res;
      }),
    );
    const pending = mod.callToolJson('napcat_status', {});
    await Promise.resolve();
    expect(host.initialize).toHaveBeenCalled();
    expect(host.callTool).not.toHaveBeenCalled();
    release(CAPS);
    host.callTool.mockResolvedValue(textResult(JSON.stringify({ ok: 1 })));
    await expect(pending).resolves.toEqual({ ok: 1 });
  });

  it('握手失败时把原因透出（不静默）', async () => {
    host.initialize.mockRejectedValue(new Error('host bridge initialize failed after 3 attempt(s): timeout'));
    await expect(mod.callToolJson('napcat_status', {})).rejects.toThrow(/initialize failed/);
  });
});

describe('api 工具封装', () => {
  it('napcat_get_history 只在有游标时才带 beforeTime', async () => {
    host.callTool.mockResolvedValue(textResult(JSON.stringify({ messages: [], nextBeforeTime: null, exhausted: true })));
    await mod.api.getHistory('group', '123');
    expect(host.callTool).toHaveBeenCalledWith('napcat_get_history', {
      chatKind: 'group',
      chatId: '123',
      count: 100,
    });
    // 游标是**时间**（epoch 秒）：服务端 message_seq 是随机短 id，不能当游标
    await mod.api.getHistory('group', '123', 1700000000);
    expect(host.callTool).toHaveBeenLastCalledWith('napcat_get_history', {
      chatKind: 'group',
      chatId: '123',
      count: 100,
      beforeTime: 1700000000,
    });
  });

  it('napcat_export 的 chat 参数只带 {kind,id,name}（额外字段会被服务端静默剥离，不能传）', async () => {
    host.callTool.mockResolvedValue(
      textResult(JSON.stringify({ mdPath: '/tmp/a.md', jsonPath: '/tmp/a.json', gitignoreUpdated: false })),
    );
    await mod.api.exportSel(
      [{ id: '1', seq: 1, time: 1700000000, senderId: '2', senderName: 'A', segments: [], text: 'x' }],
      { kind: 'group', id: '123', name: '群' },
    );
    const [, args] = host.callTool.mock.calls[0];
    expect(args).toEqual({
      messages: [{ id: '1', seq: 1, time: 1700000000, senderId: '2', senderName: 'A', segments: [], text: 'x' }],
      chat: { kind: 'group', id: '123', name: '群' },
    });
  });

  it('messages 不是数组 → 面板自己先挡住（工具侧 schema 无约束）', async () => {
    await expect(
      mod.api.formatSelection('not an array' as unknown as never[], '群'),
    ).rejects.toThrow(/数组/);
    expect(host.callTool).not.toHaveBeenCalled();
  });

  it('消息缺少有效 time → 面板自己先挡住', async () => {
    await expect(
      mod.api.formatSelection([{ id: '1', seq: 1, time: Number.NaN, senderId: '2', senderName: 'A', segments: [], text: 'x' }], '群'),
    ).rejects.toThrow(/time/);
    expect(host.callTool).not.toHaveBeenCalled();
  });

  // 服务端在消息没有有效时间时会**省略** time 字段（JSON.stringify 丢弃 undefined），
  // 面板自己也要挡住这种消息（类型上 `time` 是可选的）。
  it('消息压根没有 time 字段 → 面板自己先挡住', async () => {
    await expect(
      mod.api.formatSelection([{ id: '1', seq: 1, senderId: '2', senderName: 'A', segments: [], text: 'x' }], '群'),
    ).rejects.toThrow(/time/);
    expect(host.callTool).not.toHaveBeenCalled();
  });
});

// M1.1-8：msgKey 退化时必须**带上可区分信息**，实在区分不了就返回 null（调用方跳过该条）。
// 以前退化成 `seq:0`：多条「既无 message_id 又无 message_seq」的消息共用同一个 key
// → React 重复 key、选中态串成一片、testid 撞车。
describe('msgKey 的退化形态', () => {
  const base = { id: 'x', seq: 1, time: 1700000000, senderId: '1', senderName: 'A', segments: [], text: '' };

  it('有消息 id 时用 id', () => {
    expect(mod.msgKey(base)).toBe('x');
  });

  it('没有 id 时退回 seq + time（s 命名空间与去重键同构）', () => {
    expect(mod.msgKey({ ...base, id: '' })).toBe('s1@1700000000');
  });

  it('既没有 id 也没有有效 seq 时退回时间', () => {
    expect(mod.msgKey({ ...base, id: '', seq: 0 })).toBe('t1700000000');
  });

  it('什么都区分不了时返回 null（调用方跳过该条，而不是共用一个 key）', () => {
    expect(mod.msgKey({ ...base, id: '', seq: 0, time: Number.NaN })).toBeNull();
  });

  it('消息压根没有 time 字段时同样返回 null（服务端会省略这个字段）', () => {
    const noTime: Msg = { id: '', seq: 0, senderId: '1', senderName: 'A', segments: [], text: '' };
    expect(mod.msgKey(noTime)).toBeNull();
  });

  it('多条既无 id 又无 seq 的消息不会共用同一个 key', () => {
    const a = mod.msgKey({ ...base, id: '', seq: 0, time: 1700000000 });
    const b = mod.msgKey({ ...base, id: '', seq: 0, time: 1700000001 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });
});

describe('friendlyError 的错误转译', () => {
  it('fetch failed → 连接排查人话（不再糊英文原文）', () => {
    expect(mod.friendlyError('fetch failed')).toContain('连不上 NapCat');
    expect(mod.friendlyError('Error: fetch failed')).toContain('重试');
  });

  it('连接拒绝 / 超时 → 指向运行状态与端口', () => {
    expect(mod.friendlyError('connect ECONNREFUSED 127.0.0.1:3000')).toContain('连接地址');
    expect(mod.friendlyError('ETIMEDOUT')).toContain('连不上 NapCat');
  });

  it('token 拒绝 → 指向 token 核对', () => {
    expect(mod.friendlyError('HTTP 401 Unauthorized')).toContain('token');
  });

  it('未知错误逐字保留（不编造原因）', () => {
    expect(mod.friendlyError('OneBot 返回了奇怪的状态')).toBe('OneBot 返回了奇怪的状态');
  });
});
