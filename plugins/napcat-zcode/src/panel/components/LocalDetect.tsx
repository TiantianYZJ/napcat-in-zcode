import { useEffect, useRef, useState } from 'react';
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
  const [showFailed, setShowFailed] = useState(false);
  const [adoptBusy, setAdoptBusy] = useState('');
  const [adoptNote, setAdoptNote] = useState('');
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

  /**
   * 接管并启动：登记进受管台账（不重新下载）→ 注入模式启动。
   * 启动后 OneBot 端点才活，用户回上方表单连接（或点候选的「使用这个」）。
   */
  const adoptAndStart = async (configDir: string, webuiPort?: number): Promise<void> => {
    setAdoptBusy(configDir);
    setAdoptNote('');
    try {
      const adopted = await api.adoptHost(configDir, webuiPort);
      let note = adopted.message;
      if (!('id' in adopted) || typeof adopted.id !== 'string' || adopted.id === '') {
        throw new Error('接管结果缺少安装 id。');
      }
      try {
        const started = await api.startHost(adopted.id);
        note = started.warning
          ? `${started.message} ${started.warning}`
          : `${started.message} 已在注入模式启动。`;
      } catch (startErr) {
        note = `已接管，但启动失败：${startErr instanceof Error ? startErr.message : String(startErr)}`;
      }
      setAdoptNote(note);
      onDetected?.();
    } catch (e) {
      setAdoptNote(`接管失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAdoptBusy('');
    }
  };

  const candidates = candidatesOf(result);
  const failures = failuresOf(result);

  // 打开面板就自动检测一次：新用户不用理解「要先点检测」（初次体验的关键一步）
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    void run();
  }, []);

  return (
    <div className="detect" data-testid="detect-panel">
      <div className="section-title">本机已装的 NapCat</div>
      <button className="btn" data-testid="detect-btn" disabled={busy} onClick={() => void run()}>
        {busy ? '检测中…' : '重新检测'}
      </button>
      {err && (
        <div className="detect-budget" data-testid="detect-error">
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
              <div className="empty-title">没有找到正在运行的 NapCat</div>
              <div className="empty-desc">启动 NapCat 后重新检测，或到 NapCat 页安装一个</div>
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
                    <span className="badge warn" data-testid={`detect-token-badge-${i}`}>
                      {tokenBadge(c.entry.endpoint)}
                    </span>
                  )}
                  {c.entry.error && <span className="detail">{c.entry.error}</span>}
                  <button
                    className="btn"
                    data-testid={`detect-use-${i}`}
                    onClick={() => onPick(c.entry.endpoint, c.suspectToken)}
                  >
                    使用这个
                  </button>
                </div>
              ))}
            </div>
          )}
          {failures.length > 0 && (
            <div className="detect-failed" data-testid="detect-failed">
              {/* 默认只给一行摘要：失败端点逐个摆出来全是噪音 */}
              <button
                className="detect-failed-toggle"
                data-testid="detect-failed-toggle"
                onClick={() => setShowFailed((v) => !v)}
              >
                {showFailed
                  ? '收起失败的地址'
                  : `${failures.length} 个地址没有响应，NapCat 可能没有运行`}
              </button>
              {showFailed &&
                failures.map((f, i) => (
                  <div className="detect-fail" key={`${f.endpoint}-${i}`} data-testid={`detect-fail-${i}`}>
                    {/*
                      超时（目标在那儿但不答话）与其它失败是**两回事**，不能合并成一句。
                      其它失败里既有「根本连不上」，也有「连上了但被拒绝（鉴权/无权限）」——
                      后者可能因裁剪没进 tokenRequired，所以措辞要**同时覆盖两种**。
                    */}
                    <span className="label">{f.unresponsive === true ? '连接超时' : '无法连接'}</span>
                    <span className="ep">{f.endpoint}</span>
                    {f.error && <span className="detail">{f.error}</span>}
                  </div>
                ))}
            </div>
          )}
          {(result.installs ?? []).length > 0 && (
            <div className="detect-installs" data-testid="detect-installs">
              <div className="detect-installs-title">检测到本机安装，可以接管后直接启动</div>
              {result.installs.map((inst, i) => (
                <div className="detect-install" key={`${inst.configDir}-${i}`} data-testid={`detect-install-${i}`}>
                  <div className="detect-install-info">
                    <span className="ep mono">{inst.configDir}</span>
                    {typeof inst.webuiPort === 'number' && (
                      <span className="port tabular">WebUI {inst.webuiPort}</span>
                    )}
                  </div>
                  <button
                    className="btn"
                    data-testid={`detect-adopt-${i}`}
                    disabled={adoptBusy !== ''}
                    title="登记这个安装，然后用注入模式启动"
                    onClick={() => void adoptAndStart(inst.configDir, inst.webuiPort)}
                  >
                    {adoptBusy === inst.configDir ? '启动中…' : '接管并启动'}
                  </button>
                </div>
              ))}
              {adoptNote && (
                <div className="detect-adopt-note" data-testid="detect-adopt-note">
                  {adoptNote}
                </div>
              )}
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
