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
  openLocalLink: vi.fn(),
}));

vi.mock('../src/panel/api.js', () => ({
  api: {
    hostStatus: mocks.hostStatus,
    installNapcat: mocks.installNapcat,
    installStatus: mocks.installStatus,
    startHost: mocks.startHost,
    stopHost: mocks.stopHost,
  },
  bridge: {
    capabilities: { openLinks: true },
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
  mocks.openLocalLink.mockReset();
  mocks.hostStatus.mockResolvedValue(result());
  mocks.installNapcat.mockResolvedValue({ jobId: 'job-new', version: '4.18.42', dir: 'D:\\NapCat', mode: 'inject' });
  mocks.installStatus.mockResolvedValue({ id: 'job-old', state: 'running', phase: 'downloading', bytesReceived: 10 });
  mocks.startHost.mockResolvedValue({ started: true, pid: 42, mode: 'inject', message: 'started' });
  mocks.stopHost.mockResolvedValue({ stopped: true, message: 'stopped' });
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
});
