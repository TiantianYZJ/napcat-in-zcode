/**
 * @vitest-environment jsdom
 */
/**
 * M2 最终修复波（面板侧）的用例。
 *
 * - F2：设置面板的「当前已配置 N 条扫描路径」必须**随保存变化**
 *   （否则面板上会并排出现「已保存 1 条扫描路径」与「当前已配置 0 条扫描路径」的自相矛盾）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const ALL_CAPS = { message: true, updateModelContext: true, downloadFile: true, serverTools: true };

const mock = vi.hoisted(() => ({
  handshake: vi.fn(),
  status: vi.fn(),
  listChats: vi.fn(),
  getHistory: vi.fn(),
  configure: vi.fn(),
  detectLocal: vi.fn(),
  search: vi.fn(),
  formatSelection: vi.fn(),
  exportSel: vi.fn(),
  getConfig: vi.fn(),
  uiMessage: vi.fn(),
  updateModelContext: vi.fn(),
  downloadFile: vi.fn(),
  writeClipboard: vi.fn(),
}));

vi.mock('../src/panel/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/panel/api.js')>();
  return {
    ...actual,
    handshake: mock.handshake,
    bridge: {
      capabilities: { message: true, updateModelContext: true, downloadFile: true, serverTools: true },
      uiMessage: mock.uiMessage,
      updateModelContext: mock.updateModelContext,
      downloadFile: mock.downloadFile,
      writeClipboard: mock.writeClipboard,
    },
    api: {
      status: mock.status,
      listChats: mock.listChats,
      getHistory: mock.getHistory,
      configure: mock.configure,
      detectLocal: mock.detectLocal,
      search: mock.search,
      formatSelection: mock.formatSelection,
      exportSel: mock.exportSel,
      getConfig: mock.getConfig,
    },
  };
});

import { App } from '../src/panel/App.js';

afterEach(cleanup);

/** 「服务端」当前记住的扫描路径条数（面板每次 getConfig 都按它回答）。 */
let serverPathsCount = 0;

beforeEach(() => {
  mock.handshake.mockReset();
  mock.status.mockReset();
  mock.listChats.mockReset();
  mock.getHistory.mockReset();
  mock.configure.mockReset();
  mock.detectLocal.mockReset();
  mock.getConfig.mockReset();
  mock.uiMessage.mockReset();
  mock.updateModelContext.mockReset();
  mock.downloadFile.mockReset();
  mock.writeClipboard.mockReset();

  serverPathsCount = 0;
  mock.handshake.mockResolvedValue(ALL_CAPS);
  mock.status.mockResolvedValue({ configured: true, connected: true, mode: 'external' });
  mock.listChats.mockResolvedValue({ chats: [] });
  mock.getHistory.mockResolvedValue({ messages: [], nextBeforeSeq: null, exhausted: true });
  mock.detectLocal.mockResolvedValue({
    found: false,
    candidates: [],
    live: [],
    failed: [],
    tokenRequired: [],
    napcatRunning: false,
    scanned: { ports: [], paths: [], extraEndpoints: 0 },
    notes: [],
    installs: [],
    droppedEndpoints: [],
  });
  mock.getConfig.mockImplementation(async () => ({
    connection: { mode: 'external', endpoint: 'http://127.0.0.1:3000', token: '***' },
    export: { dir: 'user', includeImages: false },
    inject: { maxInjectChars: 40000 },
    autoDetect: { ports: [3000], endpoints: [], pathsCount: serverPathsCount },
  }));
  mock.configure.mockImplementation(async (_ep: string, _tok: string, _clear?: boolean, paths?: string[]) => {
    serverPathsCount = paths?.length ?? 0;
    return { configured: true, connected: true, paths: paths ?? [] };
  });
});

async function openSettings(): Promise<void> {
  await act(async () => {
    render(<App />);
  });
  fireEvent.click(await screen.findByTestId('settings-btn'));
  await waitFor(() => expect(screen.getByTestId('settings-panel')).toBeTruthy());
}

describe('F2：扫描路径计数随保存变化', () => {
  it('保存 2 条 → 「当前已配置」从 0 变成 2（不再停在保存前的值）', async () => {
    await openSettings();
    await waitFor(() => expect(screen.getByTestId('paths-count').textContent).toContain('0'));

    const input = (await screen.findByTestId('paths-input')) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'D:\\NapCat\nD:\\QQChatExporter' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('paths-save'));
    });
    await waitFor(() => expect(screen.getByTestId('paths-msg')).toBeTruthy());
    // ← 关键：计数跟着保存变了（验收 §13.6.5）
    await waitFor(() => expect(screen.getByTestId('paths-count').textContent).toContain('2'));
    expect(screen.getByTestId('paths-count').textContent).not.toContain('当前已配置 0 条');
  });

  it('保存后重新拉一次配置（服务端是权威值）', async () => {
    await openSettings();
    const before = mock.getConfig.mock.calls.length;
    const input = (await screen.findByTestId('paths-input')) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'D:\\NapCat' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('paths-save'));
    });
    await waitFor(() => expect(screen.getByTestId('paths-msg')).toBeTruthy());
    await waitFor(() => expect(mock.getConfig.mock.calls.length).toBeGreaterThan(before));
  });

  it('保存成空 → 计数变成 0（整体替换语义）', async () => {
    serverPathsCount = 3;
    await openSettings();
    await waitFor(() => expect(screen.getByTestId('paths-count').textContent).toContain('3'));
    const input = (await screen.findByTestId('paths-input')) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('paths-save'));
    });
    await waitFor(() => expect(screen.getByTestId('paths-msg').textContent).toContain('已清空'));
    await waitFor(() => expect(screen.getByTestId('paths-count').textContent).toContain('当前已配置 0 条'));
  });
});
