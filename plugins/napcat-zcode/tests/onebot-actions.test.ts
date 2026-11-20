import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createClient } from '../src/server/onebot/client.js';
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

// 包装层测试的响应开关：listShape 决定列表动作返回裸数组还是 {groups}/{friends} 包装；nullData 决定 data 是否为 null。
let listShape: 'array' | 'object' = 'array';
let nullData = false;

beforeEach(async () => {
  listShape = 'array';
  nullData = false;
  server = createServer((req, res) => {
    let chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const action = req.url?.slice(1) ?? '';
      const count = body.count ?? 3;
      let page: typeof ALL;
      if (!body.message_seq) {
        page = ALL.filter((m) => m.message_seq > 7); // 最新一页
      } else {
        const s = Number(body.message_seq);
        page = ALL.filter((m) => m.message_seq < s).slice(-count);
      }
      res.setHeader('content-type', 'application/json');
      if (action === 'get_login_info') {
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: nullData ? null : { user_id: 12345, nickname: 'Bot' } }));
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
});
