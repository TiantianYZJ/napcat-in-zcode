import type { OneBotClient } from './client.js';
import type { OB11Friend, OB11Group, OB11LoginInfo, OB11Message } from './types.js';

/**
 * OneBot 响应即使 retcode=0，data 也可能缺省或为 null（上游异常/兼容实现）。
 * 所有解包点统一安全回落，避免裸 TypeError 打挂调用链。
 */
type Maybe<T> = T | null | undefined;

export async function getLoginInfo(c: OneBotClient): Promise<OB11LoginInfo> {
  return c.call<OB11LoginInfo>('get_login_info');
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
  const params: Record<string, unknown> = count ? { count } : {};
  if (kind === 'group') {
    params.group_id = id;
    if (beforeSeq) params.message_seq = String(beforeSeq);
    const data = await c.call<Maybe<{ messages: OB11Message[] }>>('get_group_msg_history', params);
    return data?.messages ?? [];
  }
  params.user_id = id;
  if (beforeSeq) params.message_seq = String(beforeSeq);
  const data = await c.call<Maybe<{ messages: OB11Message[] }>>('get_friend_msg_history', params);
  return data?.messages ?? [];
}

/** 从 toSeq 所在页向更早翻页，直到覆盖 fromSeq 或空页；返回闭区间 [fromSeq, toSeq] 内消息（时间正序，按 seq 去重）。 */
export async function fetchMessagesBetween(
  c: OneBotClient,
  kind: 'group' | 'friend',
  id: string,
  fromSeq: number,
  toSeq: number,
  pageSize = 100,
): Promise<OB11Message[]> {
  const bySeq = new Map<number, OB11Message>();
  let cursor: number | undefined = toSeq;
  for (let guard = 0; guard < 1000; guard++) {
    let page: OB11Message[];
    if (cursor === undefined) {
      page = await fetchHistoryPage(c, kind, id, undefined, pageSize);
    } else {
      page = await fetchHistoryPage(c, kind, id, cursor + 1, pageSize); // “比 cursor+1 更早”，包含 cursor 所在边界
    }
    if (page.length === 0) break;
    for (const m of page) {
      const s = m.message_seq ?? 0;
      if (s >= fromSeq && s <= toSeq && !bySeq.has(s)) bySeq.set(s, m); // 按 seq 去重：页边界可能重叠
    }
    const minSeq = Math.min(...page.map((m) => m.message_seq ?? Number.MAX_SAFE_INTEGER));
    if (minSeq <= fromSeq) break;
    cursor = minSeq;
    if (page.length < pageSize) break;
  }
  return [...bySeq.values()].sort((a, b) => (a.message_seq ?? 0) - (b.message_seq ?? 0));
}
