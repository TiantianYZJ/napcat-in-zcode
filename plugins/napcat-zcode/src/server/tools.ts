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

interface HistoryResult {
  messages: Message[];
  nextBeforeSeq: number | null;
  exhausted: boolean;
}

/**
 * 拉取历史消息（游标分页，时间正序返回）。
 *
 * 终止条件：攒够 `want` 条（过滤之后）、翻到空页、或页数触顶。
 * - `seen` 按 seq 去重：服务端在页边界上重叠同一条消息时不会重复返回；
 * - `since` / `until` 是**服务端没有的时间过滤**，只能翻页后在本地过滤；
 * - `nextBeforeSeq` = 返回窗口里最小的 seq —— 传回给下一次调用即可取更早的消息；
 * - `exhausted` = 已经翻不到更早的消息（空页 / 短页 / 越过 since 边界）。
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
      exhausted = true; // 空页：更早的历史已经没有了
      break;
    }

    const norm = page
      .map((raw, index) => ({ raw, index, msg: normalizeMessage(raw) }))
      .sort((a, b) => a.msg.seq - b.msg.seq);

    let belowSince = false;
    for (const item of norm) {
      const rawSeq = rawSeqOf(item.raw);
      const key = rawSeq !== undefined ? `s${rawSeq}` : `x${item.msg.id || item.index}`;
      if (seen.has(key)) continue; // 页边界可能重叠同一条消息
      seen.add(key);
      if (until !== undefined && item.msg.time > until) continue;
      if (since !== undefined && item.msg.time < since) {
        exhausted = true;
        belowSince = true;
        continue; // 时间单调：更早的消息也都在 since 之前
      }
      if (out.length < want) {
        out.push(item.msg);
        if (rawSeq !== undefined) outSeqs.push(rawSeq);
      }
    }
    if (belowSince) break; // 越过了 since 边界，再翻更早的页也没有意义

    const pageSeqs = norm.map((x) => rawSeqOf(x.raw)).filter((s): s is number => s !== undefined);
    if (pageSeqs.length === 0) break; // 页里没有可定位的消息 → 游标推不动
    const minSeq = Math.min(...pageSeqs);
    if (cursor !== undefined && minSeq >= cursor) break; // 游标没有前进（服务端不认 message_seq）→ 停
    cursor = minSeq;
    if (norm.length < want) exhausted = true; // 短页：服务端已经没有更早的消息了
  }

  out.sort((a, b) => a.seq - b.seq);
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
      description: 'NapCat 连接状态与登录信息',
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
