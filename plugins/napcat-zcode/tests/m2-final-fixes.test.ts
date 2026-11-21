/**
 * M2 最终修复波（服务端侧）的用例。
 *
 * 覆盖这一波评审提出的承重结论：
 * - F1：「使用这个」不能把用户 WS 端点 URL 里的凭据（query）抹掉，
 *      也不能用「没有凭据的规范化候选」覆盖掉本来能用的配置；
 * - F3：盘根发现的**生效上限**要出现在 notes 里（面板只渲染 notes）；
 * - F4：活着的 HTTP 端口，它的 `ws://` 孪生端点**不是**候选（默认路径上 3 个候选里 2 个是假的）；
 * - F5：安装发现的说明（截断等）必须进**顶层** notes（面板只渲染顶层 notes）；
 * - F7：探测结论要带上它运行时用的配置指纹 → 探测期间配置变了就丢弃（过期竞态）；
 * - F10：`live` 也要裁剪（出参上界）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppState } from '../src/server/state.js';
import { registerTools } from '../src/server/tools.js';
import {
  detectLocalOnce,
  detectLocalWithInstalls,
  mergeDetectionRoots,
  MAX_LIVE,
} from '../src/server/host/detect-local.js';
import { defaultConfig } from '../src/server/config.js';
import type { OneBotClient } from '../src/server/onebot/client.js';

// ── 环境 ────────────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'napcat-final-wave-'));
  // 配置目录指向临时目录：绝不碰开发者本机的配置
  process.env.ZCODE_PLUGIN_DATA = tmp;
});

afterEach(() => {
  delete process.env.ZCODE_PLUGIN_DATA;
  rmSync(tmp, { recursive: true, force: true });
});

function diskConfig(): Record<string, any> {
  return JSON.parse(readFileSync(join(tmp, 'config.json'), 'utf-8'));
}

/** OneBot 客户端替身（让 `setConnection` 不必真的去连）。 */
function stubClient(): OneBotClient {
  return {
    async call<T>(action: string): Promise<T> {
      if (action === 'get_login_info') return { user_id: 1, nickname: 'TestBot' } as unknown as T;
      return null as unknown as T;
    },
    async close() {},
  };
}

async function makeToolClient(state: AppState): Promise<Client> {
  const server = new McpServer({ name: 'napcat', version: '0.3.0' });
  registerTools(server, state);
  const client = new Client({ name: 'test', version: '0.0.1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return client;
}

function payload(r: unknown): Record<string, any> {
  const content = (r as { content: Array<{ type: string; text?: string }> }).content;
  return JSON.parse(content[0]?.text ?? '');
}

function isError(r: unknown): boolean {
  return (r as { isError?: boolean }).isError === true;
}

/** 一个「什么都答」的假 OneBot HTTP 服务（任何路径都返回登录信息）。 */
async function startFakeOneBot(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: { user_id: 2350355494, nickname: '探测测试号' },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** 「黑洞」TCP 服务：接受连接但永不应答（把探测拖到超时）。 */
async function startBlackHole(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: Array<{ destroy: () => void }> = [];
  const server: TcpServer = createTcpServer((socket) => {
    sockets.push(socket);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

// ── F1：端点里的凭据不能被「规范化候选」抹掉 ─────────────────────────

describe('F1：「使用这个」不能抹掉端点里的凭据', () => {
  it('已存端点带 ?access_token= → 用规范化候选重配 → 落盘端点仍带凭据', async () => {
    const state = new AppState();
    state.clientOverride = stubClient();
    const c = await makeToolClient(state);

    // 用户自己配的端点（OneBot 的 WS 约定：token 走 query）
    await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'ws://127.0.0.1:3001?access_token=abc' },
    });
    expect(diskConfig().connection?.endpoint).toBe('ws://127.0.0.1:3001?access_token=abc');

    // 面板的「使用这个」按钮传的是**规范化候选**（query 被剥掉了）
    await c.callTool({ name: 'napcat_configure', arguments: { endpoint: 'ws://127.0.0.1:3001' } });
    // ← 关键：凭据没被抹掉（否则用户本来能用的配置被替换成连不上的 URL）
    expect(diskConfig().connection?.endpoint).toBe('ws://127.0.0.1:3001?access_token=abc');
  });

  it('对照：端点确实变了 → 不保留旧端点的凭据', async () => {
    const state = new AppState();
    state.clientOverride = stubClient();
    const c = await makeToolClient(state);

    await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'ws://127.0.0.1:3001?access_token=abc' },
    });
    // 换了一个**别的**端点 → 用户明确要换 → 不能把旧凭据带过去
    await c.callTool({ name: 'napcat_configure', arguments: { endpoint: 'ws://127.0.0.1:3002' } });
    expect(diskConfig().connection?.endpoint).toBe('ws://127.0.0.1:3002');
  });

  it('传入的端点自己带 query → 用传入的（不换回已存的）', async () => {
    const state = new AppState();
    state.clientOverride = stubClient();
    const c = await makeToolClient(state);

    await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'ws://127.0.0.1:3001?access_token=old' },
    });
    await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'ws://127.0.0.1:3001?access_token=new' },
    });
    expect(diskConfig().connection?.endpoint).toBe('ws://127.0.0.1:3001?access_token=new');
  });

  it('已存端点没有 query → 规范化候选照常落盘（行为不变）', async () => {
    const state = new AppState();
    state.clientOverride = stubClient();
    const c = await makeToolClient(state);

    await c.callTool({ name: 'napcat_configure', arguments: { endpoint: 'http://127.0.0.1:3000' } });
    await c.callTool({ name: 'napcat_configure', arguments: { endpoint: 'http://127.0.0.1:3000' } });
    expect(diskConfig().connection?.endpoint).toBe('http://127.0.0.1:3000');
  });

  it('已存端点带 userinfo → 规范化候选重配 → userinfo 也不被抹掉', async () => {
    // userinfo 与 query 是同一类凭据（规范化候选里都看不见）
    const state = new AppState();
    state.clientOverride = stubClient();
    const c = await makeToolClient(state);

    await c.callTool({
      name: 'napcat_configure',
      arguments: { endpoint: 'http://user:pass@127.0.0.1:3000' },
    });
    await c.callTool({ name: 'napcat_configure', arguments: { endpoint: 'http://127.0.0.1:3000' } });
    expect(diskConfig().connection?.endpoint).toBe('http://user:pass@127.0.0.1:3000');
  });
});

// ── F3：生效上限要出现在 notes 里 ────────────────────────────────────

describe('F3：盘根发现的生效上限写在 notes 里', () => {
  it('默认配置（maxRoots=32）→ notes 里有生效上限 32', () => {
    const cfg = { ...defaultConfig().autoDetect, paths: [], scanDrives: true, maxRoots: 32 };
    const { notes } = mergeDetectionRoots(cfg, {
      home: join(tmp, 'home'),
      platform: 'linux',
      env: {},
      driveRoots: [],
    });
    expect(notes.join('\n')).toContain('生效上限');
    expect(notes.join('\n')).toContain('32');
  });

  it('maxRoots 超过总量闸门 → 生效上限是 64（不是配置里的原始值）', () => {
    const cfg = { ...defaultConfig().autoDetect, paths: [], scanDrives: true, maxRoots: 999 };
    const { notes } = mergeDetectionRoots(cfg, {
      home: join(tmp, 'home'),
      platform: 'linux',
      env: {},
      driveRoots: [],
    });
    expect(notes.join('\n')).toContain('生效上限 64');
  });

  it('盘根发现关闭时 → 说明「已关闭」，不谎报上限', () => {
    const cfg = { ...defaultConfig().autoDetect, paths: [], scanDrives: false };
    const { notes } = mergeDetectionRoots(cfg, {
      home: join(tmp, 'home'),
      platform: 'linux',
      env: {},
      driveRoots: [],
    });
    expect(notes.join('\n')).toContain('已关闭');
    expect(notes.join('\n')).not.toContain('生效上限');
  });
});

// ── F4：HTTP 活端口的 ws 孪生端点不是候选 ────────────────────────────

describe('F4：活着的 HTTP 端口，其 ws:// 孪生端点不进候选', () => {
  it('HTTP 服务在跑 → ws 变体被剔除，候选只剩 HTTP 那个', async () => {
    const fake = await startFakeOneBot();
    try {
      const state = new AppState();
      state.config.autoDetect.ports = [fake.port];
      state.config.autoDetect.endpoints = [];
      state.config.autoDetect.paths = [];
      state.config.autoDetect.scanDrives = false;
      state.config.autoDetect.probeTimeoutMs = 1200;
      const p = await detectLocalWithInstalls(state);

      const http = `http://127.0.0.1:${fake.port}`;
      const ws = `ws://127.0.0.1:${fake.port}`;
      expect(p.live.some((e: { endpoint: string }) => e.endpoint === http)).toBe(true);
      // ← 关键：ws 变体不在候选里（面板的候选 = live + tokenRequired）
      expect(p.tokenRequired.some((e: { endpoint: string }) => e.endpoint === ws)).toBe(false);
      expect(p.notes.join('\n')).toContain(ws);
    } finally {
      await fake.close();
    }
  });

  it('面板侧的候选列表（live + tokenRequired）里只剩 HTTP 那个', async () => {
    // 面板的候选 = live + tokenRequired；服务端剔除后，这里自然只剩 HTTP 端点
    const fake = await startFakeOneBot();
    try {
      const state = new AppState();
      state.config.autoDetect.ports = [fake.port];
      state.config.autoDetect.endpoints = [];
      state.config.autoDetect.paths = [];
      state.config.autoDetect.scanDrives = false;
      const p = await detectLocalWithInstalls(state);
      const candidates = [...p.live, ...p.tokenRequired].map((e: { endpoint: string }) => e.endpoint);
      expect(candidates).toEqual([`http://127.0.0.1:${fake.port}`]);
    } finally {
      await fake.close();
    }
  });
});

// ── F5：安装发现的说明要进顶层 notes ─────────────────────────────────

describe('F5：安装发现的说明进顶层 notes', () => {
  it('端点数被截断 → 顶层 notes 里能看到（面板只渲染顶层 notes）', async () => {
    const installDir = join(tmp, 'NapCatInstall');
    mkdirSync(installDir, { recursive: true });
    // 8 个端点 > 每个安装目录的上限（6）→ 安装发现模块会给出截断说明
    writeFileSync(
      join(installDir, 'onebot11_12345.json'),
      JSON.stringify({
        network: {
          httpServers: Array.from({ length: 8 }, (_, i) => ({
            enable: true,
            host: '127.0.0.1',
            port: 30000 + i,
            name: `http-${i}`,
          })),
          websocketServers: [],
        },
      }),
    );
    const state = new AppState();
    state.config.autoDetect.ports = [];
    state.config.autoDetect.endpoints = [];
    state.config.autoDetect.paths = [installDir];
    state.config.autoDetect.scanDrives = false;
    const p = await detectLocalWithInstalls(state);
    expect(p.notes.join('\n')).toContain('端点数超过每个安装目录的上限');
    expect(p.notes.join('\n')).toContain('已截断');
  });
});

// ── F7：探测结论的过期竞态 ──────────────────────────────────────────

describe('F7：探测期间配置变了 → 结论作废', () => {
  it('指纹对不上 → 结论不写回缓存', async () => {
    const hole = await startBlackHole();
    try {
      const state = new AppState();
      state.config.autoDetect.ports = [hole.port];
      state.config.autoDetect.endpoints = [];
      state.config.autoDetect.paths = [];
      state.config.autoDetect.scanDrives = false;
      state.config.autoDetect.probeTimeoutMs = 800;

      // 探测开始（黑洞端口 → 这轮探测要耗掉一个探测超时）
      const inflight = detectLocalOnce(state);
      // 探测进行中：用户改了配置（指纹变了）
      state.setAutoDetectPaths([join(tmp, 'NapCat')]);

      const { fingerprint } = await inflight;
      const kept = state.setDetection(
        { found: false, napcatRunning: false },
        fingerprint,
      );
      expect(kept).toBe(false);
      expect(state.detection).toBeUndefined();
    } finally {
      await hole.close();
    }
  });

  it('工具路径：探测期间改了配置 → status 里没有过期结论', async () => {
    const hole = await startBlackHole();
    try {
      writeFileSync(
        join(tmp, 'config.json'),
        JSON.stringify({
          connection: { endpoint: '', token: '' },
          autoDetect: {
            ports: [hole.port],
            endpoints: [],
            paths: [],
            probeTimeoutMs: 1200,
            scanDrives: false,
            maxRoots: 0,
          },
        }),
      );
      const state = new AppState();
      state.clientOverride = stubClient();
      const c = await makeToolClient(state);

      const detectPromise = c.callTool({ name: 'napcat_detect_local', arguments: {} });
      // 让探测先跑起来（黑洞端口会把它拖到探测超时）
      await new Promise((r) => setTimeout(r, 100));
      // 探测进行中改配置
      const cfg = await c.callTool({
        name: 'napcat_configure',
        arguments: { endpoint: 'http://127.0.0.1:39999' },
      });
      expect(isError(cfg)).toBe(false);

      const d = payload(await detectPromise);
      expect(d.notes.join('\n')).toContain('过期');
      const s = payload(await c.callTool({ name: 'napcat_status', arguments: {} }));
      expect(s.detection).toBeUndefined();
    } finally {
      await hole.close();
    }
  });
});

// ── F10：live 也要裁剪 ──────────────────────────────────────────────

describe('F10：探测成功的端点（live）也要裁剪', () => {
  it('25 个可用端点 → live 只展示 20 条，其余在 notes 里给计数', async () => {
    const fake = await startFakeOneBot();
    try {
      const state = new AppState();
      state.config.autoDetect.ports = [];
      // 同一个假服务、不同路径 → 25 个各自独立的候选，且全都探测成功
      state.config.autoDetect.endpoints = Array.from(
        { length: 25 },
        (_, i) => `http://127.0.0.1:${fake.port}/n${i}`,
      );
      state.config.autoDetect.paths = [];
      state.config.autoDetect.scanDrives = false;
      const p = await detectLocalWithInstalls(state);
      expect(p.live.length).toBe(MAX_LIVE);
      expect(p.notes.join('\n')).toMatch(/探测成功的端点共 \d+ 条/);
    } finally {
      await fake.close();
    }
  });
});
