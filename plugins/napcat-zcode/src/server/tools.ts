import { z } from 'zod';
import { isAbsolute } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fetchMessagesBetween, getFriendList, getGroupList, scanHistoryBackwards } from './onebot/actions.js';
import { normalizeMessage } from './model/message.js';
import { formatSelection } from './model/format.js';
import { exportSelection } from './export/export.js';
import { loadConfigData } from './config.js';
import type { ChatRef, Message, Segment } from './model/types.js';
import { safeEndpointLabel, type OneBotClient } from './onebot/client.js';
import type { AppState } from './state.js';
import { endpointSecurityWarning } from './state.js';
import { detectLocalOnce } from './host/detect-local.js';
import { registerHostTools } from './host/host-tools.js';
import { fail, ok } from './tool-results.js';

/** 单次 `napcat_get_history` 最多翻多少页（防死循环）。 */
const MAX_PAGES = 40;
/** `napcat_get_history` 一次最多返回多少条。 */
const MAX_COUNT = 200;
/** `napcat_get_history` 默认返回多少条。 */
const DEFAULT_COUNT = 50;

/** 搜索单页大小（`napcat_search_messages` 向更早翻页时一次取多少条）。 */
const SEARCH_PAGE_SIZE = 100;
/** 搜索默认翻页上限（spec §5.5：`maxPages` 默认 20 页）。 */
const SEARCH_DEFAULT_MAX_PAGES = 20;
/** 搜索翻页上限的硬顶（防止调用方一次把上游打爆）。 */
const SEARCH_MAX_PAGES = 100;
/** 搜索命中上限：超出即停止扫描（工具返回要紧凑，spec §5.5）。 */
const SEARCH_MAX_HITS = 20;

/**
 * 翻页终止原因。
 *
 * **三种情况必须能区分**（不能都笼统说「没有更多了」）：
 * - `history_exhausted`：历史耗尽 —— 已经翻到会话最开始，真的没有更早的消息了；
 * - `page_budget_exhausted`：翻页预算用尽 —— 可能还有更早的消息没取到；
 * - `count_reached`：攒够了 `count` 条 —— 窗口已满（还有更早的消息，只是这次没取）；
 * - `range_covered`：区间已完整覆盖（翻过了 `fromTime` 下界）。
 *
 * 「锚点失效」（服务端报「消息<S>不存在」）是**错误**（`isError: true`），
 * 不是上面任何一种终止原因。
 */
export type HistoryStopReason =
  | 'count_reached'
  | 'range_covered'
  | 'history_exhausted'
  | 'page_budget_exhausted';

interface HistoryResult {
  messages: Message[];
  /**
   * 更早消息的游标（**时间**，unix 秒）：把它作为 `beforeTime` 传回来即可继续往前翻。
   *
   * 取窗口内**最早**那条消息的时间；窗口里没有有效时间时为 null。
   */
  nextBeforeTime: number | null;
  /**
   * 历史耗尽（真的没有更早的消息了）。
   *
   * **不等于**「本次没取满」——没取满可能是预算用尽 / 区间已覆盖 / 锚点失效，
   * 看 `stopReason` 与 `note`。
   */
  exhausted: boolean;
  /** 终止原因（机器可读）。 */
  stopReason: HistoryStopReason;
  /** 人类可读说明（中文，区分历史耗尽 / 锚点失效 / 翻页预算用尽）。 */
  note: string;
}

/** 消息列表里最早的有效时间（epoch 秒）；没有有效时间 → undefined。 */
function earliestTimeOf(messages: readonly Message[]): number | undefined {
  let min: number | undefined;
  for (const m of messages) {
    if (m.time === undefined || !Number.isFinite(m.time)) continue;
    if (min === undefined || m.time < min) min = m.time;
  }
  return min;
}

/**
 * 拉取历史消息（**时间语义**，时间正序返回）。
 *
 * 参数语义：
 * - `count`：要多少条（默认 50）；
 * - `beforeTime`：**排他**上界（只取该时间**之前**的消息）—— 「往更早翻一页」用它；
 * - `fromTime` / `toTime`：**闭**区间（unix 秒）。
 *
 * 翻页模型（按真实 NapCat 语义，2026-11-21 实测）：服务端**只认短 id 锚点**，
 * 且往更早翻**必须**带 `reverse_order` —— 插件内部用 `scanHistoryBackwards` 负责这件事，
 * 工具层只面对「时间」。
 *
 * 区间过滤一律用**时间**（unix 秒）；`message_seq` 是随机短 id，**不能**做大小比较。
 */
async function fetchHistory(
  client: OneBotClient,
  chatKind: 'group' | 'friend',
  chatId: string,
  opts: { count: number; beforeTime?: number; fromTime?: number; toTime?: number },
): Promise<HistoryResult> {
  /**
   * 有效区间（闭区间，unix 秒）。
   *
   * `beforeTime` 是**排他**上界（「该时间之前」）→ 换算成闭区间就是 `beforeTime - 1`；
   * 与 `toTime` 同时给出时取**更早**的那个上界。
   */
  let lo = opts.fromTime;
  let hi = opts.toTime;
  if (opts.beforeTime !== undefined) {
    const exclusive = opts.beforeTime - 1;
    hi = hi === undefined ? exclusive : Math.min(hi, exclusive);
  }

  const scan = await scanHistoryBackwards(client, chatKind, chatId, {
    count: opts.count,
    fromTime: lo,
    toTime: hi,
    pageSize: opts.count,
    maxPages: MAX_PAGES,
  });

  const messages = scan.messages.map(normalizeMessage);
  const nextBeforeTime = earliestTimeOf(messages) ?? null;

  const stopReason: HistoryStopReason = scan.budgetExhausted
    ? 'page_budget_exhausted'
    : scan.rangeCovered
      ? 'range_covered'
      : scan.exhausted
        ? 'history_exhausted'
        : 'count_reached';

  const notes: string[] = [];
  switch (stopReason) {
    case 'history_exhausted':
      notes.push('已翻到会话最开始：没有更早的消息了。');
      break;
    case 'page_budget_exhausted':
      notes.push(
        `翻页预算用尽（单次最多 ${MAX_PAGES} 页）：可能还有更早的消息没取到，请调大 count 或缩小时间范围。`,
      );
      break;
    case 'range_covered':
      notes.push('时间区间已完整覆盖（已翻过区间下界）。');
      break;
    case 'count_reached':
      notes.push(
        nextBeforeTime === null
          ? `已返回 ${messages.length} 条（窗口内没有有效时间，无法继续往前翻）。`
          : `已返回 ${messages.length} 条（达到 count 上限）；把 nextBeforeTime 作为 beforeTime 传回即可继续取更早的消息。`,
      );
      break;
  }
  if (stopReason === 'range_covered' && nextBeforeTime !== null) {
    notes.push(`更早的消息从 ${nextBeforeTime}（epoch 秒）之前继续取。`);
  }

  return { messages, nextBeforeTime, exhausted: scan.exhausted, stopReason, note: notes.join(' ') };
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
  // 归一：id 允许是数字（QQ 号本来就是数字型）→ 一律转成字符串，
  // 后面与 `chatId` 的交叉校验比的就是归一后的字符串（`123` 与 `'123'` 视为同一个会话）。
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

/** 搜索的终止原因（**三种必须能区分**）。 */
export type SearchStopReason = 'history_exhausted' | 'page_budget_exhausted' | 'hits_limit';

interface SearchResult {
  hits: SearchHit[];
  /** 实际扫描过的**不同**消息条数。 */
  scanned: number;
  /** 实际发起的翻页次数（含最后一页空页）。 */
  pages: number;
  /** 历史耗尽（真的翻到会话最开始，没有更早的消息了）。 */
  exhausted: boolean;
  /** 命中数达到上限、扫描提前停止。 */
  hitsTruncated: boolean;
  /** 终止原因（机器可读）。 */
  stopReason: SearchStopReason;
  /** 扫描有限性的说明（工具返回里必须带上，别让调用方以为搜全了）。 */
  note: string;
}

/**
 * 会话内关键词搜索：从最新往**更早**翻页扫描，拿到一页就在本地过滤。
 *
 * OneBot 11 没有服务端搜索动作，搜索只能客户端翻页过滤 → 扫描量天然有限。
 *
 * - 翻页方向：从最新往更早（每页带上一页最早那条的**短 id** + `reverse_order`）；
 * - 匹配：`message.text` 小写后包含 `query`（小写）即命中（大小写不敏感）；
 * - `contextBefore`：命中消息在时间上**紧邻其前（更早）**的那条 → 扫描流（新→旧）里的**下一条**；
 * - 终止原因（**三种必须能区分**）：历史耗尽 / 翻页预算用尽 / 命中数达上限。
 *   「锚点失效」（服务端报「消息<S>不存在」）是**错误**，不是终止原因。
 */
async function searchMessages(
  client: OneBotClient,
  chatKind: 'group' | 'friend',
  chatId: string,
  query: string,
  maxPages: number,
): Promise<SearchResult> {
  const q = query.trim().toLowerCase();
  const matches = (m: Message): boolean => m.text.toLowerCase().includes(q);

  // 命中计数在扫描过程中累计（每页只算这一页的新消息）——不在最后把全部历史重扫一遍。
  let hitCount = 0;
  const scan = await scanHistoryBackwards(client, chatKind, chatId, {
    pageSize: SEARCH_PAGE_SIZE,
    maxPages,
    shouldStop: (fresh) => {
      hitCount += fresh.filter((raw) => matches(normalizeMessage(raw))).length;
      return hitCount >= SEARCH_MAX_HITS;
    },
  });

  /**
   * 扫描顺序是「新 → 旧」→ 命中消息的「上文」= 扫描流里的**下一条**（更早的那条）。
   */
  const order = scan.scanOrder.map(normalizeMessage);
  const hits: SearchHit[] = [];
  let hitsTruncated = false;
  for (let i = 0; i < order.length; i++) {
    if (!matches(order[i])) continue;
    if (hits.length >= SEARCH_MAX_HITS) {
      hitsTruncated = true;
      break;
    }
    hits.push({ message: order[i], contextBefore: i + 1 < order.length ? order[i + 1] : null });
  }
  // 扫描是**因为命中数达上限**而提前停的 → 命中被截断（哪怕刚好只多出一条）。
  if (scan.stoppedEarly) hitsTruncated = true;

  const stopReason: SearchStopReason = hitsTruncated
    ? 'hits_limit'
    : scan.budgetExhausted
      ? 'page_budget_exhausted'
      : 'history_exhausted';

  const tail =
    stopReason === 'hits_limit'
      ? `命中数达到上限（${SEARCH_MAX_HITS}），扫描提前停止。`
      : stopReason === 'page_budget_exhausted'
        ? `翻页预算用尽（最多 ${maxPages} 页）：可能还有更早的消息没扫到，请调大 maxPages。`
        : '已翻到会话最开始（没有更早的消息了）。';

  const note =
    `搜索为有限扫描（OneBot 11 没有服务端搜索动作，只能向更早翻页后过滤）：本次翻页 ${scan.pages} 页、` +
    `扫描 ${order.length} 条消息、命中 ${hits.length} 条。${tail}` +
    `未命中时可提高 maxPages，或先用 napcat_get_history 按时间范围取一段再搜。`;

  return {
    hits,
    scanned: order.length,
    pages: scan.pages,
    exhausted: scan.exhausted,
    hitsTruncated,
    stopReason,
    note,
  };
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
      description:
        '配置 OneBot 端点（地址与 token），保存后重连。' +
        'token 留空（不传）= **保留已保存的 token**；要清除已存的 token，显式传 clearToken=true。' +
        '端点不在本机且没有 token 时，返回里会带 warning（局域网暴露风险提示）。',
      inputSchema: {
        endpoint: z.string().describe('OneBot 11 端点，如 http://127.0.0.1:3000 或 ws://127.0.0.1:3001'),
        token: z.string().optional().describe('access token；留空 = 保留已保存的 token'),
        clearToken: z
          .boolean()
          .optional()
          .describe('true = 清除已保存的 token（默认 false，即留空 token 不动已存值）'),
        paths: z
          .array(z.string())
          .optional()
          .describe(
            '本机 NapCat 扫描根目录（**绝对路径**，每行一个）；不传 = 不改。' +
              '相对路径会被拒绝（会随工作目录变化）。endpoint 留空时只更新扫描路径、不动连接。',
          ),
      },
    },
    async ({ endpoint, token, clearToken, paths }) => {
      try {
        /**
         * `paths` 是**加法式**的可选参数：不传 = 行为与从前逐字一致（既有调用不受影响）。
         *
         * 相对路径**报错**而不是静默丢弃：用户以为配上了、实际上没配 → 探测范围不对 →
         * 「未检测到本机 NapCat」就成了假阴性。宁可报错让人改。
         */
        const wantPaths = Array.isArray(paths) ? paths : undefined;
        let cleanPaths: string[] | undefined;
        if (wantPaths !== undefined) {
          cleanPaths = wantPaths
            .filter((p): p is string => typeof p === 'string')
            .map((p) => p.trim())
            .filter((p) => p !== '');
          const bad = cleanPaths.filter((p) => !isAbsolute(p));
          if (bad.length > 0) {
            throw new Error(
              `扫描路径必须是绝对路径（相对路径会随工作目录变化，已拒绝本次保存）：${bad.join('、')}`,
            );
          }
        }

        // 端点留空 = 只更新扫描路径（用户还没配端点时也要能改路径）
        if (typeof endpoint !== 'string' || endpoint.trim() === '') {
          if (cleanPaths === undefined) {
            throw new Error('端点不能为空：请填写 OneBot 端点，或只传 paths 更新扫描路径');
          }
          const saved = state.setAutoDetectPaths(cleanPaths);
          return ok({
            configured: state.configured,
            connected: state.client !== null,
            pathsSaved: true,
            paths: saved,
          });
        }

        /**
         * 扫描路径**先落盘**：它是与连接无关的独立配置，
         * 不该因为「端点连不上」这种另一件事而丢掉用户的输入。
         */
        const saved = cleanPaths === undefined ? undefined : state.setAutoDetectPaths(cleanPaths);
        /**
         * `setConnection` 内部在**落盘之后**就清掉了探测结论缓存：
         * 配置一旦落盘，之前那次探测的结论就对不上了——**哪怕这次连不上**
         * （端点合法但连不上时配置也已经写进文件并换了内存态，
         * 此时若不清缓存，面板会继续拿针对旧配置的结论说「检测到本机 NapCat」）。
         */
        const login = await state.setConnection(endpoint, token ?? '', { clearToken: clearToken === true });
        // 安全警告：非回环端点 + 没有 token → 同网段的人可能读到聊天记录（spec §5.2 / §9）
        const warning = endpointSecurityWarning(
          state.config.connection.endpoint,
          state.config.connection.token ?? '',
        );
        return ok({
          configured: true,
          connected: true,
          login,
          ...(warning ? { warning } : {}),
          ...(saved ? { pathsSaved: true, paths: saved } : {}),
        });
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  server.registerTool(
    'napcat_detect_local',
    {
      description:
        '本机 NapCat 探测：只探测回环地址与用户显式配置的端点，不扫描网络。' +
        '把 autoDetect.{ports,endpoints,paths} 与本机安装发现的结果合并成候选后逐个探测（不接参数，范围完全由配置决定）。' +
        '返回 {found, candidates, live, failed, tokenRequired, napcatRunning, webuiPort, budgetExhausted, scanned, notes, installs, droppedEndpoints}：' +
        '探测**不带 token**，疑似需要 token 的端点在 tokenRequired 里；' +
        'budgetExhausted=true 表示扫描未完成（预算耗尽），结果可能不全，**不能**读作「没找到本机 NapCat」；' +
        'notes 里有人类可读的说明（失败候选计数、被丢弃的非回环端点、多个 WebUI 端口、盘根发现生效上限等）。' +
        '探测结论会被 napcat_status 顺带返回（缓存，不重复扫描）。' +
        '⚠️ 返回中含**本机绝对路径**（installs[].configDir、scanned.paths、candidates[].detail、' +
        'droppedEndpoints[].detail），仅用于解释「这个端点是从哪来的」，不要拿它做别的用途。',
      inputSchema: {},
    },
    async () => {
      try {
        // 配置可能已被外部改过（面板设置页 / 用户手改文件）→ 刷新后再探
        state.reloadConfig();
        // 并发调用复用同一个探测（不重复扫盘）：MCP SDK 会并发处理请求
        const { payload, fingerprint } = await detectLocalOnce(state);
        // 结论缓存给 napcat_status 读（status 自己不会触发扫描）
        // 指纹对不上 = 探测期间配置变了 → 这份结论是按旧配置算的 → 丢弃（不写缓存）
        const kept = state.setDetection(
          {
            found: payload.found,
            napcatRunning: payload.napcatRunning,
            endpoint: payload.live[0]?.endpoint,
            budgetExhausted: payload.budgetExhausted,
          },
          fingerprint,
        );
        if (!kept) {
          payload.notes.push('探测期间配置发生了变化，这份结论已按「过期」处理（未写入缓存），请重新检测');
        }
        return ok(payload);
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
      description:
        '拉取会话历史消息（**按时间翻页**，时间正序返回）。' +
        'count=要多少条（默认 50，上限 200）；' +
        'beforeTime=**排他**上界（只取该时间**之前**的消息）：把上一次返回的 nextBeforeTime 传回来即可继续往前翻；' +
        'fromTime / toTime=**闭**区间（epoch 秒）。' +
        '区间与翻页一律按**时间**（epoch 秒）表达 —— 服务端的 message_seq 是随机短 id，不能当游标用。' +
        '返回 {messages, nextBeforeTime, exhausted, stopReason, note}：' +
        'nextBeforeTime=更早消息的时间游标（传回 beforeTime 继续翻）；' +
        'exhausted=true 表示**历史耗尽**（真的没有更早的消息了）；' +
        'stopReason 说明本次为什么停（count_reached / range_covered / history_exhausted / page_budget_exhausted）；' +
        'note 是中文说明（区分历史耗尽、锚点失效、翻页预算用尽）。',
      inputSchema: {
        chatKind: z.enum(['group', 'friend']),
        chatId: z.union([z.string(), z.number()]).describe('会话 id（QQ 群号/好友号是数字型，允许传数字）'),
        count: z.number().optional().default(DEFAULT_COUNT).describe('1-200，默认 50'),
        beforeTime: z
          .number()
          .optional()
          .describe('只取该时间**之前**的消息（epoch 秒，排他）；传上一页返回的 nextBeforeTime 可取更早的消息'),
        fromTime: z.number().optional().describe('区间下界（epoch 秒，含）'),
        toTime: z.number().optional().describe('区间上界（epoch 秒，含）'),
      },
    },
    async ({ chatKind, chatId, count, beforeTime, fromTime, toTime }) => {
      try {
        const c = await state.ensureClient();
        const want = Math.min(Math.max(Math.floor(count ?? DEFAULT_COUNT), 1), MAX_COUNT);
        // 会话 id 允许传数字 → 下发前统一归一成字符串（OneBot 的 group_id/user_id 是字符串型）
        const result = await fetchHistory(c, chatKind, String(chatId), {
          count: want,
          beforeTime,
          fromTime,
          toTime,
        });
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
        '会话内关键词搜索：从最新往**更早**翻页扫描后按正文过滤（OneBot 11 无服务端搜索动作，扫描范围有限）。' +
        '返回 {hits:[{message,contextBefore}], scanned, pages, exhausted, hitsTruncated, stopReason, note}；' +
        'scanned = 扫过的不同消息条数；pages = 翻过的页数（含可能的最后一空页）；' +
        'contextBefore 是命中消息在时间上紧邻其前（更早）的那条；' +
        'exhausted=true 表示**历史耗尽**（真的翻到会话最开始）；' +
        'stopReason 说明本次为什么停（history_exhausted / page_budget_exhausted / hits_limit）；' +
        'hitsTruncated=true 表示命中数达上限、扫描提前停止。' +
        'note 是中文说明：搜索是**有限扫描**，别把它当成搜全了。',
      inputSchema: {
        chatKind: z.enum(['group', 'friend']),
        chatId: z.union([z.string(), z.number()]).describe('会话 id（QQ 群号/好友号是数字型，允许传数字）'),
        query: z.string().describe('关键词（大小写不敏感，按消息正文匹配）'),
        maxPages: z
          .number()
          .optional()
          .default(SEARCH_DEFAULT_MAX_PAGES)
          .describe(`最多翻多少页（1-${SEARCH_MAX_PAGES}，默认 ${SEARCH_DEFAULT_MAX_PAGES}）`),
      },
    },
    async ({ chatKind, chatId, query, maxPages }) => {
      try {
        const q = (query ?? '').trim();
        if (!q) return fail(state, new Error('搜索关键词不能为空'));
        const pages = Math.min(Math.max(Math.floor(maxPages ?? SEARCH_DEFAULT_MAX_PAGES), 1), SEARCH_MAX_PAGES);
        const c = await state.ensureClient();
        return ok(await searchMessages(c, chatKind, String(chatId), q, pages));
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
        'messages 缺省（或为空数组）时用 chatKind + chatId + fromTime + toTime **现拉**该时间区间' +
        '（epoch 秒，闭区间，四个参数缺一不可；区间反了直接报错）。' +
        '现拉失败是**响亮失败**（isError）：区间取不全（翻页预算用尽 / 锚点失效）时直接报错，' +
        '不会静默导出一段缺消息的区间。' +
        'gitignoreUpdated=false 表示「.gitignore 已覆盖该目录」或「用户写了取反规则而跳过」。' +
        'includeImages 目前不下载图片文件（导出里图片为占位符 + URL 记录），媒体下载随 M1.1 增强。' +
        '返回 {mdPath, jsonPath, gitignoreUpdated}。',
      inputSchema: {
        messages: z
          .any()
          .optional()
          .describe(
            '要导出的消息（Message 对象数组；元素须带 time 字段）；缺省时用 chatKind/chatId/fromTime/toTime 现拉该时间区间',
          ),
        // 结构留在发布的 JSON Schema 里（面板可据此提示），取值校验交给 coerceChat → isError
        // id 允许数字：QQ 群号/好友号本来就是数字型，面板与 agent 很可能就这么传
        // （归一化成字符串仍在 coerceChat 里做，比较时统一用归一后的字符串）。
        chat: z
          .object({ kind: z.string(), id: z.union([z.string(), z.number()]), name: z.string() })
          .partial()
          .describe('会话引用 {kind:"group"|"friend", id:string|number, name:string}'),
        chatKind: z.enum(['group', 'friend']).optional().describe('现拉时的会话类型'),
        chatId: z.union([z.string(), z.number()]).optional().describe('现拉时的会话 id（QQ 群号/好友号是数字型，允许传数字）'),
        fromTime: z.number().optional().describe('现拉时的起始时间（epoch 秒，含）'),
        toTime: z.number().optional().describe('现拉时的结束时间（epoch 秒，含）'),
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
          if (a.chatKind === undefined || a.chatId === undefined || a.fromTime === undefined || a.toTime === undefined) {
            throw new Error('缺少 messages 时需要同时给出 chatKind、chatId、fromTime、toTime（现拉该时间区间）');
          }
          // 会话 id 允许传数字 → 统一归一成字符串再比较/下发
          // （`chat.id` 已由 coerceChat 归一；这里归一 chatId，两边比的是归一后的字符串）。
          const fetchId = String(a.chatId);
          // 区间反了 → 明确报错。否则 fetchMessagesBetween 会返回空数组，
          // 工具静默写出一对 `{会话名}_empty` 的空文件（看着像导出成功，其实是空的）。
          if (a.fromTime > a.toTime) {
            throw new Error(`fromTime（${a.fromTime}）不能大于 toTime（${a.toTime}）`);
          }
          // 交叉校验：现拉的会话必须与 chat 指向同一个会话。
          // 不校验就能把 B 群的时间区间写进 A 群名下的文件（张冠李戴，且事后看不出来）。
          if (chat.kind !== a.chatKind || chat.id !== fetchId) {
            throw new Error(
              `chat（${chat.kind}/${chat.id}）与现拉参数（${a.chatKind}/${fetchId}）不一致`,
            );
          }
          const c = await state.ensureClient();
          const fetched = await fetchMessagesBetween(c, a.chatKind, fetchId, {
            fromTime: a.fromTime,
            toTime: a.toTime,
          });
          msgs = fetched.messages.map(normalizeMessage);
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
        'token 一律以 *** 遮蔽，端点按脱敏形式返回（去掉 query 与 userinfo）；' +
        'autoDetect.paths（本机绝对路径）**不返回**，只给条数 autoDetect.pathsCount。',
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
        /**
         * `autoDetect.paths` 是**本机绝对路径**（用户装 NapCat 的目录）。
         *
         * 它**不进工具返回值**：工具返回值会进 agent 的上下文，
         * 本机目录结构不该外泄。
         *
         * 口径（B9）：**配置类返回值只给条数**（用户偏好项不进模型上下文）；
         * **诊断类返回值里的绝对路径是溯源信息，只用于解释来源**。
         * 这里属于配置类 → 只给**条数**——面板要显示「已配置 N 条」够用了。
         */
        const masked = {
          connection: {
            mode: cfg.connection.mode,
            endpoint: maskEndpoint(endpoint),
            token: token ? '***' : '',
          },
          autoDetect: {
            ports: [...cfg.autoDetect.ports],
            endpoints: cfg.autoDetect.endpoints.map(maskEndpoint),
            pathsCount: cfg.autoDetect.paths.length,
            probeTimeoutMs: cfg.autoDetect.probeTimeoutMs,
            scanDrives: cfg.autoDetect.scanDrives,
            maxRoots: cfg.autoDetect.maxRoots,
          },
          managed: {
            napcatVersion: cfg.managed.napcatVersion,
            downloadMirror: cfg.managed.downloadMirror,
            downloadProxyConfigured: cfg.managed.downloadProxy !== '',
            desktopQqPathConfigured: cfg.managed.desktopQqPath !== '',
          },
          export: { ...cfg.export },
          inject: { ...cfg.inject },
        };
        return ok(masked);
      } catch (e) {
        return fail(state, e);
      }
    },
  );

  // 受管宿主（下载 / 启停 NapCat）——单独一个模块，注册在同一台 server 上。
  registerHostTools(server, state);
}
