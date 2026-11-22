import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, bridge, friendlyError, handshake, msgKey, type Chat, type Msg, type StatusInfo } from './api.js';
import type { HostCaps } from './bridge.js';
import { Statusbar } from './components/Statusbar.js';
import { ChatList } from './components/ChatList.js';
import { MessageList } from './components/MessageList.js';
import { Toolbar } from './components/Toolbar.js';
import { ActionBar, type Notice } from './components/ActionBar.js';
import { SettingsPanel } from './components/SettingsPanel.js';
import { UnconfiguredForm } from './components/UnconfiguredForm.js';
import { HostPanel } from './components/HostPanel.js';

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
 * 跨调用去重键：与服务端 `model/message.ts` 的 `messageDedupKey` **同构**（`s` / `i` 两个命名空间）。
 *
 * - `s${seq}`：服务端 `Message.seq` 只承载 `message_seq`（没有就是 0），所以 `s` 前缀
 *   精确对应「有 message_seq」；
 * - `i${id}`：没有 `message_seq` 时用消息 id（`message_id` / `real_id`）。
 *
 * 注意：`message_seq` 是**随机短 id**（不是单调序号）—— 它只能当**去重键**，
 * 不能当游标（游标是**时间**，见 `cursorRef`）。
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

/**
 * 把宿主展示上下文落到 DOM：`<html data-theme="…">` 驱动 CSS 的深浅色分支，
 * 宿主令牌变量（`--color-background-primary` 等标准键）写进 documentElement，
 * 面板样式里的 `var(标准键, 回退值)` 就消费宿主真值。
 *
 * 主题缺失时回退 light（与官方 documents 面板一致）；握手失败时保持回退态，
 * 面板的错误态展示不受影响。
 */
function applyHostTheme(): void {
  const ctx = bridge.getHostContext();
  const root = document.documentElement;
  root.dataset.theme = ctx.theme ?? 'light';
  for (const [key, value] of Object.entries(ctx.styleVariables)) {
    root.style.setProperty(key, value);
  }
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
   * 右侧视图：记录（消息流）/ 宿主（受管宿主的装与启停）。
   *
   * 面板是**窄侧栏**，两件事没法并排：消息流要宽度，宿主管理要一整块表单。
   * 做成两个标签而不是左右分栏——侧栏放不下两个都舒服的列。
   */
  const [tab, setTab] = useState<'records' | 'host'>('records');
  /**
   * 会话抽屉是否展开。
   *
   * 会话列表在窄侧栏里会吃掉消息流的宽度 → 收成抽屉：
   * 打开面板时**默认展开**（用户第一件事往往是挑一个会话），选中之后自动收起；
   * 之后想换会话，点工具栏的「会话」按钮再展开。
   */
  const [drawerOpen, setDrawerOpen] = useState(true);

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
  /**
   * 翻页游标 = 服务端给的 `nextBeforeTime`（窗口内**最早**那条消息的时间，epoch 秒）。
   *
   * 为什么是时间不是 seq：服务端的 `message_seq` 是**随机短 id**（不是单调序号），
   * 拿它做游标比较是错的 —— 实测 M1 的 seq 游标在真实 NapCat 上原地打转。
   */
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
      // 错误进状态条与主区：转译成人话（未知错误保留原文）
      showNotice(friendlyError(errText(e)));
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
    // 宿主主题：握手成功后应用一次，其后跟随 host-context-changed 通知实时更新
    const offContext = bridge.onHostContextChanged(() => applyHostTheme());
    (async () => {
      try {
        const c = await handshake();
        if (!alive) return;
        setCaps(c);
        applyHostTheme();
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
      offContext();
    };
  }, [reload]);

  /** 打开会话：清空上一段的选择与消息，拉第一页。 */
  const openChat = useCallback(async (chat: Chat) => {
    activeRef.current = chat;
    setActive(chat);
    // 选中即收起抽屉：把宽度还给消息流（这是窄侧栏里最值钱的空间）
    setDrawerOpen(false);
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
        setOlderNote('没有更早的消息了');
        return;
      }
      if (typeof r.nextBeforeTime !== 'number') {
        // 服务端没能给出时间游标（窗口里的消息没有有效 time）→ 没法继续向前翻
        noMoreRef.current = true;
        setNoMore(true);
        setOlderNote('暂时无法加载更早的消息');
        return;
      }
      cursorRef.current = r.nextBeforeTime;
    } catch (e) {
      showNotice(errText(e));
    }
  }, []);

  /**
   * 载入更早的消息。
   *
   * 游标是**时间**（`nextBeforeTime`），不是 seq —— seq 是随机短 id，比大小没有意义。
   *
   * 「还有没有更早的消息」看服务端返回：`exhausted` 为 true = **历史耗尽**；
   * `stopReason` 区分「历史耗尽 / 翻页预算用尽（还能再翻）/ 锚点失效（工具报错）」。
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
        setOlderNote('没有更早的消息了');
        return;
      }
      const { merged, added } = mergeOlder(messagesRef.current, page);
      if (added === 0) {
        // 全是重复（边界那条被重复返回）→ 再翻也是同一页，停。
        noMoreRef.current = true;
        setNoMore(true);
        setOlderNote('没有更早的消息了');
        return;
      }
      messagesRef.current = merged;
      setMessages(merged);
      if (typeof r.nextBeforeTime !== 'number') {
        noMoreRef.current = true;
        setNoMore(true);
        setOlderNote('暂时无法加载更早的消息');
        return;
      }
      if (before !== undefined && r.nextBeforeTime >= before) {
        // 时间游标没有前进 → 再翻也是同一页，停。
        noMoreRef.current = true;
        setNoMore(true);
        setOlderNote('暂时无法加载更早的消息');
        return;
      }
      cursorRef.current = r.nextBeforeTime;
      /**
       * 翻页预算用尽 ≠ 「没有更多了」：
       * 服务端这次没翻完，但游标已经推进 → 再点一次「加载更早」就能继续。
       */
      if (r.stopReason === 'page_budget_exhausted') {
        setOlderNote(r.note ?? '翻页预算用尽：可能还有更早的消息没取到，再点一次「加载更早」继续。');
      }
    } catch (e) {
      // 锚点失效（服务端报「消息<S>不存在」）走这里：文案由服务端给（已中文化）。
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
        {/*
          会话抽屉：窄侧栏里，消息流比会话列表更值钱 → 列表收成抽屉，
          选中会话后自动收起，工具栏的「会话」按钮再展开。
          只在「已连接 + 记录页」渲染：未配置/错误态它是纯遮挡
          （盖住连接表单），不存在需要列表的时刻。
        */}
        {phase === 'ready' && tab === 'records' && (
          <div className={`drawer ${drawerOpen ? 'open' : ''}`} data-testid="chat-drawer">
            <ChatList chats={chats} active={active} onOpen={(c) => void openChat(c)} />
          </div>
        )}
        <div className="right">
          {/* 页签在握手完成后始终可见：未配置/错误相位也要能去「宿主」页安装 / 接管 */}
          {phase !== 'init' && (
            <div className="tabs" role="tablist" data-testid="tabs">
              <button
                role="tab"
                aria-selected={tab === 'records'}
                data-testid="tab-records"
                onClick={() => {
                  setTab('records');
                  setDrawerOpen(false); // 抽屉是浮层：切页签就收起，别盖住新页签的内容
                }}
              >
                记录
              </button>
              <button
                role="tab"
                aria-selected={tab === 'host'}
                data-testid="tab-host"
                onClick={() => {
                  setTab('host');
                  setDrawerOpen(false);
                }}
              >
                宿主
              </button>
            </div>
          )}
          {phase === 'init' && (
            <div className="placeholder" data-testid="phase-init">
              <div className="title">正在连接宿主…</div>
              <div className="desc">第一次连接可能需要十几秒</div>
            </div>
          )}
          {/* 未配置/错误相位：连接与引导内容只出现在「记录」页签；
              「宿主」页签有自己的内容（安装 / 接管 / 启停），两者不叠加 */}
          {phase === 'unconfigured' && tab === 'records' && (
            <UnconfiguredForm
              onDone={() => void reload()}
              onDetected={() => void refreshStatus()}
              onGoHost={() => setTab('host')}
            />
          )}
          {phase === 'error' &&
            tab === 'records' &&
            (reconfiguring ? (
              // 端点填错了/换机器了 → 让用户直接改（不预填，免得无声覆盖已有配置）
              <UnconfiguredForm
                onDone={() => void reload()}
                onDetected={() => void refreshStatus()}
                initialEndpoint=""
                onGoHost={() => setTab('host')}
              />
            ) : (
              <div className="error-card" data-testid="phase-error">
                <div className="error-title">连接 NapCat 失败</div>
                <p className="error-detail" data-testid="phase-error-detail">
                  {friendlyError(notice?.text || status?.error || '未知错误')}
                </p>
                <div className="host-acts">
                  <button className="btn primary" data-testid="retry-btn" onClick={() => void reload()}>
                    重试
                  </button>
                  <button className="btn" data-testid="reconfigure-btn" onClick={() => setReconfiguring(true)}>
                    重新配置端点
                  </button>
                </div>
              </div>
            ))}
          {phase === 'ready' && tab === 'records' && (
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
                onToggleChats={() => setDrawerOpen((v) => !v)}
                chatName={active?.name ?? ''}
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
                selfId={status?.login?.user_id}
              />
            </>
          )}
          {/* 宿主页签在任何「握手已完成」的相位都可用：
              未配置/错误相位正是需要安装、接管与启动的时刻 */}
          {phase !== 'init' && tab === 'host' && (
            <div className="pane">
              <HostPanel onChanged={() => void refreshStatus()} />
            </div>
          )}
        </div>
      </div>
      {!(phase !== 'init' && tab === 'host') && (
        <ActionBar
          selected={selected}
          chat={active}
          caps={caps}
          setNotice={showNotice}
          phase={phase}
          exportDir={exportDir}
        />
      )}
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
