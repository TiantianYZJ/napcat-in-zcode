/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const ALL_CAPS = { message: true, updateModelContext: true, downloadFile: true, serverTools: true };
const NO_CAPS = { message: false, updateModelContext: false, downloadFile: false, serverTools: false };

/** 面板 API 层（握手 + 8 个工具封装）在这里被替身掉。 */
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
}));

// 只替换「会跟宿主说话」的部分；纯函数（msgKey 等）保留真身。
vi.mock('../src/panel/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/panel/api.js')>();
  return {
    ...actual,
    handshake: mock.handshake,
    // 工厂里不能引用顶层变量（vi.mock 会被提升到文件顶部）→ 能力集就地写死。
    bridge: { capabilities: { message: true, updateModelContext: true, downloadFile: true, serverTools: true } },
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

afterEach(cleanup);

function msg(id: string, seq: number, time: number, senderName = 'Alice') {
  return {
    id,
    seq,
    time,
    senderId: senderName,
    senderName,
    segments: [{ kind: 'text', text: id }],
    text: id,
  };
}

beforeEach(() => {
  mock.handshake.mockReset();
  mock.status.mockReset();
  mock.listChats.mockReset();
  mock.getHistory.mockReset();
  mock.handshake.mockResolvedValue(ALL_CAPS);
  mock.status.mockResolvedValue({
    configured: true,
    connected: true,
    mode: 'external',
    login: { nickname: '小明', user_id: '10001' },
  });
  mock.listChats.mockImplementation(async (kind: string) =>
    kind === 'group'
      ? { chats: [{ kind: 'group', id: '1', name: '产品群' }] }
      : { chats: [{ kind: 'friend', id: '2', name: '张三' }] },
  );
  mock.getHistory.mockResolvedValue({ messages: [], nextBeforeSeq: null, exhausted: true });
});

/** 挂载 App 并把初始的异步握手/加载冲干净。 */
async function mount(): Promise<void> {
  await act(async () => {
    render(<App />);
  });
}

describe('App 状态机', () => {
  it('握手未完成时显示「正在连接宿主…」并禁用动作按钮', async () => {
    let release: (v: typeof ALL_CAPS) => void = () => {};
    mock.handshake.mockReturnValue(
      new Promise((res) => {
        release = res;
      }),
    );
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByTestId('statusbar').textContent).toContain('正在连接宿主');
    // 握手期间动作按钮必须置灰（不许静默失败）
    expect((screen.getByTestId('act-export') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('act-message') as HTMLButtonElement).disabled).toBe(true);
    release(ALL_CAPS);
    await waitFor(() => expect(screen.getByTestId('statusbar').textContent).toContain('已连接'));
  });

  it('已连接时状态条显示昵称', async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId('statusbar').textContent).toContain('已连接'));
    expect(screen.getByTestId('statusbar').textContent).toContain('小明');
  });

  it('未配置 → 显示配置表单', async () => {
    mock.status.mockResolvedValue({ configured: false, connected: false, mode: 'unconfigured' });
    await mount();
    await waitFor(() => expect(screen.getByTestId('statusbar').textContent).toContain('未配置'));
    expect(screen.getByTestId('connect-btn')).toBeTruthy();
  });

  it('未连接 → 状态条显示服务端给的错误', async () => {
    mock.status.mockResolvedValue({
      configured: true,
      connected: false,
      mode: 'external',
      error: '连接超时',
    });
    await mount();
    await waitFor(() => expect(screen.getByTestId('statusbar').textContent).toContain('连接超时'));
  });

  it('握手失败 → 报错而不是白屏', async () => {
    mock.handshake.mockRejectedValue(new Error('host bridge initialize failed'));
    await mount();
    await waitFor(() => expect(screen.getByTestId('statusbar').textContent).toContain('host bridge initialize failed'));
  });

  it('失败态可以展开「重新配置端点」表单（端点不预填，避免无声覆盖已有配置）', async () => {
    mock.status.mockResolvedValue({
      configured: true,
      connected: false,
      mode: 'external',
      error: '连接超时',
    });
    await mount();
    await waitFor(() => expect(screen.getByTestId('phase-error')).toBeTruthy());
    fireEvent.click(screen.getByTestId('reconfigure-btn'));
    await waitFor(() => expect(screen.getByTestId('setup-form')).toBeTruthy());
    expect((screen.getByTestId('connect-btn') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('App 能力降级', () => {
  it('宿主缺少能力位 → 对应按钮置灰并给出原因', async () => {
    mock.handshake.mockResolvedValue(NO_CAPS);
    await mount();
    await waitFor(() => expect(screen.getByTestId('statusbar').textContent).toContain('已连接'));

    const msgBtn = screen.getByTestId('act-message') as HTMLButtonElement;
    expect(msgBtn.disabled).toBe(true);
    expect(msgBtn.getAttribute('data-reason')).toContain('message');

    const ctxBtn = screen.getByTestId('act-context') as HTMLButtonElement;
    expect(ctxBtn.disabled).toBe(true);
    expect(ctxBtn.getAttribute('data-reason')).toContain('updateModelContext');

    const attachBtn = screen.getByTestId('act-attach') as HTMLButtonElement;
    expect(attachBtn.disabled).toBe(true);
    expect(attachBtn.getAttribute('data-reason')).toContain('downloadFile');

    const exportBtn = screen.getByTestId('act-export') as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(true);
    expect(exportBtn.getAttribute('data-reason')).toContain('serverTools');
  });

  it('能力齐备时按钮仍然置灰（占位，原因标明待实现）', async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId('statusbar').textContent).toContain('已连接'));
    const exportBtn = screen.getByTestId('act-export') as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(true);
    expect(exportBtn.getAttribute('data-reason')).toContain('T13');
  });

  it('连接中（init）相位的不可用原因是「正在连接宿主…」', async () => {
    let release: (v: typeof ALL_CAPS) => void = () => {};
    mock.handshake.mockReturnValue(
      new Promise((res) => {
        release = res;
      }),
    );
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByTestId('act-export').getAttribute('data-reason')).toContain('正在连接宿主');
    release(ALL_CAPS);
    await waitFor(() => expect(screen.getByTestId('statusbar').textContent).toContain('已连接'));
  });

  it('未配置相位的不可用原因是「尚未配置 OneBot 端点」', async () => {
    mock.status.mockResolvedValue({ configured: false, connected: false, mode: 'unconfigured' });
    await mount();
    await waitFor(() => expect(screen.getByTestId('statusbar').textContent).toContain('未配置'));
    expect(screen.getByTestId('act-export').getAttribute('data-reason')).toContain('尚未配置 OneBot 端点');
  });

  it('连接失败（error）相位的不可用原因是「连接失败」而不是「正在连接宿主」', async () => {
    mock.status.mockResolvedValue({
      configured: true,
      connected: false,
      mode: 'external',
      error: '连接超时',
    });
    await mount();
    await waitFor(() => expect(screen.getByTestId('statusbar').textContent).toContain('连接超时'));
    const reason = screen.getByTestId('act-export').getAttribute('data-reason') ?? '';
    expect(reason).toContain('连接失败');
    expect(reason).not.toContain('正在连接宿主');
  });
});

describe('App 会话与消息流', () => {
  it('点击会话载入消息；向上翻页按 seq 跨调用去重合并', async () => {
    mock.getHistory
      .mockResolvedValueOnce({
        messages: [msg('c', 10, 1000), msg('d', 11, 1001)],
        nextBeforeSeq: 10,
        exhausted: false,
      })
      .mockResolvedValueOnce({
        // 第二页把边界那条（seq=10）又带回来了 —— 服务端只在单次调用内去重
        messages: [msg('a', 8, 998), msg('b', 9, 999), msg('c', 10, 1000)],
        nextBeforeSeq: 8,
        exhausted: false,
      });

    await mount();
    await waitFor(() => expect(screen.getByTestId('chat-1')).toBeTruthy());

    fireEvent.click(screen.getByTestId('chat-1'));
    await waitFor(() => expect(screen.getAllByTestId(/^msg-/)).toHaveLength(2));

    fireEvent.click(screen.getByTestId('load-older'));
    await waitFor(() => expect(screen.getAllByTestId(/^msg-/)).toHaveLength(4));

    // 游标取上一页给的 nextBeforeSeq
    expect(mock.getHistory).toHaveBeenLastCalledWith('group', '1', 10, 100);
    // 合并后按序、无重复
    const ids = screen.getAllByTestId(/^msg-/).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['msg-a', 'msg-b', 'msg-c', 'msg-d']);
  });

  it('翻页返回空页 → 不再提供「加载更早」', async () => {
    mock.getHistory.mockResolvedValueOnce({
      messages: [msg('a', 1, 1000)],
      nextBeforeSeq: 1,
      exhausted: false,
    });
    await mount();
    await waitFor(() => expect(screen.getByTestId('chat-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('chat-1'));
    await waitFor(() => expect(screen.getAllByTestId(/^msg-/)).toHaveLength(1));
    mock.getHistory.mockResolvedValueOnce({ messages: [], nextBeforeSeq: null, exhausted: true });
    fireEvent.click(screen.getByTestId('load-older'));
    await waitFor(() => expect(screen.queryByTestId('load-older')).toBeNull());
  });

  it('消息超过渲染上限 → 顶部提示只显示最近 2000 条', async () => {
    const many = Array.from({ length: 2100 }, (_, i) => msg(`m${i}`, i + 1, 1000 + i));
    mock.getHistory.mockResolvedValueOnce({ messages: many, nextBeforeSeq: 1, exhausted: false });
    await mount();
    await waitFor(() => expect(screen.getByTestId('chat-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('chat-1'));
    await waitFor(() => expect(screen.getByTestId('cap-note')).toBeTruthy());
    expect(screen.getByTestId('cap-note').textContent).toContain('2000');
    expect(screen.getAllByTestId(/^msg-/)).toHaveLength(2000);
  });

  it('关键词过滤在客户端过滤正文', async () => {
    mock.getHistory.mockResolvedValueOnce({
      messages: [
        { ...msg('a', 1, 1000), text: '场地定了吗' },
        { ...msg('b', 2, 1001), text: '定了，周五十点' },
      ],
      nextBeforeSeq: 1,
      exhausted: false,
    });
    await mount();
    await waitFor(() => expect(screen.getByTestId('chat-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('chat-1'));
    await waitFor(() => expect(screen.getAllByTestId(/^msg-/)).toHaveLength(2));
    fireEvent.change(screen.getByTestId('filter-query'), { target: { value: '场地' } });
    await waitFor(() => expect(screen.getAllByTestId(/^msg-/)).toHaveLength(1));
    expect(screen.getByTestId('msg-a')).toBeTruthy();
  });

  it('「含图」开关诚实标注「M1 暂不下载」且不可用', async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId('statusbar').textContent).toContain('已连接'));
    const cb = screen.getByTestId('filter-images') as HTMLInputElement;
    expect(cb.disabled).toBe(true);
    expect(cb.closest('label')?.textContent).toContain('M1 暂不下载');
  });

  it('切换会话会清掉上一段残留的失败提示', async () => {
    mock.getHistory.mockRejectedValueOnce(new Error('拉取历史失败'));
    await mount();
    await waitFor(() => expect(screen.getByTestId('chat-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('chat-1'));
    await waitFor(() => expect(screen.getByTestId('toast')).toBeTruthy());
    expect(screen.getByTestId('toast').textContent).toContain('拉取历史失败');

    mock.getHistory.mockResolvedValueOnce({
      messages: [msg('z', 9, 2000)],
      nextBeforeSeq: 9,
      exhausted: false,
    });
    fireEvent.click(screen.getByTestId('chat-2'));
    await waitFor(() => expect(screen.getByTestId('msg-z')).toBeTruthy());
    expect(screen.queryByTestId('toast')).toBeNull();
  });
});

describe('App 选择规则', () => {
  beforeEach(() => {
    mock.getHistory.mockResolvedValueOnce({
      messages: [msg('a', 1, 1000), msg('b', 2, 1001), msg('c', 3, 1002)],
      nextBeforeSeq: 1,
      exhausted: false,
    });
  });

  it('单击单选、Shift 连选、Ctrl 点选', async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId('chat-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('chat-1'));
    await waitFor(() => expect(screen.getAllByTestId(/^msg-/)).toHaveLength(3));

    // 单击 → 单选
    fireEvent.click(screen.getByTestId('msg-a'));
    await waitFor(() => expect(screen.getByTestId('sel-count').textContent).toContain('已选 1 条'));

    // Shift 连选 → a..c 全选
    fireEvent.click(screen.getByTestId('msg-c'), { shiftKey: true });
    await waitFor(() => expect(screen.getByTestId('sel-count').textContent).toContain('已选 3 条'));

    // Ctrl 点选 → 取消 b
    fireEvent.click(screen.getByTestId('msg-b'), { ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('sel-count').textContent).toContain('已选 2 条'));
  });

  it('切换会话会清空上一段的选择', async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId('chat-1')).toBeTruthy());
    fireEvent.click(screen.getByTestId('chat-1'));
    await waitFor(() => expect(screen.getAllByTestId(/^msg-/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId('msg-a'));
    await waitFor(() => expect(screen.getByTestId('sel-count').textContent).toContain('已选 1 条'));

    mock.getHistory.mockResolvedValueOnce({
      messages: [msg('z', 9, 2000)],
      nextBeforeSeq: 9,
      exhausted: false,
    });
    fireEvent.click(screen.getByTestId('chat-2'));
    await waitFor(() => expect(screen.getByTestId('msg-z')).toBeTruthy());
    expect(screen.getByTestId('sel-count').textContent).toContain('已选 0 条');
  });
});
