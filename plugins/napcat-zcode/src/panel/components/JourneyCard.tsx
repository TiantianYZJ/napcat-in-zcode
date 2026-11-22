import type { Journey, JourneyAction } from '../journey.js';

/**
 * 旅程卡：首屏告诉用户「你在第几步、下一步按哪个」。
 *
 * 排布规则（ZCode 的层次感）：
 * - 标题用醒目号，副说明用弱色，一步只回答一件事；
 * - 步骤用**竖向步进条**（圆点 + 进度线），当前步高亮、已完成步收敛、未到的灰着；
 * - **只有一个主动作**（当前步的动作）。别的按钮都不给——新用户不需要在
 *   三个可能的下一步里猜。
 */
export function JourneyCard({
  journey,
  onAction,
  busy,
}: {
  journey: Journey;
  onAction: (action: JourneyAction) => void;
  busy?: boolean;
}) {
  return (
    <div className="journey-card" data-testid="journey-card">
      <ol className="journey" data-testid="journey-steps">
        {journey.steps.map((s) => (
          <li
            key={s.key}
            className={s.state}
            data-testid={`journey-step-${s.key}`}
            data-state={s.state}
          >
            <span className="journey-dot" aria-hidden="true" />
            <div className="journey-text">
              <div className="journey-title">{s.title}</div>
              <div className="journey-desc">{s.desc}</div>
            </div>
          </li>
        ))}
      </ol>
      {journey.action && (
        <div className="journey-acts">
          <button
            className="btn primary"
            data-testid="journey-action"
            data-action-kind={journey.action.kind}
            disabled={busy === true}
            onClick={() => onAction(journey.action as JourneyAction)}
          >
            {busy === true ? '处理中…' : journey.action.label}
          </button>
        </div>
      )}
    </div>
  );
}
