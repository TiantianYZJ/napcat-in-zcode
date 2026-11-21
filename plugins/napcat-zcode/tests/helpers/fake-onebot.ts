/**
 * 假 OneBot：**按真实 NapCat 语义**实现历史动作（2026-11-21 活体实测，计划 §1.2）。
 *
 * 真实语义：
 * - 不带 `message_seq` → **最新** `count` 条，时间升序（`reverse_order` 被忽略）；
 * - `message_seq=S`（S 存在）→ 从 S **向更新**取 `count` 条，**含 S**（S 在最前）；
 * - `message_seq=S` + `reverse_order=true` → 从 S **向更早**取 `count` 条，**含 S**（S 在最后）；
 * - `message_seq=S`（S 不存在）→ **报错**「消息S不存在」；
 * - `count` 守约（受实际存量限制）。
 *
 * 消息字段按实测口径造：
 * - `message_seq` = `message_id` = `real_id` = **随机 32 位短 id**（不是单调序号）；
 * - `real_seq` = 会话内**单调递增**的序号；
 * - `time` = unix 秒。
 */
import { OneBotError } from '../../src/server/onebot/errors.js';
import type { OneBotClient } from '../../src/server/onebot/client.js';

export interface FakeMessage {
  /** 随机 32 位短 id（=== message_id === real_id）。 */
  message_seq: number;
  message_id: number;
  real_id: number;
  /** 会话内单调递增序号。 */
  real_seq: number;
  time: number;
  text: string;
  sender: { user_id: number; nickname: string };
}

export interface FakeOneBotOptions {
  /** 忽略 `reverse_order`（模拟「服务端不推进游标」的坏实现 → 插件必须识别出来）。 */
  ignoreReverseOrder?: boolean;
  /** 服务端把每页条目数钳到该值（0 = 不钳；模拟 count 被限流）。 */
  maxItemsPerPage?: number;
  /** 每页最多返回几条的默认值（`count` 缺省时）。 */
  defaultCount?: number;
}

/**
 * 造一组消息：短 id **随机**（但可复现）、`real_seq` 与时间都单调递增。
 *
 * 短 id 刻意**不是** 1..n —— 插件若还按「seq 是单调序号」用，就会立刻露馅。
 */
export function makeFakeMessages(n: number, startTime = 1700000000, step = 60): FakeMessage[] {
  // Lehmer 随机（可复现、乘积不超 2^53 → 短 id 一定是整数）
  let seed = 20261121;
  const rand = () => {
    seed = (seed * 48271) % 2147483647;
    return seed;
  };
  return Array.from({ length: n }, (_, i) => {
    const shortId = rand();
    return {
      message_seq: shortId,
      message_id: shortId,
      real_id: shortId,
      real_seq: i + 1,
      time: startTime + i * step,
      text: `m${i + 1}`,
      sender: { user_id: i + 1, nickname: `u${i + 1}` },
    };
  });
}

/** 假消息 → OneBot 11 的消息对象（形状与真实 NapCat 一致）。 */
export function toOB11Message(m: FakeMessage): Record<string, unknown> {
  return {
    message_id: m.message_id,
    message_seq: m.message_seq,
    real_id: m.real_id,
    real_seq: m.real_seq,
    time: m.time,
    sender: { user_id: m.sender.user_id, nickname: m.sender.nickname },
    message: [{ type: 'text', data: { text: m.text } }],
  };
}

/** 假客户端 + 调用记录（用于断言下发了什么参数）。 */
export interface FakeOneBot {
  client: OneBotClient;
  /** 每一次历史请求的参数（按调用顺序）。 */
  calls: Array<{ action: string; params: Record<string, unknown> }>;
  /** 换一个会话的数据集（同一个客户端继续用）。 */
  setMessages(messages: FakeMessage[]): void;
}

export function createFakeOneBot(
  messages: FakeMessage[],
  opts: FakeOneBotOptions = {},
): FakeOneBot {
  let dataset = [...messages].sort((a, b) => a.time - b.time);
  const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

  const history = (action: string, params: Record<string, unknown>) => {
    const requested = Number(params.count ?? opts.defaultCount ?? 20);
    const count = opts.maxItemsPerPage && opts.maxItemsPerPage > 0 ? Math.min(requested, opts.maxItemsPerPage) : requested;
    const seqParam = params.message_seq;
    // NapCat：`message_seq` 为空或 '0' 都当「没有锚点」→ 返回最新一页
    if (seqParam === undefined || seqParam === '' || seqParam === '0') {
      return dataset.slice(Math.max(0, dataset.length - count));
    }
    const idx = dataset.findIndex((m) => String(m.message_seq) === String(seqParam));
    if (idx < 0) throw new OneBotError(1, `消息${String(seqParam)}不存在`);
    const backward = opts.ignoreReverseOrder !== true && params.reverse_order === true;
    if (backward) {
      // 向更早：含 S，S 在最后
      return dataset.slice(Math.max(0, idx - count + 1), idx + 1);
    }
    // 向更新：含 S，S 在最前
    return dataset.slice(idx, idx + count);
  };

  const client: OneBotClient = {
    async call<T>(action: string, params?: object): Promise<T> {
      const p = (params ?? {}) as Record<string, unknown>;
      calls.push({ action, params: p });
      if (action === 'get_group_msg_history' || action === 'get_friend_msg_history') {
        return { messages: history(action, p).map(toOB11Message) } as unknown as T;
      }
      if (action === 'get_group_list') return [{ group_id: 123, group_name: '产品群' }] as unknown as T;
      if (action === 'get_friend_list') return [{ user_id: 9, nickname: '张三' }] as unknown as T;
      if (action === 'get_login_info') return { user_id: 1, nickname: 'Bot' } as unknown as T;
      throw new Error(`unexpected action ${action}`);
    },
    async close(): Promise<void> {},
  };

  return {
    client,
    calls,
    setMessages(next: FakeMessage[]): void {
      dataset = [...next].sort((a, b) => a.time - b.time);
    },
  };
}
