import { useEffect, useState } from 'react';
import { api, type ConfigInfo } from '../api.js';
import { modeLabel } from './Statusbar.js';

/**
 * 设置面板。
 *
 * 绝大部分是**只读展示**：
 * 读 `napcat_get_config`：端点已脱敏、token 已被服务端换成 `'***'`。
 * 面板**只展示、不回写**：
 * - token 连 `'***'` 都不打印（面板上只说「已设置」）；
 * - 端点/token 要改只能走「未配置 / 连接失败」态的表单（那里手输，绝不拿脱敏值回填）。
 *
 * **唯一可写的一项**是「本机 NapCat 扫描路径」（`autoDetect.paths`）：
 * 此前只能手改 `config.json`，用户没有入口。
 * 保存时调 `napcat_configure`（带 `paths`）——**端点留空**表示「只更新扫描路径、
 * 不动已有连接」（用户还没配端点时也要能改路径）。
 *
 * **面板不回显已配置的路径**：服务端的 `napcat_get_config` **不返回**本机绝对路径
 * （B9：路径只给用户看，不给 agent 看；工具返回值会进 agent 的上下文）。
 * 面板只显示**条数**（`autoDetect.pathsCount`），路径内容以**用户自己填的**为准
 * （由 App 记住，见 `pathsText`）。
 */
export function SettingsPanel({
  onClose,
  pathsText,
  onPathsText,
}: {
  onClose: () => void;
  /** 扫描路径输入框的内容（**面板自己记着**，不是从工具回读的）。 */
  pathsText: string;
  onPathsText: (value: string) => void;
}) {
  const [cfg, setCfg] = useState<ConfigInfo | null>(null);
  const [err, setErr] = useState('');
  const [pathsSaving, setPathsSaving] = useState(false);
  const [pathsMsg, setPathsMsg] = useState('');
  const [pathsErr, setPathsErr] = useState('');

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
  /** 已配置的扫描路径**条数**（路径本身服务端不返回，见文件头注释）。 */
  const auto = cfg?.autoDetect as { pathsCount?: number } | undefined;
  const pathsCount = typeof auto?.pathsCount === 'number' ? auto.pathsCount : undefined;

  /** 保存扫描路径（每行一个路径）。 */
  const savePaths = async (): Promise<void> => {
    const paths = pathsText
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s !== '');
    setPathsSaving(true);
    setPathsErr('');
    setPathsMsg('');
    try {
      // 端点留空 = 只更新扫描路径，不动已有连接（服务端语义）。
      // token 传空串 = 保留已保存的 token（服务端语义，面板不碰凭据）。
      const r = await api.configure('', '', undefined, paths);
      const saved = r.paths ?? paths;
      // 空 = 清空全部：明确说出来（别让它变成一次无声的配置变更）
      setPathsMsg(
        saved.length === 0
          ? '已清空全部扫描路径（下次检测生效）'
          : `已保存 ${saved.length} 条扫描路径（下次检测生效）`,
      );
    } catch (e) {
      setPathsErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPathsSaving(false);
    }
  };

  return (
    <div className="settings-panel" data-testid="settings-panel">
      <div className="settings-head">
        <strong>插件配置</strong>
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
      <div className="settings-paths">
        <label htmlFor="paths-input">本机 NapCat 扫描路径（每行一个绝对路径）</label>
        {pathsCount !== undefined && (
          <div className="paths-count" data-testid="paths-count">
            当前已配置 {pathsCount} 条扫描路径
          </div>
        )}
        <textarea
          id="paths-input"
          data-testid="paths-input"
          rows={3}
          value={pathsText}
          placeholder={'D:\\NapCat\nD:\\QQChatExporter'}
          onChange={(e) => onPathsText(e.target.value)}
        />
        {/*
          **配置没加载完不许保存**：那时输入框还是空的（内容由 App 记住，
          面板自己也不知道已配置了几条）→ 早点一下就会把 autoDetect.paths 清空。
        */}
        <button
          data-testid="paths-save"
          disabled={pathsSaving || cfg === null}
          onClick={() => void savePaths()}
        >
          {pathsSaving ? '保存中…' : '保存扫描路径'}
        </button>
        {pathsMsg && (
          <div className="ok" data-testid="paths-msg">
            {pathsMsg}
          </div>
        )}
        {pathsErr && (
          <div className="err" data-testid="paths-error">
            {pathsErr}
          </div>
        )}
      </div>
      <p className="hint">
        端点与 token 请在「未配置 / 连接失败」时的表单里修改；token 明文不会出现在面板上。
        扫描路径必须是绝对路径（相对路径会随工作目录变化）。保存会**替换**全部已配置路径
        （留空 = 清空）；面板不回显已配置的路径，避免把本机绝对路径交给工具。
      </p>
    </div>
  );
}
