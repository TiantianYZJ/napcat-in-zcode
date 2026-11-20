import { useState } from 'react';
import { api } from '../api.js';

/**
 * 未配置 OneBot 端点时的配置表单。
 *
 * 提交后调用 `napcat_configure`（服务端会校验端点形状并落盘），成功即重载面板状态。
 */
export function UnconfiguredForm({ onDone, initialEndpoint }: { onDone: () => void; initialEndpoint?: string }) {
  const [endpoint, setEndpoint] = useState(initialEndpoint ?? 'http://127.0.0.1:3000');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
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
        Token（可空）
        <input value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      <button
        disabled={busy || !endpoint}
        data-testid="connect-btn"
        onClick={async () => {
          setBusy(true);
          setErr('');
          try {
            await api.configure(endpoint, token);
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
      <p className="hint">
        在 NapCat WebUI → 网络配置中启用 HTTP Server。本机回环可不设 token；局域网监听必须设置 token。
      </p>
    </div>
  );
}
