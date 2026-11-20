import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PluginConfig {
  connection: { mode: 'auto' | 'external'; endpoint: string; token: string };
  autoDetect: { ports: number[]; endpoints: string[] };
  managed: { napcatVersion: string; downloadMirror: 'auto' | string };
  export: { dir: 'user' | 'workspace'; includeImages: boolean };
  inject: { maxInjectChars: number };
}

/** 配置默认值（spec §6）。每次调用返回全新的对象/数组，调用方改动不会污染后续调用。 */
export function defaultConfig(): PluginConfig {
  return {
    connection: { mode: 'auto', endpoint: '', token: '' },
    autoDetect: { ports: [3000, 3001, 6099], endpoints: [] },
    managed: { napcatVersion: '4.18.42', downloadMirror: 'auto' },
    export: { dir: 'user', includeImages: false },
    inject: { maxInjectChars: 40_000 },
  };
}

/**
 * 插件数据目录：`ZCODE_PLUGIN_DATA` 优先（ZCode 启动插件进程时注入），否则 `~/.zcode/napcat-zcode`。
 *
 * token 等敏感项只落在这个用户级目录里的 `config.json`，绝不进清单或 git。
 */
export function dataDir(): string {
  return process.env.ZCODE_PLUGIN_DATA || join(homedir(), '.zcode', 'napcat-zcode');
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 不允许从配置文件带进配置对象的键：写这些键会改原型（原型污染）。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 递归合并：对象逐层合并，其余值由 `over` 覆盖（`over` 为 undefined 时保留 base）。 */
function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : (over as T);
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] = k in (base as Record<string, unknown>) ? deepMerge((base as Record<string, unknown>)[k], v) : v;
  }
  return out as T;
}

/** 端口数组：非数组 → 默认；逐项过滤非法端口；整组都非法 → 默认；显式空数组（不探测）予以尊重。 */
function pickPorts(v: unknown, fallback: number[]): number[] {
  if (!Array.isArray(v)) return fallback;
  const ports = v.filter(
    (p): p is number => typeof p === 'number' && Number.isInteger(p) && p > 0 && p <= 65535,
  );
  return ports.length === 0 && v.length > 0 ? fallback : ports;
}

/** 端点数组：非数组 → 空；逐项丢弃非字符串/空串。 */
function pickEndpoints(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
}

/**
 * 把（可能来自用户手改的）配置对象收敛成合法的 `PluginConfig`。
 *
 * 字段类型不对时**退回该项的默认值**，而不是把默认值弄坏——深合并只保证「键存在则覆盖」，
 * 不保证「值的类型对得上」。手改 config.json 时把 `ports` 写成字符串、把 `includeImages` 写成
 * `"yes"` 都很常见，若照单全收，下游会拿到 `ports: "3000,3001"` 这类不可用值。
 *
 * 未在 schema 里的键一律丢弃：配置文件是用户可见的文本，不该把未知字段带进内存与回写。
 */
function sanitize(m: Record<string, unknown>): PluginConfig {
  const d = defaultConfig();
  const conn = isObj(m.connection) ? m.connection : {};
  const auto = isObj(m.autoDetect) ? m.autoDetect : {};
  const man = isObj(m.managed) ? m.managed : {};
  const exp = isObj(m.export) ? m.export : {};
  const inj = isObj(m.inject) ? m.inject : {};
  return {
    connection: {
      mode: conn.mode === 'external' ? 'external' : 'auto',
      endpoint: typeof conn.endpoint === 'string' ? conn.endpoint : '',
      token: typeof conn.token === 'string' ? conn.token : '',
    },
    autoDetect: {
      ports: pickPorts(auto.ports, d.autoDetect.ports),
      endpoints: pickEndpoints(auto.endpoints),
    },
    managed: {
      napcatVersion:
        typeof man.napcatVersion === 'string' && man.napcatVersion.trim() !== ''
          ? man.napcatVersion
          : d.managed.napcatVersion,
      downloadMirror:
        typeof man.downloadMirror === 'string' && man.downloadMirror.trim() !== ''
          ? man.downloadMirror
          : d.managed.downloadMirror,
    },
    export: {
      dir: exp.dir === 'workspace' ? 'workspace' : 'user',
      includeImages: typeof exp.includeImages === 'boolean' ? exp.includeImages : d.export.includeImages,
    },
    inject: {
      maxInjectChars:
        typeof inj.maxInjectChars === 'number' && Number.isFinite(inj.maxInjectChars) && inj.maxInjectChars > 0
          ? Math.floor(inj.maxInjectChars)
          : d.inject.maxInjectChars,
    },
  };
}

/**
 * 读 `<dir>/config.json` 并与默认值深合并。
 *
 * 文件缺失、JSON 损坏、顶层不是对象——都回退默认值，不抛错：配置坏掉不该让插件起不来。
 */
export function loadConfig(dir: string): PluginConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
  } catch {
    return defaultConfig(); // 文件不存在 / 读失败 / JSON 损坏
  }
  if (!isObj(raw)) return defaultConfig();
  // 默认值与文件内容都是「不可信输入」：先按松散字典合并，再由 sanitize 逐字段收敛。
  const merged = deepMerge(defaultConfig() as unknown as Record<string, unknown>, raw);
  return sanitize(merged);
}

/**
 * 环境变量覆盖（来源：清单 `userConfig` 经 `.mcp.json` 的 `env` 注入）。
 *
 * - 只在取值合法时覆盖：`NAPCAT_EXPORT_DIR` ∈ {user, workspace}、`NAPCAT_INCLUDE_IMAGES` ∈ {true, false}；
 *   非法值（含空串）一律不覆盖，保留配置文件里的值，也不抛错。
 * - 就地改写并返回同一个对象（既支持 `applyEnvOverrides(cfg, env)`，也支持 `cfg = applyEnvOverrides(cfg)`）。
 * - 幂等：同样的 env 反复应用结果一致。
 */
export function applyEnvOverrides(cfg: PluginConfig, env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const dir = env.NAPCAT_EXPORT_DIR;
  if (dir === 'user' || dir === 'workspace') cfg.export.dir = dir;
  const imgs = env.NAPCAT_INCLUDE_IMAGES;
  if (imgs === 'true' || imgs === 'false') cfg.export.includeImages = imgs === 'true';
  return cfg;
}

/** 插件进程用的配置：数据目录里的文件 + 环境变量覆盖。 */
export function loadConfigData(): PluginConfig {
  return applyEnvOverrides(loadConfig(dataDir()));
}

/**
 * 原子写配置：先写 `config.json.tmp`，再 rename 覆盖 `config.json`。
 *
 * rename 在同一文件系统内是原子的——读方要么看到旧文件、要么看到完整的新文件，
 * 不会看到「被截断了一半」的 config.json。序列化在写临时文件**之前**完成：序列化失败
 * （循环引用等）时连临时文件都不会产生，旧配置原封不动。
 */
export function saveConfig(dir: string, cfg: PluginConfig): void {
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(cfg, null, 2) + '\n';
  const tmp = join(dir, 'config.json.tmp');
  const target = join(dir, 'config.json');
  writeFileSync(tmp, payload, 'utf-8');
  try {
    renameSync(tmp, target);
  } catch (err) {
    // rename 失败（目标被占用等）：清掉临时文件，别在数据目录里留垃圾；旧配置未被动过。
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }
}
