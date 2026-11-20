import { UNTRUSTED_NOTICE } from '../model/notice.js';
import type { ChatRef, Message } from '../model/types.js';

/**
 * 把选区渲染成结构化 JSON（spec §5.8：JSON 是完整规范化消息数组，含媒体 URL 与原始 segment 引用）。
 *
 * messages 原样落盘（不做投影/截断），消费方拿到的就是规范化后的完整 Message 结构：
 * id / seq / time / senderId / senderName / segments / text / replyTo。
 *
 * `notice` 字段携带**与注入体逐字相同**的不可信内容声明：
 * 导出 JSON 同样可能被读进模型上下文（用户 `@` 引用它、或让 agent 打开它），
 * 没有这句，结构化的聊天记录看起来就像可信数据。
 */
export function renderJson(messages: Message[], chat: ChatRef): string {
  return JSON.stringify(
    {
      chat: { kind: chat.kind, id: chat.id, name: chat.name },
      notice: UNTRUSTED_NOTICE,
      exportedAt: new Date().toISOString(),
      count: messages.length,
      messages,
    },
    null,
    2,
  );
}
