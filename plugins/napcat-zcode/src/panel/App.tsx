import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, handshake, msgKey, type Chat, type Msg, type StatusInfo } from './api.js';
import type { HostCaps } from './bridge.js';
import { Statusbar } from './components/Statusbar.js';
import { ChatList } from './components/ChatList.js';
import { MessageList } from './components/MessageList.js';
import { Toolbar } from './components/Toolbar.js';
import { ActionBar } from './components/ActionBar.js';
import { UnconfiguredForm } from './components/UnconfiguredForm.js';

/** 面板状态机。 */
export type Phase = 'init' | 'unconfigured' | 'error' | 'ready';

/**
 * 渲染上限（条）。
 *
 * 替代虚拟滚动：行高可变，完整虚拟化复杂度高；这里用「增量加载 + 渲染上限」，
 * 行为等价（向上滚加载更早），代价是最多只渲染最近这么多条。
 */
export const RENDER_CAP = 2000;

/** 单次翻页条数（服务端上限 200）。 */
const PAGE_SIZE = 100;

const NO_CAPS: HostCaps = {
  message: false,
  updateModelContext: false,
  downloadFile: false,
  serverTools: false,
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 跨调用去重键：优先 `seq`（= 服务端的 message_seq / message_id 归一值），其次消息 id。
 *
 * 没有稳定键的消息（既无 seq 又无 id）**不参与去重** —— 用页内下标当键会把不同消息误判成重复。
 */
function dedupeKey(m: Msg): string | null {
  if (typeof m.seq === 'number' && m.seq > 0) return `s${m.seq}`;
  if (m.id) return `i${m.id}`;
  return null;
}

/**
 * 把「更早的一页」合并进已有列表。
 *
 * 服务端**只在单次调用内去重**（`fetchHistory` 里的 `seen` 是每次调用新建的），
 * 边界那条可能被重复返回 → 面板必须**跨调用按 seq 去重**。
 *
 * 更早的消息**前置**（列表是时间正序），页内相对顺序保持服务端给的样子。
 */
export function mergeOlder(prev: Msg[], incoming: Msg[]): { merged: Msg[]; added: number } {
  const seen = new Set<string>();
  for (const m of prev) {
    const k = dedupeKey(m);
    if (k) seen.add(k);
  }
  const fresh: Msg[] = [];
  for (const m of incoming) {
    const k = dedupeKey(m);
    if (k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    fresh.push(m);
  }
  return { merged: fresh.length ? [...fresh, ...prev] : prev, added: fresh.length };
}

/** 时间范围的起点（epoch 秒）；`all` 返回 undefined（不过滤）。 */
function rangeCutoff(range: string): number | undefined {
  const now = Date.now() / 1000;
  if (range === 'today') {
    const d = new Date(now * 1000);
    d.setHours(0, 0, 0, 0);
    return d.getTime() / 1000;
  }
  if (range === '7d') return now - 7 * 86400;
  if (range === '30d') return now - 30 * 86400;
  return undefined;
}

export function App() {
  const [phase, setPhase] = useState<Phase>('init');
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [active, setActive] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [sender, setSender] = useState('');
  const [range, setRange] = useState('all');
  const [includeImages, setIncludeImages] = useState(false);
  const [notice, setNotice] = useState('');
  const [caps, setCaps] = useState<HostCaps>(NO_CAPS);
  const [noMore, setNoMore] = useState(false);
  const [olderNote, setOlderNote] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** 失败态下是否展开「重新配置端点」表单。 */
  const [reconfiguring, setReconfiguring] = useState(false);

  /** 当前会话（`loadOlder` 是稳定回调，用 ref 读最新值）。 */
  const activeRef = useRef<Chat | null>(null);
  /** 翻页游标 = 服务端给的 `nextBeforeSeq`（窗口内最小 seq）。 */
  const cursorRef = useRef<number | undefined>(undefined);
  const loadingOlderRef = useRef(false);
  const noMoreRef = useRef(false);
  /** 消息列表的「真相」副本（合并时读它，避免在 setState 更新函数里做副作用）。 */
  const messagesRef = useRef<Msg[]>([]);
  /** Shift 连选的锚点（最后一次普通点击的消息 id）。 */
  const anchorRef = useRef<string | null>(null);
  /** 当前可见消息的 id 顺序（Shift 连选按它取区间）。 */
  const orderRef = useRef<string[]>([]);

  /** 重拉状态与会话列表。 */
  const reload = useCallback(async () => {
    try {
      const st = await api.status();
      setStatus(st);
      if (!st.configured) {
        setNotice('');
        setPhase('unconfigured');
        return;
      }
      if (!st.connected) {
        setNotice('');
        setReconfiguring(false);
        setPhase('error');
        return;
      }
      const [g, f] = await Promise.all([api.listChats('group'), api.listChats('friend')]);
      setChats([...(g.chats ?? []), ...(f.chats ?? [])]);
      setNotice('');
      setPhase('ready');
    } catch (e) {
      setNotice(errText(e));
      setPhase('error');
    }
  }, []);

  /**
   * 挂载：先握手，再拉状态。
   *
   * 握手最坏 3×15s + 2×500ms ≈ 46s → 这段时间 phase 停在 `'init'`，
   * 状态条显示「正在连接宿主…」，动作按钮全部禁用。
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await handshake();
        if (!alive) return;
        setCaps(c);
        await reload();
      } catch (e) {
        if (!alive) return;
        setNotice(errText(e));
        setPhase('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [reload]);

  /** 打开会话：清空上一段的选择与消息，拉第一页。 */
  const openChat = useCallback(async (chat: Chat) => {
    activeRef.current = chat;
    setActive(chat);
    setSelection(new Set());
    anchorRef.current = null;
    messagesRef.current = [];
    setMessages([]);
    cursorRef.current = undefined;
    noMoreRef.current = false;
    setNoMore(false);
    setOlderNote('');
    try {
      const r = await api.getHistory(chat.kind, chat.id, undefined, PAGE_SIZE);
      if (activeRef.current !== chat) return; // 用户已经切到别的会话了
      const page = r.messages ?? [];
      messagesRef.current = page;
      setMessages(page);
      if (page.length === 0) {
        noMoreRef.current = true;
        setNoMore(true);
        setOlderNote('没有更早的消息了（服务端返回空页）');
        return;
      }
      if (typeof r.nextBeforeSeq !== 'number') {
        // 服务端没能给出游标（窗口里的消息没有 message_seq）→ 没法继续向前翻
        noMoreRef.current = true;
        setNoMore(true);
        setOlderNote('服务端未提供可继续向前翻页的游标（消息缺少 message_seq）');
        return;
      }
      cursorRef.current = r.nextBeforeSeq;
    } catch (e) {
      setNotice(errText(e));
    }
  }, []);

  /**
   * 载入更早的消息。
   *
   * 「还有没有更早的消息」**不看 `exhausted`**（它是历史耗尽 / 游标推不动 / 扫描页数触顶的
   * 三合一语义），而看「**再翻一页是否返回空**」→ 空页才确认到底。
   */
  const loadOlder = useCallback(async () => {
    const chat = activeRef.current;
    if (!chat || loadingOlderRef.current || noMoreRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const before = cursorRef.current;
      const r = await api.getHistory(chat.kind, chat.id, before, PAGE_SIZE);
      if (activeRef.current !== chat) return; // 期间切了会话 → 丢弃这一页
      const page = r.messages ?? [];
      if (page.length === 0) {
        noMoreRef.current = true;
        setNoMore(true);
        setOlderNote('没有更早的消息了（服务端返回空页）');
        return;
      }
      const { merged, added } = mergeOlder(messagesRef.current, page);
      if (added === 0) {
        // 全是重复（边界那条被重复返回）→ 再翻也是同一页，停。
        noMoreRef.current = true;
        setNoMore(true);
        setOlderNote('本轮没有返回新消息（边界重复或已到历史开头）');
        return;
      }
      messagesRef.current = merged;
      setMessages(merged);
      if (typeof r.nextBeforeSeq !== 'number') {
        noMoreRef.current = true;
        setNoMore(true);
        setOlderNote('服务端未提供可继续向前翻页的游标（消息缺少 message_seq）');
        return;
      }
      if (before !== undefined && r.nextBeforeSeq >= before) {
        // 游标没有前进 → 再翻也是同一页，停。
        noMoreRef.current = true;
        setNoMore(true);
        setOlderNote('游标没有前进（服务端未接受该游标），无法加载更早的消息');
        return;
      }
      cursorRef.current = r.nextBeforeSeq;
    } catch (e) {
      setNotice(errText(e));
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, []);

  /** 会话里出现过的发送人（工具栏的下拉）。 */
  const senders = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) if (m.senderId) map.set(m.senderId, m.senderName || m.senderId);
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [messages]);

  /** 客户端过滤（关键词 / 发送人 / 时间范围）。 */
  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    const cutoff = rangeCutoff(range);
    return messages.filter((m) => {
      if (kw && !m.text.toLowerCase().includes(kw)) return false;
      if (sender && m.senderId !== sender) return false;
      if (cutoff !== undefined && m.time < cutoff) return false;
      return true;
    });
  }, [messages, query, sender, range]);

  /**
   * 渲染上限：超出只渲染**最近** RENDER_CAP 条（更早的仍在 `messages` 里，
   * 导出/搜索照样能处理）。
   */
  const capped = filtered.length > RENDER_CAP;
  const visible = useMemo(
    () => (capped ? filtered.slice(filtered.length - RENDER_CAP) : filtered),
    [capped, filtered],
  );

  useEffect(() => {
    orderRef.current = visible.map((m) => msgKey(m));
  }, [visible]);

  const selected = useMemo(() => messages.filter((m) => selection.has(msgKey(m))), [messages, selection]);

  /**
   * 选择规则：单击单选、Shift 连选（按可见列表序）、Ctrl/Cmd 点选。
   *
   * Shift 的锚点是「最后一次普通点击的消息」；锚点被过滤掉时退化成单选。
   */
  const toggle = useCallback((id: string, mode: 'click' | 'ctrl' | 'shift', index: number) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (mode === 'ctrl') {
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }
      if (mode === 'shift') {
        const anchor = anchorRef.current;
        const order = orderRef.current;
        const ai = anchor ? order.indexOf(anchor) : -1;
        if (ai >= 0) {
          const [a, b] = [Math.min(ai, index), Math.max(ai, index)];
          for (let i = a; i <= b; i++) {
            const mid = order[i];
            if (mid) next.add(mid);
          }
          return next;
        }
        // 锚点不在当前可见列表里 → 退化成单选
      }
      next.clear();
      next.add(id);
      anchorRef.current = id;
      return next;
    });
  }, []);

  return (
    <div className="app">
      <Statusbar status={status} phase={phase} notice={notice} />
      <div className="main">
        <ChatList chats={chats} active={active} onOpen={(c) => void openChat(c)} />
        <div className="right">
          {phase === 'init' && (
            <div className="placeholder" data-testid="phase-init">
              正在连接宿主…（首次握手最坏约 46 秒）
            </div>
          )}
          {phase === 'unconfigured' && <UnconfiguredForm onDone={() => void reload()} />}
          {phase === 'error' &&
            (reconfiguring ? (
              // 端点填错了/换机器了 → 让用户直接改（不预填，免得无声覆盖已有配置）
              <UnconfiguredForm onDone={() => void reload()} initialEndpoint="" />
            ) : (
              <div className="placeholder" data-testid="phase-error">
                <p>{notice || status?.error || '连接失败'}</p>
                <button data-testid="retry-btn" onClick={() => void reload()}>
                  重试
                </button>
                <button data-testid="reconfigure-btn" onClick={() => setReconfiguring(true)}>
                  重新配置端点
                </button>
              </div>
            ))}
          {phase === 'ready' && (
            <>
              {capped && (
                <div className="capnote" data-testid="cap-note">
                  仅显示最近 {RENDER_CAP} 条，导出/搜索可处理更多
                </div>
              )}
              <Toolbar
                query={query}
                onQuery={setQuery}
                senders={senders}
                sender={sender}
                onSender={setSender}
                range={range}
                onRange={setRange}
                includeImages={includeImages}
                onIncludeImages={setIncludeImages}
              />
              <MessageList
                messages={visible}
                selection={selection}
                onToggle={toggle}
                onLoadOlder={loadOlder}
                noMore={noMore}
                loadingOlder={loadingOlder}
                note={olderNote}
              />
            </>
          )}
        </div>
      </div>
      <ActionBar
        selected={selected}
        chat={active}
        caps={caps}
        setNotice={setNotice}
        ready={phase === 'ready'}
      />
      {notice && phase !== 'error' && (
        <div className="toast" data-testid="toast" onClick={() => setNotice('')}>
          {notice}
        </div>
      )}
    </div>
  );
}
