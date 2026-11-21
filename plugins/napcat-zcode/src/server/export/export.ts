import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hasValidTime, type ChatRef, type Message } from '../model/types.js';
import { renderJson } from './json.js';
import { renderMarkdown } from './markdown.js';

/** 导出目录本身 + 它的各级祖先目录（判定「某条规则是否盖住了导出目录」）。 */
const EXPORT_ANCESTORS = ['.zcode', '.zcode/napcat', '.zcode/napcat/exports'];

/**
 * 导出文件与目录的权限位（POSIX）。
 *
 * 聊天记录是高敏数据（spec §5.8 / 安全要求）：导出文件与含 token 的 `config.json`
 * 用**同一套**权限口径（0600 / 0700），否则「token 只有本人可读、聊天记录同机人人可读」
 * 就是一个自相矛盾的防护。Windows 上这些位不生效（由 ACL 决定），但代码路径保持一致。
 */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * 会话名 → 文件名安全片段：非法字符与空白（连续段折叠成一个）→ `_`，限长 60。
 *
 * 覆盖 Windows 与 POSIX 的常见非法字符，外加控制字符（0x00-0x1F，Windows 文件名禁止）。
 * 空串回退成 'chat'——否则会生成以 `_` 开头的残缺文件名。
 *
 * 限长按**码点**切（`[...s]`），不按 UTF-16 码元切：后者会把代理对切成两半，
 * 落盘文件名会出现 U+FFFD 替换字符。
 */
export function sanitizeName(name: string): string {
  const cleaned = (name ?? '').replace(/[\s\\/:*?"<>|\x00-\x1f]+/g, '_');
  return [...cleaned].slice(0, 60).join('') || 'chat';
}

function two(n: number): string { return String(n).padStart(2, '0'); }

/**
 * 导出文件名主干：`{会话名}_{YYYYMMDD}_{HHmm-HHmm}`（spec §5.8）。
 *
 * - 同日：`产品群_20261121_1200-1202`
 * - 跨天：`产品群_20261121_2350-20261122_0800`（写两天日期，与注入体标题的区间写法一致，
 *   文件名自描述，不再出现「结束时间看起来早于开始时间」的歧义）
 *
 * 首末时刻取自**按时间升序后的副本**：调用方传入乱序选区时不会得到反向范围。
 * （消息正文仍按调用方给定的顺序渲染——渲染顺序是调用方的语义，不是文件名的事。）
 */
export function exportBaseName(chat: ChatRef, messages: Message[]): string {
  const name = sanitizeName(chat.name);
  // 文件名里的时间范围只按**有有效时间**的消息算：没有时间的消息排不进时间轴，
  // 硬算会得到 `NaNNaNNaN` 这样的文件名（还会让后续消歧全部失效）。
  const timed = messages.filter(hasValidTime);
  if (timed.length === 0) return `${name}_empty`;
  const sorted = [...timed].sort((a, b) => a.time - b.time);
  const a = new Date(sorted[0].time * 1000);
  const b = new Date(sorted[sorted.length - 1].time * 1000);
  const dayA = `${a.getFullYear()}${two(a.getMonth() + 1)}${two(a.getDate())}`;
  const dayB = `${b.getFullYear()}${two(b.getMonth() + 1)}${two(b.getDate())}`;
  const hmA = `${two(a.getHours())}${two(a.getMinutes())}`;
  const hmB = `${two(b.getHours())}${two(b.getMinutes())}`;
  const range = dayA === dayB ? `${hmA}-${hmB}` : `${hmA}-${dayB}_${hmB}`;
  return `${name}_${dayA}_${range}`;
}

/** 归一化一条 gitignore 规则：去掉结尾斜杠与递归前缀（`**` 加斜杠），并记录是否为锚定写法。 */
function normalizeRule(pattern: string): { path: string; anchored: boolean } {
  let p = pattern;
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  p = p.replace(/^\*\*\//, '');
  p = p.replace(/\/+$/, '');
  return { path: p, anchored };
}

/**
 * 判断一条 gitignore 规则是否盖住了导出目录。
 *
 * 盖住的写法：`.zcode`、`.zcode/napcat`、`.zcode/napcat/exports`（目录自身），
 * 以及对上述目录的通配：`.zcode/*`、`.zcode/napcat/**`、`.zcode/napcat/exports/**`。
 *
 * 锚定写法（以 `/` 开头，如 `/.zcode/napcat/`）只相对**仓库根**解析：
 * 工作区不是仓库根时（`<ws>/.git` 不存在），它指的是仓库根下的 `.zcode/napcat/`，
 * 并没盖住 `<ws>/.zcode/napcat/exports/` → 按未覆盖处理（追加一条冗余规则无害，但漏防护不可接受）。
 */
function ruleCoversExport(pattern: string, wsIsRepoRoot: boolean): boolean {
  const { path, anchored } = normalizeRule(pattern);
  if (anchored && !wsIsRepoRoot) return false;
  if (path === '*' || path === '**') return true; // 忽略一切，自然覆盖导出目录
  if (path.endsWith('/**') || path.endsWith('/*')) {
    const base = path.slice(0, path.lastIndexOf('/'));
    return EXPORT_ANCESTORS.includes(base);
  }
  return EXPORT_ANCESTORS.includes(path);
}

/** 文件的主导换行符：CRLF 多于孤立 LF 时用 CRLF，否则用 LF。 */
function dominantEol(content: string): string {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * 确保 `<ws>/.gitignore` 覆盖 `.zcode/napcat/`；已覆盖则不动文件。
 *
 * 取反规则（`!` 开头）优先：用户明确写了 `!.zcode/napcat/`（要把这些文件纳入版本库），
 * 此时**不追加**忽略规则——git 的规则是「后写者胜」，追加会静默推翻用户意图。
 *
 * 追加用 appendFileSync：先读后写（截断再写）一旦中途失败，用户原有的 .gitignore 就被毁掉了。
 *
 * @returns 是否真的改写了 .gitignore（调用方据此提示用户）。
 */
function ensureGitignore(wsDir: string): boolean {
  const gi = join(wsDir, '.gitignore');
  let content = '';
  try { content = readFileSync(gi, 'utf-8'); } catch { /* 文件不存在 */ }
  const wsIsRepoRoot = existsSync(join(wsDir, '.git'));
  const rules = content.split(/\r?\n/);

  for (const rule of rules) {
    const t = rule.trim();
    if (!t.startsWith('!')) continue;
    if (ruleCoversExport(t.slice(1), wsIsRepoRoot)) return false;
  }
  for (const rule of rules) {
    const t = rule.trim();
    if (!t || t.startsWith('#') || t.startsWith('!')) continue;
    if (ruleCoversExport(t, wsIsRepoRoot)) return false;
  }

  const eol = dominantEol(content);
  // 原文件没有以 LF 结尾时先补一个换行，避免把新规则粘在上一行末尾。
  // 末字节是**孤立 CR** 时同样要补：gitignore 只按 LF 分行，孤立 CR 不构成行结束符，
  // 不补分隔符的话新规则会被并进上一行（该规则随之失效）。
  const prefix = content && !content.endsWith('\n') ? eol : '';
  appendFileSync(gi, `${prefix}.zcode/napcat/${eol}`, 'utf-8');
  return true;
}

/**
 * 既有导出 JSON 里的会话标识。
 *
 * `kind` 可能缺失：老版本导出的 JSON 里只有 `chat.id`。
 */
interface ExistingChatRef {
  id: string;
  kind?: string;
}

/**
 * 读既有导出 JSON 的**头部**（最多 CHAT_REF_SCAN_BYTES 字节）并从中取出会话标识。
 *
 * 为什么不全读 + `JSON.parse`：
 * - 导出文件可能很大（几千条消息的 JSON 是 MB 级），每次导出都整读一遍纯属浪费；
 * - 全读还会把整个文件塞进内存，异常大的文件能把插件进程顶爆。
 *
 * 导出的 JSON 里 `chat` 是**第一个键**（见 `renderJson`），所以头部一小段就够。
 * 读不到 / 认不出 → 返回 undefined（调用方按「不是同一个会话」处理）。
 */
const CHAT_REF_SCAN_BYTES = 64 * 1024;

/**
 * 从文本里抠出 `"chat": {…}` 这个对象的**内容**（不含外层花括号）。
 *
 * 不能用 `\{([^{}]*)\}` 这种正则：会话名里可能有 `{` / `}`（群名是用户可控的），
 * 那样会截断。这里手工扫一遍，正确区分「字符串里的花括号」与「对象的花括号」。
 */
function extractChatObject(text: string): string | undefined {
  const m = /"chat"\s*:\s*\{/.exec(text);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  let depth = 1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i);
    }
  }
  return undefined; // 对象没闭合（文件被截断）
}

/** 从 JSON 文本片段里抠出 `"chat": {…}` 里的 id / kind。 */
function parseChatRef(text: string): ExistingChatRef | undefined {
  const body = extractChatObject(text);
  if (body === undefined) return undefined;
  const idMatch = /"id"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(body);
  if (!idMatch) return undefined;
  let id: string;
  try {
    const decoded = JSON.parse(idMatch[1]);
    if (typeof decoded !== 'string') return undefined;
    id = decoded;
  } catch {
    return undefined;
  }
  const kindMatch = /"kind"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(body);
  if (!kindMatch) return { id }; // 老版本导出没有 kind
  try {
    const kind = JSON.parse(kindMatch[1]);
    return typeof kind === 'string' ? { id, kind } : { id };
  } catch {
    return { id };
  }
}

/** 读出既有导出 JSON 里的会话标识（id / kind）；读不到或格式不认识时返回 undefined。 */
function readChatRef(jsonPath: string): ExistingChatRef | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(jsonPath, 'r');
    const buf = Buffer.alloc(CHAT_REF_SCAN_BYTES);
    const read = readSync(fd, buf, 0, CHAT_REF_SCAN_BYTES, 0);
    return parseChatRef(buf.toString('utf-8', 0, read));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 关闭失败不影响读到的内容 */ }
    }
  }
}

/**
 * 既有文件里的会话与本次要导出的会话**是不是同一个**。
 *
 * 比较 `kind` **和** `id`：
 * 群与好友的 id 是两套独立的编号空间，**数值可以完全相同**（群 123 与好友 123）。
 * 只比 id 时，同名同 id 的群与好友会互相覆盖（内容错配 + 静默数据丢失）。
 *
 * 老版本导出的 JSON 里没有 `kind` → 按「id 相同即同一会话」处理（向后兼容：
 * 不能因为升级就突然给用户多出一堆重复文件）。
 */
function isSameChat(existing: ExistingChatRef | undefined, chat: ChatRef): boolean {
  if (!existing) return false;
  if (existing.id !== chat.id) return false;
  if (existing.kind === undefined) return true; // 老版本导出：没有 kind 字段
  return existing.kind === chat.kind;
}

interface ExportPaths {
  mdPath: string;
  jsonPath: string;
}

/**
 * 解析最终落盘路径。
 *
 * 同名会话（两个群都叫「产品群」，或群与好友同名）导出到同一目录时文件名相同，
 * 后一次导出会把前一次的 .md/.json **静默覆盖**——内容错配且从文件名与返回值都看不出来。
 * 因此：目标 .json 已存在且其会话（kind + id）与本次不同 → 文件名追加会话 id 消歧
 * （`产品群_20261121_2350-0800_<groupId>`）；仍冲突（极端情况）→ 追加 `_2`、`_3`…
 *
 * 返回的始终是真实落盘路径（调用方会直接回显给用户）。
 */
function resolvePaths(target: string, base: string, chat: ChatRef): ExportPaths {
  const pair = (name: string): ExportPaths => ({
    mdPath: join(target, `${name}.md`),
    jsonPath: join(target, `${name}.json`),
  });

  const first = pair(base);
  // 没有同名文件 → 直接用；同名文件属于同一会话 → 覆盖即可（同一选区重复导出）。
  if (!existsSync(first.jsonPath) || isSameChat(readChatRef(first.jsonPath), chat)) return first;

  const idPart = sanitizeName(chat.id) || 'chat';
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}_${idPart}` : `${base}_${idPart}_${i}`;
    const candidate = pair(name);
    if (!existsSync(candidate.jsonPath) || isSameChat(readChatRef(candidate.jsonPath), chat)) return candidate;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 把一个选区导出成 Markdown + JSON 一对文件。
 *
 * - `dir='user'` → `${homeDir ?? homedir()}/.zcode/napcat/exports/`
 * - `dir='workspace'` → `${workspaceDir}/.zcode/napcat/exports/`，并确保
 *   `<workspaceDir>/.gitignore` 覆盖 `.zcode/napcat/`（缺覆盖时自动追加）。
 * - `dir='abs'` → `absPath` 指定的目录。
 *
 * 聊天记录是高敏数据（spec §5.8 / 安全要求）：默认落用户目录；工作区导出强制 gitignore 防护；
 * 文件与目录都是 0600 / 0700（与含 token 的 config.json 同口径）。
 */
export async function exportSelection(opts: {
  messages: Message[];
  chat: ChatRef;
  dir: 'user' | 'workspace' | 'abs';
  absPath?: string;
  workspaceDir?: string;
  homeDir?: string;
}): Promise<{ mdPath: string; jsonPath: string; gitignoreUpdated: boolean }> {
  let target: string;
  let wsDir: string | undefined;
  let gitignoreUpdated = false;
  if (opts.dir === 'workspace') {
    wsDir = opts.workspaceDir;
    if (!wsDir) throw new Error('workspace export requires workspaceDir');
    /**
     * 工作区目录必须**已经存在**。
     *
     * 以前是 `mkdirSync(target, {recursive:true})` 一把梭：工作区目录不存在时，
     * 它会把 `<ws>/.zcode/napcat/exports` 连同 `<ws>/.gitignore` 一起凭空造出来——
     * 用户填错一个路径，插件就在那儿建出一棵目录树（还改了 .gitignore）。
     * 现在改成：工作区不存在 ⇒ 明确报错；存在才建导出子目录。
     */
    let wsStat;
    try {
      wsStat = statSync(wsDir);
    } catch {
      throw new Error(`工作区目录不存在：${wsDir}（请先创建它，或改用用户目录导出）`);
    }
    if (!wsStat.isDirectory()) {
      throw new Error(`工作区路径不是目录：${wsDir}（请改用用户目录导出）`);
    }
    target = join(wsDir, '.zcode', 'napcat', 'exports');
  } else if (opts.dir === 'abs') {
    // 缺路径时响亮失败：静默回落到用户目录会把聊天记录写到用户没要求的位置。
    if (!opts.absPath) throw new Error('abs export requires absPath');
    target = opts.absPath;
  } else {
    target = join(opts.homeDir ?? homedir(), '.zcode', 'napcat', 'exports');
  }
  // 先建目录再写 .gitignore：workspaceDir 不存在时，写 .gitignore 会先 ENOENT 崩掉。
  // mode 只在目录被创建时生效；已存在的目录不受影响（下面还会 chmod 一次）。
  mkdirSync(target, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(target, DIR_MODE);
  } catch {
    /* 某些文件系统/平台不支持 chmod：不影响导出本身的正确性 */
  }
  if (wsDir) gitignoreUpdated = ensureGitignore(wsDir);

  const base = exportBaseName(opts.chat, opts.messages);
  const { mdPath, jsonPath } = resolvePaths(target, base, opts.chat);
  const md = renderMarkdown(opts.messages, opts.chat);
  const json = renderJson(opts.messages, opts.chat);
  // 本次是新建还是覆盖：只有**本次新建**的 md 才允许在 json 写失败时删掉。
  // 覆盖场景下删掉的是用户原有的导出（内容已被本次写入覆盖，删了只会让目录里连 md 都不剩）。
  const mdExisted = existsSync(mdPath);

  try {
    writeFileSync(mdPath, md, { encoding: 'utf-8', mode: FILE_MODE });
  } catch (err) {
    throw new Error(`export failed writing markdown ${mdPath}: ${errText(err)}`);
  }
  try {
    writeFileSync(jsonPath, json, { encoding: 'utf-8', mode: FILE_MODE });
  } catch (err) {
    // json 写失败时把**本次新建**的 md 撤掉，别留下孤儿文件（半对产物比没有更难判断）。
    if (!mdExisted) {
      try { unlinkSync(mdPath); } catch { /* 清理失败不掩盖原始错误 */ }
    }
    throw new Error(`export failed writing json ${jsonPath}: ${errText(err)}`);
  }
  /**
   * 收紧权限位。
   *
   * `mode` 只在「文件被创建」时生效；覆盖既有文件时权限位不变（可能是 0644），
   * 所以落盘后再 chmod 一次——这才是可靠的那步（与 config.ts 同一口径）。
   */
  for (const p of [mdPath, jsonPath]) {
    try {
      chmodSync(p, FILE_MODE);
    } catch {
      /* 某些文件系统/平台不支持 chmod：不影响导出本身的正确性 */
    }
  }
  return { mdPath, jsonPath, gitignoreUpdated };
}
