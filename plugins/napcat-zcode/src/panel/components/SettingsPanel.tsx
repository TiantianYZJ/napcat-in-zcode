import { useEffect, useState } from 'react';
import { api, type ConfigInfo } from '../api.js';
import { modeLabel } from './Statusbar.js';

/**
 * 设置面板（**只读**）。
 *
 * 读 `napcat_get_config`：端点已脱敏、token 已被服务端换成 `'***'`。
 * 面板**只展示、不回写**：
 * - token 连 `'***'` 都不打印（面板上只说「已设置」）；
 * - 端点/token 要改只能走「未配置 / 连接失败」态的表单（那里手输，绝不拿脱敏值回填）。
 */
export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .getConfig()
      .then((c) => {
        if (alive) setCfg(c);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  // ConfigInfo 的索引签名让额外字段都是 unknown → 这里显式收敛成本面板认识的形状。
  const conn = cfg?.connection as { mode?: string; endpoint?: string; token?: string } | undefined;
  const exp = cfg?.export as { dir?: string; includeImages?: boolean } | undefined;
  const inj = cfg?.inject as { maxInjectChars?: number } | undefined;

  return (
    <div className="settings-panel" data-testid="settings-panel">
      <div className="settings-head">
        <strong>插件配置（只读）</strong>
        <button data-testid="settings-close" onClick={onClose}>
          关闭
        </button>
      </div>
      {err ? (
        <div className="err" data-testid="settings-error">
          {err}
        </div>
      ) : null}
      {cfg ? (
        <dl className="settings-list">
          <dt>连接模式</dt>
          <dd>{conn?.mode ? `${modeLabel(conn.mode)}（${conn.mode}）` : '（未知）'}</dd>
          <dt>OneBot 端点</dt>
          <dd>{conn?.endpoint || '（未设置）'}</dd>
          <dt>Token</dt>
          {/* token 一律不回显：服务端给的是 '***'，这里连 '***' 都不打印 */}
          <dd>{conn?.token ? '已设置（面板不显示明文）' : '（未设置）'}</dd>
          <dt>导出目录</dt>
          <dd>{exp?.dir === 'workspace' ? '当前工作区' : '用户目录'}</dd>
          <dt>导出含图</dt>
          <dd>{exp?.includeImages ? '是' : '否'}</dd>
          <dt>注入字符上限</dt>
          <dd>
            {typeof inj?.maxInjectChars === 'number' ? String(inj.maxInjectChars) : '（默认 40000）'}
          </dd>
        </dl>
      ) : (
        !err && <div className="empty">读取配置中…</div>
      )}
      <p className="hint">
        M1 只读展示：端点与 token 请在「未配置 / 连接失败」时的表单里修改；token 明文不会出现在面板上。
      </p>
    </div>
  );
}
