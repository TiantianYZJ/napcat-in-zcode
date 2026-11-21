import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyEnvOverrides,
  dataDir,
  defaultConfig,
  loadConfig,
  loadConfigData,
  loadConfigWithRaw,
  saveConfig,
} from '../src/server/config.js';
import type { PluginConfig } from '../src/server/config.js';

// 只把 writeFileSync 换成可注入的 mock（默认透传），用于制造「写了一半才失败」的写入失败场景。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn((...args: Parameters<typeof actual.writeFileSync>) => actual.writeFileSync(...args)),
  };
});

let tmp: string;

const ENV_KEYS = ['ZCODE_PLUGIN_DATA', 'NAPCAT_EXPORT_DIR', 'NAPCAT_INCLUDE_IMAGES'] as const;
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'napcat-cfg-'));
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = envSnapshot[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe('config', () => {
  it('returns defaults when file absent', () => {
    const c = loadConfig(tmp);
    expect(c.connection.mode).toBe('auto');
    expect((c.export as Record<string, unknown>).maxChars).toBeUndefined();
    expect(c.inject.maxInjectChars).toBe(40000);
    expect(c.autoDetect.ports).toEqual([3000, 3001, 6099]);
  });

  it('deep-merges saved config over defaults', () => {
    saveConfig(tmp, { ...loadConfig(tmp), connection: { mode: 'external', endpoint: 'http://127.0.0.1:3000', token: 't' } });
    const c = loadConfig(tmp);
    expect(c.connection.endpoint).toBe('http://127.0.0.1:3000');
    expect(c.connection.token).toBe('t');
    expect(c.autoDetect.ports).toEqual([3000, 3001, 6099]); // 未覆盖项保留默认
  });

  it('falls back to defaults on corrupt json', () => {
    writeFileSync(join(tmp, 'config.json'), '{oops');
    const c = loadConfig(tmp);
    expect(c.inject.maxInjectChars).toBe(40000);
  });

  it('round-trips atomically', () => {
    const cfg = loadConfig(tmp);
    cfg.export.dir = 'workspace';
    saveConfig(tmp, cfg);
    expect(readFileSync(join(tmp, 'config.json'), 'utf-8')).toContain('"dir": "workspace"');
  });

  it('applies env overrides only for legal values', () => {
    const cfg = loadConfig(tmp);
    applyEnvOverrides(cfg, { NAPCAT_EXPORT_DIR: 'workspace', NAPCAT_INCLUDE_IMAGES: 'true' });
    expect(cfg.export.dir).toBe('workspace');
    expect(cfg.export.includeImages).toBe(true);
    // M1.1：'yes' 现在是**合法值**了（大小写不敏感的 true/false/1/0/yes/no/on/off），
    // 拿它当「非法值」示例会让断言恒真 → 换成真正非法的 'garbage'。
    applyEnvOverrides(cfg, { NAPCAT_EXPORT_DIR: 'bogus', NAPCAT_INCLUDE_IMAGES: 'garbage' });
    expect(cfg.export.dir).toBe('workspace'); // 非法值不覆盖
    expect(cfg.export.includeImages).toBe(true);
  });
});

describe('config hardening', () => {
  it('keeps defaults for wrongly typed fields in the file', () => {
    writeFileSync(
      join(tmp, 'config.json'),
      JSON.stringify({
        autoDetect: { ports: ['3000'] },
        export: { dir: 'bogus', includeImages: 'yes' },
        inject: { maxInjectChars: 'lots' },
        connection: { mode: 'weird', token: 42 },
      }),
    );
    const c = loadConfig(tmp);
    expect(c.autoDetect.ports).toEqual([3000, 3001, 6099]);
    expect(c.export.dir).toBe('user');
    expect(c.export.includeImages).toBe(false);
    expect(c.inject.maxInjectChars).toBe(40000);
    expect(c.connection.mode).toBe('auto');
    expect(c.connection.token).toBe('');
  });

  it('falls back to defaults when the file is not a config object', () => {
    for (const raw of ['5', 'null', '[]', '"str"']) {
      writeFileSync(join(tmp, 'config.json'), raw);
      const c = loadConfig(tmp);
      expect(c.connection.mode).toBe('auto');
      expect(c.inject.maxInjectChars).toBe(40000);
    }
  });

  it('ignores unknown keys', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ nope: 1, connection: { whatever: true } }));
    const c = loadConfig(tmp) as unknown as Record<string, unknown>;
    expect(c.nope).toBeUndefined();
    expect((c.connection as Record<string, unknown>).whatever).toBeUndefined();
  });

  it('does not let a file key reach the object prototype', () => {
    // 手写原始 JSON：对象字面量里的 __proto__ 不是自有属性，JSON.stringify 会把它抹掉。
    writeFileSync(join(tmp, 'config.json'), '{"__proto__": {"polluted": true}}');
    const c = loadConfig(tmp);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(c, '__proto__')).toBe(false);
  });

  it('ignores the constructor and prototype keys from the file', () => {
    writeFileSync(join(tmp, 'config.json'), '{"constructor": {"x": 1}, "prototype": {"y": 2}}');
    const c = loadConfig(tmp);
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(c, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(c, 'prototype')).toBe(false);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(({} as Record<string, unknown>).y).toBeUndefined();
  });

  it('drops invalid port entries but keeps legal ones', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ autoDetect: { ports: [3000, '3001', 0, 70000] } }));
    expect(loadConfig(tmp).autoDetect.ports).toEqual([3000]);
  });

  it('respects an explicitly empty port list', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ autoDetect: { ports: [] } }));
    expect(loadConfig(tmp).autoDetect.ports).toEqual([]);
  });

  it('filters non-string and blank endpoints', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ autoDetect: { endpoints: ['ws://a', '', '   ', 42, null] } }));
    expect(loadConfig(tmp).autoDetect.endpoints).toEqual(['ws://a']);
  });

  it('falls back to defaults for empty or non-string managed fields', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ managed: { napcatVersion: '', downloadMirror: 42 } }));
    const c = loadConfig(tmp);
    expect(c.managed.napcatVersion).toBe('4.18.42');
    expect(c.managed.downloadMirror).toBe('auto');
  });

  it('floors a fractional maxInjectChars', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ inject: { maxInjectChars: 1234.7 } }));
    expect(loadConfig(tmp).inject.maxInjectChars).toBe(1234);
  });

  it('creates the directory and leaves no temp file behind', () => {
    const nested = join(tmp, 'a', 'b');
    saveConfig(nested, defaultConfig());
    expect(existsSync(join(nested, 'config.json'))).toBe(true);
    expect(existsSync(join(nested, 'config.json.tmp'))).toBe(false);
    expect(readdirSync(nested)).toEqual(['config.json']); // 临时文件已 rename 掉
  });

  it('keeps the previous config when a save fails', () => {
    saveConfig(tmp, defaultConfig());
    const before = readFileSync(join(tmp, 'config.json'), 'utf-8');
    const circular = { ...defaultConfig() } as Record<string, unknown>;
    circular.self = circular; // 循环引用 → JSON.stringify 抛错
    expect(() => saveConfig(tmp, circular as unknown as PluginConfig)).toThrow();
    expect(readFileSync(join(tmp, 'config.json'), 'utf-8')).toBe(before);
    expect(readdirSync(tmp)).toEqual(['config.json']); // 连临时文件都没产生
  });

  it('cleans up the temp file when the rename fails and leaves the target untouched', () => {
    const target = join(tmp, 'config.json');
    mkdirSync(target); // 目标是个目录 → rename 必失败（Windows: EPERM，POSIX: EISDIR）
    expect(() => saveConfig(tmp, defaultConfig())).toThrow();
    expect(statSync(target).isDirectory()).toBe(true); // 旧目标未被破坏
    expect(readdirSync(tmp)).toEqual(['config.json']); // 临时文件已清理，不留含 token 的残片
  });

  it('removes a partially written temp file when the write fails', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(writeFileSync).mockImplementationOnce((path, _data, options) => {
      actual.writeFileSync(path, 'partial', options); // 先写一半，再失败（磁盘满等）
      throw new Error('disk full');
    });
    expect(() => saveConfig(tmp, defaultConfig())).toThrow('disk full');
    const written = String(vi.mocked(writeFileSync).mock.calls[0]?.[0]);
    expect(written).toContain(String(process.pid)); // 临时文件名带 pid（M4：多进程不互相覆盖）
    expect(existsSync(written)).toBe(false); // 半截文件已被清掉（M2）
    expect(existsSync(join(tmp, 'config.json'))).toBe(false); // 旧配置未被创建/破坏
    vi.mocked(writeFileSync).mockReset();
  });

  it('writes the config file with owner-only permissions', () => {
    if (process.platform === 'win32') return; // Windows 没有 POSIX 权限位
    saveConfig(tmp, defaultConfig());
    expect(statSync(join(tmp, 'config.json')).mode & 0o777).toBe(0o600);
  });

  it('ignores a leftover temp file', () => {
    writeFileSync(join(tmp, 'config.json.tmp'), JSON.stringify({ inject: { maxInjectChars: 1 } }));
    const c = loadConfig(tmp);
    expect(c.inject.maxInjectChars).toBe(40000);
  });

  it('round-trips every section through save and load', () => {
    const cfg = defaultConfig();
    cfg.connection = { mode: 'external', endpoint: 'http://127.0.0.1:6099', token: 'secret' };
    cfg.autoDetect = { ports: [3000, 8080], endpoints: ['ws://127.0.0.1:3001'] };
    cfg.managed = { napcatVersion: '4.18.43', downloadMirror: 'https://example.test/nc.zip' };
    cfg.export = { dir: 'workspace', includeImages: true };
    cfg.inject = { maxInjectChars: 1234 };
    saveConfig(tmp, cfg);
    expect(loadConfig(tmp)).toEqual(cfg);
  });

  it('prefers ZCODE_PLUGIN_DATA for the data dir', () => {
    process.env.ZCODE_PLUGIN_DATA = join(tmp, 'data');
    expect(dataDir()).toBe(join(tmp, 'data'));
    delete process.env.ZCODE_PLUGIN_DATA;
    expect(dataDir()).toBe(join(homedir(), '.zcode', 'napcat-zcode'));
  });

  // 微修轮 M2：宿主若把令牌**原样**注入（没做替换），直接拿它当目录名会造出
  // 一个名叫 `${ZCODE_PLUGIN_DATA}` 的字面量目录 —— 含 token 的配置会落到一个
  // 谁也猜不到的地方。含 `${` 一律视为未替换，回落默认目录。
  it('treats an unreplaced ${ZCODE_PLUGIN_DATA} token as unset', () => {
    process.env.ZCODE_PLUGIN_DATA = '${ZCODE_PLUGIN_DATA}';
    expect(dataDir()).toBe(join(homedir(), '.zcode', 'napcat-zcode'));
    process.env.ZCODE_PLUGIN_DATA = '${ZCODE_PLUGIN_DATA}/sub';
    expect(dataDir()).toBe(join(homedir(), '.zcode', 'napcat-zcode'));
    delete process.env.ZCODE_PLUGIN_DATA;
  });

  it('lets a legal env value override the file value without rewriting the file', () => {
    process.env.ZCODE_PLUGIN_DATA = tmp;
    const cfg = defaultConfig();
    cfg.export = { dir: 'workspace', includeImages: true };
    saveConfig(tmp, cfg);
    const onDisk = readFileSync(join(tmp, 'config.json'), 'utf-8');

    process.env.NAPCAT_EXPORT_DIR = 'user';
    process.env.NAPCAT_INCLUDE_IMAGES = 'false';
    const c = loadConfigData();
    expect(c.export.dir).toBe('user'); // env 优先
    expect(c.export.includeImages).toBe(false); // env 优先
    expect(readFileSync(join(tmp, 'config.json'), 'utf-8')).toBe(onDisk); // env 覆盖不回写文件
  });

  it('keeps the file config when env values are illegal', () => {
    process.env.ZCODE_PLUGIN_DATA = tmp;
    const cfg = defaultConfig();
    cfg.export = { dir: 'workspace', includeImages: true };
    saveConfig(tmp, cfg);

    // M1.1：'yes' 现在是合法值（不能拿它当「非法值」示例，断言会恒真）→ 用真正非法的 'garbage'
    process.env.NAPCAT_EXPORT_DIR = 'bogus';
    process.env.NAPCAT_INCLUDE_IMAGES = 'garbage';
    const c = loadConfigData();
    expect(c.export.dir).toBe('workspace');
    expect(c.export.includeImages).toBe(true);
  });

  it('applyEnvOverrides returns the same object and is idempotent', () => {
    const cfg = defaultConfig();
    const out = applyEnvOverrides(cfg, { NAPCAT_EXPORT_DIR: 'workspace' });
    expect(out).toBe(cfg);
    expect(applyEnvOverrides(out, { NAPCAT_EXPORT_DIR: 'workspace' }).export.dir).toBe('workspace');
  });
});

// M1.1-6：清单里的 userConfig 是**自由文本**（用户在设置界面手打），
// 只认小写 true/false 会让 True / 1 / yes 这些常见写法被**静默忽略**。
describe('includeImages 的 env 取值判定', () => {
  it('接受大小写不敏感的 true/1/yes/on', () => {
    for (const v of ['true', 'True', 'TRUE', ' true ', '1', 'yes', 'Yes', 'on', 'ON']) {
      const cfg = defaultConfig();
      applyEnvOverrides(cfg, { NAPCAT_INCLUDE_IMAGES: v });
      expect(cfg.export.includeImages).toBe(true);
    }
  });

  it('接受大小写不敏感的 false/0/no/off', () => {
    for (const v of ['false', 'False', 'FALSE', '0', 'no', 'No', 'off', 'OFF']) {
      const cfg = defaultConfig();
      cfg.export.includeImages = true;
      applyEnvOverrides(cfg, { NAPCAT_INCLUDE_IMAGES: v });
      expect(cfg.export.includeImages).toBe(false);
    }
  });

  it('判不出来时保留文件里的值，且不抛错', () => {
    const cfg = defaultConfig();
    cfg.export.includeImages = true;
    expect(() => applyEnvOverrides(cfg, { NAPCAT_INCLUDE_IMAGES: 'garbage' })).not.toThrow();
    expect(cfg.export.includeImages).toBe(true);
  });

  it('空串（清单默认值 = 未设置）不覆盖文件里的值', () => {
    const cfg = defaultConfig();
    cfg.export.includeImages = true;
    applyEnvOverrides(cfg, { NAPCAT_INCLUDE_IMAGES: '' });
    expect(cfg.export.includeImages).toBe(true);
  });
});

describe('config priority (legal env value wins, otherwise the file)', () => {
  it('lets a legal env value override the file value of export.dir', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ export: { dir: 'workspace' } }));
    process.env.ZCODE_PLUGIN_DATA = tmp;
    process.env.NAPCAT_EXPORT_DIR = 'user';
    expect(loadConfigData().export.dir).toBe('user');
  });

  it('lets a legal env value override the file value of includeImages', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ export: { includeImages: false } }));
    process.env.ZCODE_PLUGIN_DATA = tmp;
    process.env.NAPCAT_INCLUDE_IMAGES = 'true';
    expect(loadConfigData().export.includeImages).toBe(true);
  });

  it('applies env when the file does not set the field', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ connection: { mode: 'external' } }));
    process.env.ZCODE_PLUGIN_DATA = tmp;
    process.env.NAPCAT_EXPORT_DIR = 'workspace';
    process.env.NAPCAT_INCLUDE_IMAGES = 'true';
    const c = loadConfigData();
    expect(c.export.dir).toBe('workspace');
    expect(c.export.includeImages).toBe(true);
    expect(c.connection.mode).toBe('external'); // 文件里的其它字段不受影响
  });

  it('applies env when there is no config file at all', () => {
    process.env.ZCODE_PLUGIN_DATA = tmp;
    process.env.NAPCAT_EXPORT_DIR = 'workspace';
    expect(loadConfigData().export.dir).toBe('workspace');
  });

  it('keeps the file value when the env value is illegal', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ export: { dir: 'workspace', includeImages: true } }));
    process.env.ZCODE_PLUGIN_DATA = tmp;
    process.env.NAPCAT_EXPORT_DIR = 'bogus';
    // M1.1：'yes' 现在是合法值（不能拿它当「非法值」示例，断言会恒真）→ 用真正非法的 'garbage'
    process.env.NAPCAT_INCLUDE_IMAGES = 'garbage';
    const c = loadConfigData();
    expect(c.export.dir).toBe('workspace');
    expect(c.export.includeImages).toBe(true);
  });

  it('keeps the file value when the env value is empty (manifest default = 未设置)', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ export: { dir: 'workspace', includeImages: true } }));
    process.env.ZCODE_PLUGIN_DATA = tmp;
    process.env.NAPCAT_EXPORT_DIR = '';
    process.env.NAPCAT_INCLUDE_IMAGES = '';
    const c = loadConfigData();
    expect(c.export.dir).toBe('workspace');
    expect(c.export.includeImages).toBe(true);
  });

  it('keeps the file value when the env variable is not set', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ export: { dir: 'workspace', includeImages: true } }));
    process.env.ZCODE_PLUGIN_DATA = tmp;
    const c = loadConfigData();
    expect(c.export.dir).toBe('workspace');
    expect(c.export.includeImages).toBe(true);
  });

  it('applies env per field, not per section', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ export: { dir: 'workspace', includeImages: true } }));
    process.env.ZCODE_PLUGIN_DATA = tmp;
    process.env.NAPCAT_EXPORT_DIR = 'user';
    const c = loadConfigData();
    expect(c.export.dir).toBe('user'); // env 有合法值 → env 覆盖
    expect(c.export.includeImages).toBe(true); // env 没给值 → 保留文件值
  });

  it('exposes the raw file content for patch-style saves', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ export: { dir: 'workspace' }, custom: 1 }));
    const { config, raw } = loadConfigWithRaw(tmp);
    expect(raw.export).toEqual({ dir: 'workspace' });
    expect((raw as Record<string, unknown>).custom).toBe(1);
    expect(config.export.dir).toBe('workspace');
  });

  it('reports an empty raw object when the file is absent or corrupt', () => {
    expect(loadConfigWithRaw(tmp).raw).toEqual({});
    writeFileSync(join(tmp, 'config.json'), '{oops');
    expect(loadConfigWithRaw(tmp).raw).toEqual({});
  });

  it('writes only the config sections into the config file', () => {
    saveConfig(tmp, loadConfig(tmp));
    const text = readFileSync(join(tmp, 'config.json'), 'utf-8');
    expect(text).not.toContain('explicit');
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['autoDetect', 'connection', 'export', 'inject', 'managed']);
  });
});

describe('manifest userConfig defaults', () => {
  const manifestPath = fileURLToPath(new URL('../.zcode-plugin/plugin.json', import.meta.url));

  it('leaves both userConfig defaults empty so an unset setting never shadows the file', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      userConfig: Record<string, { default?: unknown; description?: string }>;
    };
    // 空串不是合法值 → env 不触发覆盖 → config.json 保持权威（spec §6 裁定）。
    expect(manifest.userConfig.exportDir.default).toBe('');
    expect(manifest.userConfig.includeImages.default).toBe('');
    expect(manifest.userConfig.exportDir.description).toContain('留空');
    expect(manifest.userConfig.includeImages.description).toContain('留空');
  });
});
