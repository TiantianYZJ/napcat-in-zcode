import { useCallback, useEffect, useRef, useState } from 'react';
import { api, bridge, type HostStatus, type HostStatusResult, type InstallJobView } from '../api.js';

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
      return { text: '未开 OneBot', cls: 'warn' };
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

export function HostPanel({ onChanged }: { onChanged?: () => void }) {
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
    <div className="detect" data-testid="host-panel">
      <div className="section-title">受管宿主（插件自己下载安装的 NapCat）</div>

      {installs.length === 0 && !job && (
        <div className="detect-notfound" data-testid="host-empty">
          还没装过 NapCat。装好之后就能在这里一键启动 / 停止，不用再手动敲命令。
        </div>
      )}

      {statuses.map((s) => {
        const badge = stateBadge(s.state);
        const id = s.install?.id;
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
            {s.install?.dir && <div className="host-dir">{s.install.dir}</div>}
            {s.message && <div className="host-msg">{s.message}</div>}
            {s.login && (
              <div className="host-msg">
                已登录：{s.login.nickname}（{s.login.user_id}）
              </div>
            )}
            <div className="host-acts">
              {s.state === 'running' || s.state === 'starting' || s.state === 'degraded' ? (
                <button
                  className="btn danger"
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
              {s.webuiPort && s.webuiReachable && (
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
            {s.onebotPort && (
              <div className="host-msg" data-testid="host-onebot-endpoint">
                OneBot：{s.onebotPortReachable ? '已监听' : '未监听'} · 127.0.0.1:{s.onebotPort}
              </div>
            )}
            {s.state === 'running' && !s.login && s.webuiPort && (
              <div className="host-login-guide" data-testid="host-login-guide">
                <div className="guide-title">还没有登录 QQ</div>
                <div className="host-msg">
                  NapCat 已启动，但还没有登录 QQ（拉取消息要先登录）。打开 WebUI →「QQ 登录」页，用手机 QQ
                  扫码登录。
                </div>
                <div className="host-acts">
                  <button
                    className="btn primary"
                    data-testid="guide-open-webui"
                    disabled={!bridge.capabilities.openLinks || busy !== ''}
                    title={
                      bridge.capabilities.openLinks
                        ? '在默认浏览器打开本机 NapCat WebUI'
                        : '宿主不支持打开外部链接'
                    }
                    onClick={() =>
                      void run('open-webui', () => bridge.openLocalLink(`http://127.0.0.1:${s.webuiPort}`))
                    }
                  >
                    打开 WebUI 扫码
                  </button>
                  <button
                    className="btn"
                    data-testid="guide-refresh"
                    disabled={busy !== ''}
                    onClick={() => void refresh()}
                  >
                    我已登录，刷新状态
                  </button>
                </div>
                {s.install?.dir && (
                  <div className="host-msg" data-testid="host-login-token-hint">
                    登录 WebUI 需要访问令牌：插件已把随机令牌写在安装目录的
                    <code>webui.json</code>
                    里（面板不回显明文{(() => {
                      const masked = s.install?.webuiTokenMasked;
                      return masked ? `；掩码 ${masked}，可用来核对` : '';
                    })()}
                    ）。
                  </div>
                )}
              </div>
            )}
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
              {job.state === 'running' ? '正在安装 NapCat' : job.state === 'succeeded' ? '安装完成' : '安装失败'}
            </span>
            <span className={`badge ${job.state === 'succeeded' ? 'ok' : job.state === 'failed' ? 'bad' : ''}`}>
              {PHASE_TEXT[job.phase] ?? job.phase}
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
                  ? `已下载 ${formatBytes(job.bytesReceived)}（服务器没声明总大小）`
                  : `${job.percent}% · ${formatBytes(job.bytesReceived)} / ${formatBytes(job.totalBytes ?? 0)}`}
              </div>
            </>
          )}
          {job.error && <div className="host-warn">{job.error}</div>}
          {(job.notes ?? []).map((n, i) => (
            <div className="host-msg" key={`${i}-${n}`}>
              {n}
            </div>
          ))}
        </div>
      )}

      {!job || job.state !== 'running' ? (
        <div className="host-card" data-testid="host-install">
          <div className="host-head">
            <span className="host-name">下载并安装 NapCat</span>
          </div>
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
          {startMode === 'inject' && (
            <div className="host-warn" data-testid="host-inject-warning">
              注入模式可能触发 QQ 完整性检查并导致「文件已损坏」错误。安装前请确认兼容性。
            </div>
          )}
          <label className="host-msg">
            安装目录（留空 = 插件数据目录）
            <input
              type="text"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder="D:\\NapCat"
              data-testid="host-dir"
            />
          </label>
          <label className="host-msg">
            下载代理（可留空；本机 github 直连不通时填 http://127.0.0.1:7897）
            <input
              type="text"
              value={proxy}
              onChange={(e) => setProxy(e.target.value)}
              placeholder="http://127.0.0.1:7897"
              data-testid="host-proxy"
            />
          </label>
          <div className="host-acts">
            <button
              className="btn primary"
              data-testid="host-install-btn"
              disabled={busy !== ''}
              onClick={() => void install()}
            >
              {busy === 'install' ? '开始中…' : '下载并安装'}
            </button>
            <button className="btn" data-testid="host-refresh" disabled={busy !== ''} onClick={() => void refresh()}>
              刷新状态
            </button>
          </div>
          <div className="host-msg">
            制品来自归档镜像（上游已清空），sha256 已钉死，校验不过会直接丢弃。
          </div>
        </div>
      ) : null}

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
