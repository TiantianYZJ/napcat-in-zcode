import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchHistoryPage, getFriendList, getGroupList } from './onebot/actions.js';
import { normalizeMessage } from './model/message.js';
import type { Message } from './model/types.js';
import type { OneBotClient } from './onebot/client.js';
import type { OB11Message } from './onebot/types.js';
import type { AppState } from './state.js';

/** 单次 `napcat_get_history` 最多翻多少页（防死循环）。 */
const MAX_PAGES = 40;
/** `napcat_get_history` 一次最多返回多少条。 */
const MAX_COUNT = 200;

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
}
