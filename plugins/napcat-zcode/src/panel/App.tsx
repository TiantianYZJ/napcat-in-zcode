import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, bridge, handshake, msgKey, type Chat, type Msg, type StatusInfo } from './api.js';
import type { HostCaps } from './bridge.js';
import { Statusbar } from './components/Statusbar.js';
import { ChatList } from './components/ChatList.js';
import { MessageList } from './components/MessageList.js';
import { Toolbar } from './components/Toolbar.js';
import { ActionBar, type Notice } from './components/ActionBar.js';
import { SettingsPanel } from './components/SettingsPanel.js';
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
 * 跨调用去重键：与服务端 `tools.ts` 的 `dedupKey` **同构**（`s` / `i` 两个命名空间）。
 *
 * - `s${seq}`：服务端 `Message.seq` 只承载 `message_seq`（没有就是 0），所以 `s` 前缀
 *   精确对应「有 message_seq」；
 * - `i${id}`：没有 `message_seq` 时用消息 id（`message_id` / `real_id`）。
 *
 * 之前这里一律用 `s${m.seq}`（单一命名空间），而服务端的 seq 在缺 `message_seq`
 * 时会回退成 `message_id` → 两边的键空间不一致，跨调用去重可能误删不同的消息。
 * 现在两边的规则逐字一致。
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
  const [notice, setNotice] = useState<Notice | null>(null);
  const [caps, setCaps] = useState<HostCaps>(NO_CAPS);
  const [noMore, setNoMore] = useState(false);
  const [olderNote, setOlderNote] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** 失败态下是否展开「重新配置端点」表单。 */
  const [reconfiguring, setReconfiguring] = useState(false);
  /** 设置面板（只读配置）是否展开。 */
  const [showSettings, setShowSettings] = useState(false);
  /**
   * 本次会话里**见过**探测结论。
   *
   * 用途：区分状态条上的「尚未检测」与「结论已过期，请重新检测」——
   * 探测结论是服务端的**缓存**，配置一变就会被清掉（`detection` 键消失）。
   * 「键消失」有两种含义：从来没探过 / 探过但结论过期了。
   * 把两者混成「未检测到本机 NapCat」就是把「不知道」说成「没有」（假阴性）。
   *
   * 注意：只要**曾经拿到过**结论就置位（哪怕是面板刚打开时服务端就有缓存），
   * 否则「结论在两次轮询之间消失」会被误报成「尚未检测」。
   */
  const [hadDetection, setHadDetection] = useState(false);
  /**
   * 设置面板里的扫描路径输入框内容（**面板自己记着**）。
   *
   * 服务端的 `napcat_get_config` **不返回**本机绝对路径（B9：路径只给用户看，
   * 不给 agent 看）→ 面板拿不到「已配置的路径」，只能记住**用户自己填过**的那些。
   * 放在 App 里（而不是设置面板的局部 state）→ 面板关掉再打开，内容还在。
   */
  const [pathsText, setPathsText] = useState('');
  /**
   * 配置里的导出目的地（跟随 `export.dir`）。
   *
   * **只影响文案**：目的地由服务端按配置决定（面板不传 `dir`），
   * 面板只是需要知道「这次是不是落在工作区」→ 决定要不要在提示里提 .gitignore。
   */
  const [exportDir, setExportDir] = useState<'user' | 'workspace' | undefined>(undefined);

  /**
   * 抛面板提示。
   *
   * 提示可以是纯文本，也可以是带「复制」入口的结构化提示
   * （沙箱里 `navigator.clipboard` 常常不可用 → 让用户自己点「复制」）。
   */
  const showNotice = useCallback((s: string | Notice) => {
    setNotice(typeof s === 'string' ? { text: s } : s);
  }, []);

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
      // 见过结论就记一笔：之后结论消失（配置变了 → 服务端清了缓存）要说「结论已过期」
      if (st.detection) setHadDetection(true);
      if (!st.configured) {
        setNotice(null);
        setPhase('unconfigured');
        return;
      }
      if (!st.connected) {
        setNotice(null);
        setReconfiguring(false);
        setPhase('error');
        return;
      }
      const [g, f] = await Promise.all([api.listChats('group'), api.listChats('friend')]);
      setChats([...(g.chats ?? []), ...(f.chats ?? [])]);
      setNotice(null);
      setPhase('ready');
    } catch (e) {
      showNotice(errText(e));
      setPhase('error');
    }
  }, []);

  /**
   * 只刷新状态（**不动相位机**）。
   *
   * 探测之后用它拿状态条摘要：失败态里 `reload()` 会把「重新配置端点」表单收起来
   * （`setReconfiguring(false)`）—— 探测的结果会随表单一起消失，用户白点一次。
   */
  const refreshStatus = useCallback(async () => {
    try {
      const st = await api.status();
      setStatus(st);
      // 见过结论就记一笔：之后结论消失（配置变了 → 服务端清了缓存）要说「结论已过期」
      if (st.detection) setHadDetection(true);
    } catch {
      /* 状态刷新失败不影响其它功能 */
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
        /**
         * 读一次配置，拿到导出目的地（`export.dir`）。
         *
         * 目的地本身由服务端按配置决定（面板不传 `dir`）；面板只是需要知道
         * 「这次会不会落在工作区」→ 决定提示里要不要提 .gitignore。
         * 读不到不影响其它功能（文案会自动退成条件式措辞，不误导）。
         */
        try {
          const cfg = await api.getConfig();
          const d = cfg.export?.dir;
          if (alive && (d === 'user' || d === 'workspace')) setExportDir(d);
        } catch {
          /* 配置读不到：不影响其它功能 */
        }
      } catch (e) {
        if (!alive) return;
        showNotice(errText(e));
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
    // 换会话就把上一段残留的提示清掉（否则上一段的失败提示会一直挂在面板上）
    setNotice(null);
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
      showNotice(errText(e));
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
      showNotice(errText(e));
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
      // 时间缺失的消息不参与时间范围过滤（`undefined < x` 本来就是 false，语义不变）
      if (cutoff !== undefined && typeof m.time === 'number' && m.time < cutoff) return false;
      return true;
    });
  }, [messages, query, sender, range]);

  /**
   * 能进消息列表的消息：时间可信 **且** 有可区分的键。
   *
   * - 没有有效时间的消息渲染出来是 `NaN:NaN`（假时间戳），不能进列表；
   * - 没有稳定键的消息（既无 id、又无 seq、连时间都不可信）无法与别的消息区分，
   *   渲染出来只能共用一个 key → 选中态会串成一片。
   *
   * 两条都是在**渲染层**挡掉，数据本身仍留在 `messages` 里（导出/搜索不受影响）。
   */
  const renderable = useMemo(
    () => filtered.filter((m) => Number.isFinite(m.time) && msgKey(m) !== null),
    [filtered],
  );

  /**
   * 渲染上限：超出只渲染**最近** RENDER_CAP 条（更早的仍在 `messages` 里，
   * 导出/搜索照样能处理）。
   */
  const capped = renderable.length > RENDER_CAP;
  const visible = useMemo(
    () => (capped ? renderable.slice(renderable.length - RENDER_CAP) : renderable),
    [capped, renderable],
  );

  useEffect(() => {
    orderRef.current = visible.map((m) => msgKey(m) ?? '');
  }, [visible]);

  const selected = useMemo(
    () => messages.filter((m) => selection.has(msgKey(m) ?? '')),
    [messages, selection],
  );

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

  /**
   * 拖拽划选：按住一条消息划过其它消息 → 选中区间（按**可见列表**序）。
   *
   * `additive`（Ctrl/Cmd 拖拽）= 与已有选区合并；否则整段替换。
   */
  const dragSelect = useCallback((fromId: string, toId: string, additive: boolean) => {
    const order = orderRef.current;
    const a = order.indexOf(fromId);
    const b = order.indexOf(toId);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    setSelection((prev) => {
      const next = additive ? new Set(prev) : new Set<string>();
      for (let i = lo; i <= hi; i++) {
        const mid = order[i];
        if (mid) next.add(mid);
      }
      return next;
    });
  }, []);

  return (
    <div className="app">
      <Statusbar
        status={status}
        phase={phase}
        notice={notice?.text ?? ''}
        onSettings={() => setShowSettings(true)}
        hadDetection={hadDetection}
      />
      <div className="main">
        <ChatList chats={chats} active={active} onOpen={(c) => void openChat(c)} />
        <div className="right">
          {phase === 'init' && (
            <div className="placeholder" data-testid="phase-init">
              正在连接宿主…（首次握手最坏约 46 秒）
            </div>
          )}
          {phase === 'unconfigured' && (
            <UnconfiguredForm onDone={() => void reload()} onDetected={() => void refreshStatus()} />
          )}
          {phase === 'error' &&
            (reconfiguring ? (
              // 端点填错了/换机器了 → 让用户直接改（不预填，免得无声覆盖已有配置）
              <UnconfiguredForm
                onDone={() => void reload()}
                onDetected={() => void refreshStatus()}
                initialEndpoint=""
              />
            ) : (
              <div className="placeholder" data-testid="phase-error">
                <p>{notice?.text || status?.error || '连接失败'}</p>
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
                onDragSelect={dragSelect}
              />
            </>
          )}
        </div>
      </div>
      <ActionBar
        selected={selected}
        chat={active}
        caps={caps}
        setNotice={showNotice}
        phase={phase}
        exportDir={exportDir}
      />
      {notice && phase !== 'error' && (
        <div className="toast" data-testid="toast">
          <span className="toast-text" onClick={() => setNotice(null)}>
            {notice.text}
          </span>
          {notice.copy !== undefined && (
            <button
              className="toast-copy"
              data-testid="toast-copy"
              title={`复制 ${notice.copy}`}
              onClick={async () => {
                const value = notice.copy ?? '';
                const ok = await bridge.writeClipboard(value);
                setNotice(
                  ok
                    ? { text: `已复制：${value}` }
                    : { text: `复制失败：请手动复制 ${value}`, copy: value },
                );
              }}
            >
              复制
            </button>
          )}
          {notice.action && (
            <button
              className="toast-action"
              data-testid="toast-action"
              onClick={() => notice.action?.onClick()}
            >
              {notice.action.label}
            </button>
          )}
        </div>
      )}
      {showSettings && (
        <SettingsPanel
          onClose={() => setShowSettings(false)}
          pathsText={pathsText}
          onPathsText={setPathsText}
        />
      )}
    </div>
  );
}
