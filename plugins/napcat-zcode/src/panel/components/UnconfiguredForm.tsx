import { useState } from 'react';
import { api } from '../api.js';

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
 */
export function UnconfiguredForm({ onDone, initialEndpoint }: { onDone: () => void; initialEndpoint?: string }) {
  const [endpoint, setEndpoint] = useState(initialEndpoint ?? 'http://127.0.0.1:3000');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [warn, setWarn] = useState('');
  return (
    <div className="setup" data-testid="setup-form">
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
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="已保存的 token 会被保留"
        />
      </label>
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
