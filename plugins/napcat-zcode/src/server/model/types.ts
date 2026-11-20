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
  time: number;
  senderId: string;
  senderName: string;
  segments: Segment[];
  text: string;
  replyTo?: { messageId: string; preview: string };
}
