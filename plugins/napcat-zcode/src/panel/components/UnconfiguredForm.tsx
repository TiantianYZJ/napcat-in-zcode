import { useRef, useState } from 'react';
import { api } from '../api.js';
import { LocalDetect } from './LocalDetect.js';

/**
 * 未配置 OneBot 端点时的配置表单。
 *
 * 提交后调用 `napcat_configure`（服务端会校验端点形状并落盘），成功即重载面板状态。
 *
 * **Token 的语义**（服务端 `napcat_configure`）：
 * - 留空 = **保留已保存的 token**（表单无法回填 token：服务端只回 `'***'`）。
 *   以前留空等于「清空」，用户只是改了端点就把凭据擦掉了。
 * - 想清除已保存的 token → 勾上「清除已保存的 token」。
 * - 填了新 token → 以新 token 为准（此时「清除」勾选会被忽略）。
 *
 * 排布：先说「要连哪台」（探测 + 端点），再说「凭据」（token），最后才是动作。
 * 失败与警告分开摆：错误是「做错了」，警告是「你应该知道的一件事」。
 */
export function UnconfiguredForm({
  onDone,
  onDetected,
  initialEndpoint,
}: {
  onDone: () => void;
  /** 本机探测完成（用来刷新状态条上的探测摘要）。 */
  onDetected?: () => void;
  initialEndpoint?: string;
}) {
  const [endpoint, setEndpoint] = useState(initialEndpoint ?? 'http://127.0.0.1:3000');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  /** 候选疑似需要 token 时的提示（聚焦 token 输入框的同时显示）。 */
  const [tokenHint, setTokenHint] = useState('');
  /** token 输入框（候选疑似需要 token 时要聚焦到这里）。 */
  const tokenRef = useRef<HTMLInputElement>(null);
  /** 在途闸门：连点「使用这个」不许并发发起两次 configure（会撞上换连接的竞态）。 */
  const picking = useRef(false);

  /**
   * 用户点了候选的「使用这个」。
   *
   * - **不自动填 token**：探测从不带 token，填了也是猜的；只把端点填进去。
   * - 疑似需要 token 时**聚焦 token 输入框**并给出提示：让用户知道该往哪儿填。
   */
  const pickCandidate = async (ep: string, suspectToken: boolean): Promise<void> => {
    if (picking.current) return;
    picking.current = true;
    setEndpoint(ep);
    setErr('');
    if (suspectToken) {
      setTokenHint('该端点可能需要 access token：请在下方填入 access token 后再连接');
      tokenRef.current?.focus();
    }
    try {
      const r = await api.configure(ep, '');
      if (r.warning) setWarn(r.warning);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      picking.current = false;
    }
  };

  return (
    <div className="setup" data-testid="setup-form">
      <h2>连接 NapCat</h2>
      <LocalDetect onPick={(ep, suspect) => void pickCandidate(ep, suspect)} onDetected={onDetected} />
      <label>
        OneBot 端点
        <input
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="http://127.0.0.1:3000 或 ws://127.0.0.1:3001"
        />
      </label>
      <label>
        Token（留空 = 保留已保存的 token）
        {/* token 是凭据：输入框不回显（type=password），不落在明文 DOM 里 */}
        <input
          ref={tokenRef}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="已保存的 token 会被保留"
        />
      </label>
      {tokenHint && (
        <div className="warn" data-testid="token-hint">
          {tokenHint}
        </div>
      )}
      <label className="inline">
        <input
          type="checkbox"
          checked={clearToken}
          disabled={token.trim() !== ''}
          onChange={(e) => setClearToken(e.target.checked)}
          data-testid="clear-token"
        />
        清除已保存的 token
      </label>
      <button
        className="btn primary"
        disabled={busy || !endpoint}
        data-testid="connect-btn"
        onClick={async () => {
          setBusy(true);
          setErr('');
          setWarn('');
          try {
            const r = await api.configure(
              endpoint,
              token,
              clearToken && token.trim() === '',
            );
            // 服务端的非回环 + 无 token 警告：不是错误，但要让人看见
            if (r.warning) setWarn(r.warning);
            onDone();
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? '连接中…' : '连接'}
      </button>
      {err && (
        <div className="err" data-testid="setup-error">
          {err}
        </div>
      )}
      {warn && (
        <div className="warn" data-testid="setup-warning">
          {warn}
        </div>
      )}
      <p className="hint">
        在 NapCat WebUI → 网络配置中启用 HTTP Server。本机回环可不设 token；局域网监听必须设置 token。
      </p>
    </div>
  );
}
