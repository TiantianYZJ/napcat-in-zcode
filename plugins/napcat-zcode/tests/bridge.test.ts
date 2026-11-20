/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostBridge } from '../src/panel/bridge.js';

/** 假宿主收到的一条 JSON-RPC 消息。 */
interface SentMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: unknown;
}

/** 假宿主对一次请求的回应。 */
interface FakeResponse {
  /** 正常结果（JSON-RPC `result`）。 */
  result?: unknown;
  /** 错误帧（JSON-RPC `error`）。 */
  error?: { code: number; message: string; data?: unknown };
  /** true = 宿主完全不响应这条请求（测超时 / 不响应 initialize）。 */
  silent?: boolean;
}

/** 假宿主的应答策略：返回 `undefined` 等价于 `silent`。 */
type Responder = (method: string, params: unknown) => FakeResponse | undefined;

/** 默认应答：与 brief 给的假宿主行为一致。 */
const defaultResponder: Responder = (method) => {
  if (method === 'ui/initialize') {
    return {
      result: {
        protocolVersion: '2026-01-26',
        hostCapabilities: {
          message: {},
          updateModelContext: {},
          downloadFile: {},
          serverTools: {},
        },
      },
    };
  }
  if (method === 'tools/call') {
    return { result: { content: [{ type: 'text', text: JSON.stringify({ ok: 1 }) }] } };
  }
  if (method === 'ui/download-file') {
    return { result: { success: true, filePath: '/tmp/选区.md' } };
  }
  return { result: {} };
};

/**
 * 装一个假宿主：接管 `window.parent.postMessage` 与 `window.addEventListener('message')`。
 *
 * vitest 的 jsdom 环境下 `window === globalThis`，所以 `vi.stubGlobal` 能同时顶掉
 * `window.parent` 与 `window.addEventListener`（本仓库实测：`window === globalThis` 为 true）。
 */
function fakeHost(responder: Responder = defaultResponder) {
  const listeners: ((ev: MessageEvent) => void)[] = [];
  vi.stubGlobal('addEventListener', (t: string, fn: (ev: MessageEvent) => void) => {
    if (t === 'message') listeners.push(fn);
  });
  const sent: SentMessage[] = [];
  vi.stubGlobal('parent', {
    postMessage: (msg: SentMessage) => {
      sent.push(msg);
      if (typeof msg.id !== 'number') return; // 通知没有 id，不回
      const reply = (data: unknown) => {
        setTimeout(
          () => listeners.forEach((fn) => fn({ data } as MessageEvent)),
          0,
        );
      };
      const res = responder(msg.method ?? '', msg.params);
      if (!res || res.silent) return; // 宿主不响应
      if (res.error) {
        reply({ jsonrpc: '2.0', id: msg.id, error: res.error });
        return;
      }
      reply({ jsonrpc: '2.0', id: msg.id, result: res.result });
    },
  });
  return { sent, listeners };
}

beforeEach(() => vi.unstubAllGlobals());

describe('HostBridge', () => {
  it('initializes and reads capabilities', async () => {
    const host = fakeHost();
    const b = new HostBridge();
    const caps = await b.initialize();
    expect(caps.message).toBe(true);
    expect(caps.serverTools).toBe(true);
    expect(host.sent[0].method).toBe('ui/initialize');
    expect(host.sent.some((m) => m.method === 'ui/notifications/initialized')).toBe(true);
  });

  it('callTool proxies and returns parsed content', async () => {
    fakeHost();
    const b = new HostBridge();
    await b.initialize();
    const r = (await b.callTool('napcat_status', {})) as { content: [{ text: string }] };
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: 1 });
  });

  it('downloadFile passes embedded contents and returns filePath', async () => {
    fakeHost();
    const b = new HostBridge();
    await b.initialize();
    const r = await b.downloadFile('选区.md', '# hi', 'text/markdown');
    expect(r.success).toBe(true);
    expect(r.filePath).toBe('/tmp/选区.md');
  });

  // ---- 握手细节（协议验证结论，见 src/panel/protocol-notes.md） ----

  it('sends protocol-correct ui/initialize params and an id-less initialized notification', async () => {
    const host = fakeHost();
    const b = new HostBridge();
    await b.initialize();

    const init = host.sent[0];
    expect(init.id).toBeTypeOf('number');
    const params = init.params as { appInfo: unknown; appCapabilities: unknown; protocolVersion: string };
    // protocolVersion 在协议 schema 里是必填的（brief 漏了，按实测补上）
    expect(params.protocolVersion).toBe('2026-01-26');
    expect(params.appInfo).toMatchObject({ name: 'napcat-zcode', version: '0.1.0' });
    expect(params.appCapabilities).toEqual({});

    const notified = host.sent.find((m) => m.method === 'ui/notifications/initialized');
    expect(notified).toBeDefined();
    // 通知没有 id
    expect(notified!.id).toBeUndefined();
  });

  it('downloadFile wraps contents as a protocol "resource" content block', async () => {
    const host = fakeHost();
    const b = new HostBridge();
    await b.initialize();
    await b.downloadFile('选区.md', '# hi', 'text/markdown');

    const call = host.sent.find((m) => m.method === 'ui/download-file');
    expect(call).toBeDefined();
    const params = call!.params as { contents: { type: string; resource: Record<string, unknown> }[] };
    expect(params.contents).toHaveLength(1);
    // 协议要求内容块带 type:"resource"，资源本体在 resource 字段里
    expect(params.contents[0].type).toBe('resource');
    expect(params.contents[0].resource).toMatchObject({ mimeType: 'text/markdown', text: '# hi' });
    expect(String(params.contents[0].resource.uri)).toContain('%E9%80%89%E5%8C%BA.md');
  });

  // ---- 能力协商的三种边界 ----

  it('treats an empty host capability set as "nothing supported"', async () => {
    fakeHost((method) =>
      method === 'ui/initialize'
        ? { result: { protocolVersion: '2026-01-26', hostCapabilities: {} } }
        : { result: {} },
    );
    const b = new HostBridge();
    const caps = await b.initialize();
    expect(caps).toEqual({ message: false, updateModelContext: false, downloadFile: false, serverTools: false });
  });

  it('ignores unknown host capability keys without failing', async () => {
    fakeHost((method) =>
      method === 'ui/initialize'
        ? {
            result: {
              protocolVersion: '2026-01-26',
              hostCapabilities: {
                experimental: { 'zcode/surface': { id: 'x' } },
                openLinks: {},
                logging: {},
                serverResources: { listChanged: true },
                serverTools: {},
              },
            },
          }
        : { result: {} },
    );
    const b = new HostBridge();
    const caps = await b.initialize();
    expect(caps.serverTools).toBe(true);
    expect(caps.message).toBe(false);
    expect(caps.downloadFile).toBe(false);
    expect(caps.updateModelContext).toBe(false);
    // 未识别的原始能力位仍然保留，面板可自行判断
    expect(b.hostCapabilities['openLinks']).toEqual({});
  });

  it('rejects and leaves no pending request when the host never answers ui/initialize', async () => {
    const host = fakeHost((method) => (method === 'ui/initialize' ? { silent: true } : { result: {} }));
    const b = new HostBridge({ timeoutMs: 30, initAttempts: 3, retryDelayMs: 5 });
    await expect(b.initialize()).rejects.toThrow(/initialize failed/);
    // 重试了 3 次
    expect(host.sent.filter((m) => m.method === 'ui/initialize')).toHaveLength(3);
    // 没有悬挂的 promise：pending 已清空
    expect(b.pendingCount).toBe(0);
  });

  it('rejects and cleans up pending state when a request times out', async () => {
    fakeHost((method) =>
      method === 'ui/initialize'
        ? { result: { protocolVersion: '2026-01-26', hostCapabilities: { serverTools: {} } } }
        : { silent: true },
    );
    const b = new HostBridge({ timeoutMs: 30, initAttempts: 1, retryDelayMs: 1 });
    await b.initialize();
    await expect(b.callTool('napcat_status', {})).rejects.toThrow(/host request timeout: tools\/call/);
    expect(b.pendingCount).toBe(0);
  });

  it('refuses tool calls when the host does not advertise serverTools', async () => {
    fakeHost((method) =>
      method === 'ui/initialize'
        ? { result: { protocolVersion: '2026-01-26', hostCapabilities: { message: {} } } }
        : { result: {} },
    );
    const b = new HostBridge();
    const caps = await b.initialize();
    expect(caps.serverTools).toBe(false);
    // 不得静默失败：给出明确原因
    await expect(b.callTool('napcat_status', {})).rejects.toThrow(/serverTools/);
  });

  // ---- 错误透传 ----

  it('passes the tool error payload through untouched', async () => {
    fakeHost((method) =>
      method === 'ui/initialize'
        ? { result: { protocolVersion: '2026-01-26', hostCapabilities: { serverTools: {} } } }
        : {
            result: {
              content: [{ type: 'text', text: JSON.stringify({ error: 'boom' }) }],
              isError: true,
            },
          },
    );
    const b = new HostBridge();
    await b.initialize();
    const r = (await b.callTool('napcat_status', {})) as {
      content: [{ type: string; text: string }];
      isError?: boolean;
    };
    // 桥不解析、不改写：载荷原样返回，解析留给面板的 API 层
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('{"error":"boom"}');
  });

  it('rejects with the host error frame verbatim', async () => {
    fakeHost((method) =>
      method === 'ui/initialize'
        ? { result: { protocolVersion: '2026-01-26', hostCapabilities: { serverTools: {} } } }
        : {
            error: {
              code: -32602,
              message: 'MCP error -32602: Input validation error: Invalid arguments for tool napcat_list_chats',
            },
          },
    );
    const b = new HostBridge();
    await b.initialize();
    await expect(b.callTool('napcat_list_chats', { kind: 1 })).rejects.toThrow(
      /^MCP error -32602: Input validation error/,
    );
  });

  it('surfaces a rejected ui/message instead of swallowing it', async () => {
    fakeHost((method) =>
      method === 'ui/initialize'
        ? { result: { protocolVersion: '2026-01-26', hostCapabilities: { message: {} } } }
        : { result: { isError: true } },
    );
    const b = new HostBridge();
    await b.initialize();
    await expect(b.uiMessage('hi')).rejects.toThrow(/ui\/message/);
  });

  it('sends ui/message and ui/update-model-context as text content blocks', async () => {
    const host = fakeHost();
    const b = new HostBridge();
    await b.initialize();
    await b.uiMessage('hello');
    await b.updateModelContext('ctx');

    const msg = host.sent.find((m) => m.method === 'ui/message');
    expect(msg!.params).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] });

    const ctx = host.sent.find((m) => m.method === 'ui/update-model-context');
    expect(ctx!.params).toEqual({ content: [{ type: 'text', text: 'ctx' }] });
  });

  // ---- 沙箱里的剪贴板：失败返回 false，不抛错 ----

  it('writeClipboard returns false when the clipboard is unavailable', async () => {
    fakeHost();
    const b = new HostBridge();
    vi.stubGlobal('navigator', {});
    await expect(b.writeClipboard('@/tmp/x.md')).resolves.toBe(false);
  });

  it('writeClipboard returns false instead of throwing when the clipboard rejects', async () => {
    fakeHost();
    const b = new HostBridge();
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: () => Promise.reject(new Error('NotAllowedError')),
      },
    });
    await expect(b.writeClipboard('@/tmp/x.md')).resolves.toBe(false);
  });

  it('writeClipboard returns true when the clipboard accepts the text', async () => {
    fakeHost();
    const b = new HostBridge();
    const written: string[] = [];
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: (t: string) => {
          written.push(t);
          return Promise.resolve();
        },
      },
    });
    await expect(b.writeClipboard('@/tmp/x.md')).resolves.toBe(true);
    expect(written).toEqual(['@/tmp/x.md']);
  });

  // ---- 断开：不留悬挂的 promise ----

  it('dispose() rejects in-flight requests instead of leaving them hanging', async () => {
    fakeHost((method) =>
      method === 'ui/initialize'
        ? { result: { protocolVersion: '2026-01-26', hostCapabilities: { serverTools: {} } } }
        : { silent: true },
    );
    const b = new HostBridge({ timeoutMs: 60_000, initAttempts: 1 });
    await b.initialize();
    const inflight = b.callTool('napcat_status', {});
    b.dispose();
    await expect(inflight).rejects.toThrow(/disposed/);
    expect(b.pendingCount).toBe(0);
  });
});
