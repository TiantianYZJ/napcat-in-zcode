import type { StatusInfo } from '../api.js';

/**
 * 顶部状态条：连接状态（未配置 / 未连接 / 已连接+昵称 / 连接中）。
 *
 * `phase === 'init'` 是「正在连接宿主…」的中间态 —— 首次握手最坏要 3×15s+2×500ms ≈ 46s，
 * 这段时间里动作按钮必须禁用（见 ActionBar）。
 */
export function Statusbar({
  status,
  phase,
  notice,
}: {
  status: StatusInfo | null;
  phase: string;
  notice: string;
}) {
  const text =
    phase === 'ready' && status?.connected
      ? `● 已连接 · ${status.login?.nickname ?? ''}`
      : phase === 'unconfigured'
        ? '○ 未配置 OneBot 端点'
        : phase === 'error'
          ? `✕ ${status?.error || notice || '未连接 OneBot'}`
          : '… 正在连接宿主…';
  return (
    <div className={`statusbar ${phase}`} data-testid="statusbar" data-phase={phase}>
      {text}
    </div>
  );
}
