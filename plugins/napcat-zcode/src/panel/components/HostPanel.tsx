import { useCallback, useEffect, useRef, useState } from 'react';
import { api, bridge, type HostStatus, type HostStatusResult, type InstallJobView } from '../api.js';
import { QrLogin } from './QrLogin.js';

/**
 * 受管宿主面板：**装 / 启 / 停 / 卸** NapCat。
 *
 * 三段式，一段只回答一件事：
 *
 * 1. **已装的**（插件自己下载安装的）：一张卡说清「装在哪、什么版本、在不在跑」，
 *    并给出启动 / 停止 / 卸载；跑着但没登录 QQ 时给扫码登录引导。
 * 2. **正在装的**：进度条 + 阶段文字（下载 / 校验 / 解压）。
 * 3. **还没装的**：选版本、选目录（可选代理），点「下载并安装」。
 *
 * 两条硬规矩：
 * - **不越权**：只停/卸本插件自己登记的实例；端口被别的实例占着时如实说明，不去动它。
 *   卸载只认台账 id、目录取自台账登记值；运行中先停（服务端拒绝运行中卸载）。
 * - **不静默失败**：每个按钮都给出禁用原因或失败原因；卸载必须二次确认（目录不可恢复）。
 * - **token 不出参**：WebUI 访问令牌只显示掩码，完整值留在安装目录的 webui.json。
 */

const PHASE_TEXT: Record<string, string> = {
  connecting: '正在连接下载源',
  downloading: '正在下载',
  verifying: '正在校验 sha256',
  extracting: '正在解压',
  done: '已完成',
  failed: '失败',
};

/** 状态徽章的文案与色调。 */
function stateBadge(state: HostStatus['state']): { text: string; cls: string } {
  switch (state) {
    case 'running':
      return { text: '运行中', cls: 'ok' };
    case 'starting':
      return { text: '启动中', cls: '' };
    case 'degraded':
      // 不说 OneBot —— 那是内部协议名，用户只需要知道「聊天数据还没接上」
      return { text: '聊天数据未就绪', cls: 'warn' };
    case 'unknown':
      return { text: '端口被占用', cls: 'warn' };
    case 'stopped':
      return { text: '未运行', cls: '' };
    default:
      return { text: '未安装', cls: '' };
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function hasLiveHost(statuses: HostStatus[]): boolean {
  return statuses.some((status) => ['running', 'starting', 'degraded'].includes(status.state));
}

export function HostPanel({
  onChanged,
  onOpenRecords,
}: {
  onChanged?: () => void;
  /** 登录成功后的出口：切到记录页看聊天记录。 */
  onOpenRecords?: () => void;
}) {
  const [state, setState] = useState<HostStatusResult | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [job, setJob] = useState<InstallJobView | null>(null);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  const [startMode, setStartMode] = useState<'standalone' | 'inject'>('standalone');

  // 安装表单
  const [dir, setDir] = useState('');
  const [version, setVersion] = useState('');
  const [proxy, setProxy] = useState('');

  const pollTimer = useRef<number | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const installs = state?.installs ?? [];
  const statuses = state?.status ?? [];
  const versions = state?.versions ?? [];
  const pollJobId = job?.state === 'running' ? job.id : null;
  const liveHost = hasLiveHost(statuses);
  const isStopping = busy === 'stop';

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api.hostStatus();
      setState(r);
      setJob((current) => {
        if (current?.state === 'running') return current;
        return r.jobs[r.jobs.length - 1] ?? null;
      });
      setErr('');
    } catch (e) {
      setErr(errText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 安装完成 → 自动启动 → 面板进入扫码登录流程（不用再点一次启动）。
  // 但如果**另一个** NapCat 实例已经在跑（用户自己启动的），就不自动开新的——
  // 否则会同时出现两个进程，端口也互相抢。
  const autoStartId = job?.state === 'succeeded' ? (job.install?.id ?? null) : null;
  const otherRunning = statuses.some(
    (s) =>
      s.install?.id !== autoStartId &&
      ['running', 'starting', 'degraded', 'unknown'].includes(s.state),
  );
  useEffect(() => {
    if (!autoStartId || autoStarted.has(autoStartId) || otherRunning) return;
    autoStarted.add(autoStartId);
    void run('autostart', async () => {
      await api.startHost(autoStartId);
      await refresh();
    });
  }, [autoStartId, otherRunning]);

  useEffect(() => {
    if (!pollJobId && !liveHost) return;
    let polling = false;
    pollTimer.current = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void (async () => {
        try {
          if (pollJobId) {
            const s = await api.installStatus(pollJobId);
            setJob(s);
            if (s.state !== 'running') {
              await refresh();
              onChangedRef.current?.();
            }
          } else {
            await refresh();
          }
        } catch (e) {
          setErr(errText(e));
        } finally {
          polling = false;
        }
      })();
    }, 1000);
    return () => {
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [pollJobId, refresh, liveHost]);

  const run = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy('');
    }
  };

  const install = (): Promise<void> =>
    run('install', async () => {
      const opts: { dir?: string; version?: string; proxy?: string } = {};
      if (dir.trim()) opts.dir = dir.trim();
      if (version) opts.version = version;
      if (proxy.trim()) opts.proxy = proxy.trim();
      const r = await api.installNapcat({ ...opts, mode: startMode });
      setJob({
        id: r.jobId,
        startedAt: new Date().toISOString(),
        state: 'running',
        phase: 'connecting',
        bytesReceived: 0,
      });
    });

  const confirmStopInstance = (id: string | undefined): Promise<void> =>
    run('stop', async () => {
      await api.stopHost(id);
      setConfirmStop(null);
      await refresh();
    });

  /**
   * 卸载（面板负责「先停止再卸载」的组合：服务端对运行中的实例会拒绝）。
   * 确认区已明确「目录整个删除、不可恢复」；成功后刷新并通知外层（状态条等）。
   */
  const confirmUninstallInstance = (id: string | undefined): Promise<void> =>
    run('uninstall', async () => {
      const target = state?.status.find((s) => (s.install?.id ?? '') === (id ?? ''));
      const stillRunning = target ? ['running', 'starting', 'degraded'].includes(target.state) : false;
      if (stillRunning) await api.stopHost(id);
      await api.uninstallHost(id);
      setConfirmUninstall(null);
      await refresh();
      onChangedRef.current?.();
    });

  return (
    <div className="host-page" data-testid="host-panel">
      <div className="page-title">NapCat 管理</div>
      <div className="page-desc">在这里安装 NapCat，随时启动和停止</div>

      {installs.length > 0 && (
        <div className="host-summary" data-testid="host-summary">
          {installs.length} 个安装 ·{' '}
          {statuses.filter((s) => ['running', 'starting', 'degraded'].includes(s.state)).length} 个运行中
        </div>
      )}

      <div className="page-card">
      {installs.length === 0 && !job && (
        <div className="detect-notfound" data-testid="host-empty">
          <div className="empty-title">还没有安装 NapCat</div>
          <div className="empty-desc">在下方选择版本，一键下载安装</div>
        </div>
      )}

      {statuses.map((s) => {
        const badge = stateBadge(s.state);
        const id = s.install?.id;
        /**
         * 这一屏要不要出扫码引导。
         *
         * **degraded 也要出**：没登录 QQ 时 NapCat 只起 WebUI、不开聊天数据通道
         * （状态是 degraded 而不是 running）—— 只按 running 判断的话，
         * 「已装好但还没登录」这个最常见的场景反而没有二维码。
         */
        const showGuide =
          (s.state === 'running' || s.state === 'degraded') && !s.login && s.webuiPort !== undefined;
        return (
          <div className="host-card" key={id ?? s.state} data-testid="host-card">
            <div className="host-head">
              <span className="host-name">
                NapCat {s.install?.version ?? ''} · {s.install?.mode === 'inject' ? '注入桌面 QQ' : '独立模式'}
              </span>
              <span className={`badge ${badge.cls}`} data-testid="host-state">
                {badge.text}
              </span>
            </div>
            {/* 事实网格（ZCode 的 definition grid：定宽弱标签列 + 值列），把散行收成可扫读的层次。
                安装目录是运维信息（长路径、占两行），折进「安装详情」——主线只留
                用户真正要判断的三件事：跑没跑、登录没、数据通没通。 */}
            <div className="host-grid" data-testid="host-facts">
              <span className="k">WebUI</span>
              <span className="v mono">
                {s.webuiPort
                  ? `127.0.0.1:${s.webuiPort}${s.webuiReachable ? ' · 已可达' : ' · 不可达'}`
                  : '—'}
              </span>
              <span className="k">聊天数据</span>
              <span className="v mono">
                {s.onebotPort
                  ? `127.0.0.1:${s.onebotPort}${s.onebotPortReachable ? ' · 已就绪' : ' · 未就绪'}`
                  : '—'}
              </span>
              {s.login && (
                <>
                  <span className="k">登录</span>
                  <span className="v">
                    {s.login.nickname}（<span className="mono">{s.login.user_id}</span>）
                  </span>
                </>
              )}
            </div>
            {s.install?.dir && (
              <details className="host-details" data-testid="host-details">
                <summary>安装详情</summary>
                <div className="host-grid">
                  <span className="k">目录</span>
                  <span className="v mono">{s.install.dir}</span>
                </div>
              </details>
            )}
            {s.message && <div className="host-msg">{s.message}</div>}
            {/*
              扫码引导。
              **放在运维按钮之前**：这一屏的主线是「扫码登录」，
              停止/卸载是运维动作，不该排在用户真正要做的事前面。
            */}
            {showGuide && (
              <div className="host-login-guide" data-testid="host-login-guide">
                <div className="guide-title">扫码登录 QQ</div>
                {id && (
                  <QrLogin
                    installId={id}
                    onLogined={() => {
                      void refresh();
                      onChangedRef.current?.();
                    }}
                  />
                )}
                <div className="host-acts">
                  <button
                    className="btn"
                    data-testid="guide-open-webui"
                    disabled={!bridge.capabilities.openLinks || busy !== ''}
                    title={
                      bridge.capabilities.openLinks ? '在浏览器打开 NapCat WebUI' : '当前环境不支持打开网页'
                    }
                    onClick={() =>
                      void run('open-webui', () => bridge.openLocalLink(`http://127.0.0.1:${s.webuiPort}`))
                    }
                  >
                    打开 WebUI
                  </button>
                  <button
                    className="btn"
                    data-testid="guide-refresh"
                    disabled={busy !== ''}
                    onClick={() => void refresh()}
                  >
                    刷新状态
                  </button>
                </div>
                {s.install?.dir && (
                  <div className="host-msg" data-testid="host-login-token-hint">
                    如果二维码扫不出来，也可以打开 WebUI 手动登录（令牌在安装目录的
                    <code>webui.json</code> 里）。
                  </div>
                )}
              </div>
            )}
            <div className="host-acts">
              {s.state === 'running' || s.state === 'starting' || s.state === 'degraded' ? (
                <button
                  className="btn"
                  data-testid="host-stop"
                  disabled={busy !== ''}
                  onClick={() => setConfirmStop(id ?? '')}
                >
                  停止
                </button>
              ) : (
                <button
                  className="btn primary"
                  data-testid="host-start"
                  disabled={busy !== '' || s.state === 'unknown'}
                  title={s.state === 'unknown' ? '端口被外部实例占用，已阻止启动以免产生冲突' : undefined}
                  onClick={() =>
                    void run('start', async () => {
                      await api.startHost(id);
                      await refresh();
                    })
                  }
                >
                  {busy === 'start' ? '启动中…' : '启动'}
                </button>
              )}
              {/* 扫码引导里已经有一个「打开 WebUI」，这里不再重复 */}
              {!showGuide && s.webuiPort && s.webuiReachable && (
                <button
                  className="btn"
                  data-testid="host-open-webui"
                  disabled={!bridge.capabilities.openLinks || busy !== ''}
                  title={bridge.capabilities.openLinks ? '在默认浏览器打开本机 NapCat WebUI' : '宿主不支持打开外部链接'}
                  onClick={() =>
                    void run('open-webui', () => bridge.openLocalLink(`http://127.0.0.1:${s.webuiPort}`))
                  }
                >
                  打开 WebUI
                </button>
              )}
              <button
                className="btn"
                data-testid="host-uninstall"
                disabled={busy !== ''}
                title="删除安装目录并清理台账（不可恢复）"
                onClick={() => setConfirmUninstall(id ?? '')}
              >
                卸载
              </button>
            </div>
            {confirmStop === (id ?? '') && (
              <div className="host-confirm" role="group" aria-label="确认停止 NapCat">
                <span>确认停止这个由插件启动的 NapCat 实例？</span>
                <div className="host-confirm-acts">
                  <button
                    className="btn danger"
                    data-testid="host-stop-confirm"
                    disabled={busy !== ''}
                    onClick={() => void confirmStopInstance(id)}
                  >
                    {isStopping ? '停止中…' : '确认停止'}
                  </button>
                  <button className="btn" data-testid="host-stop-cancel" disabled={busy !== ''} onClick={() => setConfirmStop(null)}>
                    取消
                  </button>
                </div>
              </div>
            )}
            {confirmUninstall === (id ?? '') && (
              <div className="host-confirm" role="group" aria-label="确认卸载 NapCat">
                <span data-testid="host-uninstall-text">
                  卸载会整个删除安装目录（不可恢复）：{s.install?.dir ?? '（未知目录）'}
                  ；WebUI 令牌等凭据一并清除。
                  {s.state === 'running' || s.state === 'starting' || s.state === 'degraded'
                    ? ' 实例正在运行，确认后会先停止再卸载。'
                    : ''}
                </span>
                <div className="host-confirm-acts">
                  <button
                    className="btn danger"
                    data-testid="host-uninstall-confirm"
                    disabled={busy !== ''}
                    onClick={() => void confirmUninstallInstance(id)}
                  >
                    {busy === 'uninstall' ? '卸载中…' : '确认卸载'}
                  </button>
                  <button
                    className="btn"
                    data-testid="host-uninstall-cancel"
                    disabled={busy !== ''}
                    onClick={() => setConfirmUninstall(null)}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {job && (
        <div className="host-card" data-testid="host-job">
          <div className="host-head">
            <span className="host-name">
              {job.state === 'running'
                ? '正在安装 NapCat'
                : job.state === 'succeeded'
                  ? busy === 'autostart'
                    ? '正在启动 NapCat…'
                    : '正在等你扫码登录'
                  : '安装失败'}
            </span>
            <span className={`badge ${job.state === 'succeeded' ? 'ok' : job.state === 'failed' ? 'bad' : ''}`}>
              {job.state === 'succeeded' && busy !== 'autostart' ? '待扫码' : PHASE_TEXT[job.phase] ?? job.phase}
            </span>
          </div>
          {job.state === 'running' && (
            <>
              <div className="progress">
                <div
                  className={`bar ${job.percent === undefined ? 'indeterminate' : ''}`}
                  style={job.percent === undefined ? undefined : { width: `${job.percent}%` }}
                />
              </div>
              <div className="host-msg">
                {job.percent === undefined
                  ? `已下载 ${formatBytes(job.bytesReceived)}`
                  : `${job.percent}% · ${formatBytes(job.bytesReceived)} / ${formatBytes(job.totalBytes ?? 0)}`}
              </div>
            </>
          )}
          {job.state === 'succeeded' && job.install?.id && busy !== 'autostart' && (
            <QrLogin
              installId={job.install.id}
              onLogined={() => {
                void refresh();
                onChangedRef.current?.();
              }}
              onOpenRecords={onOpenRecords}
            />
          )}
          {job.state === 'succeeded' && otherRunning && (
            <div className="host-msg" data-testid="autostart-skipped">
              检测到你自己的 NapCat 正在运行，就没有自动启动这个新装的——两个进程会抢端口。可以先停掉旧的再点启动，或直接去连接页连它。
            </div>
          )}
          {job.error && <div className="host-warn">{job.error}</div>}
          {/* 失败时 error 与 notes 常是同一句话；过程 notes 折进详情，不占屏 */}
          {(job.notes ?? []).filter((n) => n !== job.error).length > 0 && (
            <details className="job-notes">
              <summary>安装过程详情</summary>
              {(job.notes ?? [])
                .filter((n) => n !== job.error)
                .map((n, i) => (
                  <div className="host-msg" key={`${i}-${n}`}>
                    {n}
                  </div>
                ))}
            </details>
          )}
        </div>
      )}

      {!job || job.state !== 'running' ? (
        installs.length > 0 ? (
          // 已经装过：安装表单收起来，避免误触重复安装
          <details className="install-extra">
            <summary data-testid="install-extra-toggle">安装另一个 NapCat</summary>
            <div className="host-card" data-testid="host-install">
              <div className="host-head">
                <span className="host-name">安装 NapCat</span>
              </div>
              <div className="install-grid">
                <label className="host-msg">
                  版本
                  <select value={version} onChange={(e) => setVersion(e.target.value)} data-testid="host-version">
                    <option value="">默认（{versions[0] ?? '4.18.42'}）</option>
                    {versions.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="host-msg">
                  运行模式
                  <select value={startMode} onChange={(e) => setStartMode(e.target.value as 'standalone' | 'inject')} data-testid="host-mode">
                    <option value="standalone">独立模式（不影响桌面 QQ，推荐）</option>
                    <option value="inject">注入桌面 QQ（较新版本可能无法启动）</option>
                  </select>
                </label>
                <label className="host-msg">
                  安装目录
                  <input
                    type="text"
                    value={dir}
                    onChange={(e) => setDir(e.target.value)}
                    placeholder="默认用插件数据目录"
                    data-testid="host-dir"
                  />
                </label>
                <label className="host-msg">
                  下载代理
                  <input
                    type="text"
                    value={proxy}
                    onChange={(e) => setProxy(e.target.value)}
                    placeholder="可选，如 http://127.0.0.1:7897"
                    data-testid="host-proxy"
                  />
                </label>
              </div>
              {startMode === 'inject' && (
                <div className="host-warn" data-testid="host-inject-warning">
                  注入模式会操作桌面 QQ，较新版本可能无法启动。
                </div>
              )}
              <div className="host-acts">
                <button
                  className="btn primary"
                  data-testid="host-install-btn"
                  disabled={busy !== ''}
                  onClick={() => void install()}
                >
                  {busy === 'install' ? '安装中…' : '下载并安装'}
                </button>
                <button className="btn" data-testid="host-refresh" disabled={busy !== ''} onClick={() => void refresh()}>
                  刷新
                </button>
              </div>
            </div>
          </details>
        ) : (
          <div className="host-card" data-testid="host-install">
            <div className="host-head">
              <span className="host-name">安装 NapCat</span>
            </div>
            <div className="install-grid">
              <label className="host-msg">
                版本
                <select value={version} onChange={(e) => setVersion(e.target.value)} data-testid="host-version">
                  <option value="">默认（{versions[0] ?? '4.18.42'}）</option>
                  {versions.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className="host-msg">
                运行模式
                <select value={startMode} onChange={(e) => setStartMode(e.target.value as 'standalone' | 'inject')} data-testid="host-mode">
                  <option value="standalone">独立模式（不影响桌面 QQ，推荐）</option>
                  <option value="inject">注入桌面 QQ（较新版本可能无法启动）</option>
                </select>
              </label>
              <label className="host-msg">
                安装目录
                <input
                  type="text"
                  value={dir}
                  onChange={(e) => setDir(e.target.value)}
                  placeholder="默认用插件数据目录"
                  data-testid="host-dir"
                />
              </label>
              <label className="host-msg">
                下载代理
                <input
                  type="text"
                  value={proxy}
                  onChange={(e) => setProxy(e.target.value)}
                  placeholder="可选，如 http://127.0.0.1:7897"
                  data-testid="host-proxy"
                />
              </label>
            </div>
            {startMode === 'inject' && (
              <div className="host-warn" data-testid="host-inject-warning">
                注入模式会操作桌面 QQ，较新版本可能无法启动。
              </div>
            )}
            <div className="host-acts">
              <button
                className="btn primary"
                data-testid="host-install-btn"
                disabled={busy !== ''}
                onClick={() => void install()}
              >
                {busy === 'install' ? '安装中…' : '下载并安装'}
              </button>
              <button className="btn" data-testid="host-refresh" disabled={busy !== ''} onClick={() => void refresh()}>
                刷新
              </button>
            </div>
          </div>
        )
      ) : null}
      </div>

      {err && (
        <div className="detect-budget" data-testid="host-error">
          {err}
        </div>
      )}
    </div>
  );
}

/** 字节数的人话（KB / MB）。 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 安装完成后自动启动的**全局**去重：
 * 组件内 ref 会随页签切换重挂而重置（用户反馈「一切换宿主页就重启」），
 * 模块级 Set 跨挂载保留，一个安装只自动启动一次。
 */
const autoStarted = new Set<string>();
