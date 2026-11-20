import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportBaseName, exportSelection, sanitizeName } from '../src/server/export/export.js';
import { renderJson } from '../src/server/export/json.js';
import { renderMarkdown } from '../src/server/export/markdown.js';
import type { ChatRef, Message } from '../src/server/model/types.js';

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

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'napcat-export-')); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('sanitizeName', () => {
  it('replaces illegal chars', () => {
    expect(sanitizeName('产品/群:测试*')).toBe('产品_群_测试_');
    expect(sanitizeName('a b  c')).toBe('a_b_c');
  });

  it('caps length at 60 and falls back for empty names', () => {
    expect(sanitizeName('x'.repeat(100)).length).toBe(60);
    expect(sanitizeName('')).toBe('chat');
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
  it('uses first-day date and first..last time range', () => {
    const a = MSGS[0];
    const b: Message = { ...MSGS[1], time: T0 + 20 * 3600 }; // 次日 08:00，跨天
    expect(exportBaseName(CHAT, [a, b])).toBe(`产品群_${ymdCompact(T0)}_1200-0800`);
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
});

function jsonPathOf(mdPath: string): string {
  return mdPath.replace(/\.md$/, '.json');
}
