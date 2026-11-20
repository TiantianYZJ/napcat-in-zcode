import type { OB11Message, OB11MessageSegment } from '../onebot/types.js';
import type { Message, Segment } from './types.js';

// 键是规范化后的 Segment.kind（不是 OB11 段类型名）：
// OB11 的 'record' 段规范化后 kind 是 'voice'，用段类型名做键会取不到占位符。
const PLACEHOLDERS: Record<string, string> = {
  image: '[图片]',
  voice: '[语音]',
  video: '[视频]',
  face: '[表情]',
  forward: '[合并转发]',
  json: '[卡片]',
};

function segText(s: Segment): string {
  switch (s.kind) {
    case 'text': return s.text;
    case 'at': return `@${s.name ?? s.qq}`;
    case 'file': return `[文件 ${s.fileName ?? ''}]`.trimEnd();
    default: return PLACEHOLDERS[s.kind] ?? '';
  }
}

export function segmentsText(segments: Segment[]): string {
  return segments.map(segText).join('');
}

function normalizeSegment(seg: OB11MessageSegment): Segment {
  const d: Record<string, unknown> = seg.data ?? {};
  switch (seg.type) {
    case 'text': return { kind: 'text', text: String(d.text ?? '') };
    case 'at': return { kind: 'at', qq: String(d.qq ?? ''), name: d.name ? String(d.name) : undefined };
    case 'face': return { kind: 'face', faceId: String(d.id ?? ''), text: d.text ? String(d.text) : undefined };
    case 'reply': return { kind: 'reply', messageId: String(d.id ?? '') };
    case 'image': return { kind: 'image', url: d.url ? String(d.url) : undefined, fileId: d.file ? String(d.file) : undefined, width: d.width ? Number(d.width) : undefined, height: d.height ? Number(d.height) : undefined };
    case 'record': return { kind: 'voice', url: d.url ? String(d.url) : undefined, duration: d.seconds ? Number(d.seconds) : undefined };
    case 'video': return { kind: 'video', url: d.url ? String(d.url) : undefined, fileName: d.file ? String(d.file) : undefined };
    case 'file': return { kind: 'file', url: d.url ? String(d.url) : undefined, fileName: d.name ? String(d.name) : d.file ? String(d.file) : undefined, size: d.size ? Number(d.size) : undefined };
    case 'forward': return { kind: 'forward', messageId: String(d.id ?? '') };
    case 'json': return { kind: 'json', raw: jsonRaw(d.data) };
    default: return { kind: 'text', text: `[${seg.type}]` };
  }
}

/** json 段的载荷标准是字符串；个别实现直接给对象，此时保留为 JSON 文本而不是 '[object Object]'。 */
function jsonRaw(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value) ?? '';
}

/** CQ 码转义还原。 */
function unescapeCq(s: string): string {
  return s
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/**
 * 解析 CQ 码参数串：按 ',' 切参数，参数内按第一个 '=' 切键值，键值都去首尾空白。
 *
 * 不用 URLSearchParams：CQ 值是原样字面量，而 URLSearchParams 会把 '+' 当空格、
 * 把 '%xx' 当百分号编码解码、还会把 '&' 当参数分隔符——后两者会直接截断带查询串的
 * url（如 url=https://x/i.png?w=1&h=2 会被切成 url=...w=1 与 h=2）。
 */
function parseCqParams(paramStr: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of paramStr.split(',')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    const key = (eq === -1 ? part : part.slice(0, eq)).trim();
    if (!key) continue;
    out[key] = unescapeCq(eq === -1 ? '' : part.slice(eq + 1).trim());
  }
  return out;
}

/** CQ 码粗解析（NapCat 少数场景 message 为字符串）。 */
function parseCq(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\[CQ:([a-z][a-z0-9_]*)(?:,([^\]]*))?\]/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    const type = m[1].toLowerCase();
    const data = parseCqParams(m[2] ?? '');
    out.push(normalizeSegment({ type, data }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

export function normalizeMessage(raw: OB11Message): Message {
  const segments = Array.isArray(raw.message)
    ? raw.message.map(normalizeSegment)
    : parseCq(String(raw.message ?? raw.raw_message ?? ''));
  const replySeg = segments.find((s): s is Extract<Segment, { kind: 'reply' }> => s.kind === 'reply');
  return {
    id: String(raw.message_id ?? raw.real_id ?? raw.message_seq ?? ''),
    seq: Number(raw.message_seq ?? raw.message_id ?? 0),
    time: Number(raw.time ?? 0),
    senderId: String(raw.sender?.user_id ?? raw.user_id ?? ''),
    senderName: raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? ''),
    segments,
    text: segmentsText(segments),
    // 被回复消息的正文不在当前 payload 里（reply 段只带被回复的 message_id），
    // 取不到原文时用 '[引用]' 占位；调用方拿到 messageId 后可再调 get_msg 补正文。
    replyTo: replySeg ? { messageId: replySeg.messageId, preview: '[引用]' } : undefined,
  };
}
