import { OneBotError } from './errors.js';
import type { OneBotClient } from './client.js';
import type { OB11Friend, OB11Group, OB11LoginInfo, OB11Message } from './types.js';
import { messageDedupKey, messageShortId, sortMessages } from '../model/message.js';

/**
 * OneBot 响应即使 retcode=0，data 也可能缺省或为 null（上游异常/兼容实现）。
 * 所有解包点统一安全回落，避免裸 TypeError 打挂调用链。
 */
type Maybe<T> = T | null | undefined;

/** 单次区间翻页允许的最大页数；触顶说明结果无法保证完整，视为异常而非部分成功。 */
const MAX_PAGES = 1000;

export async function getLoginInfo(c: OneBotClient): Promise<OB11LoginInfo> {
  const data = await c.call<Maybe<OB11LoginInfo>>('get_login_info');
  if (!data) throw new OneBotError(-1, 'get_login_info returned no data');
  return data;
}

export async function getGroupList(c: OneBotClient): Promise<OB11Group[]> {
  const data = await c.call<Maybe<OB11Group[] | { groups: OB11Group[] }>>('get_group_list');
  if (Array.isArray(data)) return data;
  return data?.groups ?? [];
}

export async function getFriendList(c: OneBotClient): Promise<OB11Friend[]> {
  const data = await c.call<Maybe<OB11Friend[] | { friends: OB11Friend[] }>>('get_friend_list');
  if (Array.isArray(data)) return data;
  return data?.friends ?? [];
}

/**
 * 历史锚点：一条消息的**短 id**（NapCat 的 `message_seq`）。
 *
 * 2026-11-21 实测（活体 NapCat v4.18.42）：
 * - `message_seq` 是**随机 32 位短 id**（=== `message_id` === `real_id`）→ 它只能表达
 *   「**从这条开始**」，**不能**做大小比较、不能 `cursor + 1`；
 * - 会话内真正单调递增的是 `real_seq`（每会话独立计数）；
 * - `real_seq` 当 `message_seq` 传 → **查不到**（返回空）→ 锚点只能用短 id。
 */
export interface HistoryAnchor {
  /** 短 id（NapCat 的 `message_seq`）。 */
  shortId: string;
}

/**
 * 服务端说「消息<S>不存在」= **锚点失效**（那条消息已被清理 / 短 id 映射查不到）。
 *
 * 它**不是**「历史耗尽」：锚点没了就再也翻不动，必须明确告诉调用方，
 * 不能静默当成「没有更多了」。
 */
export function isAnchorInvalidError(e: unknown): boolean {
  return e instanceof OneBotError && e.message.includes('不存在');
}

/**
 * 把服务端的「消息<S>不存在」翻译成**可读中文**。
 *
 * 非锚点错误原样抛出（不吞、不改写）。
 */
function translateAnchorError(e: unknown): unknown {
  if (!isAnchorInvalidError(e)) return e;
  const err = e as OneBotError;
  return new OneBotError(
    err.retcode,
    `历史锚点已失效，可能消息已过期或已被清理：${err.message}`,
  );
}

/**
 * 取一页历史消息。
 *
 * 真实语义（2026-11-21 实测）：
 * - **不带锚点** → 最新 `count` 条（时间升序；`reverse_order` 被忽略）；
 * - **带锚点 + `backward=false`** → 从锚点**向更新**取 `count` 条（**含锚点**，时间升序）；
 * - **带锚点 + `backward=true`** → 从锚点**向更早**取 `count` 条（**含锚点**，时间升序）。
 *
 * 往更早翻**必须**带 `reverse_order: true`：不带它时服务端返回的是同一页 → 游标原地打转
 * （这正是 M1 在真实 NapCat 上翻不动的原因）。
 *
 * 锚点用**短 id**（`message_seq`）；传 `real_seq` 查不到（返回空）。
 */
export async function fetchHistoryPage(
  c: OneBotClient,
  kind: 'group' | 'friend',
  id: string,
  opts: { anchor?: HistoryAnchor; count?: number; backward?: boolean } = {},
): Promise<OB11Message[]> {
  const count = opts.count ?? 50;
  if (!Number.isFinite(count) || count <= 0) {
    throw new OneBotError(-1, `invalid count: ${count}`);
  }
  const params: Record<string, unknown> = { count };
  if (kind === 'group') params.group_id = id;
  else params.user_id = id;
  if (opts.anchor !== undefined) params.message_seq = opts.anchor.shortId;
  if (opts.backward === true) params.reverse_order = true;
  const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
  let data: Maybe<{ messages: OB11Message[] }>;
  try {
    data = await c.call<Maybe<{ messages: OB11Message[] }>>(action, params);
  } catch (e) {
    throw translateAnchorError(e);
  }
  return data?.messages ?? [];
}

/** 一次「往更早翻」的扫描结果。 */
export interface HistoryScan {
  /** 命中的消息（**时间升序**：`time` → `real_seq` → 服务端顺序）。 */
  messages: OB11Message[];
  /** 扫描顺序（新 → 旧）：截取「最新 N 条」与搜索的「上文」判定都用它。 */
  scanOrder: OB11Message[];
  /** 实际发起的翻页次数。 */
  pages: number;
  /** 历史耗尽：已经翻到会话最开始，没有更早的消息了。 */
  exhausted: boolean;
  /** 区间已完整覆盖：页内最早的消息已经早于 `fromTime`。 */
  rangeCovered: boolean;
  /** 翻页预算用尽：可能还有更早的消息没取到。 */
  budgetExhausted: boolean;
  /** 调用方的停止条件命中（提前结束扫描）。 */
  stoppedEarly: boolean;
}

export interface HistoryScanOptions {
  /** 最多取多少条（攒够就停；不传 = 把整个区间取完）。 */
  count?: number;
  /** 区间下界（含，unix 秒）。 */
  fromTime?: number;
  /** 区间上界（含，unix 秒）。 */
  toTime?: number;
  /** 每页条数（默认 100）。 */
  pageSize?: number;
  /** 翻页预算（页数，默认 MAX_PAGES）。 */
  maxPages?: number;
  /**
   * 提前停止条件（每翻完一页问一次；返回 true 就停）。
   *
   * 入参是**这一页新收集到的消息**（页内时间升序）——只给增量，调用方自己累计，
   * 免得每页都把全部历史重新过一遍。
   */
  shouldStop?: (freshMessages: OB11Message[]) => boolean;
}

/** 消息时间（epoch 秒）；缺失 / 非数值 → undefined（**没有有效时间**）。 */
function timeOf(m: OB11Message): number | undefined {
  const t: unknown = m.time;
  if (t === null || t === undefined || t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 区间判定（**一律用时间**，unix 秒，闭区间）。
 *
 * 没有有效时间的消息**保留**：它既无法证明在窗口内，也无法证明在窗口外 →
 * 丢掉就是静默丢消息；渲染层会自己跳过它。
 */
function inTimeRange(m: OB11Message, fromTime?: number, toTime?: number): boolean {
  const t = timeOf(m);
  if (t === undefined) return true;
  if (fromTime !== undefined && t < fromTime) return false;
  if (toTime !== undefined && t > toTime) return false;
  return true;
}

/** 列表里第一条带有效时间的消息的时间。 */
function firstTime(list: readonly OB11Message[]): number | undefined {
  for (const m of list) {
    const t = timeOf(m);
    if (t !== undefined) return t;
  }
  return undefined;
}

/** 一页消息的时间范围（最早 / 最晚）；没有有效时间时两端都是 undefined。 */
function timeRange(list: readonly OB11Message[]): { minTime?: number; maxTime?: number } {
  let minTime: number | undefined;
  let maxTime: number | undefined;
  for (const m of list) {
    const t = timeOf(m);
    if (t === undefined) continue;
    if (minTime === undefined || t < minTime) minTime = t;
    if (maxTime === undefined || t > maxTime) maxTime = t;
  }
  return { minTime, maxTime };
}

/** 列表里第一条带短 id（`message_seq`）的消息。 */
function firstAnchored(list: readonly OB11Message[]): OB11Message | undefined {
  for (const m of list) {
    if (messageShortId(m) !== undefined) return m;
  }
  return undefined;
}

/**
 * 扫描顺序（新 → 旧）：页序新 → 旧，页内也新 → 旧。
 *
 * 翻页是从最新往更早走的，扫描流因此是「新 → 旧」；
 * 搜索的「上文」（命中消息在时间上紧邻其前的那条）就是扫描流里的**下一条**。
 */
function toScanOrder(batches: readonly OB11Message[][]): OB11Message[] {
  const out: OB11Message[] = [];
  for (const batch of batches) {
    for (let i = batch.length - 1; i >= 0; i--) out.push(batch[i]);
  }
  return out;
}

/**
 * 从最新往更早翻页扫描，直到攒够 `count` 条 / 覆盖 `[fromTime, toTime]` / 历史耗尽。
 *
 * 翻页模型（按真实 NapCat 语义，2026-11-21 实测）：
 * - 第 1 页**不带锚点** → 最新一页；
 * - 之后每页带**上一页最早那条的短 id** + `reverse_order: true` → 该锚点**及更早**的消息；
 * - 锚点**含**在返回里 → 按短 id 去重（锚点重复只留一条）。
 *
 * 终止条件（**三种必须能区分**，不能都笼统说「没有更多了」）：
 * 1. **历史耗尽**：服务端返回空页（或整页都是已经见过的消息）→ `exhausted = true`；
 * 2. **区间已覆盖**：页内最早的消息已经早于 `fromTime` → `rangeCovered = true`；
 * 3. **翻页预算用尽**：页数触顶 → `budgetExhausted = true`（**可能还有更早的消息没取到**）。
 *
 * 另外两种**异常**（响亮失败，不静默返回残缺结果）：
 * - 页里一条 `message_seq` 都没有 → 无法定位锚点 → 抛错；
 * - 锚点与时间都没变（服务端在原地打转，比如忽略了 `reverse_order`）→ 抛错。
 */
export async function scanHistoryBackwards(
  c: OneBotClient,
  kind: 'group' | 'friend',
  id: string,
  opts: HistoryScanOptions = {},
): Promise<HistoryScan> {
  /**
   * 每页至少 **2 条**。
   *
   * 真实语义下「向更早取 count 条」是**含锚点**的：`count=1` 时服务端只会把锚点本身
   * 返回来 → 往更早翻一步都迈不出去（锚点不变、时间不变 → 永远原地打转）。
   * 所以翻页页大小不能是 1。
   */
  const pageSize = Math.max(2, opts.pageSize ?? 100);
  const maxPages = opts.maxPages ?? MAX_PAGES;
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    throw new OneBotError(-1, `invalid pageSize: ${pageSize}`);
  }
  if (!Number.isFinite(maxPages) || maxPages <= 0) {
    throw new OneBotError(-1, `invalid maxPages: ${maxPages}`);
  }
  if (opts.count !== undefined && (!Number.isFinite(opts.count) || opts.count <= 0)) {
    throw new OneBotError(-1, `invalid count: ${opts.count}`);
  }

  const seen = new Set<string>();
  /** 每页新收集到的消息（**页内时间升序**）；页按「新 → 旧」的顺序入列。 */
  const batches: OB11Message[][] = [];
  let anchor: HistoryAnchor | undefined;
  let prevAnchorId: string | undefined;
  let prevAnchorTime: number | undefined;
  let pages = 0;
  let exhausted = false;
  let rangeCovered = false;
  let budgetExhausted = false;
  let stoppedEarly = false;
  let collected = 0;

  for (;;) {
    if (pages >= maxPages) {
      budgetExhausted = true;
      break;
    }
    const page = await fetchHistoryPage(c, kind, id, {
      anchor,
      count: pageSize,
      backward: anchor !== undefined,
    });
    pages++;
    if (page.length === 0) {
      exhausted = true; // 历史耗尽：服务端返回空页
      break;
    }

    const sorted = sortMessages(page); // 页内：time → real_seq → 服务端顺序
    const { minTime, maxTime } = timeRange(sorted);
    const anchorMsg = firstAnchored(sorted);
    const anchorId = anchorMsg === undefined ? undefined : messageShortId(anchorMsg);
    /** 锚点那条消息的时间（拿它判「服务端是不是往更新的方向翻了」）。 */
    const anchorTime = anchorMsg === undefined ? undefined : timeOf(anchorMsg);

    if (anchorId === undefined) {
      // 页里没有短 id → 这一页没法定位锚点 → 再翻也只会拿到同一页
      throw new OneBotError(
        -1,
        'history page contained no message_seq values; cannot locate an anchor to page further back',
      );
    }

    // 收集：去重 + 区间过滤
    const fresh: OB11Message[] = [];
    let newKeyed = 0; // 这一页里「没见过的、且有稳定标识」的消息数
    for (const m of sorted) {
      const key = messageDedupKey(m);
      if (key !== undefined) {
        if (seen.has(key)) continue; // 页边界可能重叠同一条消息
        seen.add(key);
        newKeyed++;
      }
      if (!inTimeRange(m, opts.fromTime, opts.toTime)) continue;
      fresh.push(m);
    }
    if (fresh.length > 0) {
      batches.push(fresh);
      collected += fresh.length;
    }

    // 区间下界已被覆盖 → 区间里的消息都取到了
    if (opts.fromTime !== undefined && minTime !== undefined && minTime < opts.fromTime) {
      rangeCovered = true;
      break;
    }
    // 攒够了 → 停（多出来的按「最新优先」丢掉，见末尾的截取）
    if (opts.count !== undefined && collected >= opts.count) break;
    /**
     * 游标推进判据：**时间是否前进**（往更早的方向）。
     *
     * 往更早翻时，新的一页**只能**包含「锚点及其更早」的消息 —— 也就是这一页里
     * **最新的那条**也不能比锚点更新。若比锚点还新 → 服务端没按 `reverse_order`
     * 往回走（返回的是锚点之后的消息）→ 再翻只会越翻越新 → 响亮失败。
     *
     * 「整页都是已经见过的消息」是**另一回事**：那是**翻到历史开头**（正常结束），
     * 所以这个判定放在推进判据**之后**。
     */
    if (anchor !== undefined) {
      const wentForward =
        maxTime !== undefined && prevAnchorTime !== undefined && maxTime > prevAnchorTime;
      if (wentForward) {
        throw new OneBotError(
          -1,
          `history pagination made no progress at anchor ${prevAnchorId}: the server returned newer messages instead of older ones (reverse_order may be ignored)`,
        );
      }
    }
    // 这一页没有任何「没见过的、有稳定标识的消息」→ 服务端已经在历史开头（再往前没有消息了）
    if (newKeyed === 0) {
      exhausted = true;
      break;
    }
    anchor = { shortId: anchorId };
    prevAnchorId = anchorId;
    prevAnchorTime = anchorTime;

    // 调用方的停止条件（如搜索命中数达上限）
    if (opts.shouldStop && opts.shouldStop(fresh)) {
      stoppedEarly = true;
      break;
    }
  }

  /**
   * 扫描顺序（新 → 旧）。
   *
   * 取窗「最新优先」：攒多了就丢掉**更旧**的那些。
   *
   * 被挤掉的消息落在 `nextBeforeTime` 之前 → 下一次向前翻页正好能取回来；
   * 若反过来取最旧，被挤掉的就是**更新**的消息，而游标已经越过它们 → 永久取不回。
   */
  const scanOrderAll = toScanOrder(batches);
  const scanOrder =
    opts.count !== undefined && scanOrderAll.length > opts.count
      ? scanOrderAll.slice(0, opts.count)
      : scanOrderAll;
  /** 同一批消息的最老 → 最新视图（稳定排序按它来，服务端顺序才不会被破坏）。 */
  const oldestFirst = scanOrder.slice().reverse();

  return {
    messages: sortMessages(oldestFirst),
    scanOrder,
    pages,
    exhausted,
    rangeCovered,
    budgetExhausted,
    stoppedEarly,
  };
}

/**
 * 取 `[fromTime, toTime]` 区间内的全部消息（时间正序，按短 id 去重）。
 *
 * 从最新往更早翻页，直到区间被完整覆盖或历史耗尽。
 *
 * **响亮失败**：翻页预算用尽时抛错 —— 宁可报错，也不把一段缺消息的区间当成完整结果
 * （导出路径尤其不能静默少消息）。
 */
export async function fetchMessagesBetween(
  c: OneBotClient,
  kind: 'group' | 'friend',
  id: string,
  range: { fromTime?: number; toTime?: number },
  opts: { pageSize?: number } = {},
): Promise<{ messages: OB11Message[]; pages: number; exhausted: boolean }> {
  const scan = await scanHistoryBackwards(c, kind, id, {
    fromTime: range.fromTime,
    toTime: range.toTime,
    pageSize: opts.pageSize,
    maxPages: MAX_PAGES,
  });
  if (scan.budgetExhausted) {
    throw new OneBotError(
      -1,
      `history pagination exceeded page limit (${MAX_PAGES}); the requested time range may be incomplete`,
    );
  }
  return { messages: scan.messages, pages: scan.pages, exhausted: scan.exhausted };
}
