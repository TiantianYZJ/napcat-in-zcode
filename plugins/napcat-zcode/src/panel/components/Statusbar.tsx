import { friendlyError, type StatusInfo } from '../api.js';

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
 * 探测结论的摘要文案。
 *
 * 三态 + 两种「**下不了结论**」的情况（两者都**不是**「未检测到」）：
 * - `detection` **不存在**、本次会话从没探过 → 「尚未检测」（压根没探过）；
 * - 探过、但结论在两次轮询之间消失（配置变了 → 服务端清了缓存）→
 *   「结论已过期，请重新检测」（把「不知道」说成「没有」是假阴性）；
 * - 探过、`found` → 「检测到本机 NapCat（端点）」；
 * - 探过、NapCat 在跑但没开 OneBot Server → 「检测到 NapCat（未开启 OneBot Server）」；
 * - 探过、什么都没找到 → 「未检测到本机 NapCat」；
 * - 预算耗尽 → 「探测未完成（扫描预算耗尽）…不能据此判断本机没有 NapCat」
 *   （**绝不可**写成「未检测到本机 NapCat」：那轮扫描根本没扫完）。
 *
 * **阳性结论优先**：扫到了可用端点时，即使预算也耗尽，也要先说「检测到了」
 * （只是把「结果可能不全」补在后面）——把阳性结论藏起来是信息有损，
 * 而「预算耗尽」并不否定已经扫到的东西。
 */
export function detectionSummary(
  detection: StatusInfo['detection'],
  hadDetection: boolean,
): string {
  if (!detection) return hadDetection ? '结论已过期，请重新检测' : '尚未检测';
  if (detection.found) {
    const base = `检测到本机 NapCat（${detection.endpoint ?? '未知端点'}）`;
    return detection.budgetExhausted === true
      ? `${base}；但本轮扫描未完成，结果可能不全`
      : base;
  }
  if (detection.budgetExhausted === true) {
    return '探测未完成（扫描预算耗尽），结果可能不全 —— 不能据此判断本机没有 NapCat';
  }
  if (detection.napcatRunning) return '检测到 NapCat（未开启 OneBot Server）';
  return '未检测到本机 NapCat';
}

/**
 * 标题栏：连接状态 + 探测结论 + 安全警告 +「设置」入口。
 *
 * 视觉：一个小圆点表达状态（不是文字符号），主文案一行，次要信息逐级弱化。
 * ZCode 的规矩：**用文字层级制造密度**，不靠边框和色块。
 *
 * `phase === 'init'` 是「正在连接宿主…」的中间态 —— 首次握手最坏要 3×15s+2×500ms ≈ 46s，
 * 这段时间里动作按钮必须禁用（见 ActionBar）。
 *
 * `status.warning` 是**安全警告**（如「端点不在本机且未设 token」）：
 * 它不是连接失败，单独一行展示，不替换状态文案（否则用户以为连不上）。
 */
export function Statusbar({
  status,
  phase,
  notice,
  onSettings,
  hadDetection = false,
}: {
  status: StatusInfo | null;
  phase: string;
  notice: string;
  /** 「设置」入口（打开只读配置面板）。 */
  onSettings?: () => void;
  /** 本次会话里**见过**探测结论（用于区分「尚未检测」与「结论已过期」）。 */
  hadDetection?: boolean;
}) {
  const mode = status?.mode ?? '';
  const text =
    phase === 'ready' && status?.connected
      ? `已连接${status.login?.nickname ? ` · ${status.login.nickname}` : ''}${mode ? ` · ${modeLabel(mode)}` : ''}`
      : phase === 'unconfigured'
        ? '未配置 OneBot 端点'
        : phase === 'error'
          ? '未连接'
          : '正在连接宿主…';
  // 错误详情（人话）给 title：状态条只留短词，悬停能看完整原因
  const errorDetail =
    phase === 'error' ? friendlyError(status?.error || notice || '连接失败') : undefined;
  const detection = status?.detection;
  /**
   * 摘要行只在「结论有意义」时出现：
   * 未配置 / 连接失败（用户正需要它），或者已经有探测结论。
   * 已连接时连接本身就是答案，不必再摆一句「尚未检测」。
   */
  const showSummary = phase === 'unconfigured' || phase === 'error' || !!detection;
  // 顶部气泡化（对齐 ZCode 的胶囊语言）：状态是左胶囊、设置是右胶囊，
  // 半圆端点的 border-radius 在切线处天然曲率连续（G3 观感）
  return (
    <div className="topbar" data-testid="topbar">
      <div
        className={`statusbar ${phase}`}
        data-testid="statusbar"
        data-phase={phase}
        data-mode={mode || undefined}
      >
        <span className="dot" aria-hidden="true" />
        <span
          className="status-text"
          title={errorDetail ?? (mode ? `连接模式：${modeLabel(mode)}` : undefined)}
        >
          {text}
        </span>
        {showSummary && (
          <span className="detect-summary" data-testid="detect-summary" title={detectionSummary(detection, hadDetection)}>
            {detectionSummary(detection, hadDetection)}
          </span>
        )}
        {status?.warning && (
          <span className="status-warning" data-testid="status-warning" title={status.warning}>
            {status.warning}
          </span>
        )}
      </div>
      <span className="topbar-spacer" aria-hidden="true" />
      {onSettings && (
        <button
          className="btn ghost"
          data-testid="settings-btn"
          onClick={onSettings}
          title="查看插件配置"
        >
          设置
        </button>
      )}
    </div>
  );
}
