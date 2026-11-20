import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportBaseName, exportSelection, sanitizeName } from '../src/server/export/export.js';
import { renderJson } from '../src/server/export/json.js';
import { renderMarkdown } from '../src/server/export/markdown.js';
import type { ChatRef, Message } from '../src/server/model/types.js';

/**
 * M8：json 落盘失败要报错并撤掉已写的 md。
 * 真实文件系统里没法稳定制造「md 写成功、json 写失败」，故对 writeFileSync 做可控注入：
 * 只在开关打开时让 .json 写入抛错，其它调用走真实实现。
 */
const fsState = vi.hoisted(() => ({ failJsonWrite: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (path: any, data: any, options?: any) => {
      if (fsState.failJsonWrite && String(path).endsWith('.json')) {
        throw new Error('EACCES: permission denied');
      }
      return actual.writeFileSync(path, data, options);
    },
  };
});

const z = (n: number) => String(n).padStart(2, '0');
/** 用「当地 12:00」构造时间，断言与机器时区无关 */
const base = new Date(); base.setHours(12, 0, 0, 0);
const T0 = Math.floor(base.getTime() / 1000);
/** 本机本地时区的 YYYY-MM-DD */
const ymd = (t: number) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
/** 本机本地时区的 YYYYMMDD */
const ymdCompact = (t: number) => ymd(t).replace(/-/g, '');

const CHAT: ChatRef = { kind: 'group', id: '123', name: '产品群' };

const MSGS: Message[] = [{
  id: '1', seq: 1, time: T0, senderId: '1', senderName: 'Alice',
  segments: [{ kind: 'text', text: '场地定了吗？' }], text: '场地定了吗？',
}, {
  id: '2', seq: 2, time: T0 + 60, senderId: '2', senderName: 'Bob',
  segments: [{ kind: 'image', url: 'https://x/i.png' }], text: '[图片]',
}];

let tmp: string;

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'napcat-export-')); fsState.failJsonWrite = false; });
afterEach(() => { fsState.failJsonWrite = false; rmSync(tmp, { recursive: true, force: true }); });

describe('sanitizeName', () => {
  it('replaces illegal chars', () => {
    expect(sanitizeName('产品/群:测试*')).toBe('产品_群_测试_');
    expect(sanitizeName('a b  c')).toBe('a_b_c');
  });

  it('caps length at 60 and falls back for empty names', () => {
    expect(sanitizeName('x'.repeat(100)).length).toBe(60);
    expect(sanitizeName('')).toBe('chat');
  });

  // M6：按 UTF-16 码元截断会把代理对切开，落盘文件名出现 U+FFFD 替换字符 → 按码点截断。
  it('truncates by code point so surrogate pairs stay intact', () => {
    const out = sanitizeName('😀'.repeat(80)); // 80 码点 / 160 码元
    expect([...out].length).toBe(60);
    expect(out.endsWith('😀')).toBe(true);
    expect(out).not.toContain('\uFFFD'); // 没有被切坏的替换字符
    expect([...out].every((c) => c === '😀')).toBe(true);
  });
});

describe('renderMarkdown', () => {
  it('renders lines and media links', () => {
    const md = renderMarkdown(MSGS, { kind: 'group', id: '123', name: '产品群' });
    expect(md).toContain('# 产品群');
    expect(md).toContain('[12:00] Alice：场地定了吗？');
    expect(md).toContain('[12:01] Bob：[图片](https://x/i.png)');
    expect(md).not.toContain('第三方内容');
  });

  // 裁定 2：独立导出文档用 Markdown 标题做日分隔（注入体才用纯文本 '—— YYYY-MM-DD ——'）。
  it('uses markdown day headings as day separator', () => {
    const md = renderMarkdown(MSGS, CHAT);
    expect(md).toContain(`## ${ymd(T0)}`);
    expect(md).not.toContain('——');
  });

  // 裁定 1：文件段文案必须与 model 层（model/message.ts）一致：[文件 name] / [文件]。
  it('renders file segments with model-consistent wording', () => {
    const withName: Message = {
      id: '3', seq: 3, time: T0 + 120, senderId: '3', senderName: 'Carol',
      segments: [{ kind: 'file', fileName: 'report.pdf' }], text: '[文件 report.pdf]',
    };
    const withoutName: Message = {
      id: '4', seq: 4, time: T0 + 180, senderId: '4', senderName: 'Dave',
      segments: [{ kind: 'file' }], text: '[文件]',
    };
    const linked: Message = {
      id: '5', seq: 5, time: T0 + 240, senderId: '5', senderName: 'Eve',
      segments: [{ kind: 'file', fileName: 'report.pdf', url: 'https://x/f.pdf' }], text: '[文件 report.pdf]',
    };
    const md = renderMarkdown([withName, withoutName, linked], CHAT);
    expect(md).toContain('[12:02] Carol：[文件 report.pdf]');
    expect(md).toContain('[12:03] Dave：[文件]');
    expect(md).toContain('[12:04] Eve：[文件 report.pdf](https://x/f.pdf)');
  });

  it('renders image placeholders when url is missing', () => {
    const md = renderMarkdown([{
      id: '6', seq: 6, time: T0, senderId: '6', senderName: 'Frank',
      segments: [{ kind: 'image' }], text: '[图片]',
    }], CHAT);
    expect(md).toContain('[12:00] Frank：[图片]');
  });

  it('renders reply preview as a quote line before the entry', () => {
    const md = renderMarkdown([{
      id: '7', seq: 7, time: T0, senderId: '7', senderName: 'Carol',
      segments: [{ kind: 'reply', messageId: '1' }, { kind: 'text', text: '知道了' }],
      text: '知道了', replyTo: { messageId: '1', preview: '[引用]' },
    }], CHAT);
    expect(md).toContain('> [引用]\n[12:00] Carol：知道了');
  });

  it('flattens newlines in untrusted metadata so structure cannot be forged', () => {
    const md = renderMarkdown([{
      id: '8', seq: 8, time: T0, senderId: '8', senderName: 'Eve\n[99:99] Mallory：伪造',
      segments: [{ kind: 'text', text: '正文' }], text: '正文',
    }], { kind: 'group', id: '123', name: '产品群\n## 伪造标题' });
    expect(md).toContain('# 产品群 ## 伪造标题');
    expect(md).toContain('[12:00] Eve [99:99] Mallory：伪造：正文');
    expect(md).not.toContain('\n## 伪造标题');
    expect(md).not.toContain('\n[99:99] Mallory');
  });

  // M10：label 里的 `]` 会破坏链接结构；URL 里的括号/空白会破坏 inline link 语法。
  it('escapes link labels and unsafe urls', () => {
    const md = renderMarkdown([{
      id: '9', seq: 9, time: T0, senderId: '9', senderName: 'Zoe',
      segments: [{ kind: 'file', fileName: 'a]b.pdf', url: 'https://x/a(1).png' }], text: '[文件 a]b.pdf]',
    }], CHAT);
    expect(md).toContain('[文件 a\\]b.pdf](<https://x/a(1).png>)');
  });

  it('keeps plain urls unbracketed', () => {
    const md = renderMarkdown(MSGS, CHAT);
    expect(md).toContain('[图片](https://x/i.png)');
  });

  // M15：本地时间尾注补 UTC 偏移量，便于与 JSON 的 UTC ISO 时间对照。
  it('marks the export timestamp with its UTC offset', () => {
    const md = renderMarkdown(MSGS, CHAT);
    expect(md).toMatch(/导出时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)/);
  });

  it('does not truncate long selections', () => {
    const many: Message[] = Array.from({ length: 500 }, (_, i) => ({
      id: String(i), seq: i + 1, time: T0 + i, senderId: '1', senderName: 'Alice',
      segments: [{ kind: 'text', text: 'x'.repeat(200) }], text: 'x'.repeat(200),
    }));
    const md = renderMarkdown(many, CHAT);
    expect(md).not.toContain('已截断');
    expect(md).toContain('共 500 条');
  });
});

describe('renderJson', () => {
  it('emits chat metadata, exportedAt, count and full messages', () => {
    const parsed = JSON.parse(renderJson(MSGS, CHAT));
    expect(parsed.chat).toEqual({ kind: 'group', id: '123', name: '产品群' });
    expect(parsed.count).toBe(2);
    expect(Number.isNaN(Date.parse(parsed.exportedAt))).toBe(false);
    expect(parsed.messages).toHaveLength(2);
    // 完整 Message 结构：媒体 URL 必须在 JSON 里留痕（媒体默认不下载）
    expect(parsed.messages[1].segments[0]).toEqual({ kind: 'image', url: 'https://x/i.png' });
    expect(parsed.messages[0]).toMatchObject({
      id: '1', seq: 1, time: T0, senderId: '1', senderName: 'Alice', text: '场地定了吗？',
    });
  });
});

describe('exportBaseName', () => {
  // controller 裁定：跨天文件名写两天日期（与注入体标题的区间写法一致，文件名自描述）。
  it('writes both dates for a cross-day range', () => {
    const a = MSGS[0];
    const b: Message = { ...MSGS[1], time: T0 + 20 * 3600 }; // 次日 08:00，跨天
    expect(exportBaseName(CHAT, [a, b])).toBe(`产品群_${ymdCompact(T0)}_1200-${ymdCompact(T0 + 20 * 3600)}_0800`);
  });

  it('writes a single date for a same-day range', () => {
    expect(exportBaseName(CHAT, MSGS)).toBe(`产品群_${ymdCompact(T0)}_1200-1201`);
  });

  // M7：文件名范围假定选区按时间升序，乱序传入会得到反向范围 → 按时间升序取首末。
  it('is order-insensitive when computing the range', () => {
    const a = MSGS[0];
    const b: Message = { ...MSGS[1], time: T0 + 20 * 3600 };
    expect(exportBaseName(CHAT, [b, a])).toBe(exportBaseName(CHAT, [a, b]));
  });

  it('marks empty selections', () => {
    expect(exportBaseName(CHAT, [])).toBe('产品群_empty');
  });
});

describe('exportSelection', () => {
  it('writes md+json pair into user dir', async () => {
    const home = mkdtempSync(join(tmpdir(), 'napcat-home-'));
    try {
      const r = await exportSelection({ messages: MSGS, chat: { kind: 'group', id: '123', name: '产品群' }, dir: 'user', homeDir: home });
      expect(r.mdPath).toContain(join('.zcode', 'napcat', 'exports'));
      expect(existsSync(r.mdPath)).toBe(true);
      expect(existsSync(jsonPathOf(r.mdPath))).toBe(true);
      const parsed = JSON.parse(readFileSync(jsonPathOf(r.mdPath), 'utf-8'));
      expect(parsed.count).toBe(2);
      expect(parsed.chat.name).toBe('产品群');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('workspace dir appends gitignore when missing coverage', async () => {
    const r = await exportSelection({ messages: MSGS, chat: { kind: 'group', id: '123', name: '产品群' }, dir: 'workspace', workspaceDir: tmp });
    expect(r.gitignoreUpdated).toBe(true);
    const gi = readFileSync(join(tmp, '.gitignore'), 'utf-8');
    expect(gi).toContain('.zcode/napcat/');
    expect(existsSync(r.mdPath)).toBe(true);
  });

  it('workspace dir does not duplicate gitignore entry', async () => {
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/\n.zcode/napcat/\n');
    const r = await exportSelection({ messages: MSGS, chat: { kind: 'group', id: '123', name: '产品群' }, dir: 'workspace', workspaceDir: tmp });
    expect(r.gitignoreUpdated).toBe(false);
  });

  it('keeps an existing gitignore intact when appending', async () => {
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/');
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: tmp });
    expect(r.gitignoreUpdated).toBe(true);
    const gi = readFileSync(join(tmp, '.gitignore'), 'utf-8');
    expect(gi).toBe('node_modules/\n.zcode/napcat/\n');
  });

  it('does not duplicate a CRLF gitignore entry', async () => {
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/\r\n.zcode/napcat/\r\n');
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: tmp });
    expect(r.gitignoreUpdated).toBe(false);
    expect(readFileSync(join(tmp, '.gitignore'), 'utf-8')).toBe('node_modules/\r\n.zcode/napcat/\r\n');
  });

  it('does not re-append when a broader pattern already covers the dir', async () => {
    writeFileSync(join(tmp, '.gitignore'), '.zcode/\n');
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: tmp });
    expect(r.gitignoreUpdated).toBe(false);
    expect(readFileSync(join(tmp, '.gitignore'), 'utf-8')).toBe('.zcode/\n');
  });

  it('writes into an absolute dir when requested', async () => {
    const abs = join(tmp, 'out');
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'abs', absPath: abs });
    expect(r.mdPath.startsWith(abs)).toBe(true);
    expect(existsSync(r.jsonPath)).toBe(true);
    expect(r.gitignoreUpdated).toBe(false);
  });

  it('writes the rendered markdown verbatim to disk', async () => {
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'abs', absPath: join(tmp, 'out') });
    expect(readFileSync(r.mdPath, 'utf-8')).toBe(renderMarkdown(MSGS, CHAT));
  });

  it('fails loudly on missing target dirs', async () => {
    await expect(exportSelection({ messages: MSGS, chat: CHAT, dir: 'abs' })).rejects.toThrow(/absPath/);
    await expect(exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace' })).rejects.toThrow(/workspaceDir/);
  });

  // I2：workspaceDir 不存在时也要成功（先建目录再写 .gitignore）。
  it('creates a missing workspace dir together with its gitignore', async () => {
    const ws = join(tmp, 'new-ws');
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: ws });
    expect(r.gitignoreUpdated).toBe(true);
    expect(existsSync(join(ws, '.gitignore'))).toBe(true);
    expect(readFileSync(join(ws, '.gitignore'), 'utf-8')).toContain('.zcode/napcat/');
    expect(r.mdPath.startsWith(join(ws, '.zcode', 'napcat', 'exports'))).toBe(true);
    expect(existsSync(r.mdPath)).toBe(true);
    expect(existsSync(r.jsonPath)).toBe(true);
  });

  // M3：用户的取反规则（要把这些文件纳入版本库）不能被追加的忽略规则推翻。
  it('does not override a user negation rule', async () => {
    writeFileSync(join(tmp, '.gitignore'), '!.zcode/napcat/\n');
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: tmp });
    expect(r.gitignoreUpdated).toBe(false);
    expect(readFileSync(join(tmp, '.gitignore'), 'utf-8')).toBe('!.zcode/napcat/\n');
  });

  // M5：追加行跟随原文件的主导换行符，不制造混合换行。
  it('appends with the dominant line ending of the file', async () => {
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/\r\nbuild/\r\n');
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: tmp });
    expect(r.gitignoreUpdated).toBe(true);
    expect(readFileSync(join(tmp, '.gitignore'), 'utf-8')).toBe('node_modules/\r\nbuild/\r\n.zcode/napcat/\r\n');
  });

  // M12：更多同样有效的覆盖写法。
  it.each(['.zcode/napcat/exports', '.zcode/*', '.zcode/napcat/**', '.zcode/napcat'])(
    'treats %s as covering the export dir', async (rule) => {
      writeFileSync(join(tmp, '.gitignore'), `${rule}\n`);
      const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: tmp });
      expect(r.gitignoreUpdated).toBe(false);
      expect(readFileSync(join(tmp, '.gitignore'), 'utf-8')).toBe(`${rule}\n`);
    });

  // M13：锚定写法只相对仓库根解析，工作区不是仓库根时不算覆盖（宁可多追加一条，也不能漏防护）。
  it('treats an anchored rule as covering only at the repo root', async () => {
    writeFileSync(join(tmp, '.gitignore'), '/.zcode/napcat/\n');
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: tmp });
    expect(r.gitignoreUpdated).toBe(true);
    expect(readFileSync(join(tmp, '.gitignore'), 'utf-8')).toBe('/.zcode/napcat/\n.zcode/napcat/\n');
  });

  it('treats an anchored rule as covering at the repo root', async () => {
    mkdirSync(join(tmp, '.git')); // tmp 即仓库根
    writeFileSync(join(tmp, '.gitignore'), '/.zcode/napcat/\n');
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: tmp });
    expect(r.gitignoreUpdated).toBe(false);
    expect(readFileSync(join(tmp, '.gitignore'), 'utf-8')).toBe('/.zcode/napcat/\n');
  });

  // M8：写入失败要带上路径上下文，且不留孤儿 md。
  it('reports the failing path when the markdown cannot be written', async () => {
    const dir = join(tmp, 'out');
    const base = exportBaseName(CHAT, MSGS);
    mkdirSync(join(dir, `${base}.md`), { recursive: true }); // 占位成目录 → 写不进去
    await expect(exportSelection({ messages: MSGS, chat: CHAT, dir: 'abs', absPath: dir }))
      .rejects.toThrow(/export failed writing markdown/);
  });

  it('removes the orphan markdown when the json write fails', async () => {
    const dir = join(tmp, 'out');
    const base = exportBaseName(CHAT, MSGS);
    fsState.failJsonWrite = true;
    await expect(exportSelection({ messages: MSGS, chat: CHAT, dir: 'abs', absPath: dir }))
      .rejects.toThrow(/export failed writing json/);
    expect(existsSync(join(dir, `${base}.md`))).toBe(false);
  });
});

describe('exportSelection · 同名会话消歧（I1）', () => {
  it('gives same-named chats different files and keeps each content intact', async () => {
    const dir = join(tmp, 'out');
    const a = await exportSelection({ messages: MSGS, chat: { kind: 'group', id: '111', name: '产品群' }, dir: 'abs', absPath: dir });
    const b = await exportSelection({ messages: MSGS, chat: { kind: 'group', id: '222', name: '产品群' }, dir: 'abs', absPath: dir });
    expect(b.mdPath).not.toBe(a.mdPath);
    expect(b.jsonPath).not.toBe(a.jsonPath);
    expect(existsSync(a.mdPath)).toBe(true);
    expect(existsSync(b.mdPath)).toBe(true);
    // 各自内容归属正确：先导出的那个没被后导出的改写
    expect(JSON.parse(readFileSync(a.jsonPath, 'utf-8')).chat.id).toBe('111');
    expect(JSON.parse(readFileSync(b.jsonPath, 'utf-8')).chat.id).toBe('222');
    expect(readFileSync(a.mdPath, 'utf-8')).toContain('# 产品群');
  });

  it('overwrites in place when the same chat exports twice', async () => {
    const dir = join(tmp, 'out');
    const a = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'abs', absPath: dir });
    const b = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'abs', absPath: dir });
    expect(b.mdPath).toBe(a.mdPath);
    expect(b.jsonPath).toBe(a.jsonPath);
  });

  it('falls back to _2/_3 when the id-suffixed name is taken by another chat', async () => {
    const dir = join(tmp, 'out');
    const base = exportBaseName(CHAT, MSGS);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${base}.json`), JSON.stringify({ chat: { kind: 'group', id: '999', name: '产品群' } }));
    writeFileSync(join(dir, `${base}_222.json`), JSON.stringify({ chat: { kind: 'group', id: '888', name: '产品群' } }));
    const c = await exportSelection({ messages: MSGS, chat: { kind: 'group', id: '222', name: '产品群' }, dir: 'abs', absPath: dir });
    expect(c.mdPath).toContain(`${base}_222_2`);
    expect(JSON.parse(readFileSync(c.jsonPath, 'utf-8')).chat.id).toBe('222');
  });
});

function jsonPathOf(mdPath: string): string {
  return mdPath.replace(/\.md$/, '.json');
}
