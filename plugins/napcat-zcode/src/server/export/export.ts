import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ChatRef, Message } from '../model/types.js';
import { renderJson } from './json.js';
import { renderMarkdown } from './markdown.js';

/**
 * 会话名 → 文件名安全片段：非法字符与空白（连续段折叠成一个）→ `_`，限长 60。
 *
 * 覆盖 Windows 与 POSIX 的常见非法字符，外加控制字符（0x00-0x1F，Windows 文件名禁止）。
 * 空串回退成 'chat'——否则会生成以 `_` 开头的残缺文件名。
 */
export function sanitizeName(name: string): string {
  return (name ?? '').replace(/[\s\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 60) || 'chat';
}

function two(n: number): string { return String(n).padStart(2, '0'); }

/**
 * 导出文件名主干：`{会话名}_{YYYYMMDD}_{HHmm-HHmm}`（spec §5.8）。
 *
 * 日期取**首条消息**所在日，时间范围取首条 HH:mm → 末条 HH:mm。
 * 跨天选区时日期仍是首条那天的日期（模板只允许一个 YYYYMMDD），
 * 跨天本身由时间范围体现——命名口径在此固化，避免同一选区两次导出得到不同文件名。
 */
export function exportBaseName(chat: ChatRef, messages: Message[]): string {
  if (messages.length === 0) return `${sanitizeName(chat.name)}_empty`;
  const a = new Date(messages[0].time * 1000);
  const b = new Date(messages[messages.length - 1].time * 1000);
  const day = `${a.getFullYear()}${two(a.getMonth() + 1)}${two(a.getDate())}`;
  const range = `${two(a.getHours())}${two(a.getMinutes())}-${two(b.getHours())}${two(b.getMinutes())}`;
  return `${sanitizeName(chat.name)}_${day}_${range}`;
}

/**
 * 判断某一行 .gitignore 规则是否已经盖住 `.zcode/napcat/` 整个目录。
 *
 * 覆盖写法（去掉锚定前缀 '/'、递归前缀 '**' 加斜杠 与结尾的 '/' 之后比对）：
 * - `.zcode/napcat/`、`.zcode/napcat` → 盖住导出目录及其内容
 * - `.zcode/`、`.zcode` → 更宽的规则，同样盖住
 *
 * 取反规则（`!` 开头）与注释行不算覆盖——它们恰恰表示「不忽略」。
 */
function coversExportDir(raw: string): boolean {
  const line = raw.trim();
  if (!line || line.startsWith('#') || line.startsWith('!')) return false;
  const p = line.replace(/^\*\*\//, '').replace(/^\//, '').replace(/\/+$/, '');
  return p === '.zcode' || p === '.zcode/napcat';
}

/**
 * 确保 `<ws>/.gitignore` 覆盖 `.zcode/napcat/`；已覆盖则不动文件。
 *
 * @returns 是否真的改写了 .gitignore（调用方据此提示用户）。
 */
function ensureGitignore(wsDir: string): boolean {
  const gi = join(wsDir, '.gitignore');
  let content = '';
  try { content = readFileSync(gi, 'utf-8'); } catch { /* 文件不存在 */ }
  if (content.split('\n').some(coversExportDir)) return false;
  // 原文件没有结尾换行时先补一个，避免把新规则粘在上一行末尾。
  const addition = (content && !content.endsWith('\n') ? '\n' : '') + '.zcode/napcat/\n';
  writeFileSync(gi, content + addition, 'utf-8');
  return true;
}

/**
 * 把一个选区导出成 Markdown + JSON 一对文件。
 *
 * - `dir='user'` → `${homeDir ?? homedir()}/.zcode/napcat/exports/`
 * - `dir='workspace'` → `${workspaceDir}/.zcode/napcat/exports/`，并确保
 *   `<workspaceDir>/.gitignore` 覆盖 `.zcode/napcat/`（缺覆盖时自动追加）。
 * - `dir='abs'` → `absPath` 指定的目录。
 *
 * 聊天记录是高敏数据（spec §5.8 / 安全要求）：默认落用户目录；工作区导出强制 gitignore 防护。
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
    target = join(wsDir, '.zcode', 'napcat', 'exports');
  } else if (opts.dir === 'abs') {
    // 缺路径时响亮失败：静默回落到用户目录会把聊天记录写到用户没要求的位置。
    if (!opts.absPath) throw new Error('abs export requires absPath');
    target = opts.absPath;
  } else {
    target = join(opts.homeDir ?? homedir(), '.zcode', 'napcat', 'exports');
  }
  mkdirSync(target, { recursive: true });
  if (wsDir) gitignoreUpdated = ensureGitignore(wsDir);
  const base = exportBaseName(opts.chat, opts.messages);
  const mdPath = join(target, `${base}.md`);
  const jsonPath = join(target, `${base}.json`);
  writeFileSync(mdPath, renderMarkdown(opts.messages, opts.chat), 'utf-8');
  writeFileSync(jsonPath, renderJson(opts.messages, opts.chat), 'utf-8');
  return { mdPath, jsonPath, gitignoreUpdated };
}
