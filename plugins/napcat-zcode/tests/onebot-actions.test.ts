import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createClient, type OneBotClient } from '../src/server/onebot/client.js';
import {
  fetchHistoryPage,
  fetchMessagesBetween,
  getFriendList,
  getGroupList,
  getLoginInfo,
} from '../src/server/onebot/actions.js';

// 数据集：seq 1..10，时间正序。服务端“最新页”= seq 8..10（页大小 3）。
// 给定 message_seq=s 时返回“比 s 更早的 3 条”（即 seq < s 的最大 3 条），符合 NapCat 语义。
const ALL = Array.from({ length: 10 }, (_, i) => ({ message_seq: i + 1, time: 1700000000 + i, sender: { nickname: `u${i + 1}` }, message: [{ type: 'text', data: { text: `m${i + 1}` } }] }));

const GROUPS = [{ group_id: 900, group_name: '群A', member_count: 3 }];
const FRIENDS = [{ user_id: 777, nickname: '好友A' }];

let server: Server;
let port: number;

// 最近一次请求的 URL 与请求体（用于断言 action 名与参数名）。
let lastUrl = '';
let lastBody: Record<string, unknown> = {};
let requestCount = 0;

// 服务端行为开关：
// - listShape：列表动作返回裸数组还是 {groups}/{friends} 包装；
// - nullData：列表/历史动作的 data 为 null；
// - nullLoginInfo：get_login_info 的 data 为 null；
// - ignoreMessageSeq：服务端忽略 message_seq（恒返回最新一页，游标不推进）；
// - maxItemsPerPage：服务端把每页条目数钳到该值（0 = 不钳，模拟 count 被服务端限流）；
// - seqlessItems：每页额外混入一条没有 message_seq 的消息。
let listShape: 'array' | 'object' = 'array';
let nullData = false;
let nullLoginInfo = false;
let ignoreMessageSeq = false;
let maxItemsPerPage = 0;
let seqlessItems = false;

beforeEach(async () => {
  listShape = 'array';
  nullData = false;
  nullLoginInfo = false;
  ignoreMessageSeq = false;
  maxItemsPerPage = 0;
  seqlessItems = false;
  lastUrl = '';
  lastBody = {};
  requestCount = 0;
  server = createServer((req, res) => {
    let chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requestCount++;
      lastUrl = req.url ?? '';
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      lastBody = body;
      const action = req.url?.slice(1) ?? '';
      const count = maxItemsPerPage > 0 ? maxItemsPerPage : (body.count ?? 3);
      let page: typeof ALL;
      if (!body.message_seq) {
        page = ALL.filter((m) => m.message_seq > 7); // 最新一页
      } else {
        const s = Number(body.message_seq);
        page = ALL.filter((m) => m.message_seq < s).slice(-count);
      }
      if (ignoreMessageSeq) page = ALL.filter((m) => m.message_seq > 7); // 忽略游标：恒返回最新一页
      if (seqlessItems) page = [...page, { time: 1700000000, sender: { nickname: 'no-seq' }, message: [] }] as typeof ALL;
      res.setHeader('content-type', 'application/json');
      if (action === 'get_login_info') {
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: nullLoginInfo ? null : { user_id: 12345, nickname: 'Bot' } }));
        return;
      }
      if (action === 'get_group_list') {
        const data = listShape === 'object' ? { groups: GROUPS } : GROUPS;
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: nullData ? null : data }));
        return;
      }
      if (action === 'get_friend_list') {
        const data = listShape === 'object' ? { friends: FRIENDS } : FRIENDS;
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: nullData ? null : data }));
        return;
      }
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: nullData ? null : { messages: page } }));

    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('history paging', () => {
  it('first page returns latest messages', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    const page = await fetchHistoryPage(c, 'group', '123');
    expect(page.map((m) => m.message_seq)).toEqual([8, 9, 10]);
    await c.close();
  });

  it('cursor page returns older messages', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    const page = await fetchHistoryPage(c, 'group', '123', 8, 3);
    expect(page.map((m) => m.message_seq)).toEqual([5, 6, 7]);
    await c.close();
  });

  it('fetchMessagesBetween walks to the boundary', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    const msgs = await fetchMessagesBetween(c, 'group', '123', 4, 10, 3);
    expect(msgs.map((m) => m.message_seq)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    await c.close();
  });

  it('friend history uses get_friend_msg_history', async () => {
    let action = '';
    server.closeAllConnections?.();
    const s2 = createServer((req, res) => {
      action = req.url?.slice(1) ?? '';
      let chunks: Buffer[] = [];
      req.on('data', (c2) => chunks.push(c2));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { messages: [] } }));
      });
    });
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    const p2 = (s2.address() as { port: number }).port;
    const c = createClient({ endpoint: `http://127.0.0.1:${p2}` });
    await fetchHistoryPage(c, 'friend', '555');
    expect(action).toBe('get_friend_msg_history');
    await c.close();
    await new Promise<void>((r) => s2.close(() => r()));
  });
});

describe('action wrappers', () => {
  it('getLoginInfo returns login info', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    const info = await getLoginInfo(c);
    expect(info).toEqual({ user_id: 12345, nickname: 'Bot' });
    await c.close();
  });

  it('getGroupList accepts both array and {groups} shapes', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    listShape = 'array';
    expect(await getGroupList(c)).toEqual(GROUPS);
    listShape = 'object';
    expect(await getGroupList(c)).toEqual(GROUPS);
    await c.close();
  });

  it('getFriendList accepts both array and {friends} shapes', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    listShape = 'array';
    expect(await getFriendList(c)).toEqual(FRIENDS);
    listShape = 'object';
    expect(await getFriendList(c)).toEqual(FRIENDS);
    await c.close();
  });

  it('tolerates null data without throwing', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    nullData = true;
    expect(await getGroupList(c)).toEqual([]);
    expect(await getFriendList(c)).toEqual([]);
    expect(await fetchHistoryPage(c, 'group', '123')).toEqual([]);
    expect(await fetchHistoryPage(c, 'friend', '555')).toEqual([]);
    await c.close();
  });

  it('getLoginInfo throws OneBotError when the server returns null data', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    nullLoginInfo = true;
    await expect(getLoginInfo(c)).rejects.toMatchObject({ name: 'OneBotError', retcode: -1 });
    await c.close();
  });
});

describe('request mapping', () => {
  it('group path calls get_group_msg_history with group_id/message_seq/count', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    await fetchHistoryPage(c, 'group', '123', 8, 3);
    expect(lastUrl).toBe('/get_group_msg_history');
    expect(lastBody).toEqual({ group_id: '123', message_seq: '8', count: 3 });
    await c.close();
  });

  it('friend path calls get_friend_msg_history with user_id/message_seq/count', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    await fetchHistoryPage(c, 'friend', '555', 8, 3);
    expect(lastUrl).toBe('/get_friend_msg_history');
    expect(lastBody).toEqual({ user_id: '555', message_seq: '8', count: 3 });
    await c.close();
  });

  it('treats beforeSeq 0 as a real cursor instead of "no cursor"', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    const page = await fetchHistoryPage(c, 'group', '123', 0, 3);
    expect(lastUrl).toBe('/get_group_msg_history');
    expect(lastBody).toEqual({ group_id: '123', message_seq: '0', count: 3 });
    expect(page).toEqual([]); // seq < 0 没有消息
    await c.close();
  });

  it('rejects a non-positive count before sending a request', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    await expect(fetchHistoryPage(c, 'group', '123', undefined, 0)).rejects.toMatchObject({ name: 'OneBotError' });
    expect(requestCount).toBe(0);
    await c.close();
  });
});

describe('pagination robustness', () => {
  it('keeps paging when the server returns fewer items than count', async () => {
    maxItemsPerPage = 2; // 服务端把每页钳到 2 条（少于请求的 3），不等于历史耗尽
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    const msgs = await fetchMessagesBetween(c, 'group', '123', 4, 10, 3);
    expect(msgs.map((m) => m.message_seq)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    await c.close();
  });

  it('throws instead of returning a partial range when the server ignores message_seq', async () => {
    ignoreMessageSeq = true;
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    await expect(fetchMessagesBetween(c, 'group', '123', 4, 10, 3)).rejects.toMatchObject({ name: 'OneBotError' });
    expect(requestCount).toBeLessThan(10); // 不能空转到页数上限
    await c.close();
  });

  it('throws instead of returning a partial range when pageSize is 1', async () => {
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    await expect(fetchMessagesBetween(c, 'group', '123', 4, 10, 1)).rejects.toMatchObject({ name: 'OneBotError' });
    expect(requestCount).toBeLessThan(10);
    await c.close();
  });

  it('throws when the page limit is exceeded', async () => {
    // 用内存 stub：每页都比上一页更早 1 条，游标永远前进但永远到不了下界 → 触顶页数上限。
    let calls = 0;
    const stub: OneBotClient = {
      async call<T>(): Promise<T> {
        calls++;
        return { messages: [{ message_seq: 100000 - calls }] } as unknown as T;
      },
      async close(): Promise<void> {},
    };
    await expect(fetchMessagesBetween(stub, 'group', '123', 0, 100000, 1)).rejects.toThrow(/page limit/);
    expect(calls).toBe(1000);
  });

  it('completes when the history is exhausted above fromSeq', async () => {
    // fromSeq=0 小于最老消息的 seq=1：重叠式翻页会一直拿到边界消息，
    // 靠「严格更早」的探测请求证明历史已耗尽 → 区间完整返回，而不是误报「无进展」。
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    const msgs = await fetchMessagesBetween(c, 'group', '123', 0, 10, 3);
    expect(msgs.map((m) => m.message_seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await c.close();
  });

  it('skips messages that carry no message_seq', async () => {
    seqlessItems = true;
    const c = createClient({ endpoint: `http://127.0.0.1:${port}` });
    const msgs = await fetchMessagesBetween(c, 'group', '123', 4, 10, 3);
    expect(msgs.every((m) => m.message_seq !== undefined)).toBe(true);
    expect(msgs.map((m) => m.message_seq)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    await c.close();
  });
});
