import type { OB11Message, OB11MessageSegment } from '../onebot/types.js';
import type { Message, Segment } from './types.js';

/**
 * 纯文本投影占位符。
 * 键是规范化后的 Segment.kind（不是 OB11 段类型名：OB11 的 'record' 段规范化后 kind 是 'voice'），
 * satisfies 让键名拼错或漏写时在编译期暴露，而不是静默渲染成空串。
 */
const PLACEHOLDERS = {
  image: '[图片]',
  voice: '[语音]',
  video: '[视频]',
  face: '[表情]',
  forward: '[合并转发]',
  json: '[卡片]',
} satisfies Partial<Record<Segment['kind'], string>>;

/**
 * 段的纯文本投影。switch 对 Segment['kind'] 穷尽：
 * 新增段类型时这里编译期报错，不会漏投影。
 */
function segText(s: Segment): string {
  switch (s.kind) {
    case 'text': return s.text;
    case 'at': return `@${s.name || s.qq}`;
    case 'face': return PLACEHOLDERS.face;
    case 'reply': return '';
    case 'image': return PLACEHOLDERS.image;
    case 'voice': return PLACEHOLDERS.voice;
    case 'video': return PLACEHOLDERS.video;
    case 'file': return s.fileName ? `[文件 ${s.fileName}]` : '[文件]';
    case 'json': return PLACEHOLDERS.json;
    case 'forward': return PLACEHOLDERS.forward;
  }
}

export function segmentsText(segments: Segment[]): string {
  return segments.map(segText).join('');
}

/** 数值字段安全转换：空值与非数值字符串都归为 undefined，不产生 NaN。 */
function toNum(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeSegment(seg: OB11MessageSegment): Segment {
  const d: Record<string, unknown> = seg.data ?? {};
  switch (seg.type) {
    case 'text': return { kind: 'text', text: String(d.text ?? '') };
    case 'at': return { kind: 'at', qq: String(d.qq ?? ''), name: d.name ? String(d.name) : undefined };
    case 'face': return { kind: 'face', faceId: String(d.id ?? ''), text: d.text ? String(d.text) : undefined };
    case 'reply': return { kind: 'reply', messageId: String(d.id ?? '') };
    case 'image': return { kind: 'image', url: d.url ? String(d.url) : undefined, fileId: d.file ? String(d.file) : undefined, width: toNum(d.width), height: toNum(d.height) };
    // 语音时长字段名各实现不一（seconds/duration/time），三种都吃；真实字段名待 NapCat 实测确认。
    case 'record': return { kind: 'voice', url: d.url ? String(d.url) : undefined, duration: toNum(d.seconds) ?? toNum(d.duration) ?? toNum(d.time) };
    case 'video': return { kind: 'video', url: d.url ? String(d.url) : undefined, fileName: d.file ? String(d.file) : undefined };
    case 'file': return { kind: 'file', url: d.url ? String(d.url) : undefined, fileName: d.name ? String(d.name) : d.file ? String(d.file) : undefined, size: toNum(d.size) };
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

/**
 * CQ 码转义还原：先还原 &#91; / &#93; / &#44;，再还原 &amp;
 * （顺序要紧：先还原 &amp; 会把 &amp;#44; 里的 &#44; 提前吃掉）。
 */
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

/**
 * CQ 码粗解析（NapCat 少数场景 message 为字符串）。
 * 纯文本片段同样要还原 CQ 转义，否则 'AT&amp;T' 这类正文会带着转义残留进入 Message.text，
 * 关键词搜索搜不到、导出的正文也不干净。
 */
function parseCq(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\[CQ:([a-z][a-z0-9_]*)(?:,([^\]]*))?\]/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: 'text', text: unescapeCq(text.slice(last, m.index)) });
    const type = m[1].toLowerCase();
    const data = parseCqParams(m[2] ?? '');
    out.push(normalizeSegment({ type, data }));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: unescapeCq(text.slice(last)) });
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
