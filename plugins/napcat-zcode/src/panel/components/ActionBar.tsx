import { useEffect, useRef, useState } from 'react';
import { api, bridge, type Chat, type Msg } from '../api.js';
import type { HostCaps } from '../bridge.js';
// 只取类型（`import type` 会被编译期抹掉）→ 不会与 App.tsx 形成运行期循环依赖。
import type { Phase } from '../App.js';
import { hm } from './MessageList.js';

/**
 * 面板提示（toast）。
 *
 * `copy` 非空时，toast 里额外挂一个「复制」按钮：点了才写剪贴板
 * （面板跑在沙箱 iframe 里，`navigator.clipboard` 经常不可用 → 降级成手动复制）。
 *
 * `action` 是**另一个**动作按钮（例如「改用用户目录」的一键退路）。
 */
export interface Notice {
  /** 提示正文。 */
  text: string;
  /** 「复制」按钮要写进剪贴板的值（一般是 `@<路径>`）。 */
  copy?: string;
  /** 额外动作按钮（例如失败后的「改用用户目录」重试）。 */
  action?: { label: string; onClick: () => void };
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
  phase: Phase,
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
    // 时间缺失的消息不参与跨度计算（`undefined < x` / `undefined > x` 本来都是 false，语义不变）
    const t = m.time;
    if (t === undefined) continue;
    if (t < min) min = t;
    if (t > max) max = t;
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
 * 是不是「工作区目录不可用」这类失败。
 *
 * 服务端的原话（`src/server/export/export.ts`）：
 * - 「工作区导出需要工作区目录：请给出 workspaceDir 参数，或在 ZCode 项目目录里使用插件」；
 * - 「工作区目录不存在：…」（最终修复波 SF-7 引入：不再凭空创建工作区目录树）；
 * - 「工作区路径不是目录：…」；
 * - 导出器里还有一句英文的 `workspace export requires workspaceDir`。
 *
 * 命中时给「改用用户目录」的一键退路；**不命中就按普通失败处理**（不猜、不改目的地）。
 * 注意：这几条正是该退路被设计出来解决的场景，正则漏掉任何一条都会让用户只拿到一句裸错误。
 */
export function isWorkspaceDirMissing(message: string): boolean {
  return /工作区导出需要工作区目录|workspace export requires workspaceDir|工作区目录不存在|工作区路径不是目录|workspaceDir/.test(
    message,
  );
}

/**
 * `.gitignore` 说明（只有导出落在**工作区**时才有意义）。
 *
 * `gitignoreUpdated === false` 有**两种**含义（已被规则覆盖 / 因用户的取反规则而跳过），
 * 服务端只回一个布尔值 → 文案把两种可能都说出来，**不断言具体是哪一种**。
 *
 * @param exportDir 目的地（`undefined` = 未知 → 用条件式措辞，既不谎称是工作区也不隐瞒风险）。
 */
export function gitignoreNote(
  result: { gitignoreUpdated: boolean },
  exportDir?: 'user' | 'workspace',
): string {
  if (result.gitignoreUpdated) return '已在工作区 .gitignore 追加忽略规则';
  if (exportDir === 'user') return '';
  if (exportDir === 'workspace')
    return '.gitignore 未改动（导出目录可能已被忽略规则覆盖，或存在取反规则）——请确认这些文件不会进入版本库';
  return '若导出落在工作区：.gitignore 未改动（可能被忽略规则覆盖，或存在取反规则）——请确认这些文件不会进入版本库';
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
  exportDir,
}: {
  selected: Msg[];
  chat: Chat | null;
  caps: HostCaps;
  /** 抛提示（字符串或带「复制」入口的结构化提示）。 */
  setNotice: (s: string | Notice) => void;
  /** 面板相位（`init` / `unconfigured` / `error` / `ready`）——决定按钮不可用的措辞。 */
  phase?: Phase;
  /**
   * 配置里的导出目的地（跟随 `export.dir`）。
   *
   * **只影响文案**：目的地由服务端按配置决定（面板不传 `dir`），
   * 面板只是需要知道「这次是不是落在工作区」→ 决定要不要提 .gitignore。
   */
  exportDir?: 'user' | 'workspace';
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

  /**
   * 保存为附件：**主路径 = 服务端导出**（`napcat_export` 落盘并回真实路径）。
   *
   * 平台没有「往输入框附件区塞文件」的 API（spec §5.9），
   * 所以这里做三段式：服务端导出 → 复制 `@<mdPath>` → 用户粘贴到输入框回车。
   *
   * **目的地跟随服务端配置**（`export.dir`，默认用户目录）：
   * 这里**不传 `dir`**，让服务端按配置决定 —— 用户在设置里显式选的工作区目录必须生效。
   * 万一工作区目录不可用（缺 `ZCODE_PROJECT_DIR`），那是**真实失败**：
   * 原样报出原因，并给一个「改用用户目录」的一键退路（**不静默改写目的地**）。
   *
   * @param dir 缺省 = 跟随配置；`'user'` = 用户点了「改用用户目录」的退路。
   */
  async function attach(dir?: 'user'): Promise<void> {
    try {
      const r =
        dir === undefined
          ? await api.exportSel(selected, chat!)
          : await api.exportSel(selected, chat!, dir);
      const ref = `@${r.mdPath}`;
      const copied = await bridge.writeClipboard(ref);
      const lines = [
        copied
          ? '已导出并复制引用，粘贴到输入框回车即作为附件发送'
          : `已导出：${r.mdPath}（剪贴板不可用，请点「复制」复制 @ 路径，粘贴到输入框回车即作为附件发送）`,
      ];
      // .gitignore 说明只在**工作区**导出时才有意义（用户目录没有 .gitignore 这回事）
      const note = gitignoreNote(r, dir ?? exportDir);
      if (note) lines.push(note);
      setNotice({ text: lines.join('\n'), copy: ref });
    } catch (e) {
      const msg = errText(e);
      // 工作区目录不可用 → 显示真实原因 + 给「改用用户目录」的一键退路
      if (dir === undefined && isWorkspaceDirMissing(msg)) {
        setNotice({
          text: `${msg}。`,
          action: {
            label: '改用用户目录',
            onClick: () => {
              void run(() => attach('user'))();
            },
          },
        });
        return;
      }
      throw e; // 其它失败交给统一执行壳（落 toast）
    }
  }

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

    /** 保存为附件：服务端导出 + 复制 `@路径`（目的地跟随配置，见上面的 `attach`）。 */
    attach,

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
        // .gitignore 说明只在**工作区**导出时才有意义
        const note = gitignoreNote(r, dir);
        if (note) lines.push(note);
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
