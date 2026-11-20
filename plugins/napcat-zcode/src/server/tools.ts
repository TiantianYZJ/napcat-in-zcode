import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchHistoryPage, fetchMessagesBetween, getFriendList, getGroupList } from './onebot/actions.js';
import { normalizeMessage } from './model/message.js';
import { formatSelection } from './model/format.js';
import { exportSelection } from './export/export.js';
import { loadConfigData } from './config.js';
import type { ChatRef, Message, Segment } from './model/types.js';
import { safeEndpointLabel, type OneBotClient } from './onebot/client.js';
import type { OB11Message } from './onebot/types.js';
import type { AppState } from './state.js';

/** 单次 `napcat_get_history` 最多翻多少页（防死循环）。 */
const MAX_PAGES = 40;
/** `napcat_get_history` 一次最多返回多少条。 */
const MAX_COUNT = 200;

/** 搜索单页大小（`napcat_search_messages` 向更早翻页时一次取多少条）。 */
const SEARCH_PAGE_SIZE = 100;
/** 搜索默认翻页上限（spec §5.5：`maxPages` 默认 20 页）。 */
const SEARCH_DEFAULT_MAX_PAGES = 20;
/** 搜索翻页上限的硬顶（防止调用方一次把上游打爆）。 */
const SEARCH_MAX_PAGES = 100;
/** 搜索命中上限：超出即停止扫描（工具返回要紧凑，spec §5.5）。 */
const SEARCH_MAX_HITS = 20;

/** 成功返回：统一是「一段 JSON 文本」。 */
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

/**
 * 失败返回：`isError: true` + `{error: string}`。
 *
 * 工具层不向外抛异常——错误信息经 `state.redact` 脱敏（token 不许出现在返回值里）。
 */
function fail(state: AppState, e: unknown) {
  const message = state.redact(e instanceof Error ? e.message : String(e));
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/** 原始消息里的 `message_seq`（游标只能用这个；`message_id` 不是序号）。 */
function rawSeqOf(raw: OB11Message): number | undefined {
  const s = raw.message_seq;
  return typeof s === 'number' && Number.isFinite(s) ? s : undefined;
}

/**
 * 去重键：优先 `message_seq`，其次 `message_id` / `real_id`。
 *
 * 两者都没有时返回 undefined —— 这条消息**不参与去重**。
 * 不能拿「页内下标」当键：跨页的同一条消息下标相同，会被误判成重复而静默丢弃。
 */
function dedupKey(raw: OB11Message): string | undefined {
  const seq = rawSeqOf(raw);
  if (seq !== undefined) return `s${seq}`;
  const id = raw.message_id ?? raw.real_id;
  if (typeof id === 'number' && Number.isFinite(id)) return `i${id}`;
  return undefined;
}

interface HistoryResult {
  messages: Message[];
  nextBeforeSeq: number | null;
  exhausted: boolean;
}

/**
 * 拉取历史消息（游标分页，时间正序返回）。
 *
 * 取窗规则：**页内按 seq 降序挑选，取最新的 `want` 条**（最终输出仍按 seq 升序）。
 * - 为什么取最新：配额在页中途填满时，被挤掉的是该页**更旧**的消息，
 *   它们落在 `nextBeforeSeq` 之前 → 下一次向前翻页正好能取回来。
 *   若反过来取最旧，被挤掉的就是**更新**的消息，而游标已经越过它们 → 永久取不回（还会在窗口里留空洞）。
 * - `seen` 按稳定键去重（`message_seq` 优先、`message_id` 次之）：服务端在页边界上重叠同一条消息时不会重复返回；
 * - `since` / `until` 是**服务端没有的时间过滤**，只能翻页后在本地过滤；
 * - `exhausted` = 没攒满 `want` 条（**三合一语义**，详见下方说明——不要读作「已经没有更早的消息了」）。
 */
async function fetchHistory(
  client: OneBotClient,
  chatKind: 'group' | 'friend',
  chatId: string,
  beforeSeq: number | undefined,
  want: number,
  since: number | undefined,
  until: number | undefined,
): Promise<HistoryResult> {
  const out: Message[] = [];
  const outSeqs: number[] = []; // out 里那些「有原始 message_seq」的 seq（同序子集）
  const seen = new Set<string>();
  let cursor = beforeSeq;
  let exhausted = false;

  for (let guard = 0; guard < MAX_PAGES && out.length < want; guard++) {
    const page = await fetchHistoryPage(client, chatKind, chatId, cursor, want);
    if (page.length === 0) {
      break; // 空页：没有更早的历史了（窗口必然没攒满 → exhausted 由循环后的统一判定给出）
    }

    const norm = page
      .map((raw) => ({ raw, msg: normalizeMessage(raw) }))
      .sort((a, b) => a.msg.seq - b.msg.seq);

    let belowSince = false;
    // 降序遍历：先收最新的，配额满了就停（更旧的留给下一次翻页）
    for (const item of [...norm].reverse()) {
      const key = dedupKey(item.raw);
      if (key !== undefined) {
        if (seen.has(key)) continue; // 页边界可能重叠同一条消息
        seen.add(key);
      }
      if (until !== undefined && item.msg.time > until) continue;
      if (since !== undefined && item.msg.time < since) {
        belowSince = true;
        continue; // 时间单调：更早的消息也都在 since 之前（exhausted 由循环后的统一判定给出）
      }
      if (out.length < want) {
        out.push(item.msg);
        const rawSeq = rawSeqOf(item.raw);
        if (rawSeq !== undefined) outSeqs.push(rawSeq);
      }
    }
    if (belowSince) break; // 越过了 since 边界，再翻更早的页也没有意义

    const pageSeqs = norm.map((x) => rawSeqOf(x.raw)).filter((s): s is number => s !== undefined);
    if (pageSeqs.length === 0) break; // 页里没有可定位的消息 → 游标推不动
    const minSeq = Math.min(...pageSeqs);
    if (cursor !== undefined && minSeq >= cursor) break; // 游标没有前进（服务端不认 message_seq）→ 停
    cursor = minSeq;
  }

  /**
   * `exhausted` 的唯一判定口径：**窗口没攒满 `want` 条**时为 true。
   *
   * 它是**三合一**语义，不等于「历史一定到底」：
   * ① 历史耗尽（空页 / 翻到最开头）；
   * ② 游标推不动（服务端不认 `message_seq`，或页里没有可定位的消息）；
   * ③ 翻页数触顶（MAX_PAGES）。
   *
   * 下游不要把它读作「已经没有更早的消息了」——窗口满时它为 false，
   * 而窗口不满也可能是 ②/③ 而不是 ①。
   *
   * 目前**没有**可靠的「真的到底」信号：
   * - `nextBeforeSeq` 只表示窗口内最小 seq——窗口为空、或窗口内消息都没有 `message_seq` 时它是 null
   *   （那时历史可能还有消息），而真正翻到底时它通常反而**非** null；
   * - `exhausted` 是上面的三合一语义。
   * 要等真实 NapCat 的 `message_seq` 边界语义实测（T14）后才能定。
   * 面板若要判断「还有没有更早的消息」，以「**再翻一页返回空**」为准。
   */
  if (out.length < want) exhausted = true;

  out.sort((a, b) => a.seq - b.seq);
  /**
   * 翻页游标：返回窗口里最小的 seq。
   *
   * 语义假设：服务端的 `message_seq` 是**独占**边界（传 s 返回 seq < s 的消息）。
   * `onebot/actions.ts` 的 `fetchMessagesBetween` 对「含 / 不含」两种语义都做了防御，
   * 这里只按独占实现 —— 若真实 NapCat 是「含」边界，调用方（面板）需要按 seq 跨调用去重，
   * 否则边界那条会被重复返回（真实语义待 T14 实测确认）。
   */
  const nextBeforeSeq = outSeqs.length > 0 ? Math.min(...outSeqs) : null;
  return { messages: out, nextBeforeSeq, exhausted };
}

/**
 * 刷新配置快照。
 *
 * `AppState.config` 是**进程启动时**读的一次快照：运行期外部改了 `config.json`
 * （面板设置页、用户手改文件）不会被感知。要「读当前值」必须先刷新，
 * 否则工具返回的是启动时的旧值。
 */
function refreshConfig(state: AppState): void {
  state.config = loadConfigData();
}

/**
 * 把外部传入的「消息对象」收敛成 `Message`。
 *
 * 入参来自面板 / agent（`napcat_get_history` 的输出），类型系统拦不住畸形数据：
 * 缺 `time` 就渲染成 `NaN-NaN-NaN`、`replyTo` 缺 `preview` 就抛 TypeError。
 * 这里缺关键字段**直接报错**（工具层转 `isError`），不产出半吊子结果。
 */
function coerceMessage(v: unknown, index: number): Message {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`第 ${index + 1} 条消息不是对象`);
  }
  const o = v as Record<string, unknown>;
  /**
   * `time` 必须是有限数。
   *
   * 注意 `Number(null) === 0` —— 直接 `Number(o.time)` 会把 `null` 当成 epoch 0，
   * 渲染成 1970-01-01（而不是报出「缺少有效的 time 字段」）。
   * 这里只接受数字或非空数字串，`null`/`undefined`/`''`/布尔一律拒绝。
   */
  const rawTime = o.time;
  const time =
    typeof rawTime === 'number'
      ? rawTime
      : typeof rawTime === 'string' && rawTime.trim() !== ''
        ? Number(rawTime)
        : Number.NaN;
  if (!Number.isFinite(time)) {
    throw new Error(`第 ${index + 1} 条消息缺少有效的 time 字段（epoch 秒）`);
  }
  const text = typeof o.text === 'string' ? o.text : '';
  let segments: Segment[] = Array.isArray(o.segments) ? (o.segments as Segment[]) : [];
  // 只给了正文、没给段 → 补一个文本段（否则这一条会渲染成空行）
  if (segments.length === 0 && text !== '') segments = [{ kind: 'text', text }];
  const replyRaw =
    typeof o.replyTo === 'object' && o.replyTo !== null ? (o.replyTo as Record<string, unknown>) : undefined;
  const seq = Number(o.seq);
  return {
    id: o.id === undefined || o.id === null ? '' : String(o.id),
    seq: Number.isFinite(seq) ? seq : 0,
    time,
    senderId: o.senderId === undefined || o.senderId === null ? '' : String(o.senderId),
    senderName: o.senderName === undefined || o.senderName === null ? '' : String(o.senderName),
    segments,
    text,
    replyTo: replyRaw
      ? { messageId: String(replyRaw.messageId ?? ''), preview: String(replyRaw.preview ?? '') }
      : undefined,
  };
}

/** 批量收敛消息数组（入参不是数组直接报错）。 */
function coerceMessages(input: unknown): Message[] {
  if (!Array.isArray(input)) throw new Error('messages 必须是数组');
  return input.map((v, i) => coerceMessage(v, i));
}

/** 收敛会话引用 `{kind, id, name}`（缺 id / kind 非法直接报错）。 */
function coerceChat(v: unknown): ChatRef {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('chat 必须是 {kind, id, name} 对象');
  }
  const o = v as Record<string, unknown>;
  if (o.kind !== 'group' && o.kind !== 'friend') {
    throw new Error("chat.kind 必须是 'group' 或 'friend'");
  }
  const id = o.id === undefined || o.id === null ? '' : String(o.id);
  if (!id) throw new Error('chat.id 不能为空');
  const name = o.name === undefined || o.name === null ? '' : String(o.name);
  return { kind: o.kind, id, name };
}

interface SearchHit {
  /** 命中的那条消息。 */
  message: Message;
  /** 命中消息在时间上紧邻其前（更早）的那条；扫描范围内没有则为 null。 */
  contextBefore: Message | null;
}

interface SearchResult {
  hits: SearchHit[];
  /** 实际扫描过的**不同**消息条数。 */
  scanned: number;
  /** 实际发起的翻页次数（含最后一页空页）。 */
  pages: number;
  /** 三合一语义（见 `searchMessages` 的注释），**不等于**「没有更早的消息了」。 */
  exhausted: boolean;
  /** 命中数达到上限、扫描提前停止。 */
  hitsTruncated: boolean;
  /** 扫描有限性的说明（工具返回里必须带上，别让调用方以为搜全了）。 */
  note: string;
}

/**
 * 会话内关键词搜索：向**更早**的方向翻页，拿到一页就在本地过滤。
 *
 * OneBot 11 没有服务端搜索动作，搜索只能客户端翻页过滤 → 扫描量天然有限。
 *
 * - 翻页方向：从 `startSeq`（缺省=最新）向更早翻页（游标取页内最小 `message_seq`）；
 * - 匹配：`message.text` 小写后包含 `query`（小写）即命中（大小写不敏感）；
 * - `contextBefore`：命中消息在时间上**紧邻其前（更早）**的那条 → 需要一个元素的 lookahead
 *   （扫描流是「新→旧」，更早的那条在命中之后才出现）；
 * - `exhausted`：**三合一**语义（历史耗尽 / 游标推不动 / 翻页触顶 `maxPages`），
 *   和 `napcat_get_history` 同一口径 —— **不要**读成「已经没有更早的消息了」，
 *   要判断还有更早消息应以「**再翻一页是否返回空**」为准。
 */
async function searchMessages(
  client: OneBotClient,
  chatKind: 'group' | 'friend',
  chatId: string,
  query: string,
  startSeq: number | undefined,
  maxPages: number,
): Promise<SearchResult> {
  const q = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let pages = 0;
  let exhausted = false;
  let hitsTruncated = false;
  let cursor = startSeq;
  /** 待定命中：它的「上文」是扫描流里的下一条，要等下一条出现才能确定。 */
  let pending: Message | null = null;

  for (let i = 0; i < maxPages; i++) {
    const page = await fetchHistoryPage(client, chatKind, chatId, cursor, SEARCH_PAGE_SIZE);
    pages++;
    if (page.length === 0) {
      exhausted = true; // 空页：历史耗尽
      break;
    }
    // 页内按 seq **降序**（新→旧）：与扫描方向一致，命中消息的「下一条」始终是更早的一条
    const norm = page
      .map((raw) => ({ raw, msg: normalizeMessage(raw) }))
      .sort((a, b) => b.msg.seq - a.msg.seq);

    for (const item of norm) {
      const key = dedupKey(item.raw);
      if (key !== undefined) {
        if (seen.has(key)) continue; // 页边界可能重叠同一条消息
        seen.add(key);
      }
      scanned++;
      // 当前这条就是待定命中的「上文」（时间上更早的一条）
      if (pending) {
        hits.push({ message: pending, contextBefore: item.msg });
        pending = null;
      }
      if (!item.msg.text.toLowerCase().includes(q)) continue;
      if (hits.length >= SEARCH_MAX_HITS) {
        hitsTruncated = true;
        break;
      }
      pending = item.msg;
    }
    if (hitsTruncated) break;

    const pageSeqs = norm.map((x) => rawSeqOf(x.raw)).filter((s): s is number => s !== undefined);
    if (pageSeqs.length === 0) {
      exhausted = true; // 页里没有可定位的消息 → 游标推不动
      break;
    }
    const minSeq = Math.min(...pageSeqs);
    if (cursor !== undefined && minSeq >= cursor) {
      exhausted = true; // 游标没有前进（服务端不认 message_seq）→ 推不动
      break;
    }
    cursor = minSeq;
  }
  // 翻页触顶：扫描结束，但**不代表**历史到底（同一个三合一口径）
  if (!hitsTruncated && pages >= maxPages) exhausted = true;
  // 扫描范围内最旧的一条命中没有上文
  if (pending) hits.push({ message: pending, contextBefore: null });

  const note =
    `搜索为有限扫描（OneBot 11 没有服务端搜索动作，只能向更早翻页后过滤）：本次翻页 ${pages} 页、` +
    `扫描 ${scanned} 条消息、命中 ${hits.length} 条。exhausted 为三合一语义（历史耗尽 / 游标推不动 / ` +
    `翻页触顶 maxPages 上限），不等于「没有更早的消息了」——判断还有更早消息请看「再翻一页是否返回空」。` +
    (hitsTruncated ? `命中数达到上限（${SEARCH_MAX_HITS}），扫描提前停止。` : '') +
    `未命中时可提高 maxPages，或先用 napcat_get_history 按时间范围取一段再搜。`;

  return { hits, scanned, pages, exhausted, hitsTruncated, note };
}

/**
 * 注册 MCP 工具面。
 *
 * 工具名 / 描述 / 入参 schema / 返回结构是**对外契约**（T10、T12、T13 依赖），改这里要同步改它们。
 * 返回值一律是「一段 JSON 文本」；出错时 `isError: true` + `{error}`。
 */
export function registerTools(server: McpServer, state: AppState): void {
  server.registerTool(
    'napcat_status',
    {
      description:
        'NapCat 连接状态与登录信息（连接失败时返回 {connected:false, error}，此时 isError 为 false —— 这是状态，不是工具错误）',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await state.status());
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  server.registerTool(
    'napcat_configure',
    {
      description: '配置 OneBot 端点（地址与 token），保存后重连',
      inputSchema: {
        endpoint: z.string().describe('OneBot 11 端点，如 http://127.0.0.1:3000 或 ws://127.0.0.1:3001'),
        token: z.string().optional().describe('access token，可空'),
      },
    },
    async ({ endpoint, token }) => {
      try {
        const login = await state.setConnection(endpoint, token ?? '');
        return ok({ configured: true, connected: true, login });
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  server.registerTool(
    'napcat_list_chats',
    {
      description: '列出群或好友',
      inputSchema: {
        kind: z.enum(['group', 'friend']),
      },
    },
    async ({ kind }) => {
      try {
        const c = await state.ensureClient();
        if (kind === 'group') {
          const groups = await getGroupList(c);
          const chats = groups.map((g) => ({
            kind,
            id: String(g.group_id),
            name: g.group_name,
            memberCount: typeof g.member_count === 'number' ? g.member_count : undefined,
          }));
          return ok({ chats });
        }
        const friends = await getFriendList(c);
        const chats = friends.map((f) => ({
          kind,
          id: String(f.user_id),
          name: f.remark || f.nickname,
        }));
        return ok({ chats });
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  server.registerTool(
    'napcat_get_history',
    {
      description: '拉取会话历史消息（游标分页，时间正序返回）',
      inputSchema: {
        chatKind: z.enum(['group', 'friend']),
        chatId: z.string(),
        beforeSeq: z.number().optional().describe('传入上一页返回的 nextBeforeSeq 获取更早消息'),
        count: z.number().optional().default(100).describe('1-200'),
        since: z.number().optional().describe('起始时间 epoch 秒（含）'),
        until: z.number().optional().describe('结束时间 epoch 秒（含）'),
      },
    },
    async ({ chatKind, chatId, beforeSeq, count, since, until }) => {
      try {
        const c = await state.ensureClient();
        const want = Math.min(Math.max(Math.floor(count ?? 100), 1), MAX_COUNT);
        const result = await fetchHistory(c, chatKind, chatId, beforeSeq, want, since, until);
        return ok(result);
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  server.registerTool(
    'napcat_search_messages',
    {
      description:
        '会话内关键词搜索：向更早翻页扫描后按正文过滤（OneBot 11 无服务端搜索动作，扫描范围有限）。' +
        '返回 {hits:[{message,contextBefore}], scanned, pages, exhausted, hitsTruncated, note}；' +
        'scanned = 扫过的不同消息条数；pages = 翻过的页数（含可能的最后一空页）；' +
        'contextBefore 是命中消息在时间上紧邻其前（更早）的那条；' +
        'exhausted 为三合一语义（历史耗尽 / 游标推不动 / 翻页触顶 maxPages 上限），不等于「没有更早的消息了」' +
        '——判断还有更早消息请看「再翻一页是否返回空」；' +
        '命中数达上限而提前停止时 exhausted 为 false（那时是 hitsTruncated 在说明）。',
      inputSchema: {
        chatKind: z.enum(['group', 'friend']),
        chatId: z.string(),
        query: z.string().describe('关键词（大小写不敏感，按消息正文匹配）'),
        startSeq: z.number().optional().describe('起始游标：只扫描 message_seq 小于它的消息；缺省从最新一条开始'),
        maxPages: z
          .number()
          .optional()
          .default(SEARCH_DEFAULT_MAX_PAGES)
          .describe(`最多翻多少页（1-${SEARCH_MAX_PAGES}，默认 ${SEARCH_DEFAULT_MAX_PAGES}）`),
      },
    },
    async ({ chatKind, chatId, query, startSeq, maxPages }) => {
      try {
        const q = (query ?? '').trim();
        if (!q) return fail(state, new Error('搜索关键词不能为空'));
        const pages = Math.min(Math.max(Math.floor(maxPages ?? SEARCH_DEFAULT_MAX_PAGES), 1), SEARCH_MAX_PAGES);
        const c = await state.ensureClient();
        return ok(await searchMessages(c, chatKind, chatId, q, startSeq, pages));
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  server.registerTool(
    'napcat_format_selection',
    {
      description:
        '把选定消息格式化为注入文本：首行恒为「第三方内容」不可信声明（不改写、不裁剪），' +
        '逐条 [HH:mm] 发言人：内容；超出 maxChars 时截断并尾注。返回 {text, count, truncated}。',
      inputSchema: {
        messages: z.any().describe('napcat_get_history 返回的 Message 对象数组（必须是数组；元素须带 time 字段）'),
        chatName: z.string().describe('会话名（群名 / 好友名）'),
        maxChars: z.number().optional().describe('注入文本字符上限；缺省取配置 inject.maxInjectChars'),
      },
    },
    async ({ messages, chatName, maxChars }) => {
      try {
        refreshConfig(state);
        const list = coerceMessages(messages);
        const limit = maxChars ?? state.config.inject.maxInjectChars;
        // 原样透传 formatSelection 的输出：首行的不可信声明不得在工具层改写/裁剪/替换
        return ok(formatSelection(list, { chatName, maxChars: limit }));
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  server.registerTool(
    'napcat_export',
    {
      description:
        '导出选定消息为 Markdown + JSON 文件对：默认落在 ~/.zcode/napcat/exports，' +
        'dir=workspace 时落在 <工作区>/.zcode/napcat/exports 并自动补 .gitignore 规则。' +
        'gitignoreUpdated=false 表示「.gitignore 已覆盖该目录」或「用户写了取反规则而跳过」。' +
        'includeImages 目前不下载图片文件（导出里图片为占位符 + URL 记录），媒体下载随 M1.1 增强。' +
        '返回 {mdPath, jsonPath, gitignoreUpdated}。',
      inputSchema: {
        messages: z
          .any()
          .optional()
          .describe('要导出的消息（Message 对象数组；元素须带 time 字段）；缺省时用 chatKind/chatId/fromSeq/toSeq 现拉该 seq 区间'),
        // 结构留在发布的 JSON Schema 里（面板可据此提示），取值校验交给 coerceChat → isError
        chat: z
          .object({ kind: z.string(), id: z.string(), name: z.string() })
          .partial()
          .describe('会话引用 {kind:"group"|"friend", id:string, name:string}'),
        chatKind: z.enum(['group', 'friend']).optional().describe('现拉时的会话类型'),
        chatId: z.string().optional().describe('现拉时的会话 id'),
        fromSeq: z.number().optional().describe('现拉时的起始 message_seq（含）'),
        toSeq: z.number().optional().describe('现拉时的结束 message_seq（含）'),
        dir: z.enum(['user', 'workspace']).optional().describe('导出目录；缺省取配置 export.dir'),
        includeImages: z.boolean().optional().describe('是否下载图片（M1 尚未实现媒体下载，本参数不影响产物）'),
        workspaceDir: z.string().optional().describe('工作区导出时的目录根；缺省取 ZCODE_PROJECT_DIR'),
      },
    },
    async (a) => {
      try {
        refreshConfig(state);
        const chat = coerceChat(a.chat);
        let msgs: Message[];
        // 空数组与缺省同等处理（brief 的口径）：一律走「现拉该 seq 区间」，
        // 而不是导出一份空文件——空选区更可能是「我想要这个区间」而不是「我想要 0 条」。
        if (a.messages === undefined || a.messages.length === 0) {
          if (a.chatKind === undefined || a.chatId === undefined || a.fromSeq === undefined || a.toSeq === undefined) {
            throw new Error('缺少 messages 时需要同时给出 chatKind、chatId、fromSeq、toSeq（现拉该 seq 区间）');
          }
          // 区间反了 → 明确报错。否则 fetchMessagesBetween 会返回空数组，
          // 工具静默写出一对 `{会话名}_empty` 的空文件（看着像导出成功，其实是空的）。
          if (a.fromSeq > a.toSeq) {
            throw new Error(`fromSeq（${a.fromSeq}）不能大于 toSeq（${a.toSeq}）`);
          }
          // 交叉校验：现拉的会话必须与 chat 指向同一个会话。
          // 不校验就能把 B 群的区间写进 A 群名下的文件（张冠李戴，且事后看不出来）。
          if (chat.kind !== a.chatKind || chat.id !== a.chatId) {
            throw new Error(
              `chat（${chat.kind}/${chat.id}）与现拉参数（${a.chatKind}/${a.chatId}）不一致`,
            );
          }
          const c = await state.ensureClient();
          msgs = (await fetchMessagesBetween(c, a.chatKind, a.chatId, a.fromSeq, a.toSeq)).map(normalizeMessage);
        } else {
          msgs = coerceMessages(a.messages);
        }
        // dir 缺省取配置；workspaceDir 优先用注入位（测试），其次调用方给的，最后取 ZCode 项目目录
        const dir = a.dir ?? state.config.export.dir;
        const workspaceDir = state.workspaceDirOverride ?? a.workspaceDir ?? process.env.ZCODE_PROJECT_DIR;
        if (dir === 'workspace' && !workspaceDir) {
          throw new Error('工作区导出需要工作区目录：请给出 workspaceDir 参数，或在 ZCode 项目目录里使用插件');
        }
        // includeImages：M1 的导出器只写占位符 + URL（媒体下载随 M1.1 增强）→ 本参数**不改变产物**。
        // 刻意不在这里假装下载了图片。
        const r = await exportSelection({
          messages: msgs,
          chat,
          dir,
          workspaceDir,
          homeDir: state.homeDirOverride,
        });
        return ok(r);
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  server.registerTool(
    'napcat_get_config',
    {
      description:
        '读取插件当前配置（面板设置页用）：每次调用都会重新读取 config.json 并应用环境变量覆盖；' +
        'token 一律以 *** 遮蔽，端点按脱敏形式返回（去掉 query 与 userinfo）。',
      inputSchema: {},
    },
    async () => {
      try {
        // AppState.config 是启动快照 → 不刷新就是旧值
        refreshConfig(state);
        const cfg = state.config;
        const token = cfg.connection?.token ?? '';
        const endpoint = cfg.connection?.endpoint ?? '';
        /**
         * 端点一律脱敏：端点里可能带 access_token（ws 约定）/ user:pass。
         * `autoDetect.endpoints` 是**一列端点**，同样可能有凭据 → 逐条脱敏，
         * 否则用户把带凭据的 URL 放进候选列表就会明文出现在面板里。
         */
        const maskEndpoint = (ep: string): string => state.redact(safeEndpointLabel(ep));
        const masked = {
          ...cfg,
          connection: {
            ...cfg.connection,
            endpoint: maskEndpoint(endpoint),
            token: token ? '***' : '',
          },
          autoDetect: {
            ...cfg.autoDetect,
            endpoints: (cfg.autoDetect?.endpoints ?? []).map(maskEndpoint),
          },
        };
        return ok(masked);
      } catch (e) {
        return fail(state, e);
      }
    },
  );
}
