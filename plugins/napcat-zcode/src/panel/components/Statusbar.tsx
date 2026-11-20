import type { StatusInfo } from '../api.js';

/**
 * 连接模式的中文标签。
 *
 * 服务端只报两种：`external`（外部 OneBot 端点）与 `unconfigured`（未配置）；
 * 配置文件里的 `connection.mode` 还可能是 `auto`（自动探测，M2 才落地）。
 * 认不出来的值原样显示（不编造含义）。
 */
export function modeLabel(mode: string): string {
  switch (mode) {
    case 'external':
      return '外部端点';
    case 'auto':
      return '自动探测';
    case 'unconfigured':
      return '未配置';
    default:
      return mode;
  }
}

/**
 * 顶部状态条：连接状态（未配置 / 未连接 / 已连接+昵称+连接模式 / 连接中）+「设置」入口。
 *
 * `phase === 'init'` 是「正在连接宿主…」的中间态 —— 首次握手最坏要 3×15s+2×500ms ≈ 46s，
 * 这段时间里动作按钮必须禁用（见 ActionBar）。
 */
export function Statusbar({
  status,
  phase,
  notice,
  onSettings,
}: {
  status: StatusInfo | null;
  phase: string;
  notice: string;
  /** 「设置」入口（打开只读配置面板）。 */
  onSettings?: () => void;
}) {
  const mode = status?.mode ?? '';
  const text =
    phase === 'ready' && status?.connected
      ? `● 已连接 · ${status.login?.nickname ?? ''} · ${modeLabel(mode)}`
      : phase === 'unconfigured'
        ? '○ 未配置 OneBot 端点'
        : phase === 'error'
          ? `✕ ${status?.error || notice || '未连接 OneBot'}`
          : '… 正在连接宿主…';
  return (
    <div
      className={`statusbar ${phase}`}
      data-testid="statusbar"
      data-phase={phase}
      data-mode={mode || undefined}
    >
      <span className="status-text" title={mode ? `连接模式：${mode}` : undefined}>
        {text}
      </span>
      {onSettings && (
        <button
          className="settings"
          data-testid="settings-btn"
          onClick={onSettings}
          title="查看插件配置（只读）"
        >
          设置
        </button>
      )}
    </div>
  );
}
