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
  message_seq?: number;
  real_id?: number;
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
