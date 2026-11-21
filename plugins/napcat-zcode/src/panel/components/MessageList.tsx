import { useEffect, useLayoutEffect, useRef } from 'react';
import { msgKey, type Msg } from '../api.js';

/**
 * `HH:mm`（消息时间是 epoch 秒）。
 *
 * 时间缺失（`undefined`）时按 NaN 处理 → 渲染成 `NaN:NaN`（与之前逐字相同：
 * 消息列表渲染前已过滤掉没有有效时间的消息，这里只是类型上不撒谎）。
 */
export function hm(t: number | undefined): string {
  const d = new Date((t ?? Number.NaN) * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 消息流（时间正序）——面板的主视图。
 *
 * 读起来要像**一段聊天**：连续的同一发言者归成一组，组头只出现一次名字；
 * 「我」的消息用 ZCode 的 user-message-bubble 填充，一眼能分出哪条是自己发的；
 * 时间跟在组头旁边，不在每条消息里重复。
 *
 * 交互：
 * - 点击选中 / 取消；Ctrl（Cmd）加选；Shift 连选；
 * - **按住一条消息并划过其它消息** → 按可见顺序选中区间；
 * - 滚到顶部哨兵时载入更早的消息（没有 IntersectionObserver 的环境退回按钮）。
 *
 * 不做完整虚拟滚动（行高可变，复杂度高），改用「增量加载 + 渲染上限」，
 * 行为与虚拟滚动等价（向上滚加载更早），差异与理由见 Task 12 的 brief。
 */
export function MessageList({
  messages,
  selection,
  onToggle,
  onLoadOlder,
  noMore,
  loadingOlder,
  note,
  onDragSelect,
  selfId,
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
  /** 拖拽划选：上报起点与终点（`additive` = Ctrl/Cmd 拖拽 → 与已有选区合并）。 */
  onDragSelect?: (fromId: string, toId: string, additive: boolean) => void;
  /** 本机登录账号（用来区分「我发的」与「别人发的」；不传则不区分）。 */
  selfId?: string;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const listwrap = useRef<HTMLDivElement>(null);
  /** 已渲染条数（被跳过的消息不占位，保证传给上层的下标与可见顺序一致）。 */
  let renderedIndex = 0;

  /** 拖拽划选状态：起点消息键、是否正在拖、刚拖过（用来吃掉浏览器补的那个 click）。 */
  const dragFrom = useRef<string | null>(null);
  const dragging = useRef(false);
  const suppressClick = useRef(false);

  /** 鼠标松开 → 结束拖拽。 */
  useEffect(() => {
    const end = (): void => {
      dragging.current = false;
      dragFrom.current = null;
      /**
       * 拖拽结束后浏览器还会补一个 click（目标是按下与松开的最近公共祖先）。
       * 若拖拽确实划过别的消息，这个 click 不能把刚划好的区间改成单选 →
       * 置一个标记让它被忽略；用 `setTimeout(0)` 复位，保证之后的正常点击不受影响。
       */
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    };
    window.addEventListener('mouseup', end);
    return () => window.removeEventListener('mouseup', end);
  }, []);

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

  /** 连续同一发言者归一组。 */
  const groups: { senderId: string; senderName: string; items: { m: Msg; key: string; index: number }[] }[] = [];
  for (const m of messages) {
    // key / testid 用 msgKey：服务端的 id 在缺 message_id/real_id/message_seq 时是空串
    // → 直接用 m.id 会让多条消息撞 key（React 警告）并串选中态、撞 testid。
    // msgKey 返回 null = 这条消息**无法与别的消息区分** → 干脆不渲染
    // （渲染出来只能共用一个 key，选中态会串成一片）。
    const key = msgKey(m);
    if (key === null) continue;
    // 下标按**已渲染**的条数计：被跳过的消息不占位，
    // 与上层 `orderRef`（同样只含可见且有键的消息）逐项对齐。
    const i = renderedIndex++;
    const last = groups[groups.length - 1];
    if (last && last.senderId === m.senderId) last.items.push({ m, key, index: i });
    else groups.push({ senderId: m.senderId, senderName: m.senderName, items: [{ m, key, index: i }] });
  }

  return (
    <div className="listwrap" ref={listwrap}>
      <div ref={sentinel} className="sentinel" data-testid="older-sentinel">
        {note ? <span className="note">{note}</span> : <span>向上滚动加载更早…</span>}
        {!noMore && (
          <button className="btn" data-testid="load-older" onClick={onLoadOlder} disabled={loadingOlder}>
            {loadingOlder ? '加载中…' : '加载更早'}
          </button>
        )}
      </div>
      {groups.map((g) => (
        <div className="msggroup" key={g.senderId + ':' + g.items[0].key}>
          <div className="who">
            {g.senderName}
            {g.items[0].m.time !== undefined && <span className="t"> · {hm(g.items[0].m.time)}</span>}
          </div>
          {g.items.map(({ m, key, index }) => (
            <div
              key={key}
              data-testid={`msg-${key}`}
              role="button"
              tabIndex={0}
              aria-pressed={selection.has(key)}
              className={`msg ${selection.has(key) ? 'sel' : ''} ${
                selfId && m.senderId === selfId ? 'mine' : ''
              }`}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                dragFrom.current = key;
                dragging.current = true;
                suppressClick.current = false;
              }}
              onMouseOver={(e) => {
                if (!dragging.current) return;
                // 只认落在消息行本身的悬停（划过行内的子元素不重复触发）
                if (e.target !== e.currentTarget) return;
                const from = dragFrom.current;
                if (!from || from === key) return;
                suppressClick.current = true;
                // 划选优先于文本选择：把浏览器已经开始的文本选区清掉
                e.preventDefault();
                if (typeof window.getSelection === 'function') window.getSelection()?.removeAllRanges();
                onDragSelect?.(from, key, e.ctrlKey || e.metaKey);
              }}
              onClick={(e) => {
                // 刚拖拽过 → 这个 click 是浏览器补的，别让它把区间改成单选
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                const mode = e.ctrlKey || e.metaKey ? 'ctrl' : e.shiftKey ? 'shift' : 'click';
                onToggle(key, mode, index);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                onToggle(key, e.ctrlKey || e.metaKey ? 'ctrl' : e.shiftKey ? 'shift' : 'click', index);
              }}
            >
              {m.replyTo && <div className="reply">↪ {m.replyTo.preview}</div>}
              <div className="body">{m.text}</div>
            </div>
          ))}
        </div>
      ))}
      {messages.length === 0 && (
        <div className="empty">
          <span className="title">这里还没有消息</span>
          <span>换个会话，或在「宿主」里连上 NapCat。</span>
        </div>
      )}
    </div>
  );
}
