/**
 * @vitest-environment jsdom
 */
/**
 * 最终修复波的面板用例（MF-2 表单语义 / MF-5 警告展示 / should-fix #8 密码框）。
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
      // 工厂里不能引用顶层变量（vi.mock 会被提升到文件顶部）→ 能力集就地写死
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
      search: mock.search,
      formatSelection: mock.formatSelection,
      exportSel: mock.exportSel,
      getConfig: mock.getConfig,
    },
  };
});

import { App } from '../src/panel/App.js';
import { mergeOlder } from '../src/panel/App.js';

afterEach(cleanup);

beforeEach(() => {
  mock.handshake.mockReset();
  mock.status.mockReset();
  mock.listChats.mockReset();
  mock.getHistory.mockReset();
  mock.configure.mockReset();
  mock.getConfig.mockReset();
  mock.handshake.mockResolvedValue(ALL_CAPS);
  mock.status.mockResolvedValue({
    configured: true,
    connected: true,
    mode: 'external',
    login: { nickname: '小明', user_id: '1' },
  });
  mock.listChats.mockImplementation(async (kind: string) =>
    kind === 'group' ? { chats: [{ kind: 'group', id: '1', name: '产品群' }] } : { chats: [] },
  );
  mock.getHistory.mockResolvedValue({ messages: [], nextBeforeSeq: null, exhausted: true });
  mock.getConfig.mockResolvedValue({
    connection: { mode: 'external', endpoint: 'http://127.0.0.1:3000', token: '***' },
    export: { dir: 'user', includeImages: false },
    inject: { maxInjectChars: 40000 },
  });
  mock.configure.mockResolvedValue({ configured: true, connected: true });
});

async function mount(): Promise<void> {
  await act(async () => {
    render(<App />);
  });
}

describe('MF-5：状态条展示安全警告', () => {
  it('status 带 warning 时状态条上出现警告', async () => {
    mock.status.mockResolvedValue({
      configured: true,
      connected: true,
      mode: 'external',
      login: { nickname: '小明' },
      warning: '端点不在本机（192.168.1.10:3000）且未设置 token',
    });
    await mount();
    const el = await screen.findByTestId('status-warning');
    expect(el.textContent).toContain('192.168.1.10:3000');
  });

  it('没有 warning 时不出现警告元素', async () => {
    await mount();
    await screen.findByTestId('statusbar');
    expect(screen.queryByTestId('status-warning')).toBeNull();
  });
});

describe('MF-2 / should-fix #8：配置表单的 token 语义', () => {
  it('token 输入框是密码框（凭据不明文显示）', async () => {
    mock.status.mockResolvedValue({ configured: false, connected: false, mode: 'unconfigured' });
    await mount();
    await screen.findByTestId('setup-form');
    const tokenInput = document.querySelector('input[type="password"]');
    expect(tokenInput).not.toBeNull();
    // 端点输入框仍是普通文本框（只有凭据是密码框）
    const endpointInput = screen.getByPlaceholderText('http://127.0.0.1:3000 或 ws://127.0.0.1:3001');
    expect(endpointInput.getAttribute('type')).not.toBe('password');
  });

  it('留空 token 时不传 clearToken（服务端语义：留空 = 保留已存的 token）', async () => {
    mock.status.mockResolvedValue({ configured: false, connected: false, mode: 'unconfigured' });
    await mount();
    await screen.findByTestId('setup-form');
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-btn'));
    });
    await waitFor(() => expect(mock.configure).toHaveBeenCalled());
    expect(mock.configure).toHaveBeenCalledWith('http://127.0.0.1:3000', '', false);
  });

  it('勾上「清除已保存的 token」且 token 留空 → clearToken=true', async () => {
    mock.status.mockResolvedValue({ configured: false, connected: false, mode: 'unconfigured' });
    await mount();
    await screen.findByTestId('setup-form');
    await act(async () => {
      fireEvent.click(screen.getByTestId('clear-token'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-btn'));
    });
    await waitFor(() => expect(mock.configure).toHaveBeenCalled());
    expect(mock.configure).toHaveBeenCalledWith('http://127.0.0.1:3000', '', true);
  });

  it('填了新 token 时以新 token 为准（clearToken 被忽略）', async () => {
    mock.status.mockResolvedValue({ configured: false, connected: false, mode: 'unconfigured' });
    await mount();
    await screen.findByTestId('setup-form');
    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(tokenInput, { target: { value: 'new-token' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-btn'));
    });
    await waitFor(() => expect(mock.configure).toHaveBeenCalled());
    expect(mock.configure).toHaveBeenCalledWith('http://127.0.0.1:3000', 'new-token', false);
  });

  it('服务端的 warning 会在表单上显示出来', async () => {
    mock.status.mockResolvedValue({ configured: false, connected: false, mode: 'unconfigured' });
    mock.configure.mockResolvedValue({
      configured: true,
      connected: true,
      warning: '端点不在本机（192.168.1.10:3000）且未设置 token',
    });
    await mount();
    await screen.findByTestId('setup-form');
    await act(async () => {
      fireEvent.click(screen.getByTestId('connect-btn'));
    });
    const el = await screen.findByTestId('setup-warning');
    expect(el.textContent).toContain('token');
  });
});

describe('should-fix #5：跨调用去重键与服务端同构', () => {
  const m = (id: string, seq: number) => ({
    id,
    seq,
    time: 1700000000,
    senderId: '2',
    senderName: 'A',
    segments: [],
    text: id,
  });

  it('有 message_seq 的消息按 s 前缀去重（重复的边界消息不重复出现）', () => {
    const { merged, added } = mergeOlder([m('1', 5)], [m('1', 5)]);
    expect(added).toBe(0);
    expect(merged).toHaveLength(1);
  });

  it('没有 message_seq 的消息按 i 前缀去重（id 相同即同一条）', () => {
    const { merged, added } = mergeOlder([m('7', 0)], [m('7', 0)]);
    expect(added).toBe(0);
    expect(merged).toHaveLength(1);
  });

  it('两个不同编号空间的消息不会被误判成同一条', () => {
    // 一条 message_id=9（没有 message_seq → seq=0），一条 message_seq=9（seq=9）
    const { merged, added } = mergeOlder([m('A', 0)], [m('B', 9)]);
    expect(added).toBe(1);
    expect(merged).toHaveLength(2);
  });
});
