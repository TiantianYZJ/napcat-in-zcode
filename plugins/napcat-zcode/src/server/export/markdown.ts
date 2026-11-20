import { segmentsText } from '../model/message.js';
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
 * 与注入体的区别只在「折行」这一点；逐条消息行格式两者必须一致（`[HH:mm] 发言人：内容`）。
 */
function flatten(s: string): string {
  return s.replace(/\r?\n/g, ' ').trim();
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
      return s.url ? `[图片](${s.url})` : '[图片]';
    case 'file': {
      const label = s.fileName ? `文件 ${s.fileName}` : '文件';
      return s.url ? `[${label}](${s.url})` : `[${label}]`;
    }
    default:
      return segmentsText([s]);
  }
}

/**
 * 把选区渲染成独立导出文档（Markdown）。
 *
 * 与注入体（model/format.ts 的 formatSelection）是**两个渲染器**：
 * - 本函数：无「不可信内容声明」头、无截断（导出的是全量选区）；
 *   日分隔用 Markdown 标题 `## YYYY-MM-DD`（独立文档需要结构）。
 * - 注入体：首行恒带不可信内容声明、超限截断；日分隔用纯文本 `—— YYYY-MM-DD ——`。
 *
 * 两者**逐条消息行格式必须一致**：`[HH:mm] 发言人：内容`。
 */
export function renderMarkdown(messages: Message[], chat: ChatRef): string {
  const out: string[] = [`# ${flatten(chat.name ?? '')}`, ''];
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
  out.push('', `> 导出时间：${fullDate(Math.floor(Date.now() / 1000))} · 共 ${messages.length} 条`);
  return out.join('\n') + '\n';
}
