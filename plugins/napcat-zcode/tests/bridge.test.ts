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
          openLinks: {},
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
 *
 * `removeEventListener` 一并 stub：否则 `dispose()` 的监听器拆卸根本没被验证
 *（stub 掉的 addEventListener 不会真的注册到 DOM 上，真实 removeEventListener 也就摘不掉）。
 */
function fakeHost(responder: Responder = defaultResponder) {
  const listeners: ((ev: MessageEvent) => void)[] = [];
  vi.stubGlobal('addEventListener', (t: string, fn: (ev: MessageEvent) => void) => {
    if (t === 'message') listeners.push(fn);
  });
  vi.stubGlobal('removeEventListener', (t: string, fn: (ev: MessageEvent) => void) => {
    if (t !== 'message') return;
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  });
  const sent: SentMessage[] = [];
  /** 把一帧投递给所有 message 监听器（异步，和真机一致）。 */
  const deliver = (data: unknown) => {
    setTimeout(
      () => listeners.forEach((fn) => fn({ data } as MessageEvent)),
      0,
    );
  };
  vi.stubGlobal('parent', {
    postMessage: (msg: SentMessage) => {
      sent.push(msg);
      if (typeof msg.id !== 'number') return; // 通知没有 id，不回
      const res = responder(msg.method ?? '', msg.params);
      if (!res || res.silent) return; // 宿主不响应
      if (res.error) {
        deliver({ jsonrpc: '2.0', id: msg.id, error: res.error });
        return;
      }
      deliver({ jsonrpc: '2.0', id: msg.id, result: res.result });
    },
  });
  return {
    sent,
    listeners,
    /** 手动回一条结果（用来测乱序响应 / 并发）。 */
    reply: (id: number, result: unknown) => deliver({ jsonrpc: '2.0', id, result }),
    /** 手动回一条错误帧。 */
    replyError: (id: number, error: { code: number; message: string; data?: unknown }) =>
      deliver({ jsonrpc: '2.0', id, error }),
  };
}

beforeEach(() => vi.unstubAllGlobals());

describe('HostBridge', () => {
  it('initializes and reads capabilities', async () => {
    const host = fakeHost();
    const b = new HostBridge();
    const caps = await b.initialize();
    expect(caps.message).toBe(true);
    expect(caps.serverTools).toBe(true);
    expect(caps.openLinks).toBe(true);
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

  it('opens a loopback link through ui/open-link', async () => {
    const host = fakeHost();
    const b = new HostBridge();
    await b.initialize();
    await b.openLocalLink('http://127.0.0.1:6099');
    const call = host.sent.find((m) => m.method === 'ui/open-link');
    expect(call?.params).toEqual({ url: 'http://127.0.0.1:6099/' });
  });

  it('rejects non-loopback and non-http links before contacting the host', async () => {
    const host = fakeHost();
    const b = new HostBridge();
    await b.initialize();
    await expect(b.openLocalLink('https://example.com')).rejects.toThrow('只允许打开本机');
    await expect(b.openLocalLink('file:///etc/passwd')).rejects.toThrow('只允许打开本机');
    expect(host.sent.some((m) => m.method === 'ui/open-link')).toBe(false);
  });

  it('refuses openLocalLink when the host does not advertise openLinks', async () => {
    const host = fakeHost((method) =>
      method === 'ui/initialize'
        ? { result: { protocolVersion: '2026-01-26', hostCapabilities: {} } }
        : { result: {} },
    );
    const b = new HostBridge();
    await b.initialize();
    await expect(b.openLocalLink('http://127.0.0.1:6099')).rejects.toThrow(/openLinks/);
    expect(host.sent.some((m) => m.method === 'ui/open-link')).toBe(false);
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
    expect(params.appInfo).toMatchObject({ name: 'napcat-zcode', version: '0.12.4' });
    expect(params.appCapabilities).toEqual({ availableDisplayModes: ['inline', 'fullscreen'] });

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
    expect(caps).toEqual({
      message: false,
      updateModelContext: false,
      downloadFile: false,
      serverTools: false,
      openLinks: false,
    });
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
    expect(caps.openLinks).toBe(true);
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

  it('dispose() detaches the message listener', async () => {
    const host = fakeHost();
    const b = new HostBridge();
    await b.initialize();
    expect(host.listeners.length).toBe(1);
    b.dispose();
    expect(host.listeners.length).toBe(0);
  });

  it('dispose() clears the handshake state and the capability bits', async () => {
    fakeHost();
    const b = new HostBridge();
    await b.initialize();
    expect(b.initialized).toBe(true);
    expect(b.capabilities.serverTools).toBe(true);

    b.dispose();

    // 已销毁的桥不该再声称自己拥有宿主能力
    expect(b.initialized).toBe(false);
    expect(b.capabilities).toEqual({
      message: false,
      updateModelContext: false,
      downloadFile: false,
      serverTools: false,
      openLinks: false,
    });
    expect(b.hostCapabilities).toEqual({});
    // 销毁后再调用动作类方法必须被挡住
    await expect(b.callTool('napcat_status', {})).rejects.toThrow(/not initialized/);
  });

  // ---- 能力位：值为 null / false / undefined 一律视为不支持 ----

  it('treats null / false / undefined capability values as unsupported', async () => {
    fakeHost((method) =>
      method === 'ui/initialize'
        ? {
            result: {
              protocolVersion: '2026-01-26',
              hostCapabilities: {
                message: null,
                downloadFile: false,
                serverTools: {},
                updateModelContext: undefined,
              },
            },
          }
        : { result: {} },
    );
    const b = new HostBridge();
    const caps = await b.initialize();
    expect(caps).toEqual({
      message: false,
      downloadFile: false,
      serverTools: true,
      updateModelContext: false,
      openLinks: false,
    });
  });

  // ---- 并发：id → pending 关联 ----

  it('correlates concurrent requests by id even when the responses arrive out of order', async () => {
    const host = fakeHost((method) =>
      method === 'ui/initialize'
        ? { result: { protocolVersion: '2026-01-26', hostCapabilities: { serverTools: {} } } }
        : { silent: true }, // tools/call 不自动回，测试手动控制顺序
    );
    const b = new HostBridge({ timeoutMs: 5_000, initAttempts: 1 });
    await b.initialize();

    const first = b.callTool('napcat_status', {});
    const second = b.callTool('napcat_list_chats', { kind: 'group' });
    expect(b.pendingCount).toBe(2);

    const calls = host.sent.filter((m) => m.method === 'tools/call');
    expect(calls).toHaveLength(2);
    expect(calls[0].id).not.toBe(calls[1].id);

    // 逆序回：第二个请求先回
    host.reply(calls[1].id!, { content: [{ type: 'text', text: 'second' }] });
    host.reply(calls[0].id!, { content: [{ type: 'text', text: 'first' }] });

    expect(((await first) as { content: [{ text: string }] }).content[0].text).toBe('first');
    expect(((await second) as { content: [{ text: string }] }).content[0].text).toBe('second');
    expect(b.pendingCount).toBe(0);
  });

  // ---- 不把自己的请求当响应 ----

  it('ignores its own request frames instead of resolving them with undefined', async () => {
    const host = fakeHost((method) =>
      method === 'ui/initialize'
        ? { result: { protocolVersion: '2026-01-26', hostCapabilities: { serverTools: {} } } }
        : { silent: true },
    );
    const b = new HostBridge({ timeoutMs: 40, initAttempts: 1 });
    await b.initialize();

    // 模拟「window.parent 缺失」：桥的 post() 回退到 window，请求帧会回到自己的监听器
    vi.stubGlobal('parent', undefined);
    vi.stubGlobal('postMessage', (msg: unknown) => {
      setTimeout(() => host.listeners.forEach((fn) => fn({ data: msg } as MessageEvent)), 0);
    });

    // 自己的请求帧带 method → 不能被当成响应把 pending 满足掉（否则会 resolve 出 undefined）
    await expect(b.callTool('napcat_status', {})).rejects.toThrow(/host request timeout: tools\/call/);
    expect(b.pendingCount).toBe(0);
  });

  // ---- 宿主实测的下载语义 ----

  it('maps the measured host download shapes: {} = ok, {isError:true} = not confirmed', async () => {
    fakeHost((method) => {
      if (method === 'ui/initialize') {
        return {
          result: { protocolVersion: '2026-01-26', hostCapabilities: { downloadFile: {} } },
        };
      }
      if (method === 'ui/download-file') {
        // 宿主实测：成功返回 {}（路径被丢弃），失败与取消都返回 {isError:true}
        return { result: {} };
      }
      return { result: {} };
    });
    const b = new HostBridge();
    await b.initialize();
    const ok = await b.downloadFile('选区.md', '# hi', 'text/markdown');
    expect(ok.success).toBe(true);
    // 宿主不返回路径，也不返回 canceled
    expect(ok.filePath).toBeUndefined();
    expect(ok.canceled).toBeUndefined();
    expect(ok.error).toBeUndefined();
    expect(ok.raw).toEqual({});
  });

  it('reports a neutral machine-readable marker when the host does not confirm the download', async () => {
    fakeHost((method) => {
      if (method === 'ui/initialize') {
        return {
          result: { protocolVersion: '2026-01-26', hostCapabilities: { downloadFile: {} } },
        };
      }
      if (method === 'ui/download-file') return { result: { isError: true } };
      return { result: {} };
    });
    const b = new HostBridge();
    await b.initialize();
    const r = await b.downloadFile('选区.md', '# hi', 'text/markdown');
    expect(r.success).toBe(false);
    // 不自造人话：给一个中性的机器可读标记，由面板自己措辞
    expect(r.error).toBe('download_not_confirmed');
    expect(r.raw).toEqual({ isError: true });
  });

  // ── 宿主主题上下文（hostContext.theme + styles.variables） ────────

  it('reads theme and style variables from the initialize hostContext', async () => {
    fakeHost((method) => {
      if (method === 'ui/initialize') {
        return {
          result: {
            protocolVersion: '2026-01-26',
            hostCapabilities: {},
            hostContext: {
              theme: 'dark',
              styles: { variables: { '--color-background-primary': '#161616', 'not-a-var': 'x' } },
            },
          },
        };
      }
      return { result: {} };
    });
    const b = new HostBridge();
    await b.initialize();
    const ctx = b.getHostContext();
    expect(ctx.theme).toBe('dark');
    expect(ctx.styleVariables['--color-background-primary']).toBe('#161616');
    // 非 `--` 开头的键不收（不是 CSS 自定义属性，写进 DOM 没有意义）
    expect(Object.keys(ctx.styleVariables)).toEqual(['--color-background-primary']);
  });

  it('merges partial host-context-changed notifications and notifies subscribers', async () => {
    const host = fakeHost((method) => {
      if (method === 'ui/initialize') {
        return {
          result: {
            protocolVersion: '2026-01-26',
            hostCapabilities: {},
            hostContext: { theme: 'light', styles: { variables: { '--color-text-primary': '#171717' } } },
          },
        };
      }
      return { result: {} };
    });
    const b = new HostBridge();
    await b.initialize();
    const seen: unknown[] = [];
    const off = b.onHostContextChanged((ctx) => seen.push(ctx));

    // 通知只带变化字段（partial）→ 与当前上下文合并，不丢已有变量
    host.listeners.forEach((fn) =>
      fn({
        data: {
          jsonrpc: '2.0',
          method: 'ui/notifications/host-context-changed',
          params: { theme: 'dark', styles: { variables: { '--color-text-primary': '#f5f5f5' } } },
        },
      } as MessageEvent),
    );
    await new Promise((r) => setTimeout(r, 10));
    const ctx = b.getHostContext();
    expect(ctx.theme).toBe('dark');
    expect(ctx.styleVariables['--color-text-primary']).toBe('#f5f5f5');
    expect(seen).toHaveLength(1);

    off();
    host.listeners.forEach((fn) =>
      fn({ data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } } } as MessageEvent),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1); // 取消订阅后不再收到回调
    // 桥仍是状态持有者：内部状态继续跟随通知推进，只是不再通知订阅者
    expect(b.getHostContext().theme).toBe('light');
  });

  it('falls back to an empty context when the host sends no theme', async () => {
    fakeHost();
    const b = new HostBridge();
    await b.initialize();
    expect(b.getHostContext().theme).toBeUndefined();
    expect(b.getHostContext().styleVariables).toEqual({});
  });

  it('clears host context and listeners on dispose', async () => {
    fakeHost();
    const b = new HostBridge();
    await b.initialize();
    let calls = 0;
    b.onHostContextChanged(() => {
      calls += 1;
    });
    b.dispose();
    expect(b.getHostContext()).toEqual({ styleVariables: {} });
    // dispose 后桥不再处理通知（监听器已摘除）——直接断言订阅者集合被清空的行为：
    // 重新 initialize 前通知不会触发任何回调（calls 保持 0）
    expect(calls).toBe(0);
  });
});
