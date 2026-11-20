import type { Chat, Msg } from '../api.js';
import type { HostCaps } from '../bridge.js';
import { hm } from './MessageList.js';

/**
 * 四个动作按钮：**每个都依赖一个宿主能力位**。
 *
 * 能力位语义（实测，见 `protocol-notes.md` §2.4）：键存在 = 支持，
 * 值为 `null`/`undefined`/`false` = 不支持；宿主恒有 `serverTools`，
 * 其余三个（`message` / `updateModelContext` / `downloadFile`）取决于宿主开关。
 */
const ACTIONS = [
  { id: 'act-message', label: '发送到对话', cap: 'message', method: 'ui/message' },
  { id: 'act-context', label: '设为背景', cap: 'updateModelContext', method: 'ui/update-model-context' },
  { id: 'act-attach', label: '保存为附件…', cap: 'downloadFile', method: 'ui/download-file' },
  { id: 'act-export', label: '导出', cap: 'serverTools', method: 'tools/call' },
] as const;

/**
 * 按钮不可用的原因（**必须给出原因，不许静默失败**）。
 *
 * 优先级：面板没就绪 → 宿主不支持该能力 → 动作本身还没实现（本任务只做占位）。
 */
export function disabledReason(
  cap: keyof HostCaps,
  method: string,
  caps: HostCaps,
  ready: boolean,
): string {
  if (!ready) return '面板尚未就绪（正在连接宿主…）';
  if (!caps[cap]) return `宿主不支持 ${method}（缺少能力位 ${cap}）`;
  return '占位：T13 实现';
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

/**
 * 底部动作条。
 *
 * **本任务只做占位**：已选计数 + 四个置灰按钮（完整实现在 T13）。
 * 置灰不等于「坏了」：每个按钮都带 `data-reason` 说明为什么不能点。
 */
export function ActionBar({
  selected,
  chat,
  caps,
  ready,
}: {
  selected: Msg[];
  chat: Chat | null;
  caps: HostCaps;
  setNotice: (s: string) => void;
  /** 面板是否已就绪（握手完成 + 已连接）。 */
  ready?: boolean;
}) {
  const isReady = ready !== false;
  return (
    <div className="actionbar">
      <span data-testid="sel-count">已选 {selected.length} 条</span>
      {span(selected) && <span className="span" data-testid="sel-span">{span(selected)}</span>}
      {chat && <span className="chat-name">{chat.name}</span>}
      <div className="acts">
        {ACTIONS.map((a) => {
          const reason = disabledReason(a.cap, a.method, caps, isReady);
          return (
            <button
              key={a.id}
              data-testid={a.id}
              className="act disabled"
              disabled
              title={reason}
              data-reason={reason}
              data-cap={a.cap}
            >
              {a.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
