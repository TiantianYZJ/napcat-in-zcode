import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface PluginConfig {
  connection: { mode: 'auto' | 'external'; endpoint: string; token: string };
  autoDetect: {
    /** 要扫的本机端口（回环）。 */
    ports: number[];
    /** 用户显式配置的额外端点（允许非回环——用户自己填的才算数）。 */
    endpoints: string[];
    /**
     * 用户显式指定的**扫描根**（只收绝对路径）。
     *
     * 这是覆盖「装在任意命名目录里的 NapCat」最可靠的途径
     * （上游 `writePath` 在 Windows/Linux 上就是安装目录本身，如 `D:\QQChatExporter`）。
     */
    paths: string[];
    /** 单候选探测超时（ms）。 */
    probeTimeoutMs: number;
    /** 是否做盘根自动发现（`A:\`…`Z:\` 的一级子目录）。 */
    scanDrives: boolean;
    /** 盘根发现的候选根上限（**每个盘各自计数**；`0` = 禁用盘根发现）。 */
    maxRoots: number;
  };
  managed: {
    /** 要装的 NapCat 版本。 */
    napcatVersion: string;
    /** 下载镜像（'auto' = 用内置的归档镜像）。 */
    downloadMirror: 'auto' | string;
    /** 下载代理（如 http://127.0.0.1:7897）；空 = 直连。 */
    downloadProxy: string;
    /** 桌面 QQ 可执行文件路径（注入模式用；空 = 注入模式不可用）。 */
    desktopQqPath: string;
  };
  export: { dir: 'user' | 'workspace'; includeImages: boolean };
  inject: { maxInjectChars: number };
}

/** 配置默认值（spec §6）。每次调用返回全新的对象/数组，调用方改动不会污染后续调用。 */
export function defaultConfig(): PluginConfig {
  return {
    connection: { mode: 'auto', endpoint: '', token: '' },
    autoDetect: {
      ports: [3000, 3001, 6099],
      endpoints: [],
      paths: [],
      probeTimeoutMs: 1200,
      scanDrives: true,
      maxRoots: 32,
    },
    managed: { napcatVersion: '4.18.42', downloadMirror: 'auto', downloadProxy: '', desktopQqPath: '' },
    export: { dir: 'user', includeImages: false },
    inject: { maxInjectChars: 40_000 },
  };
}

/**
 * 插件数据目录：`ZCODE_PLUGIN_DATA` 优先（ZCode 启动插件进程时注入），否则 `~/.zcode/napcat-zcode`。
 *
 * **未替换的令牌要当没注入**：宿主若把 `${ZCODE_PLUGIN_DATA}` 原样注入（没做替换），
 * 直接拿它当目录名会造出一个名叫 `${ZCODE_PLUGIN_DATA}` 的字面量目录——
 * 配置（含 token）就会落到一个谁也猜不到的地方。故含 `${` 一律视为未替换。
 *
 * token 等敏感项只落在这个用户级目录里的 `config.json`，绝不进清单或 git。
 */
export function dataDir(): string {
  const injected = process.env.ZCODE_PLUGIN_DATA;
  if (injected && !injected.includes('${')) return injected;
  return join(homedir(), '.zcode', 'napcat-zcode');
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
 * 扫描根路径：只收**绝对路径**。
 *
 * 相对路径一律丢弃——模块是按 CWD 解析相对路径的，
 * 而 CWD 会随宿主（ZCode 面板 / MCP 客户端 / 终端）变化，语义含糊且不可复现。
 * 重复路径去重（同一个目录扫两遍纯属浪费）。
 */
function pickPaths(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const p of v) {
    if (typeof p !== 'string') continue;
    const t = p.trim();
    if (t === '') continue;
    if (!isAbsolute(t)) continue; // 相对路径 → 丢弃
    seen.add(t);
  }
  return [...seen];
}

/** 探测超时：只接受 100–10000 的整数，越界/类型不对 → 默认值。 */
function pickProbeTimeoutMs(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 100 || v > 10000) return fallback;
  return v;
}

/** 布尔项：只接受真正的布尔值，类型不对 → 默认值。 */
function pickBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** 盘根发现上限：只接受 0–512 的整数，越界/类型不对 → 默认值（`0` = 禁用盘根发现，合法）。 */
function pickMaxRoots(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 512) return fallback;
  return v;
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
      paths: pickPaths(auto.paths),
      probeTimeoutMs: pickProbeTimeoutMs(auto.probeTimeoutMs, d.autoDetect.probeTimeoutMs),
      scanDrives: pickBool(auto.scanDrives, d.autoDetect.scanDrives),
      maxRoots: pickMaxRoots(auto.maxRoots, d.autoDetect.maxRoots),
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
      downloadProxy:
        typeof man.downloadProxy === 'string' ? man.downloadProxy.trim() : d.managed.downloadProxy,
      desktopQqPath:
        typeof man.desktopQqPath === 'string' ? man.desktopQqPath.trim() : d.managed.desktopQqPath,
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

/** 读 `<dir>/config.json` 的原始内容；文件缺失/损坏/顶层不是对象 → 空对象（不抛错）。 */
function readRaw(dir: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8'));
  } catch {
    return {}; // 文件不存在 / 读失败 / JSON 损坏
  }
  return isObj(raw) ? raw : {};
}

/**
 * 读配置并**同时**返回文件里的原始内容。
 *
 * - `config`：与默认值深合并、逐字段收敛后的合法配置（与 `loadConfig` 同一个对象）。
 * - `raw`：文件里的原始 JSON 对象（缺失/损坏时为 `{}`）——保存时以它为基底**只写入变化的字段**，
 *   才不会把 env 值或默认值固化进文件（spec §6「保存配置时只写入文件里变化的字段」）。
 */
export function loadConfigWithRaw(dir: string): { config: PluginConfig; raw: Record<string, unknown> } {
  const raw = readRaw(dir);
  // 默认值与文件内容都是「不可信输入」：先按松散字典合并，再由 sanitize 逐字段收敛。
  const merged = deepMerge(defaultConfig() as unknown as Record<string, unknown>, raw);
  return { config: sanitize(merged), raw };
}

/**
 * 读 `<dir>/config.json` 并与默认值深合并。
 *
 * 文件缺失、JSON 损坏、顶层不是对象——都回退默认值，不抛错：配置坏掉不该让插件起不来。
 */
export function loadConfig(dir: string): PluginConfig {
  return loadConfigWithRaw(dir).config;
}

/**
 * 布尔型 env 取值：大小写不敏感的 `true/false/1/0/yes/no/on/off`。
 *
 * 清单里的 `userConfig` 是**自由文本**（用户在设置界面里手打），只认小写 `true`/`false`
 * 会让 `True`、`1`、`yes` 这些常见写法被**静默忽略**——用户以为改生效了，其实没有。
 *
 * 判不出来（空串、乱填）→ 返回 undefined：调用方**保留文件里的值**且**不抛错**
 * （env 只是覆盖项，不该把插件整死）。
 */
function parseBoolEnv(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === '') return undefined;
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
  return undefined;
}

/**
 * 环境变量覆盖（来源：清单 `userConfig` 经 `.mcp.json` 的 `env` 注入）。
 *
 * 优先级（spec §6 裁定，2026-11-21 修订）：**env 合法值优先**（env 覆盖 `config.json`）——
 * 用户在 ZCode 设置界面改值，env 立刻生效。
 *
 * 「env 总是有值」这个前提在**清单侧**被消掉了：两项 `userConfig` 的 `default` 都是空串，
 * 空串不是合法值 → 不触发覆盖 → 用户没动过设置时，`config.json` 保持权威。
 * 于是「没设置 / 注入默认值 / 注入空串 / 不注入」几种 ZCode 行为下结果都正确，
 * 不需要追踪「字段是否显式设置」。
 *
 * - 只在取值合法时覆盖：`NAPCAT_EXPORT_DIR` ∈ {user, workspace}；
 *   `NAPCAT_INCLUDE_IMAGES` 接受大小写不敏感的 `true/false/1/0/yes/no/on/off`；
 *   非法值（含空串、未设置）一律不覆盖，保留 `config.json` 里的值，也不抛错。
 * - 就地改写并返回同一个对象（既支持 `applyEnvOverrides(cfg, env)`，也支持 `cfg = applyEnvOverrides(cfg)`）。
 * - 幂等：同样的 env 反复应用结果一致。
 */
export function applyEnvOverrides(cfg: PluginConfig, env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const dir = env.NAPCAT_EXPORT_DIR;
  if (dir === 'user' || dir === 'workspace') cfg.export.dir = dir;
  const imgs = parseBoolEnv(env.NAPCAT_INCLUDE_IMAGES);
  if (imgs !== undefined) cfg.export.includeImages = imgs;
  const proxy = env.NAPCAT_DOWNLOAD_PROXY;
  if (typeof proxy === 'string' && proxy.trim() !== '') cfg.managed.downloadProxy = proxy.trim();
  const qqPath = env.NAPCAT_DESKTOP_QQ_PATH;
  if (typeof qqPath === 'string' && qqPath.trim() !== '') cfg.managed.desktopQqPath = qqPath.trim();
  return cfg;
}

/** 插件进程用的配置：`config.json` 为基底，env 的合法值覆盖之。 */
export function loadConfigData(): PluginConfig {
  return applyEnvOverrides(loadConfig(dataDir()));
}

/**
 * 临时文件名：带 pid 与时间戳。
 *
 * 固定名（`config.json.tmp`）在两个插件进程（两个 ZCode 窗口）同时保存时会互相覆盖临时文件，
 * 甚至把对方的半截文件 rename 成 config.json。
 */
function tempPath(dir: string): string {
  return join(dir, `config.json.${process.pid}.${Date.now()}.tmp`);
}

/**
 * 原子写配置：先写临时文件，再 rename 覆盖 `config.json`。
 *
 * - rename 在同一文件系统内是原子的——读方要么看到旧文件、要么看到完整的新文件，
 *   不会看到「被截断了一半」的 config.json。读方只读 `config.json`，残留的临时文件不被读取。
 * - 序列化在写临时文件**之前**完成：序列化失败（循环引用等）时连临时文件都不会产生，旧配置原封不动。
 * - 写临时文件失败 → 删掉可能写了一半的临时文件再重抛，不在数据目录里留含 token 的残片。
 * - 临时文件与最终文件都用 0600 权限（POSIX）：config.json 含 token，只有本人可读。
 *   rename 不保留权限位（Windows 上更不保留），所以落盘后再 chmod 一次——这才是可靠的那步。
 */
export function saveConfig(dir: string, cfg: PluginConfig): void {
  mkdirSync(dir, { recursive: true });
  const payload = JSON.stringify(cfg, null, 2) + '\n';
  const tmp = tempPath(dir);
  const target = join(dir, 'config.json');
  try {
    // mode 只在「文件被创建」时生效；临时文件每次都是新建的，0600 在这里就位。
    writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    // 写失败：可能留下半截临时文件（含 token 片段）→ 删掉再重抛。
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖原始错误 */
    }
    throw err;
  }
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
  try {
    // rename 不带权限位：目标文件的权限靠这一步收紧（POSIX 上含 token 的文件不该全局可读）。
    chmodSync(target, 0o600);
  } catch {
    /* 某些文件系统/平台不支持 chmod：不影响配置本身的正确性 */
  }
}
