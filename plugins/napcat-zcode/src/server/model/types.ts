export interface ChatRef {
  kind: 'group' | 'friend';
  id: string;
  name: string;
  avatar?: string;
}

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'at'; qq: string; name?: string }
  | { kind: 'face'; faceId: string; text?: string }
  | { kind: 'reply'; messageId: string }
  | { kind: 'image'; url?: string; fileId?: string; width?: number; height?: number }
  | { kind: 'voice'; url?: string; duration?: number }
  | { kind: 'video'; url?: string; fileName?: string }
  | { kind: 'file'; url?: string; fileName?: string; size?: number }
  | { kind: 'json'; raw: string }
  | { kind: 'forward'; messageId: string; preview?: string };

export interface Message {
  id: string;
  seq: number;
  /**
   * 消息时间（epoch 秒）。
   *
   * `undefined` = **没有有效时间**（上游缺 `time` 或 `time` 不是数值）。
   *
   * 不用 `0` 兜底：`0` 是 1970-01-01 00:00，与「时间不可信」不是一回事——
   * 兜底成 0 会让畸形消息渲染出一个**看起来正常但完全错误**的时间戳。
   * 渲染器据此**跳过**该条（并如实报出跳过了几条），而不是产出 `NaN-NaN-NaN`。
   */
  time: number | undefined;
  senderId: string;
  senderName: string;
  segments: Segment[];
  text: string;
  replyTo?: { messageId: string; preview: string };
}

/**
 * 消息是否带**有效时间**（有限数）。
 *
 * 用它把「时间不可信」的消息挡在时间轴与渲染器之外：
 * 没有有效时间的消息既无法定位（since/until 过滤），也渲染不出可信的时间戳。
 */
export function hasValidTime(m: Message): m is Message & { time: number } {
  return typeof m.time === 'number' && Number.isFinite(m.time);
}
