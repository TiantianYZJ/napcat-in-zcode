import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyEnvOverrides,
  dataDir,
  defaultConfig,
  loadConfig,
  loadConfigData,
  saveConfig,
} from '../src/server/config.js';
import type { PluginConfig } from '../src/server/config.js';

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
    applyEnvOverrides(cfg, { NAPCAT_EXPORT_DIR: 'bogus', NAPCAT_INCLUDE_IMAGES: 'yes' });
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

  it('drops invalid port entries but keeps legal ones', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ autoDetect: { ports: [3000, '3001', 0, 70000] } }));
    expect(loadConfig(tmp).autoDetect.ports).toEqual([3000]);
  });

  it('respects an explicitly empty port list', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ autoDetect: { ports: [] } }));
    expect(loadConfig(tmp).autoDetect.ports).toEqual([]);
  });

  it('creates the directory and leaves no temp file behind', () => {
    const nested = join(tmp, 'a', 'b');
    saveConfig(nested, defaultConfig());
    expect(existsSync(join(nested, 'config.json'))).toBe(true);
    expect(existsSync(join(nested, 'config.json.tmp'))).toBe(false);
  });

  it('keeps the previous config when a save fails', () => {
    saveConfig(tmp, defaultConfig());
    const before = readFileSync(join(tmp, 'config.json'), 'utf-8');
    const circular = { ...defaultConfig() } as Record<string, unknown>;
    circular.self = circular; // 循环引用 → JSON.stringify 抛错
    expect(() => saveConfig(tmp, circular as unknown as PluginConfig)).toThrow();
    expect(readFileSync(join(tmp, 'config.json'), 'utf-8')).toBe(before);
    expect(existsSync(join(tmp, 'config.json.tmp'))).toBe(false);
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

  it('applies env overrides on top of the file config without rewriting the file', () => {
    process.env.ZCODE_PLUGIN_DATA = tmp;
    const cfg = defaultConfig();
    cfg.export = { dir: 'workspace', includeImages: true };
    saveConfig(tmp, cfg);
    const onDisk = readFileSync(join(tmp, 'config.json'), 'utf-8');

    process.env.NAPCAT_EXPORT_DIR = 'user';
    process.env.NAPCAT_INCLUDE_IMAGES = 'false';
    const overridden = loadConfigData();
    expect(overridden.export.dir).toBe('user');
    expect(overridden.export.includeImages).toBe(false);
    expect(readFileSync(join(tmp, 'config.json'), 'utf-8')).toBe(onDisk); // env 覆盖不回写文件
  });

  it('keeps the file config when env values are illegal', () => {
    process.env.ZCODE_PLUGIN_DATA = tmp;
    const cfg = defaultConfig();
    cfg.export = { dir: 'workspace', includeImages: true };
    saveConfig(tmp, cfg);

    process.env.NAPCAT_EXPORT_DIR = 'bogus';
    process.env.NAPCAT_INCLUDE_IMAGES = 'yes';
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
