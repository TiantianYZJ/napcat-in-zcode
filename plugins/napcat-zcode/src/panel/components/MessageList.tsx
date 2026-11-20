import { useEffect, useLayoutEffect, useRef } from 'react';
import { msgKey, type Msg } from '../api.js';

/** `HH:mm`（消息时间是 epoch 秒）。 */
export function hm(t: number): string {
  const d = new Date(t * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 右栏：消息流（时间正序）。
 *
 * - 向上滚（滚到顶部 sentinel）触发 `onLoadOlder()` 载入更早的消息；
 * - 没有 `IntersectionObserver` 的环境（jsdom / 老宿主）退回「加载更早」按钮；
 * - 不做完整虚拟滚动（行高可变，复杂度高），改用「增量加载 + 渲染上限」，
 *   行为与虚拟滚动等价（向上滚加载更早），差异与理由见 Task 12 的 brief。
 */
export function MessageList({
  messages,
  selection,
  onToggle,
  onLoadOlder,
  noMore,
  loadingOlder,
  note,
}: {
  messages: Msg[];
  selection: Set<string>;
  onToggle: (id: string, mode: 'click' | 'ctrl' | 'shift', index: number) => void;
  onLoadOlder: () => void;
  /** 已经确认没有更早的消息（空页 / 游标推不动）→ 不再提供加载入口。 */
  noMore?: boolean;
  loadingOlder?: boolean;
  /** 顶部提示（为什么不能继续加载）。 */
  note?: string;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const listwrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = sentinel.current;
    const root = listwrap.current;
    if (!target || !root) return;
    // 没有 IO 的环境（jsdom、部分沙箱）就靠按钮兜底，不能因为缺 API 就崩。
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadOlder();
      },
      { root, rootMargin: '80px' },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [onLoadOlder]);

  // 顶部插入更早的消息时保持视口不跳（否则用户会被甩到列表中间）。
  const prevHeight = useRef(0);
  const prevCount = useRef(0);
  useLayoutEffect(() => {
    const el = listwrap.current;
    if (!el) return;
    if (messages.length > prevCount.current && prevHeight.current > 0) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    }
    prevHeight.current = el.scrollHeight;
    prevCount.current = messages.length;
  }, [messages]);

  return (
    <div className="listwrap" ref={listwrap}>
      <div ref={sentinel} className="sentinel" data-testid="older-sentinel">
        {note ? <span className="note">{note}</span> : <span>向上滚动加载更早…</span>}
        {!noMore && (
          <button data-testid="load-older" onClick={onLoadOlder} disabled={loadingOlder}>
            {loadingOlder ? '加载中…' : '加载更早'}
          </button>
        )}
      </div>
      {messages.map((m, i) => (
        <div
          key={m.id}
          data-testid={`msg-${m.id}`}
          className={`msg ${selection.has(msgKey(m)) ? 'sel' : ''}`}
          onClick={(e) => {
            const mode = e.ctrlKey || e.metaKey ? 'ctrl' : e.shiftKey ? 'shift' : 'click';
            onToggle(msgKey(m), mode, i);
          }}
        >
          {m.replyTo && <div className="reply">↪ {m.replyTo.preview}</div>}
          <span className="t">{hm(m.time)}</span>
          <span className="who">{m.senderName}</span>
          <span className="body">{m.text}</span>
        </div>
      ))}
      {messages.length === 0 && <div className="empty">没有消息</div>}
    </div>
  );
}
