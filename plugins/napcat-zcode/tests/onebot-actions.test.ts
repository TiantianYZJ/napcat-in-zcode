import { describe, expect, it } from 'vitest';
import { OneBotError } from '../src/server/onebot/errors.js';
import {
  fetchHistoryPage,
  fetchMessagesBetween,
  getFriendList,
  getGroupList,
  getLoginInfo,
  isAnchorInvalidError,
  scanHistoryBackwards,
} from '../src/server/onebot/actions.js';
import { createFakeOneBot, makeFakeMessages } from './helpers/fake-onebot.js';
import type { OB11Message } from '../src/server/onebot/types.js';

/**
 * 本文件覆盖**真实 NapCat 语义**（2026-11-21 活体实测，计划 §1.2）：
 *
 * - 不带 `message_seq` → **最新** count 条，时间升序；
 * - `message_seq=S` → 从 S **向更新**取 count 条，**含 S**；
 * - `message_seq=S` + `reverse_order=true` → 从 S **向更早**取 count 条，**含 S**；
 * - `message_seq=S`（S 不存在）→ **报错**「消息S不存在」；
 * - `message_seq` 是**随机短 id**（不是单调序号）→ 只能当锚点，不能比大小。
 *
 * 假 OneBot 的行为由 `tests/helpers/fake-onebot.ts` 实现（与真实语义一一对应）。
 */
const MSGS = makeFakeMessages(10);
const byShortId = (m: OB11Message) => m.message_seq as number;

describe('fetchHistoryPage —— 真实语义', () => {
  it('不带锚点 → 返回最新的一页，时间升序', async () => {
    const fake = createFakeOneBot(MSGS);
    const page = await fetchHistoryPage(fake.client, 'group', '123', { count: 3 });
    expect(page.map(byShortId)).toEqual([MSGS[7].message_seq, MSGS[8].message_seq, MSGS[9].message_seq]);
    expect(page.map((m) => m.time)).toEqual([MSGS[7].time, MSGS[8].time, MSGS[9].time]);
  });

  it('带锚点 → 从锚点向更新取，含锚点本身', async () => {
    const fake = createFakeOneBot(MSGS);
    const page = await fetchHistoryPage(fake.client, 'group', '123', {
      anchor: { shortId: String(MSGS[4].message_seq) },
      count: 3,
    });
    expect(page.map(byShortId)).toEqual([MSGS[4].message_seq, MSGS[5].message_seq, MSGS[6].message_seq]);
  });

  it('带锚点 + backward → 从锚点向更早取，含锚点本身，时间仍升序', async () => {
    const fake = createFakeOneBot(MSGS);
    const page = await fetchHistoryPage(fake.client, 'group', '123', {
      anchor: { shortId: String(MSGS[4].message_seq) },
      count: 3,
      backward: true,
    });
    expect(page.map(byShortId)).toEqual([MSGS[2].message_seq, MSGS[3].message_seq, MSGS[4].message_seq]);
    expect(page.map((m) => m.time)).toEqual([MSGS[2].time, MSGS[3].time, MSGS[4].time]);
  });

  it('锚点不存在 → 报错，并翻译成可读中文（不是「历史耗尽」）', async () => {
    const fake = createFakeOneBot(MSGS);
    let err: unknown;
    try {
      await fetchHistoryPage(fake.client, 'group', '123', { anchor: { shortId: '999999999' }, count: 3 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(isAnchorInvalidError(err)).toBe(true);
    expect((err as Error).message).toContain('历史锚点已失效');
    expect((err as Error).message).toContain('可能消息已过期');
  });

  it('count 非法时连请求都不发', async () => {
    const fake = createFakeOneBot(MSGS);
    await expect(fetchHistoryPage(fake.client, 'group', '123', { count: 0 })).rejects.toMatchObject({
      name: 'OneBotError',
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('fetchHistoryPage —— 请求映射', () => {
  it('群走 get_group_msg_history，带 group_id/count', async () => {
    const fake = createFakeOneBot(MSGS);
    await fetchHistoryPage(fake.client, 'group', '123', { count: 3 });
    expect(fake.calls[0].action).toBe('get_group_msg_history');
    expect(fake.calls[0].params).toEqual({ count: 3, group_id: '123' });
  });

  it('好友走 get_friend_msg_history，带 user_id/count', async () => {
    const fake = createFakeOneBot(MSGS);
    await fetchHistoryPage(fake.client, 'friend', '555', { count: 3 });
    expect(fake.calls[0].action).toBe('get_friend_msg_history');
    expect(fake.calls[0].params).toEqual({ count: 3, user_id: '555' });
  });

  it('锚点以短 id（message_seq）下发，且 backward 时带 reverse_order', async () => {
    const fake = createFakeOneBot(MSGS);
    const shortId = String(MSGS[4].message_seq);
    await fetchHistoryPage(fake.client, 'group', '123', { anchor: { shortId }, count: 3, backward: true });
    expect(fake.calls[0].params).toEqual({
      count: 3,
      group_id: '123',
      message_seq: shortId,
      reverse_order: true,
    });
  });

  it('不带锚点时不下发 message_seq / reverse_order', async () => {
    const fake = createFakeOneBot(MSGS);
    await fetchHistoryPage(fake.client, 'group', '123', { count: 3 });
    expect(fake.calls[0].params.message_seq).toBeUndefined();
    expect(fake.calls[0].params.reverse_order).toBeUndefined();
  });
});

describe('scanHistoryBackwards —— 往更早翻', () => {
  it('从最新往更早翻，收集到指定条数，时间正序', async () => {
    const fake = createFakeOneBot(MSGS);
    const scan = await scanHistoryBackwards(fake.client, 'group', '123', { count: 6, pageSize: 3 });
    expect(scan.messages.map(byShortId)).toEqual(MSGS.slice(4).map((m) => m.message_seq));
    const times = scan.messages.map((m) => m.time).filter((t): t is number => t !== undefined);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(scan.pages).toBeGreaterThan(1);
  });

  it('每一页都带 reverse_order 与上一页最早那条的短 id', async () => {
    const fake = createFakeOneBot(MSGS);
    await scanHistoryBackwards(fake.client, 'group', '123', { count: 6, pageSize: 3 });
    const hist = fake.calls.filter((c) => c.action === 'get_group_msg_history');
    expect(hist[0].params.message_seq).toBeUndefined(); // 第一页取最新
    expect(hist[0].params.reverse_order).toBeUndefined();
    expect(hist[1].params.reverse_order).toBe(true);
    // 锚点是「上一页最早那条」的短 id（真实语义：锚点含在返回里 → 下页会重叠一条）
    expect(hist[1].params.message_seq).toBe(String(MSGS[7].message_seq));
    expect(hist[2].params.message_seq).toBe(String(MSGS[5].message_seq));
  });

  it('翻到历史开头 → exhausted（真的没有更早的消息了）', async () => {
    const fake = createFakeOneBot(MSGS);
    const scan = await scanHistoryBackwards(fake.client, 'group', '123', { pageSize: 4 });
    expect(scan.messages).toHaveLength(MSGS.length);
    expect(scan.exhausted).toBe(true);
    expect(scan.budgetExhausted).toBe(false);
  });

  it('区间下界被覆盖 → rangeCovered，且消息都在区间内', async () => {
    const fake = createFakeOneBot(MSGS);
    const from = MSGS[3].time;
    const to = MSGS[6].time;
    const scan = await scanHistoryBackwards(fake.client, 'group', '123', { fromTime: from, toTime: to, pageSize: 2 });
    expect(scan.rangeCovered).toBe(true);
    expect(scan.messages.map((m) => m.time)).toEqual([MSGS[3].time, MSGS[4].time, MSGS[5].time, MSGS[6].time]);
  });

  it('翻页预算用尽 → budgetExhausted（不是「历史耗尽」）', async () => {
    const fake = createFakeOneBot(MSGS);
    const scan = await scanHistoryBackwards(fake.client, 'group', '123', { pageSize: 1, maxPages: 2 });
    expect(scan.budgetExhausted).toBe(true);
    expect(scan.exhausted).toBe(false);
  });

  it('服务端忽略 reverse_order（游标原地打转）→ 响亮报错，不静默返回同一页', async () => {
    const fake = createFakeOneBot(MSGS, { ignoreReverseOrder: true });
    await expect(
      scanHistoryBackwards(fake.client, 'group', '123', { pageSize: 3 }),
    ).rejects.toMatchObject({ name: 'OneBotError' });
  });

  it('页里没有 message_seq → 响亮报错（无法定位锚点）', async () => {
    const fake = createFakeOneBot(MSGS);
    // 造一批「只有 real_seq、没有 message_seq」的消息：锚点只能是短 id
    const noShortId = MSGS.map((m) => ({
      ...m,
      message_seq: undefined as unknown as number,
      message_id: undefined as unknown as number,
      real_id: undefined as unknown as number,
    }));
    fake.setMessages(noShortId);
    await expect(scanHistoryBackwards(fake.client, 'group', '123', { pageSize: 3 })).rejects.toMatchObject({
      name: 'OneBotError',
    });
  });

  it('锚点失效（服务端报「消息<S>不存在」）→ 报可读中文，不是「没有更多了」', async () => {
    // 锚点是服务端给的短 id；消息在翻页途中被清理 → 服务端报「不存在」
    const stale = {
      async call<T>(_action: string, params?: object): Promise<T> {
        const p = (params ?? {}) as Record<string, unknown>;
        if (p.message_seq === undefined) {
          return { messages: [MSGS[0]] } as unknown as T;
        }
        throw new OneBotError(1, `消息${String(p.message_seq)}不存在`);
      },
      async close(): Promise<void> {},
    };
    let err: unknown;
    try {
      await scanHistoryBackwards(stale, 'group', '123', { pageSize: 3 });
    } catch (e) {
      err = e;
    }
    expect(isAnchorInvalidError(err)).toBe(true);
    expect((err as Error).message).toContain('历史锚点已失效');
  });
});

describe('fetchMessagesBetween —— 时间区间', () => {
  it('返回闭区间内的全部消息（时间正序）', async () => {
    const fake = createFakeOneBot(MSGS);
    const r = await fetchMessagesBetween(fake.client, 'group', '123', {
      fromTime: MSGS[2].time,
      toTime: MSGS[5].time,
    });
    expect(r.messages.map((m) => m.time)).toEqual([MSGS[2].time, MSGS[3].time, MSGS[4].time, MSGS[5].time]);
    expect(r.exhausted).toBe(false);
  });

  it('区间跨越历史开头 → 也能干净完成（exhausted）', async () => {
    const fake = createFakeOneBot(MSGS);
    const r = await fetchMessagesBetween(fake.client, 'group', '123', { fromTime: MSGS[0].time });
    expect(r.messages).toHaveLength(MSGS.length);
    expect(r.exhausted).toBe(true);
  });

  it('区间内一条都没有 → 空数组（不是报错）', async () => {
    const fake = createFakeOneBot(MSGS);
    const r = await fetchMessagesBetween(fake.client, 'group', '123', {
      fromTime: MSGS[0].time - 1000,
      toTime: MSGS[0].time - 1,
    });
    expect(r.messages).toEqual([]);
  });

  it('翻页预算用尽 → 响亮报错（区间可能残缺，不能静默返回）', async () => {
    // 每页都比上一页更早 1 条：游标永远前进，但永远到不了区间下界 → 触顶页数上限。
    let calls = 0;
    const stub = {
      async call<T>(): Promise<T> {
        calls++;
        return {
          messages: [{ message_seq: 100000 - calls, real_seq: calls, time: 1700000000 - calls }],
        } as unknown as T;
      },
      async close(): Promise<void> {},
    };
    await expect(fetchMessagesBetween(stub, 'group', '123', { fromTime: 0 })).rejects.toThrow(/page limit/);
    expect(calls).toBe(1000);
  });
});

describe('action wrappers', () => {
  it('getLoginInfo returns login info', async () => {
    const fake = createFakeOneBot(MSGS);
    expect(await getLoginInfo(fake.client)).toEqual({ user_id: 1, nickname: 'Bot' });
  });

  it('getGroupList / getFriendList 返回空数组（兼容 null data）', async () => {
    const fake = createFakeOneBot(MSGS);
    expect(await getGroupList(fake.client)).toEqual([{ group_id: 123, group_name: '产品群' }]);
    expect(await getFriendList(fake.client)).toEqual([{ user_id: 9, nickname: '张三' }]);
  });

  it('data 为 null 时安全回落（不抛 TypeError）', async () => {
    const nullClient = {
      async call<T>(): Promise<T> {
        return null as unknown as T;
      },
      async close(): Promise<void> {},
    };
    expect(await getGroupList(nullClient)).toEqual([]);
    expect(await getFriendList(nullClient)).toEqual([]);
    expect(await fetchHistoryPage(nullClient, 'group', '123')).toEqual([]);
    await expect(getLoginInfo(nullClient)).rejects.toMatchObject({ name: 'OneBotError' });
  });
});
