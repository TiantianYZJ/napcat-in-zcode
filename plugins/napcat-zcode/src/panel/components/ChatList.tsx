import { useState } from 'react';
import type { Chat } from '../api.js';

/**
 * 左栏：会话列表（群 / 好友分组 + 名称搜索）。
 *
 * 点击切换会话（由 App 负责载入消息与清空选择）。
 */
export function ChatList({
  chats,
  active,
  onOpen,
}: {
  chats: Chat[];
  active: Chat | null;
  onOpen: (c: Chat) => void;
}) {
  const [q, setQ] = useState('');
  const kw = q.trim().toLowerCase();
  const groups = chats.filter((c) => c.kind === 'group' && (!kw || c.name.toLowerCase().includes(kw)));
  const friends = chats.filter((c) => c.kind === 'friend' && (!kw || c.name.toLowerCase().includes(kw)));
  const row = (c: Chat) => (
    <div
      key={c.kind + c.id}
      data-testid={`chat-${c.id}`}
      data-kind={c.kind}
      className={`chat ${active?.id === c.id && active?.kind === c.kind ? 'on' : ''}`}
      onClick={() => onOpen(c)}
    >
      {c.name}
    </div>
  );
  return (
    <div className="chatlist">
      <input
        placeholder="搜索会话…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        data-testid="chat-search"
      />
      <div className="cap">群</div>
      {groups.map(row)}
      <div className="cap">好友</div>
      {friends.map(row)}
      {chats.length === 0 && <div className="empty">暂无会话</div>}
    </div>
  );
}
