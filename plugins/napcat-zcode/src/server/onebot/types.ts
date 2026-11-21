export interface OB11MessageSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface OB11Sender {
  user_id?: number | string;
  nickname?: string;
  card?: string;
}

export interface OB11Message {
  message_id?: number;
  /**
   * NapCat 的 `message_seq` 是**随机 32 位短 id**（实测 === `message_id` === `real_id`），
   * 不是单调序号 → 只能当**翻页锚点**（「从这条开始」），**不能**做大小比较。
   */
  message_seq?: number;
  real_id?: number;
  /**
   * `real_seq`：**会话内单调递增**的序号（每会话独立计数）——同一秒内的多条消息靠它定序。
   *
   * （实测：群 A 38；群 B 8838,8839,8840…；私聊同样成立。）
   *
   * 注意：真实 NapCat 把它发成**字符串**（`"8841"`）→ 取值要走数值转换，不能直接当数字用。
   */
  real_seq?: number | string;
  time?: number;
  group_id?: number | string;
  user_id?: number | string;
  sender?: OB11Sender;
  message?: OB11MessageSegment[] | string;
  raw_message?: string;
}

export interface OB11Group {
  group_id: number | string;
  group_name: string;
  member_count?: number;
}

export interface OB11Friend {
  user_id: number | string;
  nickname: string;
  remark?: string;
}

export interface OB11LoginInfo {
  user_id: number | string;
  nickname: string;
}

export interface OB11Return<T> {
  status: string;
  retcode: number;
  data: T;
  message?: string;
  wording?: string;
  echo?: string;
}
