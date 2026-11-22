/*
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { HostStatusResult, InstallJobView } from '../src/panel/api.js';

const mocks = vi.hoisted(() => ({
  hostStatus: vi.fn(),
  installNapcat: vi.fn(),
  installStatus: vi.fn(),
  startHost: vi.fn(),
  stopHost: vi.fn(),
  uninstallHost: vi.fn(),
  qrLogin: vi.fn(),
  openLocalLink: vi.fn(),
  caps: { openLinks: true },
}));

vi.mock('../src/panel/api.js', () => ({
  api: {
    hostStatus: mocks.hostStatus,
    installNapcat: mocks.installNapcat,
    installStatus: mocks.installStatus,
    startHost: mocks.startHost,
    stopHost: mocks.stopHost,
    uninstallHost: mocks.uninstallHost,
    qrLogin: mocks.qrLogin,
  },
  bridge: {
    capabilities: mocks.caps,
    openLocalLink: mocks.openLocalLink,
  },
}));

import { HostPanel } from '../src/panel/components/HostPanel.js';

const install = {
  id: 'napcat-test',
  version: '4.18.42',
  mode: 'inject',
  installedAt: '2026-11-21T00:00:00.000Z',
  artifactSha256: 'a'.repeat(64),
  dir: 'D:\\NapCat',
};

function result(overrides: Partial<HostStatusResult> = {}): HostStatusResult {
  return {
    installs: [],
    status: [],
    jobs: [],
    versions: ['4.18.42'],
    ...overrides,
  };
}

function hostState(
  state: 'stopped' | 'running' | 'unknown' = 'stopped',
  overrides: Record<string, unknown> = {},
): HostStatusResult {
  return result({
    installs: [install],
    status: [{ state, install, ...overrides } as HostStatusResult['status'][number]],
  });
}

beforeEach(() => {
  mocks.hostStatus.mockReset();
  mocks.installNapcat.mockReset();
  mocks.installStatus.mockReset();
  mocks.startHost.mockReset();
  mocks.stopHost.mockReset();
  mocks.uninstallHost.mockReset();
  mocks.qrLogin.mockReset();
  mocks.qrLogin.mockResolvedValue({ phase: 'waiting', message: '请用手机 QQ 扫一扫' });
  mocks.openLocalLink.mockReset();
  mocks.caps.openLinks = true;
  mocks.hostStatus.mockResolvedValue(result());
  mocks.installNapcat.mockResolvedValue({ jobId: 'job-new', version: '4.18.42', dir: 'D:\\NapCat', mode: 'inject' });
  mocks.installStatus.mockResolvedValue({ id: 'job-old', state: 'running', phase: 'downloading', bytesReceived: 10 });
  mocks.startHost.mockResolvedValue({ started: true, pid: 42, mode: 'inject', message: 'started' });
  mocks.stopHost.mockResolvedValue({ stopped: true, message: 'stopped' });
  mocks.uninstallHost.mockResolvedValue({ uninstalled: true, id: 'napcat-test', dir: 'D:\\NapCat', alreadyGone: false, message: 'ok' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('HostPanel', () => {
  it('recovers the latest in-progress install job when the panel mounts', async () => {
    const job: InstallJobView = {
      id: 'job-old',
      startedAt: '2026-11-21T00:00:00.000Z',
      state: 'running',
      phase: 'downloading',
      bytesReceived: 2048,
      totalBytes: 4096,
      percent: 50,
    };
    mocks.hostStatus.mockResolvedValue(result({ jobs: [job] }));
    render(<HostPanel />);

    expect(await screen.findByTestId('host-job')).toBeTruthy();
    expect(screen.getByTestId('host-job').textContent).toContain('50%');
    expect(screen.queryByTestId('host-empty')).toBeNull();
  });

  it('starts an installed instance with its registered mode and blocks an external port conflict', async () => {
    mocks.hostStatus.mockResolvedValue(hostState('stopped'));
    render(<HostPanel />);
    await screen.findByTestId('host-start');
    fireEvent.click(screen.getByTestId('host-start'));
    await waitFor(() => expect(mocks.startHost).toHaveBeenCalledWith('napcat-test'));
    expect(mocks.startHost).toHaveBeenCalledTimes(1);

    cleanup();
    mocks.hostStatus.mockResolvedValue(hostState('unknown', { message: '外部实例占用端口' }));
    render(<HostPanel />);
    const start = await screen.findByTestId('host-start') as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toContain('外部实例占用');
  });

  it('requires a second confirmation before stopping an instance', async () => {
    mocks.hostStatus.mockResolvedValue(hostState('running'));
    render(<HostPanel />);
    fireEvent.click(await screen.findByTestId('host-stop'));
    expect(mocks.stopHost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('host-stop-confirm'));
    await waitFor(() => expect(mocks.stopHost).toHaveBeenCalledWith('napcat-test'));
  });

  it('sends installation mode and proxy only to napcat_install', async () => {
    render(<HostPanel />);
    fireEvent.change(await screen.findByTestId('host-mode'), { target: { value: 'inject' } });
    fireEvent.change(screen.getByTestId('host-proxy'), { target: { value: 'http://127.0.0.1:7897' } });
    fireEvent.click(screen.getByTestId('host-install-btn'));
    await waitFor(() =>
      expect(mocks.installNapcat).toHaveBeenCalledWith({ mode: 'inject', proxy: 'http://127.0.0.1:7897' }),
    );
    expect(mocks.startHost).not.toHaveBeenCalled();
  });

  it('opens WebUI only when the host advertises openLinks', async () => {
    mocks.hostStatus.mockResolvedValue(
      hostState('running', { webuiPort: 6099, webuiReachable: true }),
    );
    render(<HostPanel />);
    const button = await screen.findByTestId('host-open-webui');
    fireEvent.click(button);
    await waitFor(() => expect(mocks.openLocalLink).toHaveBeenCalledWith('http://127.0.0.1:6099'));
  });

  it('uninstall requires a second confirmation and then removes the managed install', async () => {
    mocks.hostStatus
      .mockResolvedValueOnce(hostState('stopped'))
      .mockResolvedValueOnce(result()); // 卸载成功后的刷新：台账空
    render(<HostPanel />);
    fireEvent.click(await screen.findByTestId('host-uninstall'));
    // 确认文案点名安装目录（不可恢复）
    expect(screen.getByTestId('host-uninstall-text').textContent).toContain('D:\\NapCat');
    expect(mocks.uninstallHost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('host-uninstall-confirm'));
    await waitFor(() => expect(mocks.uninstallHost).toHaveBeenCalledWith('napcat-test'));
    expect(mocks.stopHost).not.toHaveBeenCalled(); // 已停止 → 不需要组合停止
    await waitFor(() => expect(screen.queryByTestId('host-card')).toBeNull());
  });

  it('uninstall on a running instance stops first, then uninstalls', async () => {
    mocks.hostStatus.mockResolvedValue(hostState('running'));
    render(<HostPanel />);
    fireEvent.click(await screen.findByTestId('host-uninstall'));
    // 运行中的确认文案要说明「先停止再卸载」
    expect(screen.getByTestId('host-uninstall-text').textContent).toContain('先停止再卸载');
    fireEvent.click(screen.getByTestId('host-uninstall-confirm'));
    await waitFor(() => expect(mocks.stopHost).toHaveBeenCalledWith('napcat-test'));
    await waitFor(() => expect(mocks.uninstallHost).toHaveBeenCalledWith('napcat-test'));
    // 顺序：stop 先于 uninstall
    const stopAt = mocks.stopHost.mock.invocationCallOrder[0];
    const uninstallAt = mocks.uninstallHost.mock.invocationCallOrder[0];
    expect(stopAt).toBeLessThan(uninstallAt);
  });

  it('shows a QR-login guide while running without a login, with a masked token hint', async () => {
    mocks.hostStatus.mockResolvedValue(
      hostState('running', { webuiPort: 6099, webuiReachable: true }),
    );
    render(<HostPanel />);
    const guide = await screen.findByTestId('host-login-guide');
    expect(guide.textContent).toContain('扫码登录 QQ');
    expect(guide.textContent).toContain('webui.json');
    // 掩码可展示、明文绝不出现
    expect(guide.textContent).not.toMatch(/webuiToken=|token:["']/i);
    fireEvent.click(screen.getByTestId('guide-open-webui'));
    await waitFor(() => expect(mocks.openLocalLink).toHaveBeenCalledWith('http://127.0.0.1:6099'));
    // 登录之后（hostStatus 返回 login）引导卡消失
    cleanup();
    mocks.hostStatus.mockResolvedValue(
      hostState('running', { webuiPort: 6099, webuiReachable: true, login: { user_id: '1', nickname: '已登录' } }),
    );
    render(<HostPanel />);
    await screen.findByTestId('host-card');
    expect(screen.queryByTestId('host-login-guide')).toBeNull();
  });

  it('guide open button is disabled with a reason when openLinks is unsupported', async () => {
    mocks.caps.openLinks = false;
    mocks.hostStatus.mockResolvedValue(
      hostState('running', { webuiPort: 6099, webuiReachable: true }),
    );
    render(<HostPanel />);
    const openBtn = (await screen.findByTestId('guide-open-webui')) as HTMLButtonElement;
    expect(openBtn.disabled).toBe(true);
    expect(openBtn.title).toContain('不支持打开网页');
    // 刷新按钮不受 openLinks 影响（用户手动确认登录后可以刷新）
    const refreshBtn = screen.getByTestId('guide-refresh') as HTMLButtonElement;
    expect(refreshBtn.disabled).toBe(false);
  });

  it('auto-starts a finished install when no other instance is running', async () => {
    mocks.hostStatus.mockResolvedValue(
      result({
        installs: [install],
        status: [{ state: 'stopped', install }],
        jobs: [
          {
            id: 'job-done',
            startedAt: '2026-11-22T00:00:00.000Z',
            state: 'succeeded',
            phase: 'done',
            bytesReceived: 1,
            install,
          },
        ],
      }),
    );
    render(<HostPanel />);
    await waitFor(() => expect(mocks.startHost).toHaveBeenCalledWith('napcat-test'));
    expect(mocks.startHost).toHaveBeenCalledTimes(1);
  });

  it('does not auto-start when another instance is already running, and says why', async () => {
    const adopted = { ...install, id: 'napcat-adopted', version: '0.0.1' };
    mocks.hostStatus.mockResolvedValue(
      result({
        installs: [adopted, install],
        status: [
          // 用户自己的实例在跑（端口被占 = unknown）
          { state: 'unknown', install: adopted, message: '端口被占用' },
          // 新装的还没启动
          { state: 'stopped', install },
        ],
        jobs: [
          {
            id: 'job-done',
            startedAt: '2026-11-22T00:00:00.000Z',
            state: 'succeeded',
            phase: 'done',
            bytesReceived: 1,
            install,
          },
        ],
      }),
    );
    render(<HostPanel />);
    await screen.findByTestId('autostart-skipped');
    // 不自动启动：两个进程会抢端口
    expect(mocks.startHost).not.toHaveBeenCalled();
  });

  it('shows a QR-login stepper and finishes with a link to the records tab', async () => {
    const onRecords = vi.fn();
    mocks.qrLogin.mockResolvedValue({
      phase: 'waiting',
      message: '请用手机 QQ 扫一扫',
      qrDataUrl: 'data:image/gif;base64,AAAA',
    });
    mocks.hostStatus.mockResolvedValue(
      result({
        installs: [install],
        status: [{ state: 'running', install }],
        jobs: [
          {
            id: 'job-done',
            startedAt: '2026-11-22T00:00:00.000Z',
            state: 'succeeded',
            phase: 'done',
            bytesReceived: 1,
            install,
          },
        ],
      }),
    );
    render(<HostPanel onOpenRecords={onRecords} />);
    // 步进条：桌面 QQ 没在跑 → 第 0 步已完成，第 1 步（扫码）是当前
    await waitFor(() => expect(screen.getByTestId('qr-steps')).toBeTruthy());
    expect(screen.getByTestId('qr-step-0').getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('qr-step-1').getAttribute('data-state')).toBe('now');

    // 登录成功后：给出「去看聊天记录」出口与 OneBot 已开启的提示
    // （面板每 2 秒轮询一次 → 等待窗口要大于轮询间隔）
    mocks.qrLogin.mockResolvedValue({ phase: 'logined', message: '登录成功', onebotEnabled: true });
    await waitFor(() => expect(screen.getByTestId('qr-onebot-ok')).toBeTruthy(), { timeout: 4000 });
    fireEvent.click(screen.getByTestId('qr-open-records'));
    expect(onRecords).toHaveBeenCalledTimes(1);
  });
});
