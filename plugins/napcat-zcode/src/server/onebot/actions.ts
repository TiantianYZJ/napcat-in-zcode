import { OneBotError } from './errors.js';
import type { OneBotClient } from './client.js';
import type { OB11Friend, OB11Group, OB11LoginInfo, OB11Message } from './types.js';

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

export async function fetchHistoryPage(
  c: OneBotClient,
  kind: 'group' | 'friend',
  id: string,
  beforeSeq?: number,
  count = 50,
): Promise<OB11Message[]> {
  if (!Number.isFinite(count) || count <= 0) {
    throw new OneBotError(-1, `invalid count: ${count}`);
  }
  // count 默认 50（brief 既定）；显式传 0/负数已在上一行拒绝，不会退化成「不传 count 由服务端决定页大小」。
  const params: Record<string, unknown> = count !== undefined ? { count } : {};
  if (kind === 'group') {
    params.group_id = id;
    if (beforeSeq !== undefined) params.message_seq = String(beforeSeq);
    const data = await c.call<Maybe<{ messages: OB11Message[] }>>('get_group_msg_history', params);
    return data?.messages ?? [];
  }
  params.user_id = id;
  if (beforeSeq !== undefined) params.message_seq = String(beforeSeq);
  const data = await c.call<Maybe<{ messages: OB11Message[] }>>('get_friend_msg_history', params);
  return data?.messages ?? [];
}

/**
 * 从 toSeq 所在页向更早翻页，直到覆盖 fromSeq 或空页；返回闭区间 [fromSeq, toSeq] 内消息（时间正序，按 seq 去重）。
 *
 * 终止路径有三条，都能证明区间已被完整取回：
 * - 空页：历史已耗尽，区间内消息全部取完；
 * - 页内最小 seq <= fromSeq：已覆盖下界；
 * - 探测请求证明更早的历史确实不存在（见下方「无进展」分支）。
 *
 * 「服务端把 count 钳小」不再作为终止条件（短页不等于耗尽，会漏消息）；
 * 翻页无进展时用探测请求区分「历史耗尽」与「服务端不推进游标」，
 * 判定与 NapCat `message_seq` 的独占/包含语义无关、也不依赖探测页容量；
 * 无法推进以及超过 MAX_PAGES 都会抛 OneBotError，不静默返回残缺区间——
 * 那会让调用方把部分结果当成完整结果。
 */
export async function fetchMessagesBetween(
  c: OneBotClient,
  kind: 'group' | 'friend',
  id: string,
  fromSeq: number,
  toSeq: number,
  pageSize = 100,
): Promise<OB11Message[]> {
  const bySeq = new Map<number, OB11Message>();
  let cursor = toSeq;
  let pages = 0;
  let failure: string | undefined;
  for (; pages < MAX_PAGES; pages++) {
    const prevCursor = cursor;
    // 请求「比 cursor+1 更早」的一页（含 cursor 所在边界，页边界重叠在下面按 seq 去重）。
    const msgs = await fetchHistoryPage(c, kind, id, cursor + 1, pageSize);
    if (msgs.length === 0) break; // 历史耗尽：区间内消息已取尽
    for (const m of msgs) {
      const s = m.message_seq;
      if (s === undefined) continue; // 无 message_seq 的消息无法定位：跳过，不进去重表
      if (s >= fromSeq && s <= toSeq && !bySeq.has(s)) bySeq.set(s, m);
    }
    const seqs = msgs.map((m) => m.message_seq).filter((s): s is number => s !== undefined);
    if (seqs.length === 0) {
      failure = 'history page contained no message_seq values; cannot advance cursor';
      break;
    }
    const minSeq = Math.min(...seqs);
    if (minSeq <= fromSeq) break; // 已覆盖下界，区间完整
    if (minSeq >= prevCursor) {
      // 游标没有前进。用探测请求区分「历史确实耗尽」与「服务端不推进游标」，
      // 判定与 message_seq 的独占/包含语义无关（NapCat 真实语义待实测），且不依赖探测页的容量：
      //   P(minSeq) 为探测页，minSeq 是本次无进展点的边界消息。
      //   1) 探测页里有 seq < minSeq → 更早的历史确实存在，但游标推不动 → 区间可能残缺 → 抛错；
      //   2) 探测页里有 seq > minSeq → 服务端不认这个游标 → 区间可能残缺 → 抛错；
      //   3) 探测页为空 → 两种语义下都意味着没有 ≤ minSeq 的消息 → 确认耗尽 → 正常结束；
      //   4) 探测页非空但取不到任何可比较的 message_seq → 无法验证 → 抛错；
      //   5) 探测页只含 minSeq（只可能出现在包含式语义）→ 该页不足以证明没有更早消息
      //      （容量可能看不全）→ 再探测一次 P(minSeq - 1)：为空 → 确认耗尽；非空 → 抛错。
      const probe = await fetchHistoryPage(c, kind, id, minSeq, pageSize);
      const probeSeqs = probe.map((m) => m.message_seq).filter((s): s is number => s !== undefined);
      if (probeSeqs.some((s) => s < minSeq)) {
        failure = `history pagination made no progress at cursor ${prevCursor}; earlier history exists but the cursor cannot advance`;
        break;
      }
      if (probeSeqs.some((s) => s > minSeq)) {
        failure = `history pagination made no progress at cursor ${prevCursor}; the server ignored message_seq`;
        break;
      }
      if (probe.length === 0) break; // 空页：确认没有 ≤ minSeq 的消息 → 历史耗尽，区间完整
      if (probeSeqs.length === 0) {
        failure = `history probe at cursor ${prevCursor} returned no message_seq values; cannot verify whether history is exhausted`;
        break;
      }
      // 探测页只含 minSeq：再探测一次严格更早的边界，区分「确实没有更早消息」与「容量不足看不全」。
      const deeper = await fetchHistoryPage(c, kind, id, minSeq - 1, pageSize);
      if (deeper.length === 0) break; // 确认没有 ≤ minSeq-1 的消息 → 历史耗尽，区间完整
      failure = `history pagination made no progress at cursor ${prevCursor}; earlier history exists but the cursor cannot advance`;
      break;
    }
    cursor = minSeq;
  }
  if (failure) throw new OneBotError(-1, failure);
  if (pages >= MAX_PAGES) {
    throw new OneBotError(-1, `history pagination exceeded page limit (${MAX_PAGES})`);
  }
  return [...bySeq.values()].sort((a, b) => (a.message_seq ?? 0) - (b.message_seq ?? 0));
}
