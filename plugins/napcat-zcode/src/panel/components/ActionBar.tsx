import { useEffect, useRef, useState } from 'react';
import { api, bridge, type Chat, type Msg } from '../api.js';
import type { HostCaps } from '../bridge.js';
import { hm } from './MessageList.js';

/**
 * 面板提示（toast）。
 *
 * `copy` 非空时，toast 里额外挂一个「复制」按钮：点了才写剪贴板
 * （面板跑在沙箱 iframe 里，`navigator.clipboard` 经常不可用 → 降级成手动复制）。
 */
export interface Notice {
  /** 提示正文。 */
  text: string;
  /** 「复制」按钮要写进剪贴板的值（一般是 `@<路径>`）。 */
  copy?: string;
}

/**
 * 四个动作按钮 + 一个导出菜单：**每个都依赖一个宿主能力位**。
 *
 * 能力位语义（实测，见 `protocol-notes.md` §2.4）：键存在 = 支持，
 * 值为 `null`/`undefined`/`false` = 不支持；宿主恒有 `serverTools`，
 * 其余三个（`message` / `updateModelContext` / `downloadFile`）取决于宿主开关。
 *
 * 「保存为附件…」依赖的是 `serverTools` 而不是 `downloadFile`：
 * 它的**主路径是服务端导出**（`napcat_export` 拿真实落盘路径 → 复制 `@路径`），
 * `ui/download-file` 只是「另存一份」的降级通道（宿主不回传保存路径，见 §6.1）。
 */
const ACTIONS = [
  { id: 'act-message', label: '发送到对话', cap: 'message', method: 'ui/message' },
  { id: 'act-context', label: '设为背景', cap: 'updateModelContext', method: 'ui/update-model-context' },
  { id: 'act-attach', label: '保存为附件…', cap: 'serverTools', method: 'tools/call' },
  { id: 'act-download', label: '另存一份…', cap: 'downloadFile', method: 'ui/download-file' },
] as const;

/**
 * 按钮不可用的原因（**必须给出原因，不许静默失败**）。
 *
 * 优先级：面板没就绪（**按相位给准确措辞**）→ 宿主不支持该能力 → 动作本身的前置条件
 * （没打开会话 / 没选消息 / 正在处理中）。
 *
 * 相位措辞不能混用：`init` 时是「正在连接宿主…」，`error` 时是「连接失败」（不是「正在连接」），
 * `unconfigured` 时是「尚未配置端点」。
 *
 * @returns 不可用的原因；**空串 = 可用**。
 */
export function disabledReason(
  cap: keyof HostCaps,
  method: string,
  caps: HostCaps,
  phase: string,
  precondition = '',
): string {
  if (phase === 'init') return '正在连接宿主…（握手未完成）';
  if (phase === 'unconfigured') return '尚未配置 OneBot 端点';
  if (phase === 'error') return '连接失败（可点「重试」重试连接）';
  if (!caps[cap]) return `宿主不支持 ${method}（缺少能力位 ${cap}）`;
  return precondition;
}

/** 选区的时间跨度（`HH:mm–HH:mm`）。 */
function span(selected: Msg[]): string {
  if (selected.length === 0) return '';
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const m of selected) {
    if (m.time < min) min = m.time;
    if (m.time > max) max = m.time;
  }
  return `${hm(min)}–${hm(max)}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 另存为的建议文件名：`{会话名}_{YYYYMMDD-HHmm}`。
 *
 * 会话名里的非法字符（`\ / : * ? " < > |` 与控制字符）换成 `_`，
 * 免得宿主弹出的保存对话框拿到一个不可用的名字。
 */
export function suggestName(chat: Chat): string {
  const cleaned = (chat?.name ?? '').replace(/[\s\\/:*?"<>|\x00-\x1f]+/g, '_');
  const base = [...cleaned].slice(0, 60).join('') || 'chat';
  const d = new Date();
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}`;
  return `${base}_${stamp}`;
}

/**
 * 底部动作条。
 *
 * 五个入口：
 * - `发送到对话`（`ui/message`）、`设为背景`（`ui/update-model-context`）：注入。
 * - `保存为附件…`：**服务端导出 + 复制 `@路径`**（主路径，拿到真实落盘路径）。
 * - `另存一份…`：`ui/download-file` 降级通道（宿主弹另存为，但**不回传路径**）。
 * - `导出▾`：静默写导出目录（用户目录 / 当前工作区），**不弹宿主另存为**。
 */
export function ActionBar({
  selected,
  chat,
  caps,
  setNotice,
  phase,
}: {
  selected: Msg[];
  chat: Chat | null;
  caps: HostCaps;
  /** 抛提示（字符串或带「复制」入口的结构化提示）。 */
  setNotice: (s: string | Notice) => void;
  /** 面板相位（`init` / `unconfigured` / `error` / `ready`）——决定按钮不可用的措辞。 */
  phase?: string;
}) {
  const p = phase ?? 'ready';
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  /** 动作的前置条件（与能力位无关的那些）。 */
  const precondition = busy
    ? '处理中…'
    : !chat
      ? '未打开会话'
      : selected.length === 0
        ? '未选择消息'
        : '';

  // 点菜单外面就收起（触发按钮在菜单容器内，由它自己的 onClick 切换）。
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = menuRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  /** 统一的执行壳：忙态置灰 + 失败落 toast（不许只 console）。 */
  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setNotice({ text: `操作失败：${errText(e)}` });
    } finally {
      setBusy(false);
    }
  };

  /** 注入体（服务端统一格式化；首行是不可信第三方内容声明）。 */
  const format = async () => api.formatSelection(selected, chat!.name);

  /** 截断尾注要如实告诉用户（不静默丢消息）。 */
  const truncateNote = (r: { truncated: boolean }): string =>
    r.truncated ? '；内容超长已截断，完整内容请导出后以附件引用' : '';

  const actions = {
    /** 发送到对话：`ui/message`（role=user）。 */
    async send(): Promise<void> {
      const r = await format();
      // 原样透传：注入体的首行是「不可信第三方内容」声明，面板不得改写/裁剪/替换。
      await bridge.uiMessage(r.text);
      setNotice({ text: `已发送到对话（${r.count} 条）${truncateNote(r)}` });
    },

    /** 设为背景：`ui/update-model-context`（不产生新轮次）。 */
    async background(): Promise<void> {
      const r = await format();
      await bridge.updateModelContext(r.text);
      setNotice({ text: `已设为背景（${r.count} 条）${truncateNote(r)}` });
    },

    /**
     * 保存为附件：**主路径 = 服务端导出**（`napcat_export` 落盘并回真实路径）。
     *
     * 平台没有「往输入框附件区塞文件」的 API（spec §5.9），
     * 所以这里做三段式：服务端导出 → 复制 `@<mdPath>` → 用户粘贴到输入框回车。
     *
     * 目录固定用**用户目录**（spec §5.8 的默认目录）：
     * - 用户目录永远可写（工作区导出依赖 `ZCODE_PROJECT_DIR`，没有就导不出去）；
     * - 用户目录**不涉及 .gitignore** → `gitignoreUpdated` 的两种含义（已覆盖 / 因取反规则跳过）
     *   在这条路径上根本不会出现，文案不必含糊；
     * - 需要落到工作区时用「导出▾ → 导出到当前工作区」，那里才检查 .gitignore。
     */
    async attach(): Promise<void> {
      const r = await api.exportSel(selected, chat!, 'user');
      const ref = `@${r.mdPath}`;
      const copied = await bridge.writeClipboard(ref);
      setNotice({
        text: copied
          ? '已导出并复制引用，粘贴到输入框回车即作为附件发送'
          : `已导出：${r.mdPath}（剪贴板不可用，请点「复制」复制 @ 路径，粘贴到输入框回车即作为附件发送）`,
        copy: ref,
      });
    },

    /**
     * 另存一份：`ui/download-file` 降级通道（宿主弹另存为对话框）。
     *
     * **宿主实测**（protocol-notes §6.1）：成功返回 `{}`、失败与用户取消都返回 `{isError:true}`，
     * 插件**拿不到保存路径，也分不清取消与失败**。
     * 因此这里**不依赖** `success` / `filePath` / `canceled`，只按「宿主给没给错误文案」措辞，
     * 并且**不把机器可读标记（`download_not_confirmed`）当人话显示**。
     */
    async download(): Promise<void> {
      const r = await format();
      const res = await bridge.downloadFile(`${suggestName(chat!)}.md`, r.text, 'text/markdown');
      if (res.error === 'download_not_confirmed') {
        setNotice({ text: '已触发另存为，宿主未返回保存结果（可能已取消或失败）' });
        return;
      }
      if (typeof res.error === 'string' && res.error !== '') {
        // 宿主自己给的文案：原样带出（不替换成面板自造的措辞）
        setNotice({ text: `另存为未完成：${res.error}` });
        return;
      }
      setNotice({ text: '已触发另存为，请查看宿主弹出的保存对话框（宿主不回传保存路径）' });
    },

    /** 导出：静默写导出目录（**不弹宿主另存为**），回两个真实路径。 */
    exportTo(dir: 'user' | 'workspace'): () => Promise<void> {
      return async () => {
        const r = await api.exportSel(selected, chat!, dir);
        const lines = [`已导出：${r.mdPath}`, r.jsonPath];
        if (dir === 'workspace') {
          // gitignoreUpdated=false 有**两种**含义（已覆盖 / 因取反规则跳过），
          // 服务端只给一个布尔值 → 文案把两种可能都说出来，不误导用户。
          lines.push(
            r.gitignoreUpdated
              ? '已在工作区 .gitignore 追加忽略规则'
              : '.gitignore 未改动（导出目录可能已被忽略规则覆盖，或存在取反规则）——请确认这些文件不会进入版本库',
          );
        }
        setNotice({ text: lines.join('\n'), copy: `@${r.mdPath}` });
      };
    },
  };

  const actBtn = (
    id: string,
    label: string,
    cap: keyof HostCaps,
    method: string,
    onClick: () => void,
  ) => {
    const reason = disabledReason(cap, method, caps, p, precondition);
    return (
      <button
        key={id}
        data-testid={id}
        className={`act${reason ? ' disabled' : ''}`}
        disabled={reason !== ''}
        title={reason || undefined}
        data-reason={reason}
        data-cap={cap}
        onClick={onClick}
      >
        {label}
      </button>
    );
  };

  const exportReason = disabledReason('serverTools', 'tools/call', caps, p, precondition);

  return (
    <div className="actionbar">
      <span data-testid="sel-count">已选 {selected.length} 条</span>
      {span(selected) && <span className="span" data-testid="sel-span">{span(selected)}</span>}
      {chat && <span className="chat-name">{chat.name}</span>}
      <div className="acts">
        {actBtn('act-message', '发送到对话', 'message', 'ui/message', run(actions.send))}
        {actBtn(
          'act-context',
          '设为背景',
          'updateModelContext',
          'ui/update-model-context',
          run(actions.background),
        )}
        {actBtn('act-attach', '保存为附件…', 'serverTools', 'tools/call', run(actions.attach))}
        {actBtn('act-download', '另存一份…', 'downloadFile', 'ui/download-file', run(actions.download))}
        <div className="menu-wrap" ref={menuRef}>
          <button
            data-testid="act-export"
            data-cap="serverTools"
            className={`act${exportReason ? ' disabled' : ''}`}
            disabled={exportReason !== ''}
            title={exportReason || undefined}
            data-reason={exportReason}
            onClick={() => setMenuOpen((v) => !v)}
          >
            导出▾
          </button>
          {menuOpen && (
            <div className="menu" data-testid="export-menu">
              <button
                data-testid="act-export-user"
                onClick={() => {
                  setMenuOpen(false);
                  void run(actions.exportTo('user'))();
                }}
              >
                导出到用户目录
              </button>
              <button
                data-testid="act-export-workspace"
                onClick={() => {
                  setMenuOpen(false);
                  void run(actions.exportTo('workspace'))();
                }}
              >
                导出到当前工作区
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
