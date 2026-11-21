import { useRef, useState } from 'react';
import { api, type DetectEntry, type DetectResult } from '../api.js';

/**
 * 「检测本机 NapCat」区块。
 *
 * **检测不自动连接**：只列候选，由用户点「使用这个」。
 * （自动连接会把「探测」变成「替用户做决定」——探测失败时用户连是哪台机器都不知道。）
 *
 * 文案口径（来自 M2 Task 4 的复审裁定，逐条照做）：
 * - `budgetExhausted === true` → **绝不可**说「未检测到本机 NapCat」（那是假阴性）；
 * - `detection` 键不存在 → 「尚未检测」（不是「未检测到」）；
 * - 超时类失败（「目标无响应」）与其它失败（「连不上」）分开说，不合并成一句；
 * - `tokenRequired` 只作**角标**，措辞是「可能」——探测从不带 token，
 *   且 WebUI 自己的 token ≠ OneBot access token；
 * - `notes` **原样渲染**：面板不自己重算数量（候选/端口都被截到上限，计数只在 notes 里）。
 */
export function LocalDetect({
  onPick,
  onDetected,
}: {
  /** 用户点了「使用这个」：`suspectToken` = 该候选疑似需要 access token。 */
  onPick: (endpoint: string, suspectToken: boolean) => void;
  /** 探测完成（用来刷新状态条上的探测摘要）。 */
  onDetected?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DetectResult | null>(null);
  const [err, setErr] = useState('');
  /**
   * 在途闸门（ref 而不是 state）：`setBusy(true)` 之后的同一次事件循环里，
   * 连点两次仍可能再进一次 handler —— state 更新是异步的，ref 是同步的。
   */
  const inflight = useRef(false);

  const run = async (): Promise<void> => {
    if (inflight.current) return; // 并发重复触发：直接忽略
    inflight.current = true;
    setBusy(true);
    setErr('');
    try {
      const r = await api.detectLocal();
      setResult(r);
      onDetected?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  const candidates = candidatesOf(result);
  const failures = failuresOf(result);

  return (
    <div className="detect" data-testid="detect-panel">
      <button data-testid="detect-btn" disabled={busy} onClick={() => void run()}>
        {busy ? '检测中…' : '检测本机 NapCat'}
      </button>
      {err && (
        <div className="err" data-testid="detect-error">
          {err}
        </div>
      )}
      {result && (
        <div className="detect-result" data-testid="detect-result">
          {result.budgetExhausted === true && (
            <div className="detect-budget" data-testid="detect-budget">
              探测未完成（扫描预算耗尽），结果可能不全 —— 不能据此判断本机没有 NapCat。
              请调大 autoDetect.probeTimeoutMs 或减少扫描端口后重试。
            </div>
          )}
          {!result.found && result.napcatRunning === true && (
            <div className="detect-nowebui" data-testid="detect-nowebui">
              检测到 NapCat 正在运行，但没有开启 OneBot Server。
              {typeof result.webuiPort === 'number' && (
                <div>WebUI 地址：http://127.0.0.1:{result.webuiPort}</div>
              )}
              <div>请在 NapCat WebUI → 网络配置 → 开启 HTTP Server 后再检测。</div>
            </div>
          )}
          {!result.found && result.napcatRunning !== true && result.budgetExhausted !== true && (
            <div className="detect-notfound" data-testid="detect-notfound">
              未检测到本机 NapCat
            </div>
          )}
          {candidates.length > 0 && (
            <div className="detect-candidates" data-testid="detect-candidates">
              {candidates.map((c, i) => (
                <div className="detect-candidate" key={c.entry.endpoint} data-testid={`detect-candidate-${i}`}>
                  <span className="ep">{c.entry.endpoint}</span>
                  {c.entry.login?.nickname && <span className="nick">{c.entry.login.nickname}</span>}
                  {c.entry.unresponsive === true && (
                    <span className="label">目标无响应（超时）</span>
                  )}
                  {c.suspectToken && (
                    <span className="badge" data-testid={`detect-token-badge-${i}`}>
                      {tokenBadge(c.entry.endpoint)}
                    </span>
                  )}
                  {c.entry.error && <span className="detail">{c.entry.error}</span>}
                  <button data-testid={`detect-use-${i}`} onClick={() => onPick(c.entry.endpoint, c.suspectToken)}>
                    使用这个
                  </button>
                </div>
              ))}
            </div>
          )}
          {failures.length > 0 && (
            <div className="detect-failed" data-testid="detect-failed">
              {failures.map((f, i) => (
                <div className="detect-fail" key={`${f.endpoint}-${i}`} data-testid={`detect-fail-${i}`}>
                  {/* 超时（目标在那儿但不答话）与连不上（端口上根本没服务）是两回事 */}
                  <span className="label">{f.unresponsive === true ? '目标无响应（超时）' : '连不上'}</span>
                  <span className="ep">{f.endpoint}</span>
                  {f.error && <span className="detail">{f.error}</span>}
                </div>
              ))}
            </div>
          )}
          {(result.installs ?? []).length > 0 && (
            <div className="detect-installs" data-testid="detect-installs">
              {result.installs.map((inst, i) => (
                <div key={`${inst.configDir}-${i}`}>
                  本机安装：{inst.configDir}
                  {typeof inst.webuiPort === 'number' ? `（WebUI 端口 ${inst.webuiPort}）` : ''}
                </div>
              ))}
            </div>
          )}
          {(result.droppedEndpoints ?? []).length > 0 && (
            <div className="detect-dropped" data-testid="detect-dropped">
              {result.droppedEndpoints.map((d, i) => (
                <div key={`${d.endpoint}-${i}`}>已跳过 {d.endpoint}（不是回环地址）</div>
              ))}
            </div>
          )}
          {(result.notes ?? []).length > 0 && (
            <div className="detect-notes" data-testid="detect-notes">
              {result.notes.map((n, i) => (
                <div key={`${i}-${n}`}>{n}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 疑似需要 token 的角标。措辞必须是「可能」——探测从不带 token，说不准。 */
function tokenBadge(endpoint: string): string {
  if (endpoint.startsWith('ws')) {
    // WS 握手被拒也可能是「该端口压根不是 WebSocket 服务」→ 不许断言「需要 access token」
    return '该端点可能需要 access token（也可能该端口不是 WebSocket 服务）';
  }
  return '该端点可能需要 access token';
}

/**
 * 候选列表：探测成功的排前面，其后是**疑似需要 token** 的（带角标）。
 *
 * 同一端点只出现一次（`tokenRequired` 是 `failed` 的子集，可能与 `live` 重叠）。
 */
export function candidatesOf(
  result: DetectResult | null,
): { entry: DetectEntry; suspectToken: boolean }[] {
  if (!result) return [];
  const out: { entry: DetectEntry; suspectToken: boolean }[] = [];
  const seen = new Set<string>();
  for (const e of result.live ?? []) {
    if (seen.has(e.endpoint)) continue;
    seen.add(e.endpoint);
    out.push({ entry: e, suspectToken: false });
  }
  for (const e of result.tokenRequired ?? []) {
    if (seen.has(e.endpoint)) continue;
    seen.add(e.endpoint);
    out.push({ entry: e, suspectToken: true });
  }
  return out;
}

/**
 * 失败列表：去掉已经作为候选展示过的（`tokenRequired`），
 * 免得同一个端点出现两次、两种说法。
 */
export function failuresOf(result: DetectResult | null): DetectEntry[] {
  if (!result) return [];
  const shown = new Set((result.tokenRequired ?? []).map((e) => e.endpoint));
  return (result.failed ?? []).filter((e) => !shown.has(e.endpoint));
}
