import { segmentsText } from '../model/message.js';
import { UNTRUSTED_NOTICE } from '../model/notice.js';
import type { ChatRef, Message, Segment } from '../model/types.js';

function two(n: number): string { return String(n).padStart(2, '0'); }

/** HH:mm（本机本地时区，与 model/format.ts 同口径）。 */
function hm(t: number): string {
  const d = new Date(t * 1000);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** YYYY-MM-DD（本机本地时区）。 */
function ymd(t: number): string {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** YYYY-MM-DD HH:mm。 */
function fullDate(t: number): string {
  return `${ymd(t)} ${hm(t)}`;
}

/**
 * 折行净化：会话名、发言人名、引用预览都是不可信元数据（群名/昵称可含换行），
 * 换行会伪造出新的标题行/记录行。与 model/format.ts 的 flatten 同口径，只压成空格。
 *
 * 换行有三种形态都要压：CRLF（`\r\n`）、孤立 `\n`、孤立 `\r`——
 * CommonMark 也把 CR 当行结束符，只处理 `\r?\n` 时含孤立 CR 的会话名/昵称
 * 仍可在文档里伪造结构（跨任务登记的缺口，本轮已修）。
 *
 * 与注入体的区别只在「折行」这一点；逐条消息行格式两者必须一致（`[HH:mm] 发言人：内容`）。
 */
function flatten(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ').trim();
}

/**
 * Markdown 链接文本转义：方括号会破坏链接结构（`]` → `\]`），反斜杠本身是转义符（`\` → `\\`）。
 * 反斜杠漏转义时，文件名以 `\` 结尾会产出 `[文件 a\]`——`\]` 被当成转义掉的右括号，链接结构随之破坏。
 */
function escapeLabel(s: string): string {
  return s.replace(/([\\\[\]])/g, '\\$1');
}

/**
 * Markdown 链接目标：含空白或括号的 URL 会破坏 inline link 语法 → 用尖括号形式 `<url>`；
 * URL 里的 `<`/`>` 本身会破坏尖括号形式 → 先百分号编码。
 *
 * 非尖括号分支还要转义反斜杠：CommonMark 会把 `\` 当转义符吃掉（`a\b.png` → `ab.png`）；
 * 尖括号目标内部不做转义处理，故那里无需处理反斜杠。
 */
function linkTarget(url: string): string {
  const safe = url.replace(/[<>]/g, (c) => (c === '<' ? '%3C' : '%3E'));
  if (/[\s()]/.test(safe)) return `<${safe}>`;
  return safe.replace(/\\/g, '\\\\');
}

/** UTC 偏移标记（如 `UTC+08:00`）：让本地时间尾注能被换算成 JSON 里的 UTC ISO 时间。 */
function utcOffsetLabel(d: Date): string {
  const mins = -d.getTimezoneOffset(); // 本地相对 UTC 的分钟偏移（东八区为 +480）
  const abs = Math.abs(mins);
  return `UTC${mins < 0 ? '-' : '+'}${two(Math.floor(abs / 60))}:${two(abs % 60)}`;
}

/**
 * 单个段的 Markdown 文本。
 *
 * 媒体策略（spec §5.8）：默认不下载媒体，只留 URL 记入 JSON；
 * 有 url 的图片/文件渲染成 Markdown 链接，没有 url 的渲染成占位符。
 *
 * 文件段文案与 model/message.ts 的投影保持一致：有文件名 → `[文件 name]`，无文件名 → `[文件]`。
 */
function segmentText(s: Segment): string {
  switch (s.kind) {
    case 'image':
      return s.url ? `[图片](${linkTarget(s.url)})` : '[图片]';
    case 'file': {
      const label = s.fileName ? `文件 ${s.fileName}` : '文件';
      return s.url ? `[${escapeLabel(label)}](${linkTarget(s.url)})` : `[${escapeLabel(label)}]`;
    }
    default:
      return segmentsText([s]);
  }
}

/**
 * 把选区渲染成独立导出文档（Markdown）。
 *
 * 与注入体（model/format.ts 的 formatSelection）是**两个渲染器**：
 * - 本函数：**首部带不可信内容声明**、无截断（导出的是全量选区）；
 *   日分隔用 Markdown 标题 `## YYYY-MM-DD`（独立文档需要结构）。
 * - 注入体：首行恒带不可信内容声明、超限截断；日分隔用纯文本 `—— YYYY-MM-DD ——`。
 *
 * 两者的**逐条消息行格式必须一致**：`[HH:mm] 发言人：内容`；
 * **信任标记也必须一致**：导出文件是插件推荐喂回模型的主路径
 * （服务端导出 → 复制 `@路径` → 用户粘贴 → 宿主把文件读进模型上下文），
 * 没有这句声明，模型读到的就只是一份看起来可信的聊天记录。
 */
export function renderMarkdown(messages: Message[], chat: ChatRef): string {
  const out: string[] = [`# ${flatten(chat.name ?? '')}`, '', UNTRUSTED_NOTICE, ''];
  let lastDay = '';
  for (const m of messages) {
    const day = ymd(m.time);
    if (day !== lastDay) { out.push(`## ${day}`, ''); lastDay = day; }
    const body = (m.segments ?? []).map(segmentText).join('');
    // 引用预览另起一行排在这条消息之前（与注入体同形态）；预览为空则不占一行。
    const preview = m.replyTo ? flatten(m.replyTo.preview ?? '') : '';
    if (preview) out.push(`> ${preview}`);
    out.push(`[${hm(m.time)}] ${flatten(m.senderName ?? '')}：${body}`);
  }
  out.push('', `> 导出时间：${fullDate(Math.floor(Date.now() / 1000))} (${utcOffsetLabel(new Date())}) · 共 ${messages.length} 条`);
  return out.join('\n') + '\n';
}
