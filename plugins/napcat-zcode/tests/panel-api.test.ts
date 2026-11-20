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
    host.callTool.mockResolvedValue(textResult(JSON.stringify({ error: '未配置 OneBot 端点' }), true));
    await expect(mod.callToolJson('napcat_status', {})).rejects.toThrow('未配置 OneBot 端点');
  });

  it('isError + 非 JSON 载荷 → 把原文当错误消息（不崩）', async () => {
    host.callTool.mockResolvedValue(textResult('MCP error -32602: Input validation error: bad args', true));
    await expect(mod.callToolJson('napcat_status', {})).rejects.toThrow(
      'MCP error -32602: Input validation error: bad args',
    );
  });

  it('工具调用 reject（SDK/zod 校验失败）→ 逐字保留原始文案', async () => {
    const err = Object.assign(new Error('MCP error -32602: Input validation error: chatId'), {
      code: -32602,
      payload: { code: -32602, message: 'MCP error -32602: Input validation error: chatId' },
    });
    host.callTool.mockRejectedValue(err);
    await expect(mod.callToolJson('napcat_get_history', {})).rejects.toThrow(
      'MCP error -32602: Input validation error: chatId',
    );
    await expect(mod.callToolJson('napcat_get_history', {})).rejects.toMatchObject({ code: -32602 });
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
  it('napcat_get_history 只在有游标时才带 beforeSeq', async () => {
    host.callTool.mockResolvedValue(textResult(JSON.stringify({ messages: [], nextBeforeSeq: null, exhausted: true })));
    await mod.api.getHistory('group', '123');
    expect(host.callTool).toHaveBeenCalledWith('napcat_get_history', {
      chatKind: 'group',
      chatId: '123',
      count: 100,
    });
    await mod.api.getHistory('group', '123', 42);
    expect(host.callTool).toHaveBeenLastCalledWith('napcat_get_history', {
      chatKind: 'group',
      chatId: '123',
      count: 100,
      beforeSeq: 42,
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
});
