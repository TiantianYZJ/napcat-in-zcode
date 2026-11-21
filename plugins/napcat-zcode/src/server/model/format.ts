import { segmentsText } from './message.js';
import { UNTRUSTED_NOTICE } from './notice.js';
import { hasValidTime, type Message } from './types.js';

/**
 * 注入头的不可信内容声明（spec §5.7 的安全要求）。
 *
 * 常量本体在 `./notice.js`（与导出产物共用同一句，见那里的说明）：
 * 注入体与导出文档是同一批聊天内容的两种渲染，信任标记必须一致。
 *
 * 任何情况下都不省略、不改写：即便 maxChars 小到装不下整个头部，也保留整句声明
 * （spec 把注入体上限称作「软上限」，安全声明优先于额度）。
 */

/** spec §5.7：注入体软上限默认 40000 字符（可由 config.inject.maxInjectChars 覆盖）。 */
const DEFAULT_MAX_CHARS = 40_000;

/** 截断尾注（含前后两个换行）的预留长度。 */
const TAIL_RESERVE = 64;

/** 跨天时间范围的长度上界，用于给头部估预算（真实日期串长度与之相同）。 */
const LONG_RANGE_PLACEHOLDER = '0000-00-00 00:00–0000-00-00 00:00';

function two(n: number): string { return String(n).padStart(2, '0'); }

interface TimeParts {
  /** HH:mm */
  hm: string;
  /** YYYY-MM-DD */
  date: string;
  /** MM-DD（换日判定用；跨年时 MM-DD 也不同） */
  day: string;
}

/** 时间一律按本机本地时区渲染（spec §5.7 的展示口径）。 */
function fmtTime(t: number): TimeParts {
  const d = new Date(t * 1000);
  return {
    hm: `${two(d.getHours())}:${two(d.getMinutes())}`,
    date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`,
    day: `${two(d.getMonth() + 1)}-${two(d.getDate())}`,
  };
}

/** 标题里的时间范围：同一天只写一次日期，跨天写两个。 */
function rangeText(first: TimeParts, last: TimeParts): string {
  return first.date === last.date
    ? `${first.date} ${first.hm}–${last.hm}`
    : `${first.date} ${first.hm}–${last.date} ${last.hm}`;
}

function titleLine(chatName: string, range: string, count: number): string {
  return `## QQ 聊天记录 · ${chatName} · ${range}（${count} 条）`;
}

/**
 * 折行净化：不可信的元数据（会话名、发言人名、引用预览）里的换行会伪造出新的标题行/记录行，只压成空格。
 *
 * 换行有三种形态，都要处理：`\r\n`（CRLF）、孤立 `\n`、孤立 `\r`。
 * CommonMark 把 **CR 也当行结束符**，只压 `\r?\n` 会让含孤立 CR 的昵称
 * 仍能伪造出一行标题/记录 —— 因此这里按 `\r\n|\r|\n` 全部压成空格。
 *
 * 注意它**只挡元数据伪造，不挡正文里的伪造行**：正文（消息内容）里的换行是合法的（多行消息），
 * 且整块正文都处在首行的不可信声明之下，由模型侧按「第三方内容」对待。
 * 因此不要把 flatten() 当成对注入体的全面消毒。
 */
function flatten(s: string): string {
  return s.replace(/\r\n|\r|\n/g, ' ').trim();
}

/**
 * 单条消息的渲染形态：消息本身恒为一行 `[HH:mm] 发言人：正文`；
 * 有引用时，引用预览另起一行，排在这条消息之前（导出器 renderMarkdown 同此形态）。
 *
 * m.segments / m.senderName 走兜底：调用方（T10 工具层）拿到的消息来自外部入参，
 * 类型系统拦不住「传进来的对象其实不是 Message」，缺字段时按空处理而不是抛异常。
 *
 * `replyTo.preview` 同样兜底成空串：预览缺失是常见形态（只给了被回复的 id），
 * 直接 `flatten(undefined)` 会抛 TypeError，把整次格式化带崩。
 */
function entryText(m: Message, t: TimeParts): string {
  const line = `[${t.hm}] ${flatten(m.senderName ?? '')}：${segmentsText(m.segments ?? [])}`;
  const preview = m.replyTo ? flatten(m.replyTo.preview ?? '') : '';
  return preview ? `> ${preview}\n${line}` : line;
}

/**
 * 把选区格式化成注入模型上下文的文本（与导出器共用同一套消息行形态）。
 *
 * 返回值语义（下游 T10/T13 按此对齐）：
 * - `text`：可直接注入的文本。首行恒为不可信内容声明，任何情况下都不截断、不改写。
 * - `count`：**实际渲染进正文的消息条数**（发生截断或跳过无有效时间的消息时小于入参条数）；
 *   标题里的「（N 条）」用的是它，截断尾注里的「共 N 条」才是选区总条数。
 * - `truncated`：**选区里是否有消息因超长没被纳入**。`truncated === false` ⇒ 没有消息被截断掉。
 *   但 `text.length` 仍可能超过 `maxChars`——单条消息本身就超限时，
 *   为保证「首条不被切掉」，该条整条保留（spec 把注入体上限称作软上限）。
 *
 * **「跳过」是独立于 `truncated` 的第三个维度**（判读时别把两者混为一谈）：
 * - 没有有效时间（`time` 缺失/非有限）的消息**根本不会被渲染**，
 *   绝不允许渲染出 `NaN-NaN-NaN` 这种假时间戳；
 * - 跳过**不影响** `truncated`：被跳过的消息不参与长度计算，`truncated` 仍可能是 false；
 * - 因此 `truncated === false` **不等于**「选区消息全部进了正文」——
 *   只有 `count`（= 实际渲染条数）加上正文末尾的「（跳过 N 条：消息缺少有效时间）」能说清全貌。
 */
export function formatSelection(
  messages: Message[],
  meta: { chatName: string; maxChars?: number },
): { text: string; count: number; truncated: boolean } {
  const maxChars = meta.maxChars ?? DEFAULT_MAX_CHARS;
  // 会话名与其它元数据同样可被攻击者控制（群名/好友名可含换行）→ 一律折行净化。
  const chatName = flatten(meta.chatName ?? '');

  // 头部与尾注先占额度，剩下的才是正文预算。
  // 头部长度随 count 变化，这里按「全部条数 + 跨天范围」估上界：
  // 实际 count ≤ messages.length，位数只会更少，故该估算不小于真实头部长度。
  const headerReserve =
    UNTRUSTED_NOTICE.length + 2 +
    titleLine(chatName, LONG_RANGE_PLACEHOLDER, messages.length).length + 2;
  const bodyBudget = Math.max(0, maxChars - headerReserve - TAIL_RESERVE);

  const blocks: string[] = [];
  /** 已渲染消息的时间（**只**含真正渲染出去的那些）——标题的时间范围取自这里。 */
  const times: number[] = [];
  let bodyLen = 0;
  let count = 0;
  /** 因为没有有效时间而被跳过的条数（不静默丢，如实报出来）。 */
  let skipped = 0;
  let truncated = false;
  let lastDay = '';

  for (const m of messages) {
    // 没有有效时间的消息**跳过**（不渲染）：直接拿它算时间会得到 `NaN-NaN-NaN`，
    // 那是模型看到的一行假时间戳，比少一条消息危险得多。
    if (!hasValidTime(m)) { skipped++; continue; }
    const t = fmtTime(m.time);
    const daySep = t.day !== lastDay ? `—— ${t.date} ——` : '';
    const entry = entryText(m, t);
    const block = daySep ? `${daySep}\n${entry}` : entry;
    // 块之间以换行相连（+1 是分隔符本身），与最终 bodyLen 的口径一致。
    const added = block.length + (blocks.length > 0 ? 1 : 0);
    // count > 0 才允许截断：首条永远保留，不会被额度挤成空选区。
    // 单条就超限时允许溢出（spec 称软上限），宁可超长也不丢首条。
    if (count > 0 && bodyLen + added > bodyBudget) { truncated = true; break; }
    blocks.push(block);
    bodyLen += added;
    count++;
    times.push(m.time);
    lastDay = t.day;
  }

  const first = count > 0 ? fmtTime(times[0]) : null;
  const last = count > 0 ? fmtTime(times[count - 1]) : null;
  const range = first && last ? rangeText(first, last) : '空';
  const header = `${UNTRUSTED_NOTICE}\n\n${titleLine(chatName, range, count)}\n\n`;
  let text = header + blocks.join('\n');
  // 跳过的条数要**说出来**：静默少几条会让模型以为记录本来就是这么少。
  if (skipped > 0) text += `\n\n（跳过 ${skipped} 条：消息缺少有效时间）`;
  if (truncated) text += `\n\n（已截断，共 ${messages.length} 条，完整内容请导出后以附件引用）`;
  return { text, count, truncated };
}
