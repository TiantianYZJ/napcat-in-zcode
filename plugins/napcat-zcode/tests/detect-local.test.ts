import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AppState } from '../src/server/state.js';
import { registerTools } from '../src/server/tools.js';
import {
  detectLocalWithInstalls,
  mergeDetectionRoots,
  pickWebuiPort,
  redactDetectResult,
  trimFailedBySource,
  MAX_CANDIDATES,
  MAX_SCANNED_PORTS,
} from '../src/server/host/detect-local.js';
import { defaultConfig } from '../src/server/config.js';
import type { DetectCandidate, DetectResult } from '../src/server/onebot/detect.js';
import type { InstalledNapCat } from '../src/server/host/local-napcat.js';

/**
 * M2 Task 4：`napcat_detect_local` 工具 + `napcat_status` 的 detection 集成。
 *
 * 这里覆盖三层：
 * ① 工具契约（返回形状、描述、参数为空）；
 * ② 与 `napcat_status` 的缓存集成（探测前不返回、探测后返回、配置成功后清除）；
 * ③ 编排层的硬约束（根来源优先级、WebUI 端口选取、脱敏、预算耗尽、失败桶裁剪、丢弃端点可见）。
 */

// ── 假 OneBot ────────────────────────────────────────────────────────

interface FakeServer {
  port: number;
  /** 收到的请求数（用来断言「状态查询没有触发端口扫描」）。 */
  requests: number;
  close: () => Promise<void>;
}

interface FakeReply {
  status?: string;
  retcode?: number;
  wording?: string;
  message?: string;
  data?: unknown;
}

async function startFakeOneBot(reply?: (action: string) => FakeReply): Promise<FakeServer> {
  const state = { requests: 0 };
  const server = createServer((req, res) => {
    state.requests += 1;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const action = (req.url || '').split('?')[0].slice(1);
      const r = reply ? reply(action) : { data: { user_id: 2350355494, nickname: '探测测试号' } };
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          status: r.status ?? 'ok',
          retcode: r.retcode ?? 0,
          wording: r.wording,
          message: r.message,
          data: r.data,
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    get requests() {
      return state.requests;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** 「黑洞」TCP 服务：接受连接但永不应答（用来把探测拖到超时）。 */
async function startBlackHole(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: Array<{ destroy: () => void }> = [];
  const server = createTcpServer((socket) => {
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

/** 找一个「确定没人监听」的端口（绑定后立刻关掉）。 */
async function closedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

// ── 工具客户端 ───────────────────────────────────────────────────────

async function makeToolClient(state: AppState): Promise<Client> {
  const server = new McpServer({ name: 'napcat', version: '0.1.0' });
  registerTools(server, state);
  const client = new Client({ name: 'test', version: '0.0.1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return client;
}

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

// AppState 构造时读插件数据目录 → 测试里统一指向临时目录。
let tmp: string;
const ENV_KEYS = ['ZCODE_PLUGIN_DATA', 'NAPCAT_EXPORT_DIR', 'NAPCAT_INCLUDE_IMAGES'] as const;
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'napcat-detect-'));
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

/** 写 config.json（探测范围完全由它决定）。 */
function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(join(tmp, 'config.json'), JSON.stringify(cfg));
}

/** 只关心 autoDetect 的配置写法。 */
function autoDetectConfig(autoDetect: Record<string, unknown>, connection?: Record<string, unknown>): void {
  writeConfig({ connection: connection ?? { endpoint: '', token: '' }, autoDetect });
}

describe('napcat_detect_local 工具契约', () => {
  it('registers the tool with an empty input schema and declares its scope', async () => {
    const state = new AppState();
    const c = await makeToolClient(state);
    const list = await c.listTools();
    const tool = list.tools.find((t) => t.name === 'napcat_detect_local');
    expect(tool).toBeDefined();
    // C10：探测范围完全由配置决定 → 不接受任何参数
    expect(tool?.inputSchema).toMatchObject({ type: 'object' });
    expect(Object.keys((tool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})).toEqual([]);
    // C8：描述必须写明探测范围（agent 只看得到 description）
    expect(tool?.description).toContain('只探测回环地址与用户显式配置的端点');
    expect(tool?.description).toContain('不扫描网络');
  });

  it('finds a running OneBot on a configured port', async () => {
    const fake = await startFakeOneBot();
    // WebUI 探测端口既不能硬编 6099（NapCat 可改），也不能依赖「本机恰好没有 NapCat 在跑」
    // ——用一份「已被发现、但端口没在监听」的安装配置把探测端口钉死，结果与本机环境无关。
    const webuiPort = await closedPort();
    const installDir = join(tmp, 'NapCatInstall');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'onebot11_12345.json'),
      JSON.stringify({
        network: {
          httpServers: [{ enable: true, host: '127.0.0.1', port: fake.port, name: 'http' }],
          websocketServers: [],
        },
      }),
    );
    writeFileSync(
      join(installDir, 'webui.json'),
      JSON.stringify({ host: '127.0.0.1', port: webuiPort, token: 't', disableWebUI: false }),
    );
    try {
      autoDetectConfig({
        ports: [fake.port],
        endpoints: [],
        paths: [installDir],
        probeTimeoutMs: 1200,
        scanDrives: false,
        maxRoots: 0,
      });
      const state = new AppState();
      const c = await makeToolClient(state);
      const r = await c.callTool({ name: 'napcat_detect_local', arguments: {} });
      expect(isError(r)).toBe(false);
      const p = payload(r);
      expect(p.found).toBe(true);
      expect(p.live[0].endpoint).toBe(`http://127.0.0.1:${fake.port}`);
      expect(p.live[0].login.nickname).toBe('探测测试号');
      expect(p.napcatRunning).toBe(false); // 探测的是上面那个没人监听的端口
      // WebUI 端口来自安装配置，不是硬编 6099
      // （顶层 webuiPort 只在「NapCat 在跑」时才有值，这里看的是安装项上报的端口）
      expect(p.installs[0].webuiPort).toBe(webuiPort);
    } finally {
      await fake.close();
    }
  });

  it('probes the endpoint discovered in a local NapCat install', async () => {
    const fake = await startFakeOneBot();
    try {
      const installDir = join(tmp, 'NapCatInstall');
      mkdirSync(installDir, { recursive: true });
      writeFileSync(
        join(installDir, 'onebot11_12345.json'),
        JSON.stringify({
          network: {
            httpServers: [{ enable: true, host: '127.0.0.1', port: fake.port, name: 'http' }],
            websocketServers: [],
          },
        }),
      );
      autoDetectConfig({
        ports: [],
        endpoints: [],
        paths: [installDir],
        probeTimeoutMs: 1200,
        scanDrives: false,
        maxRoots: 0,
      });
      const state = new AppState();
      const c = await makeToolClient(state);
      const p = payload(await c.callTool({ name: 'napcat_detect_local', arguments: {} }));
      expect(p.found).toBe(true);
      const installLive = p.live.find((c: DetectCandidate) => c.source === 'install');
      expect(installLive?.endpoint).toBe(`http://127.0.0.1:${fake.port}`);
      expect(p.installs.length).toBe(1);
      expect(p.installs[0].endpoints).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it('reports the install endpoints that the loopback gate dropped', async () => {
    // C9：非回环端点会被回环闸门静默丢弃 —— 面板必须能看到「为什么我配的端点没出现」
    const installDir = join(tmp, 'NapCatInstall');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(
      join(installDir, 'onebot11_12345.json'),
      JSON.stringify({
        network: {
          httpServers: [{ enable: true, host: '192.168.1.50', port: 3000, name: 'http' }],
          websocketServers: [],
        },
      }),
    );
    autoDetectConfig({
      ports: [],
      endpoints: [],
      paths: [installDir],
      probeTimeoutMs: 1200,
      scanDrives: false,
      maxRoots: 0,
    });
    const state = new AppState();
    const c = await makeToolClient(state);
    const p = payload(await c.callTool({ name: 'napcat_detect_local', arguments: {} }));
    expect(p.droppedEndpoints.length).toBe(1);
    expect(p.droppedEndpoints[0].endpoint).toBe('http://192.168.1.50:3000');
    expect(p.droppedEndpoints[0].reason).toBe('nonLoopback');
    expect(p.installs[0].nonLoopbackEndpoints).toBe(1);
    expect(p.notes.join('\n')).toContain('192.168.1.50:3000');
  });
});

describe('napcat_detect_local 的脱敏（C3）', () => {
  it('never echoes the configured token back, even when the upstream echoes it raw', async () => {
    // 上游把 token **原样**回显（没有 `token=` / `Bearer` 前缀）→
    // 探测内核自己的三种形态挡不住，只能靠 state.redact 兜底。
    const secret = 'super-secret-token';
    const fake = await startFakeOneBot(() => ({
      status: 'failed',
      retcode: 1404,
      wording: `invalid token ${secret}`,
    }));
    try {
      autoDetectConfig(
        { ports: [fake.port], endpoints: [], paths: [], probeTimeoutMs: 1200, scanDrives: false, maxRoots: 0 },
        { endpoint: '', token: secret },
      );
      const state = new AppState();
      const c = await makeToolClient(state);
      const r = await c.callTool({ name: 'napcat_detect_local', arguments: {} });
      expect(toolText(r)).not.toContain(secret);
      expect(toolText(r)).toContain('***');
    } finally {
      await fake.close();
    }
  });

  it('redacts every error and detail string of a detect result', () => {
    const secret = 'super-secret-token';
    const state = new AppState();
    state.config.connection.token = secret;
    const result: DetectResult = {
      found: false,
      candidates: [
        { endpoint: 'http://127.0.0.1:3000', transport: 'http', source: 'port', detail: `端口 ${secret}` },
      ],
      live: [],
      failed: [
        { endpoint: 'http://127.0.0.1:3000', transport: 'http', source: 'port', error: `boom ${secret}` },
      ],
      tokenRequired: [
        { endpoint: 'http://127.0.0.1:3000', transport: 'http', source: 'port', error: `auth ${secret}`, needsToken: true },
      ],
      napcatRunning: false,
      scanned: { ports: [3000], paths: [], extraEndpoints: 0 },
    };
    const out = redactDetectResult(state, result);
    expect(JSON.stringify(out)).not.toContain(secret);
    expect(out.failed[0].error).toContain('***');
    expect(out.tokenRequired[0].error).toContain('***');
    expect(out.candidates[0].detail).toContain('***');
  });
});

describe('napcat_detect_local 的结论口径（C4/C5）', () => {
  it('marks an exhausted scan as incomplete instead of "not found"', async () => {
    // 预算耗尽 = 「没扫完」，与「扫完了没找到」是两回事
    const hole = await startBlackHole();
    try {
      const endpoints = Array.from({ length: 20 }, (_, i) => `http://127.0.0.1:${hole.port}/n${i}`);
      const state = new AppState();
      state.config.autoDetect.ports = [];
      state.config.autoDetect.endpoints = endpoints;
      state.config.autoDetect.paths = [];
      state.config.autoDetect.scanDrives = false;
      const p = await detectLocalWithInstalls(state, { budgetMs: 60 });
      expect(p.budgetExhausted).toBe(true);
      expect(p.notes.join('\n')).toContain('预算耗尽');
      expect(p.notes.join('\n')).toContain('结果可能不全');
    } finally {
      await hole.close();
    }
  });

  it('marks a timed-out candidate as unresponsive rather than plain failure', async () => {
    const hole = await startBlackHole();
    try {
      const state = new AppState();
      state.config.autoDetect.ports = [hole.port];
      state.config.autoDetect.endpoints = [];
      state.config.autoDetect.paths = [];
      state.config.autoDetect.scanDrives = false;
      state.config.autoDetect.probeTimeoutMs = 300;
      const p = await detectLocalWithInstalls(state, { budgetMs: 4000 });
      const timedOut = p.failed.filter((f: { unresponsive?: boolean }) => f.unresponsive === true);
      expect(timedOut.length).toBeGreaterThan(0);
    } finally {
      await hole.close();
    }
  });

  it('trims the failed bucket per source and reports the total in the notes', async () => {
    const port = await closedPort();
    const endpoints = Array.from({ length: 20 }, (_, i) => `http://127.0.0.1:${port}/n${i}`);
    const state = new AppState();
    state.config.autoDetect.ports = [];
    state.config.autoDetect.endpoints = endpoints;
    state.config.autoDetect.paths = [];
    state.config.autoDetect.scanDrives = false;
    const p = await detectLocalWithInstalls(state);
    expect(p.failed.filter((f: { source: string }) => f.source === 'config').length).toBe(5);
    expect(p.notes.join('\n')).toMatch(/失败候选共 \d+ 条/);
  });

  it('trims by source in the helper', () => {
    const items: Array<DetectCandidate & { error?: string }> = [
      ...Array.from({ length: 20 }, (_, i) => ({ endpoint: `http://127.0.0.1:${i}`, transport: 'http' as const, source: 'config' as const })),
      ...Array.from({ length: 3 }, (_, i) => ({ endpoint: `http://127.0.0.1:${100 + i}`, transport: 'http' as const, source: 'port' as const })),
    ];
    const { kept, dropped, total } = trimFailedBySource(items, 5);
    expect(total).toBe(23);
    expect(kept).toHaveLength(8); // config 5 + port 3
    expect(dropped).toBe(15);
  });
});

describe('napcat_detect_local 的根来源与 WebUI 端口（C1/C2）', () => {
  it('merges the three root sources with the user paths first', () => {
    const cfg = { ...defaultConfig().autoDetect, paths: ['D:\\my-napcat'], scanDrives: false };
    const { roots } = mergeDetectionRoots(cfg, { home: 'C:\\Users\\tester', platform: 'win32', env: {} });
    expect(roots[0]).toBe('D:\\my-napcat'); // ① 用户显式路径排最前
    expect(roots).toContain('C:\\Users\\tester\\.napcat'); // ② 默认位置
  });

  it('skips the drive scan when scanDrives is false', () => {
    const cfg = { ...defaultConfig().autoDetect, paths: [], scanDrives: false };
    const { roots, driveRoots } = mergeDetectionRoots(cfg, { home: '/home/tester', platform: 'linux', env: {} });
    expect(driveRoots).toEqual([]);
    expect(roots).toEqual([
      join('/home/tester', '.napcat'),
      join('/home/tester', 'NapCat'),
      join('/home/tester', '.config', 'napcat'),
      join('/home/tester', 'Library', 'Application Support', 'QQ', 'NapCat'),
      join('/home/tester', 'Library', 'Application Support', 'NapCat'),
      join('/home/tester', '.local', 'share', 'NapCat'),
    ]);
  });

  it('keeps the drive roots after the defaults and clamps maxRoots to the total gate', () => {
    // 假盘根：下面有一个名字像 NapCat 的目录 → 盘根发现会命中它
    const fakeDrive = join(tmp, 'fake-drive');
    mkdirSync(join(fakeDrive, 'NapCatApp'), { recursive: true });
    const cfg = { ...defaultConfig().autoDetect, paths: [], scanDrives: true, maxRoots: 999 };
    const { roots, driveRoots } = mergeDetectionRoots(cfg, {
      home: join(tmp, 'home'),
      platform: 'linux',
      env: {},
      driveRoots: [fakeDrive],
    });
    expect(driveRoots).toEqual([join(fakeDrive, 'NapCatApp')]);
    // 盘根发现的根排在默认位置之后（用户显式 → 默认位置 → 盘根发现）
    expect(roots.indexOf(join(fakeDrive, 'NapCatApp'))).toBeGreaterThan(roots.indexOf(join(tmp, 'home', '.napcat')));
  });

  it('prefers the WebUI port of an install that also has endpoints', () => {
    const installed: InstalledNapCat[] = [
      { configDir: '/a', onebotConfigs: [], endpoints: [], webui: { port: 7000 } },
      {
        configDir: '/b',
        onebotConfigs: ['/b/onebot11_1.json'],
        endpoints: [{ endpoint: 'http://127.0.0.1:3000', transport: 'http', detail: '/b' }],
        webui: { port: 7100 },
      },
    ];
    const { port, notes } = pickWebuiPort(installed);
    expect(port).toBe(7100);
    expect(notes.join('\n')).toContain('7000');
  });

  it('never uses a disabled WebUI as the probe port', () => {
    const installed: InstalledNapCat[] = [
      {
        configDir: '/a',
        onebotConfigs: ['/a/onebot11_1.json'],
        endpoints: [{ endpoint: 'http://127.0.0.1:3000', transport: 'http', detail: '/a' }],
        webui: { port: 7000, disabled: true },
      },
    ];
    const { port, notes } = pickWebuiPort(installed);
    expect(port).toBe(6099); // 回落到默认端口
    expect(notes.join('\n')).toContain('禁用');
  });
});

describe('napcat_status 的 detection 集成（C7）', () => {
  it('omits detection and does not scan before an explicit detection', async () => {
    const fake = await startFakeOneBot();
    try {
      autoDetectConfig({ ports: [fake.port], endpoints: [], paths: [], probeTimeoutMs: 1200, scanDrives: false, maxRoots: 0 });
      const state = new AppState();
      const c = await makeToolClient(state);

      const s = payload(await c.callTool({ name: 'napcat_status', arguments: {} }));
      expect(s.detection).toBeUndefined();
      expect(fake.requests).toBe(0); // 状态查询没有触发任何端口扫描

      const d = payload(await c.callTool({ name: 'napcat_detect_local', arguments: {} }));
      expect(d.found).toBe(true);
      expect(fake.requests).toBeGreaterThan(0); // 显式探测才真的探
    } finally {
      await fake.close();
    }
  });

  it('exposes the cached detection after a detection', async () => {
    const fake = await startFakeOneBot();
    try {
      autoDetectConfig({ ports: [fake.port], endpoints: [], paths: [], probeTimeoutMs: 1200, scanDrives: false, maxRoots: 0 });
      const state = new AppState();
      const c = await makeToolClient(state);
      await c.callTool({ name: 'napcat_detect_local', arguments: {} });

      const s = payload(await c.callTool({ name: 'napcat_status', arguments: {} }));
      expect(s.detection).toBeDefined();
      expect(s.detection.found).toBe(true);
      expect(s.detection.endpoint).toBe(`http://127.0.0.1:${fake.port}`);
      expect(typeof s.detection.napcatRunning).toBe('boolean');
    } finally {
      await fake.close();
    }
  });

  it('clears the cached detection after a successful configure', async () => {
    const fake = await startFakeOneBot();
    try {
      autoDetectConfig({ ports: [fake.port], endpoints: [], paths: [], probeTimeoutMs: 1200, scanDrives: false, maxRoots: 0 });
      const state = new AppState();
      const c = await makeToolClient(state);
      await c.callTool({ name: 'napcat_detect_local', arguments: {} });
      expect(payload(await c.callTool({ name: 'napcat_status', arguments: {} })).detection).toBeDefined();

      const cfg = await c.callTool({
        name: 'napcat_configure',
        arguments: { endpoint: `http://127.0.0.1:${fake.port}`, token: 'tok' },
      });
      expect(isError(cfg)).toBe(false);
      expect(payload(await c.callTool({ name: 'napcat_status', arguments: {} })).detection).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  it('keeps the existing status fields untouched', async () => {
    const state = new AppState();
    const c = await makeToolClient(state);
    const s = payload(await c.callTool({ name: 'napcat_status', arguments: {} }));
    // 既有字段与语义不得改变（向后兼容）
    expect(s.configured).toBe(false);
    expect(s.connected).toBe(false);
    expect(s.mode).toBe('unconfigured');
  });
});

/**
 * 缓存失效（配置真的变了）+ 并发复用 + 出参上界 + 首次探测的 token 外泄缺口。
 *
 * 这几条都落在「探测结论」这条链路上：
 * - 结论是**针对某一份配置**得出的 → 配置变了就得失效；
 * - 结论的**产生**不能被并发调用放大成 N 份扫描；
 * - 结论的**体积**必须有上界；
 * - 结论里不能带出 token 明文。
 */
describe('探测缓存的失效条件（F1）', () => {
  it('clears the cached detection when configure points at an unreachable endpoint', async () => {
    // 端点**合法但连不上** → 配置已经落盘、内存态也换了 → 旧结论必须失效，
    // 否则面板会继续拿「针对旧配置」的结论说「检测到本机 NapCat」。
    const fake = await startFakeOneBot();
    const dead = await closedPort();
    try {
      autoDetectConfig({ ports: [fake.port], endpoints: [], paths: [], probeTimeoutMs: 1200, scanDrives: false, maxRoots: 0 });
      const state = new AppState();
      const c = await makeToolClient(state);
      await c.callTool({ name: 'napcat_detect_local', arguments: {} });
      expect(payload(await c.callTool({ name: 'napcat_status', arguments: {} })).detection).toBeDefined();

      const cfg = await c.callTool({ name: 'napcat_configure', arguments: { endpoint: `http://127.0.0.1:${dead}` } });
      expect(isError(cfg)).toBe(true); // 连不上 → 工具报错
      // 但配置已落盘 → 旧结论不能继续展示
      expect(payload(await c.callTool({ name: 'napcat_status', arguments: {} })).detection).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  it('drops the cached detection when autoDetect changed in config.json externally', async () => {
    const fake = await startFakeOneBot();
    try {
      autoDetectConfig({ ports: [fake.port], endpoints: [], paths: [], probeTimeoutMs: 1200, scanDrives: false, maxRoots: 0 });
      const state = new AppState();
      const c = await makeToolClient(state);
      await c.callTool({ name: 'napcat_detect_local', arguments: {} });
      expect(payload(await c.callTool({ name: 'napcat_status', arguments: {} })).detection).toBeDefined();

      // 外部改了 config.json（换了扫描端口）→ 旧结论已经对不上当前配置
      autoDetectConfig({ ports: [fake.port + 1], endpoints: [], paths: [], probeTimeoutMs: 1200, scanDrives: false, maxRoots: 0 });
      const s = payload(await c.callTool({ name: 'napcat_status', arguments: {} }));
      expect(s.detection).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  it('drops the cached detection when the configured endpoint changed in config.json externally', async () => {
    const fake = await startFakeOneBot();
    try {
      autoDetectConfig({ ports: [fake.port], endpoints: [], paths: [], probeTimeoutMs: 1200, scanDrives: false, maxRoots: 0 });
      const state = new AppState();
      const c = await makeToolClient(state);
      await c.callTool({ name: 'napcat_detect_local', arguments: {} });
      expect(payload(await c.callTool({ name: 'napcat_status', arguments: {} })).detection).toBeDefined();

      // 外部改了 config.json 的 connection（换了端点）→ 旧结论失效
      writeConfig({
        connection: { endpoint: `http://127.0.0.1:${fake.port}`, token: '' },
        autoDetect: { ports: [fake.port], endpoints: [], paths: [], probeTimeoutMs: 1200, scanDrives: false, maxRoots: 0 },
      });
      const s = payload(await c.callTool({ name: 'napcat_status', arguments: {} }));
      expect(s.detection).toBeUndefined();
    } finally {
      await fake.close();
    }
  });
});

describe('并发探测的复用（F2）', () => {
  it('probes the server only once when two detect calls overlap', async () => {
    // MCP SDK 并发处理请求 → 两次并发调用不能变成两次全盘扫描
    const fake = await startFakeOneBot();
    try {
      autoDetectConfig({ ports: [fake.port], endpoints: [], paths: [], probeTimeoutMs: 1200, scanDrives: false, maxRoots: 0 });
      const state = new AppState();
      const c = await makeToolClient(state);
      // 基线：一次探测会打几个请求（http 探测 + ws 握手探测都算）
      await c.callTool({ name: 'napcat_detect_local', arguments: {} });
      const baseline = fake.requests;
      expect(baseline).toBeGreaterThan(0);

      const before = fake.requests;
      const [r1, r2] = await Promise.all([
        c.callTool({ name: 'napcat_detect_local', arguments: {} }),
        c.callTool({ name: 'napcat_detect_local', arguments: {} }),
      ]);
      expect(isError(r1)).toBe(false);
      expect(isError(r2)).toBe(false);
      expect(payload(r1).found).toBe(true);
      expect(payload(r2).found).toBe(true);
      // 两次并发调用复用同一次探测 → 服务端只多挨**一遍**探测（而不是两遍）
      expect(fake.requests - before).toBe(baseline);
    } finally {
      await fake.close();
    }
  });
});

describe('探测出参的上界（F4）', () => {
  it('caps the candidate list and the scanned ports, and reports the totals in the notes', async () => {
    const state = new AppState();
    state.config.autoDetect.ports = Array.from({ length: 30 }, (_, i) => 20000 + i);
    state.config.autoDetect.endpoints = [];
    state.config.autoDetect.paths = [];
    state.config.autoDetect.scanDrives = false;
    const p = await detectLocalWithInstalls(state, { budgetMs: 60 });
    // 候选 = 2 × 端口数 + WebUI 端口 → 必须被截断
    expect(p.candidates.length).toBe(MAX_CANDIDATES);
    expect(p.scanned.ports.length).toBe(MAX_SCANNED_PORTS);
    expect(p.notes.join('\n')).toMatch(/候选端点共 \d+ 条/);
    expect(p.notes.join('\n')).toMatch(/扫描端口共 \d+ 个/);
  });
});

describe('首次探测的 token 外泄缺口（F5）', () => {
  it('never echoes a token that only appeared in the endpoint query', async () => {
    // 这个 token 本进程**没见过**（用户没配 token），只是写在端点的 query 里：
    // 规范化端点会剥掉 query，但上游可能把它**裸回显**出来。
    const secret = 'tk-9f2a7c1d';
    const fake = await startFakeOneBot(() => ({
      status: 'failed',
      retcode: 1404,
      wording: `invalid credential ${secret}`,
    }));
    try {
      autoDetectConfig({
        ports: [],
        endpoints: [`http://127.0.0.1:${fake.port}/?access_token=${secret}`],
        paths: [],
        probeTimeoutMs: 1200,
        scanDrives: false,
        maxRoots: 0,
      });
      const state = new AppState();
      const c = await makeToolClient(state);
      const r = await c.callTool({ name: 'napcat_detect_local', arguments: {} });
      expect(toolText(r)).not.toContain(secret);
      expect(toolText(r)).toContain('***');
    } finally {
      await fake.close();
    }
  });

  it('never echoes a bare token the process has never seen when the upstream demands auth', async () => {
    // 上游**裸回显**它自己持有的 token（没有 token= / Bearer 前缀）：
    // 探测内核的三种形态规则挡不住，本进程也没见过它 → 只能靠鉴权失败语境下的长串遮蔽。
    const secret = 'aB3dEf6hJ9kLm2nP5qR8sT1uV';
    const fake = await startFakeOneBot(() => ({
      status: 'failed',
      retcode: 1404,
      wording: `unauthorized ${secret}`,
    }));
    try {
      autoDetectConfig({
        ports: [],
        endpoints: [`http://127.0.0.1:${fake.port}`],
        paths: [],
        probeTimeoutMs: 1200,
        scanDrives: false,
        maxRoots: 0,
      });
      const state = new AppState();
      const c = await makeToolClient(state);
      const r = await c.callTool({ name: 'napcat_detect_local', arguments: {} });
      expect(toolText(r)).not.toContain(secret);
    } finally {
      await fake.close();
    }
  });
});
