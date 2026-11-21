/**
 * M2 Task 2：本机 NapCat 安装与配置发现。
 *
 * 用例全部在**临时目录**里造出真实的 NapCat 目录结构（不依赖本机真实的 NapCat 路径）。
 *
 * 结构参照 NapCat Shell/Framework 的真实布局：
 *   <安装目录>/config/onebot11_<uin>.json   每个账号一份 OneBot 11 配置
 *   <安装目录>/config/webui.json            WebUI 配置（host/port/token/disableWebUI）
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultNapCatRoots,
  findLocalNapCat,
  installPathsOf,
  MAX_ENDPOINTS_PER_INSTALL,
  MAX_ENDPOINTS_TOTAL,
  toInstallCandidates,
  type InstalledNapCat,
} from '../src/server/host/local-napcat.js';

/**
 * 模拟「目录不可读」（EACCES）。
 *
 * Windows 上 `chmod` 不生效，用权限位制造不可读目录并不可移植——
 * 改为在 fs 层面直接抛 EACCES，与真实权限错误同形。
 */
const fsState = vi.hoisted(() => ({ denied: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: (...args: unknown[]) => {
      const target = String(args[0]);
      if (fsState.denied.some((d) => target.includes(d))) {
        const err = new Error(`EACCES: permission denied, scandir '${target}'`) as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return (actual.readdirSync as (...a: unknown[]) => unknown)(...args);
    },
  };
});

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'napcat-local-'));
  fsState.denied = [];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  fsState.denied = [];
});

/** 造一个 NapCat 账号配置文件，返回它的绝对路径。 */
function writeOnebotConfig(dir: string, name: string, config: unknown): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, typeof config === 'string' ? config : `${JSON.stringify(config, null, 2)}\n`);
  return p;
}

/** 一个 HTTP server 项。 */
function httpServer(port: number, host = '127.0.0.1', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { enable: true, name: `http-${port}`, host, port, messagePostFormat: 'array', token: '', ...extra };
}

/** 一个 WebSocket server 项。 */
function wsServer(port: number, host = '127.0.0.1', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { enable: true, name: `ws-${port}`, host, port, messagePostFormat: 'array', token: '', ...extra };
}

describe('findLocalNapCat', () => {
  it('reads the http endpoint out of an onebot11 config and rewrites 0.0.0.0 to loopback', () => {
    const root = join(tmp, 'NapCat');
    const configDir = join(root, 'config');
    const file = writeOnebotConfig(configDir, 'onebot11_123.json', {
      network: {
        httpServers: [httpServer(3000, '0.0.0.0', { token: 'onebot-secret-token' })],
        websocketServers: [wsServer(3001, '127.0.0.1', { enable: false })],
      },
    });

    const found = findLocalNapCat([root]);

    expect(found).toHaveLength(1);
    const inst = found[0];
    expect(inst.configDir).toBe(configDir);
    expect(inst.onebotConfigs).toEqual([file]);
    // 0.0.0.0（监听所有网卡）被改写成回环
    expect(inst.endpoints).toHaveLength(1);
    expect(inst.endpoints[0].endpoint).toBe('http://127.0.0.1:3000');
    expect(inst.endpoints[0].transport).toBe('http');
    expect(inst.endpoints[0].rewrittenToLoopback).toBe(true);
    // 禁用的 ws server 被排除
    expect(inst.endpoints.some((e) => e.endpoint.includes('3001'))).toBe(false);
    // OneBot access token 不进返回值
    expect(JSON.stringify(inst)).not.toContain('onebot-secret-token');
  });

  it('keeps http and ws on the same port as two separate candidates', () => {
    const root = join(tmp, 'NapCat');
    writeOnebotConfig(join(root, 'config'), 'onebot11_123.json', {
      network: {
        httpServers: [httpServer(3000)],
        websocketServers: [wsServer(3000)],
      },
    });

    const found = findLocalNapCat([root]);

    expect(found).toHaveLength(1);
    const endpoints = found[0].endpoints;
    expect(endpoints).toHaveLength(2);
    const byScheme = new Map(endpoints.map((e) => [e.endpoint, e.transport]));
    expect(byScheme.get('http://127.0.0.1:3000')).toBe('http');
    expect(byScheme.get('ws://127.0.0.1:3000')).toBe('ws');
    // scheme 与 transport 必须一致（Task 1 按 scheme 重算 transport）
    for (const e of endpoints) {
      expect(e.transport).toBe(e.endpoint.startsWith('ws') ? 'ws' : 'http');
    }
  });

  it('rewrites the ipv6 wildcard host to the ipv6 loopback', () => {
    const root = join(tmp, 'NapCat');
    writeOnebotConfig(join(root, 'config'), 'onebot11_123.json', {
      network: { httpServers: [httpServer(3000, '::')], websocketServers: [] },
    });

    const found = findLocalNapCat([root]);

    expect(found[0].endpoints[0].endpoint).toBe('http://[::1]:3000');
    expect(found[0].endpoints[0].rewrittenToLoopback).toBe(true);
  });

  it('keeps a non-loopback host as-is and marks it instead of silently rewriting it', () => {
    const root = join(tmp, 'NapCat');
    writeOnebotConfig(join(root, 'config'), 'onebot11_123.json', {
      network: { httpServers: [httpServer(3000, '192.168.1.20')], websocketServers: [] },
    });

    const found = findLocalNapCat([root]);

    const ep = found[0].endpoints[0];
    expect(ep.endpoint).toBe('http://192.168.1.20:3000');
    expect(ep.nonLoopback).toBe(true);
    expect(ep.rewrittenToLoopback).toBeUndefined();
  });

  it('reads the webui port but never exposes the webui token', () => {
    const root = join(tmp, 'NapCat');
    const configDir = join(root, 'config');
    writeOnebotConfig(configDir, 'onebot11_123.json', {
      network: { httpServers: [httpServer(3000)], websocketServers: [] },
    });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'webui.json'),
      `${JSON.stringify({ host: '127.0.0.1', port: 6099, token: 'webui-secret-token', disableWebUI: false })}\n`,
    );

    const found = findLocalNapCat([root]);

    expect(found[0].webui?.port).toBe(6099);
    expect(found[0].webui?.tokenRequired).toBe(true);
    // token 明文不进返回值
    expect(JSON.stringify(found[0])).not.toContain('webui-secret-token');
    expect(found[0].webui?.token).toBeUndefined();
  });

  it('finds the configs of multiple accounts', () => {
    const root = join(tmp, 'NapCat');
    const configDir = join(root, 'config');
    writeOnebotConfig(configDir, 'onebot11_111.json', {
      network: { httpServers: [httpServer(3000)], websocketServers: [] },
    });
    writeOnebotConfig(configDir, 'onebot11_222.json', {
      network: { httpServers: [httpServer(3010)], websocketServers: [] },
    });

    const found = findLocalNapCat([root]);

    expect(found).toHaveLength(1);
    expect(found[0].onebotConfigs).toHaveLength(2);
    expect(found[0].onebotConfigs.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual([
      'onebot11_111.json',
      'onebot11_222.json',
    ]);
    expect(found[0].endpoints.map((e) => e.endpoint).sort()).toEqual([
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3010',
    ]);
  });

  it('returns an empty array when there is no napcat at all', () => {
    const root = join(tmp, 'NapCat');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'readme.txt'), 'nothing to see here');

    expect(findLocalNapCat([root])).toEqual([]);
    expect(findLocalNapCat([join(tmp, 'does-not-exist')])).toEqual([]);
  });

  it('skips unreadable directories instead of throwing', () => {
    const root = join(tmp, 'NapCat');
    const configDir = join(root, 'config');
    writeOnebotConfig(configDir, 'onebot11_123.json', {
      network: { httpServers: [httpServer(3000)], websocketServers: [] },
    });

    fsState.denied = [configDir];
    let found: ReturnType<typeof findLocalNapCat> = [];
    expect(() => {
      found = findLocalNapCat([root]);
    }).not.toThrow();
    expect(found).toEqual([]);

    // 根目录本身不可读 → 同样跳过
    fsState.denied = [root];
    expect(() => findLocalNapCat([root])).not.toThrow();
    expect(findLocalNapCat([root])).toEqual([]);
  });

  it('skips corrupted json instead of throwing', () => {
    const root = join(tmp, 'NapCat');
    writeOnebotConfig(join(root, 'config'), 'onebot11_123.json', '{ this is not json');

    let found: ReturnType<typeof findLocalNapCat> = [];
    expect(() => {
      found = findLocalNapCat([root]);
    }).not.toThrow();
    expect(found.flatMap((i) => i.endpoints)).toEqual([]);
  });

  it('does not descend deeper than two levels', () => {
    const root = join(tmp, 'NapCat');
    // 两层深（<root>/config/xxx.json）→ 应被找到
    writeOnebotConfig(join(root, 'config'), 'onebot11_123.json', {
      network: { httpServers: [httpServer(3000)], websocketServers: [] },
    });
    // 三层深（<root>/a/b/xxx.json）→ 不该被找到
    writeOnebotConfig(join(root, 'a', 'b'), 'onebot11_456.json', {
      network: { httpServers: [httpServer(4000)], websocketServers: [] },
    });

    const found = findLocalNapCat([root]);

    expect(found).toHaveLength(1);
    expect(found[0].onebotConfigs).toHaveLength(1);
    expect(found[0].onebotConfigs[0]).toContain('onebot11_123.json');
    expect(found[0].onebotConfigs[0]).not.toContain('onebot11_456.json');
    expect(found[0].endpoints.map((e) => e.endpoint)).toEqual(['http://127.0.0.1:3000']);
  });

  it('truncates the endpoints when the limit is exceeded and says so', () => {
    const rootA = join(tmp, 'A');
    const rootB = join(tmp, 'B');
    const servers = (from: number) =>
      Array.from({ length: 8 }, (_, i) => httpServer(from + i));
    writeOnebotConfig(join(rootA, 'config'), 'onebot11_1.json', {
      network: { httpServers: servers(3001), websocketServers: [] },
    });
    writeOnebotConfig(join(rootB, 'config'), 'onebot11_2.json', {
      network: { httpServers: servers(4001), websocketServers: [] },
    });

    const found = findLocalNapCat([rootA, rootB]);

    const total = found.reduce((n, i) => n + i.endpoints.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_ENDPOINTS_TOTAL);
    expect(total).toBe(MAX_ENDPOINTS_TOTAL);
    // 每个安装目录的上限
    expect(found[0].endpoints.length).toBe(MAX_ENDPOINTS_PER_INSTALL);
    // 截断必须被说明
    const truncated = found.filter((i) => i.truncated);
    expect(truncated.length).toBeGreaterThan(0);
    for (const i of truncated) {
      expect((i.notes ?? []).join(' ')).toMatch(/截断/);
    }
  });

  it('ignores servers with an unusable port but keeps a numeric string port', () => {
    const root = join(tmp, 'NapCat');
    writeOnebotConfig(join(root, 'config'), 'onebot11_123.json', {
      network: {
        httpServers: [
          { enable: true, name: 'ok', host: '127.0.0.1', port: 3000 },
          { enable: true, name: 'string-port', host: '127.0.0.1', port: '3010' },
          { enable: true, name: 'bool-port', host: '127.0.0.1', port: true },
          { enable: true, name: 'no-port', host: '127.0.0.1' },
          { enable: true, name: 'bad-port', host: '127.0.0.1', port: 99999 },
        ],
        websocketServers: [],
      },
    });

    const found = findLocalNapCat([root]);

    expect(found[0].endpoints.map((e) => e.endpoint)).toEqual([
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3010',
    ]);
  });

  it('never throws on a garbage roots argument', () => {
    expect(() => findLocalNapCat(undefined as unknown as string[])).not.toThrow();
    expect(findLocalNapCat(undefined as unknown as string[])).toEqual([]);
    expect(findLocalNapCat(['', '   ', 123 as unknown as string])).toEqual([]);
  });
});

describe('defaultNapCatRoots', () => {
  it('lists the platform independent roots on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      const roots = defaultNapCatRoots('/home/u', platform);
      expect(roots).toContain(join('/home/u', '.napcat'));
      expect(roots).toContain(join('/home/u', 'NapCat'));
      expect(roots).toContain(join('/home/u', '.config', 'napcat'));
    }
  });

  it('lists the windows specific roots on windows only', () => {
    const env = {
      APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      USERPROFILE: 'C:\\Users\\u',
    };
    const win = defaultNapCatRoots('C:\\Users\\u', 'win32', env);
    expect(win).toContain(join(env.APPDATA, 'NapCat'));
    expect(win).toContain(join(env.LOCALAPPDATA, 'NapCat'));
    expect(win).toContain(join(env.ProgramFiles, 'NapCat'));
    expect(win).toContain(join(env['ProgramFiles(x86)'], 'NapCat'));
    expect(win).toContain(join('C:\\Users\\u', 'AppData', 'Roaming', 'NapCatQQ'));

    const linux = defaultNapCatRoots('/home/u', 'linux', env);
    expect(linux).not.toContain(join(env.APPDATA, 'NapCat'));
  });

  it('lists the mac/linux specific roots on non-windows platforms', () => {
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const roots = defaultNapCatRoots('/home/u', platform);
      expect(roots).toContain(join('/home/u', 'Library', 'Application Support', 'NapCat'));
      expect(roots).toContain(join('/home/u', '.local', 'share', 'NapCat'));
    }
  });

  it('never returns duplicates', () => {
    const roots = defaultNapCatRoots('/home/u', 'win32', {
      APPDATA: '/home/u/AppData/Roaming',
      LOCALAPPDATA: '/home/u/AppData/Local',
      USERPROFILE: '/home/u',
    });
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describe('install candidate handoff', () => {
  it('maps the discovered endpoints into detect candidates with source install', () => {
    const root = join(tmp, 'NapCat');
    const configDir = join(root, 'config');
    const file = writeOnebotConfig(configDir, 'onebot11_123.json', {
      network: {
        httpServers: [httpServer(3000, '0.0.0.0')],
        websocketServers: [wsServer(3000)],
      },
    });

    const candidates = toInstallCandidates(findLocalNapCat([root]));

    expect(candidates).toHaveLength(2);
    for (const c of candidates) {
      expect(c.source).toBe('install');
      expect(c.detail).toBe(file);
      // scheme 是权威：transport 必须与 endpoint 的 scheme 一致
      expect(c.transport).toBe(c.endpoint.startsWith('ws') ? 'ws' : 'http');
    }
    expect(candidates.map((c) => c.endpoint).sort()).toEqual([
      'http://127.0.0.1:3000',
      'ws://127.0.0.1:3000',
    ]);
  });

  it('exposes the scanned config paths', () => {
    const root = join(tmp, 'NapCat');
    const configDir = join(root, 'config');
    const file = writeOnebotConfig(configDir, 'onebot11_123.json', {
      network: { httpServers: [httpServer(3000)], websocketServers: [] },
    });

    const paths = installPathsOf(findLocalNapCat([root]));

    expect(paths).toContain(configDir);
    expect(paths).toContain(file);
  });

  it('never throws on garbage input', () => {
    expect(toInstallCandidates(undefined as unknown as InstalledNapCat[])).toEqual([]);
    expect(installPathsOf(undefined as unknown as InstalledNapCat[])).toEqual([]);
  });
});

describe('module hygiene', () => {
  it('does not read anything outside the given roots', () => {
    const root = join(tmp, 'NapCat');
    writeOnebotConfig(join(root, 'config'), 'onebot11_123.json', {
      network: { httpServers: [httpServer(3000)], websocketServers: [] },
    });
    const before = readdirSync(tmp).length;

    findLocalNapCat([root]);

    expect(readdirSync(tmp).length).toBe(before);
  });
});
