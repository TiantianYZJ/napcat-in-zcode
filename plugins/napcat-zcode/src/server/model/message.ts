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

/**
 * 消息排序比较器（**时间语义**，2026-11-21 实测后确立）。
 *
 * 排序键：`time` 升序 → 同一秒内 `real_seq` 升序 → 再同则**保持服务端顺序**。
 *
 * 为什么不用 `message_seq` 排序：实测它是**随机 32 位短 id**（=== `message_id` === `real_id`），
 * 不是单调序号 —— 按它排序等于按随机数排序，输出顺序会与真实时间轴无关。
 * 会话内真正单调递增的是 `real_seq`（每会话独立计数）。
 *
 * 「保持服务端顺序」靠**稳定排序**实现：`Array.prototype.sort` 自 ES2019 起保证稳定，
 * 比较器相等时元素相对次序不变。
 *
 * 没有有效 `time` 的消息排在**最后**（排不进时间轴），它们之间同样保持服务端顺序。
 */
export function compareMessages(a: OB11Message, b: OB11Message): number {
  const ta = toNum(a.time);
  const tb = toNum(b.time);
  if (ta !== tb) {
    if (ta === undefined) return 1;
    if (tb === undefined) return -1;
    return ta - tb;
  }
  const ra = toNum(a.real_seq);
  const rb = toNum(b.real_seq);
  if (ra !== rb) {
    if (ra === undefined) return 1;
    if (rb === undefined) return -1;
    return ra - rb;
  }
  return 0;
}

/**
 * 按时间语义排序消息（升序：`time` → `real_seq` → 服务端顺序）。
 *
 * 返回**新数组**（不改原数组）。
 */
export function sortMessages(messages: readonly OB11Message[]): OB11Message[] {
  return [...messages].sort(compareMessages);
}

/**
 * 消息去重键：`message_seq`（短 id）优先 → `message_id` → `real_id`。
 *
 * 三个字段都没有时返回 `undefined` —— 这条消息**不参与去重**。
 * 不能拿「页内下标」当键：跨页的同一条消息下标相同，会被误判成重复而静默丢弃。
 *
 * 命名空间与面板侧 `App.tsx` 的 `dedupeKey` **同构**：
 * `s` = 有 `message_seq`，`i` = 只有消息 id（`message_id` / `real_id`）。
 */
export function messageDedupKey(m: OB11Message): string | undefined {
  const seq = toNum(m.message_seq);
  if (seq !== undefined) return `s${seq}`;
  const id = toNum(m.message_id) ?? toNum(m.real_id);
  if (id !== undefined) return `i${id}`;
  return undefined;
}

/**
 * 锚点用的短 id（`message_seq`）。
 *
 * 只有 `message_seq` 能当锚点：`real_seq` 传进去**查不到**（实测返回空），
 * `message_id` 也不是短 id。只有它能表达「从这条开始」。
 */
export function messageShortId(m: OB11Message): string | undefined {
  const seq = toNum(m.message_seq);
  return seq === undefined ? undefined : String(seq);
}


/**
 * 语音时长的取值口径。
 *
 * `record` 段的时长字段名各实现不一（`seconds` / `duration`），两种都吃。
 *
 * **`time` 不再被当作时长**（2026-11-21 实测后移除）：实测 NapCat 的 OB11 `record` 段
 * 只有 `file` / `path` / `url` / `file_size` 四个字段，**根本不带时长**；
 * 而 `time` 这个名字在别处被用来放绝对时间戳（epoch 秒）—— 拿它算「时长」
 * 会得到几百万秒这种一眼假的数字。插件**不编造也不推断**时长：没有明确的时长字段就是没有时长。
 */
function normalizeSegment(seg: OB11MessageSegment): Segment {
  const d: Record<string, unknown> = seg.data ?? {};
  switch (seg.type) {
    // 段数组路径的 text 段也要还原 CQ 转义（与 parseCq 的纯文本片段同口径）：
    // 同一条消息因 NapCat 交付形态不同（段数组 vs CQ 串）而残留不同的转义，
    // 会让搜索与导出对不上。unescapeCq 是函数声明（提升），这里调用它没有顺序问题。
    case 'text': return { kind: 'text', text: unescapeCq(String(d.text ?? '')) };
    case 'at': return { kind: 'at', qq: String(d.qq ?? ''), name: d.name ? String(d.name) : undefined };
    case 'face': return { kind: 'face', faceId: String(d.id ?? ''), text: d.text ? String(d.text) : undefined };
    case 'reply': return { kind: 'reply', messageId: String(d.id ?? '') };
    case 'image': return { kind: 'image', url: d.url ? String(d.url) : undefined, fileId: d.file ? String(d.file) : undefined, width: toNum(d.width), height: toNum(d.height) };
    // 时长只认**明确的时长字段名**（seconds / duration）。
    // 实测 NapCat 的 record 段**不带任何时长字段** → duration 会是 undefined（不编造）。
    case 'record': return { kind: 'voice', url: d.url ? String(d.url) : undefined, duration: toNum(d.seconds) ?? toNum(d.duration) };
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
    /**
     * `seq` **只**是 `message_seq`（spec §5.4）。
     *
     * 注意：实测（2026-11-21）`message_seq` 是**随机 32 位短 id**（=== `message_id` === `real_id`），
     * **不是**单调游标 —— 它只能当**锚点**（「从这条开始」），不能拿来做大小比较、
     * 不能 `cursor + 1`。会话内单调递增的是 `real_seq`（见 `realSeq`）。
     *
     * 以前缺 `message_seq` 时会回退成 `message_id` —— 两个不同的编号空间混在一个字段里，
     * 导致「按 seq 去重」可能把两条不同的消息判成同一条（面板与服务端的去重键因此不一致）。
     * 没有 `message_seq` 就是没有锚点：`seq = 0`，去重改用消息 id（`i` 前缀）。
     *
     * 取值走 `toNum`：`message_seq` 是非数值字符串时**不能**得到 `NaN`
     * （`NaN` 会一路传染到排序、游标比较与去重键），按「没有锚点」处理（0）。
     */
    seq: toNum(raw.message_seq) ?? 0,
    /**
     * `real_seq`：会话内单调递增的序号 —— **同一秒内多条消息的定序键**。
     *
     * 缺失 = 上游没给（不是 0）。排序口径见 `compareMessages`：`time` → `real_seq` → 服务端顺序。
     */
    realSeq: toNum(raw.real_seq),
    /**
     * `time` 走 `toNum`：缺失或非数值 → `undefined`（**没有有效时间**），
     * 不用 0 兜底（0 是 1970-01-01，是看起来正常的错误时间戳）。
     * 渲染器据此跳过该条并报出跳过条数，绝不产出 `NaN-NaN-NaN`。
     */
    time: toNum(raw.time),
    senderId: String(raw.sender?.user_id ?? raw.user_id ?? ''),
    senderName: raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? ''),
    segments,
    text: segmentsText(segments),
    // 被回复消息的正文不在当前 payload 里（reply 段只带被回复的 message_id），
    // 取不到原文时用 '[引用]' 占位；调用方拿到 messageId 后可再调 get_msg 补正文。
    replyTo: replySeg ? { messageId: replySeg.messageId, preview: '[引用]' } : undefined,
  };
}
