import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportBaseName, exportSelection, sanitizeName } from '../src/server/export/export.js';
import { renderJson } from '../src/server/export/json.js';
import { renderMarkdown } from '../src/server/export/markdown.js';
import { UNTRUSTED_NOTICE } from '../src/server/model/notice.js';
import type { ChatRef, Message } from '../src/server/model/types.js';

/**
 * M8：json 落盘失败要报错并撤掉已写的 md。
 * 真实文件系统里没法稳定制造「md 写成功、json 写失败」，故对 writeFileSync 做可控注入：
 * 只在开关打开时让 .json 写入抛错，其它调用走真实实现。
 *
 * 顺带**记录**每次 write/mkdir 的选项：权限位（MF-4）在 Windows 上无法从 `stat` 观察到
 * （那里没有 POSIX mode），但「写盘时传了什么 mode」是跨平台可断言的。
 *
 * 另外记录 readFileSync 的调用路径：M1.1 起既有导出 JSON **不再被整读**
 * （只读头部若干 KB），这条断言就是那个性能约束的承重用例。
 */
const fsState = vi.hoisted(() => ({
  failJsonWrite: false,
  writes: [] as Array<{ path: string; options: any }>,
  mkdirs: [] as Array<{ path: string; options: any }>,
  reads: [] as string[],
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdirSync: (path: any, options?: any) => {
      fsState.mkdirs.push({ path: String(path), options });
      return actual.mkdirSync(path, options);
    },
    writeFileSync: (path: any, data: any, options?: any) => {
      fsState.writes.push({ path: String(path), options });
      if (fsState.failJsonWrite && String(path).endsWith('.json')) {
        throw new Error('EACCES: permission denied');
      }
      return actual.writeFileSync(path, data, options);
    },
    readFileSync: (path: any, ...rest: any[]) => {
      fsState.reads.push(String(path));
      return (actual.readFileSync as any)(path, ...rest);
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'napcat-export-'));
  fsState.failJsonWrite = false;
  fsState.writes.length = 0;
  fsState.mkdirs.length = 0;
  fsState.reads.length = 0;
});
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
    // 导出文档**带**不可信声明（MF-1）：导出文件是插件推荐喂回模型的主路径
    // （服务端导出 → 复制 @路径 → 用户粘贴 → 宿主把文件读进模型上下文），
    // 没有这句声明，模型读到的就只是一份看起来可信的聊天记录。
    // （原断言是 `not.toContain('第三方内容')`——它锁的正是本次要改掉的行为。）
    expect(md).toContain(UNTRUSTED_NOTICE);
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

  // N4/N5：label 里的反斜杠要转义（否则 `a\` 会吃掉后面的 `]`），非尖括号 URL 里的反斜杠也要转义。
  it('escapes backslashes in labels and plain urls', () => {
    const md = renderMarkdown([{
      id: '10', seq: 10, time: T0, senderId: '10', senderName: 'Ann',
      segments: [
        { kind: 'file', fileName: 'a\\b.pdf', url: 'https://x/f.pdf' },
        { kind: 'image', url: 'https://x/a\\b.png' },
      ], text: '',
    }], CHAT);
    expect(md).toContain('[文件 a\\\\b.pdf](https://x/f.pdf)');
    expect(md).toContain('[图片](https://x/a\\\\b.png)');
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

  // M1.1 S1：没有有效时间（缺失 / 非有限）的消息**跳过**，并如实报出跳过了几条。
  // 以前直接拿 m.time 渲染 → `## NaN-NaN-NaN` 与 `[NaN:NaN]`（假时间戳）。
  it('skips messages without a valid time and reports how many were skipped', () => {
    const msgs: Message[] = [
      MSGS[0],
      { ...MSGS[1], time: undefined },        // time 缺失
      { ...MSGS[1], id: '3', time: Number.NaN }, // time 非有限
    ];
    const md = renderMarkdown(msgs, CHAT);
    // 被跳过的两条不渲染（内容、发言人都不会出现）
    expect(md).not.toContain('Bob');
    expect(md).not.toContain('[图片]');
    // 渲染出来的那一条完整保留
    expect(md).toContain('[12:00] Alice：场地定了吗？');
    // 绝不产出 NaN 字样
    expect(md).not.toContain('NaN');
    // 「共 N 条」= **渲染数**，并说明另外几条为什么没渲染
    expect(md).toContain('共 1 条');
    expect(md).toContain('（另有 2 条缺少有效时间，未渲染）');
  });

  it('skips every message when none of them has a valid time', () => {
    const md = renderMarkdown([{ ...MSGS[0], time: Number.NaN }], CHAT);
    expect(md).not.toContain('NaN');
    expect(md).not.toContain('Alice');
    expect(md).toContain('共 0 条');
    expect(md).toContain('（另有 1 条缺少有效时间，未渲染）');
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

  // I2：工作区目录**必须已经存在**（最终修复波 should-fix #7）。
  // 以前是 mkdir 一把梭，会把不存在的 `<ws>/.zcode/napcat/exports` 连同 `<ws>/.gitignore`
  // 一起凭空造出来（用户填错路径就在那儿建出一棵目录树、还改了 .gitignore）。
  // 现在：不存在 ⇒ 明确报错，且**不创建**任何目录。
  it('rejects a missing workspace dir instead of creating it', async () => {
    const ws = join(tmp, 'new-ws');
    await expect(
      exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: ws }),
    ).rejects.toThrow(/工作区目录不存在/);
    expect(existsSync(ws)).toBe(false); // 没有凭空造出目录树
    expect(existsSync(join(ws, '.gitignore'))).toBe(false);
  });

  // 工作区存在时：导出子目录与 .gitignore 照常创建。
  it('creates the export subdir and the gitignore inside an existing workspace', async () => {
    const ws = join(tmp, 'existing-ws');
    mkdirSync(ws, { recursive: true });
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: ws });
    expect(r.gitignoreUpdated).toBe(true);
    expect(existsSync(join(ws, '.gitignore'))).toBe(true);
    expect(readFileSync(join(ws, '.gitignore'), 'utf-8')).toContain('.zcode/napcat/');
    expect(r.mdPath.startsWith(join(ws, '.zcode', 'napcat', 'exports'))).toBe(true);
    expect(existsSync(r.mdPath)).toBe(true);
    expect(existsSync(r.jsonPath)).toBe(true);
  });

  // MF-4：导出文件与目录的权限位（跨平台可断言「写盘时传了什么 mode」——
  // Windows 上没有 POSIX mode，stat 看不到，只在 POSIX 用例里断言实际权限）。
  it('导出文件按 0600 写、导出目录按 0700 建', async () => {
    await exportSelection({ messages: MSGS, chat: CHAT, dir: 'user', homeDir: tmp });
    const md = fsState.writes.find((w) => w.path.endsWith('.md'));
    const json = fsState.writes.find((w) => w.path.endsWith('.json'));
    expect(md?.options?.mode).toBe(0o600);
    expect(json?.options?.mode).toBe(0o600);
    const dir = fsState.mkdirs.find((m) => m.path.endsWith(join('napcat', 'exports')));
    expect(dir?.options?.mode).toBe(0o700);
  });

  // MF-4：覆盖导出时权限也要收紧（mode 只在创建时生效 → 落盘后再 chmod 一次）。
  it('覆盖导出时也会把权限收回来', async () => {
    const first = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'user', homeDir: tmp });
    const { chmodSync, statSync } = await import('node:fs');
    chmodSync(first.mdPath, 0o644);
    chmodSync(first.jsonPath, 0o644);
    await exportSelection({ messages: MSGS, chat: CHAT, dir: 'user', homeDir: tmp });
    if (process.platform !== 'win32') {
      expect(statSync(first.mdPath).mode & 0o777).toBe(0o600);
      expect(statSync(first.jsonPath).mode & 0o777).toBe(0o600);
    }
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

  // N2：覆盖场景下 json 写失败**不能**删掉原有的 .md（删了目录里连 md 都不剩）。
  it('keeps a pre-existing markdown when the json write fails on a re-export', async () => {
    const dir = join(tmp, 'out');
    const first = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'abs', absPath: dir });
    fsState.failJsonWrite = true;
    await expect(exportSelection({ messages: MSGS, chat: CHAT, dir: 'abs', absPath: dir }))
      .rejects.toThrow(/export failed writing json/);
    expect(existsSync(first.mdPath)).toBe(true);
    expect(readFileSync(first.mdPath, 'utf-8')).toBe(renderMarkdown(MSGS, CHAT));
  });

  // N1：末字节是孤立 CR 时也要补分隔符，否则新规则会被并进上一行（该规则失效）。
  it('separates the appended rule when the gitignore ends with a lone CR', async () => {
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/\r');
    const r = await exportSelection({ messages: MSGS, chat: CHAT, dir: 'workspace', workspaceDir: tmp });
    expect(r.gitignoreUpdated).toBe(true);
    const gi = readFileSync(join(tmp, '.gitignore'), 'utf-8');
    expect(gi.split('\n')[1]).toBe('.zcode/napcat/');
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

  // M1.1-1：群与好友的 id 是两套编号空间，**数值可以完全相同**（群 123 与好友 123）。
  // 只比 id 的话，两者同名同 id 时会互相覆盖 → 内容错配 + 静默数据丢失。
  it('群与好友同 id 同名 → 产出两个不同文件，互不覆盖', async () => {
    const dir = join(tmp, 'out');
    const g = await exportSelection({ messages: MSGS, chat: { kind: 'group', id: '123', name: '产品群' }, dir: 'abs', absPath: dir });
    const f = await exportSelection({ messages: MSGS, chat: { kind: 'friend', id: '123', name: '产品群' }, dir: 'abs', absPath: dir });
    expect(f.mdPath).not.toBe(g.mdPath);
    expect(f.jsonPath).not.toBe(g.jsonPath);
    expect(existsSync(g.mdPath)).toBe(true);
    expect(existsSync(f.mdPath)).toBe(true);
    // 各自的内容归属正确：群那份没被好友那份改写（也没有反过来）
    expect(JSON.parse(readFileSync(g.jsonPath, 'utf-8')).chat).toEqual({ kind: 'group', id: '123', name: '产品群' });
    expect(JSON.parse(readFileSync(f.jsonPath, 'utf-8')).chat).toEqual({ kind: 'friend', id: '123', name: '产品群' });
  });

  // M1.1-1：老版本导出的 JSON 里没有 kind → 按「id 相同即同一会话」处理（向后兼容，
  // 不能因为升级就给用户凭空多出一堆重复文件）。
  it('既有导出没有 kind 字段时按 id 相同视为同一会话（老版本兼容，原地覆盖）', async () => {
    const dir = join(tmp, 'out');
    const base = exportBaseName(CHAT, MSGS);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${base}.json`), JSON.stringify({ chat: { id: '123' }, count: 0, messages: [] }));
    const r = await exportSelection({ messages: MSGS, chat: { kind: 'group', id: '123', name: '产品群' }, dir: 'abs', absPath: dir });
    expect(r.jsonPath).toBe(join(dir, `${base}.json`)); // 没有多出 _123 后缀
    expect(JSON.parse(readFileSync(r.jsonPath, 'utf-8')).chat.kind).toBe('group');
  });

  // M1.1-11：既有导出 JSON 不再被整读 + JSON.parse（只读头部若干 KB）。
  it('既有导出 JSON 只读头部，不再被整读进内存', async () => {
    const dir = join(tmp, 'out');
    const base = exportBaseName(CHAT, MSGS);
    mkdirSync(dir, { recursive: true });
    const big = JSON.stringify({
      chat: { kind: 'group', id: '999', name: '产品群' },
      count: 1,
      messages: Array.from({ length: 5000 }, (_, i) => ({ id: String(i), seq: i, time: 1700000000, text: 'x'.repeat(200) })),
    });
    writeFileSync(join(dir, `${base}.json`), big);
    const r = await exportSelection({ messages: MSGS, chat: { kind: 'group', id: '123', name: '产品群' }, dir: 'abs', absPath: dir });
    // 消歧仍然生效（读到了头部里的 chat.id=999 → 不是同一个会话 → 加 id 后缀）
    expect(r.jsonPath).toBe(join(dir, `${base}_123.json`));
    // 关键断言：既有导出 JSON 没有被 readFileSync 整读
    expect(fsState.reads.some((p) => p === join(dir, `${base}.json`))).toBe(false);
  });

  // M1.1-12：json 写失败时错误信息要带上路径（用户才知道是哪个文件没写成）。
  it('json 写失败的错误信息里带上出错的路径', async () => {
    const dir = join(tmp, 'out');
    const base = exportBaseName(CHAT, MSGS);
    fsState.failJsonWrite = true;
    await expect(exportSelection({ messages: MSGS, chat: CHAT, dir: 'abs', absPath: dir }))
      .rejects.toThrow(new RegExp(`export failed writing json .*${base}\\.json`));
  });

  // 会话名是用户可控的：名字里带花括号时，读既有导出 JSON 的「头部」仍要认得出会话。
  it('会话名里带花括号也能认出既有导出属于同一会话', async () => {
    const dir = join(tmp, 'out');
    const chat = { kind: 'group' as const, id: '123', name: '群{1}测试' };
    const first = await exportSelection({ messages: MSGS, chat, dir: 'abs', absPath: dir });
    const second = await exportSelection({ messages: MSGS, chat, dir: 'abs', absPath: dir });
    expect(second.jsonPath).toBe(first.jsonPath); // 同一会话 → 原地覆盖，不多出后缀文件
  });
});

function jsonPathOf(mdPath: string): string {
  return mdPath.replace(/\.md$/, '.json');
}
