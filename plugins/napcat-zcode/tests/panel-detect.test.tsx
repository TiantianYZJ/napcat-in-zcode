/**
 * @vitest-environment jsdom
 */
/**
 * M2 Task 5：面板「检测本机 NapCat」入口的用例。
 *
 * 覆盖 B1–B8 的**面板侧**行为：
 * - B1：未配置态有「检测本机 NapCat」按钮；检测**不自动连接**；
 * - B2：列出候选，每行一个「使用这个」；疑似需要 token 的候选点击后聚焦 token 输入框；
 * - B3：NapCat 在跑但没开 OneBot Server → 明确提示 + WebUI 地址 + 指引；
 * - B4：什么都没找到 → 「未检测到本机 NapCat」，且手填表单仍在；
 * - B5：探测中按钮置灰 + 「检测中…」，并发点击不触发第二次；
 * - B6：文案规则（尚未检测 / 预算耗尽 / 超时 vs 连不上 / token 角标）；
 * - B7：状态条摘要行三态 + 「结论已过期」；
 * - B8：设置面板里能改 `autoDetect.paths`（保存后走 configure）。
 *
 * 面板**不重算**服务端给的计数与说明：`notes` 原样渲染，端口数量一律不自己数。
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
import { detectionSummary } from '../src/panel/components/Statusbar.js';

afterEach(cleanup);

/** 一份空的探测结果（面板各分支的公共底座）。 */
function detectResult(over: Record<string, unknown> = {}) {
  return {
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
    ...over,
  };
}

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

  mock.handshake.mockResolvedValue(ALL_CAPS);
  mock.status.mockResolvedValue({ configured: false, connected: false, mode: 'unconfigured' });
  mock.listChats.mockResolvedValue({ chats: [] });
  mock.getHistory.mockResolvedValue({ messages: [], nextBeforeSeq: null, exhausted: true });
  mock.configure.mockResolvedValue({ configured: true, connected: true });
  mock.detectLocal.mockResolvedValue(detectResult());
  mock.getConfig.mockResolvedValue({
    connection: { mode: 'external', endpoint: 'http://127.0.0.1:3000', token: '***' },
    export: { dir: 'user', includeImages: false },
    inject: { maxInjectChars: 40000 },
    autoDetect: { ports: [3000], endpoints: [], paths: [], probeTimeoutMs: 1200 },
  });
});

async function mount(): Promise<void> {
  await act(async () => {
    render(<App />);
  });
  await screen.findByTestId('setup-form');
}

describe('B1：未配置态的「检测本机 NapCat」入口', () => {
  it('有检测按钮；点它调 napcat_detect_local，且**不自动连接**', async () => {
    await mount();
    const btn = screen.getByTestId('detect-btn');
    expect(btn.textContent).toContain('检测');
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect(mock.detectLocal).toHaveBeenCalledTimes(1));
    // 检测只是「列候选」，不许顺手连上
    expect(mock.configure).not.toHaveBeenCalled();
  });

  it('检测失败 → 显示错误信息，不崩', async () => {
    mock.detectLocal.mockRejectedValueOnce(new Error('探测失败：host unreachable'));
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    const err = await screen.findByTestId('detect-error');
    expect(err.textContent).toContain('探测失败');
  });
});

describe('B2：候选列表与「使用这个」', () => {
  it('列出 live 候选（端点 + 昵称）；点「使用这个」→ configure 用该端点', async () => {
    mock.detectLocal.mockResolvedValue(
      detectResult({
        found: true,
        live: [
          {
            endpoint: 'http://127.0.0.1:3000',
            transport: 'http',
            source: 'port',
            login: { user_id: '10001', nickname: '小明' },
          },
        ],
      }),
    );
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('detect-candidates')).toBeTruthy());
    const row = screen.getByTestId('detect-candidate-0');
    expect(row.textContent).toContain('http://127.0.0.1:3000');
    expect(row.textContent).toContain('小明');

    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-use-0'));
    });
    await waitFor(() => expect(mock.configure).toHaveBeenCalled());
    expect(mock.configure).toHaveBeenCalledWith('http://127.0.0.1:3000', '');
  });

  it('疑似需要 token 的候选 → 点「使用这个」聚焦 token 输入框并给出提示', async () => {
    mock.detectLocal.mockResolvedValue(
      detectResult({
        found: false,
        tokenRequired: [
          {
            endpoint: 'ws://127.0.0.1:3001',
            transport: 'ws',
            source: 'port',
            error: '127.0.0.1:3001：websocket connect failed',
            needsToken: true,
          },
        ],
      }),
    );
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('detect-candidates')).toBeTruthy());
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-use-0'));
    });
    await waitFor(() => expect(screen.getByTestId('token-hint')).toBeTruthy());
    expect(screen.getByTestId('token-hint').textContent).toContain('access token');
    const tokenInput = document.querySelector('input[type="password"]') as HTMLInputElement;
    expect(document.activeElement).toBe(tokenInput);
  });
});

describe('B3：NapCat 在跑但没开 OneBot Server', () => {
  it('明确说「没有开启 OneBot Server」+ 给 WebUI 地址与开启指引', async () => {
    mock.detectLocal.mockResolvedValue(
      detectResult({ found: false, napcatRunning: true, webuiPort: 6099 }),
    );
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    const box = await screen.findByTestId('detect-nowebui');
    expect(box.textContent).toContain('没有开启 OneBot Server');
    expect(box.textContent).toContain('http://127.0.0.1:6099');
    expect(box.textContent).toContain('网络配置');
  });

  it('webuiPort 缺失 → 不显示地址（不许编一个端口出来）', async () => {
    mock.detectLocal.mockResolvedValue(detectResult({ found: false, napcatRunning: true }));
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    const box = await screen.findByTestId('detect-nowebui');
    expect(box.textContent).toContain('没有开启 OneBot Server');
    expect(box.textContent).not.toContain('http://127.0.0.1:');
  });
});

describe('B4：什么都没找到', () => {
  it('说「未检测到本机 NapCat」，且手填端点的表单仍在', async () => {
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('detect-notfound')).toBeTruthy());
    expect(screen.getByTestId('detect-notfound').textContent).toContain('未检测到本机 NapCat');
    // 表单不许被藏起来
    expect(screen.getByTestId('connect-btn')).toBeTruthy();
    expect(screen.getByPlaceholderText('http://127.0.0.1:3000 或 ws://127.0.0.1:3001')).toBeTruthy();
  });
});

describe('B5：探测中状态', () => {
  it('按钮置灰 + 文案「检测中…」；并发点击不触发第二次探测', async () => {
    let release: (v: unknown) => void = () => {};
    mock.detectLocal.mockReturnValue(
      new Promise((res) => {
        release = res;
      }),
    );
    await mount();
    const btn = screen.getByTestId('detect-btn') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => expect((screen.getByTestId('detect-btn') as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId('detect-btn').textContent).toContain('检测中');
    // 并发点击：置灰的按钮点不动；即使被强行触发也不该发第二次请求
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    expect(mock.detectLocal).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(detectResult());
    });
    await waitFor(() => expect((screen.getByTestId('detect-btn') as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('B6：文案规则', () => {
  it('预算耗尽 → 绝不说「未检测到本机 NapCat」', async () => {
    mock.detectLocal.mockResolvedValue(
      detectResult({
        found: false,
        budgetExhausted: true,
        notes: ['扫描未完成（预算耗尽），结果可能不全：不能据此判断「本机没有 NapCat」'],
      }),
    );
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    const box = await screen.findByTestId('detect-budget');
    expect(box.textContent).toContain('探测未完成');
    expect(box.textContent).toContain('不能据此判断本机没有 NapCat');
    expect(box.textContent).toContain('probeTimeoutMs');
    expect(screen.queryByTestId('detect-notfound')).toBeNull();
    // 整个面板上都不许出现这句
    expect(document.body.textContent).not.toContain('未检测到本机 NapCat');
  });

  it('超时类失败与其它失败分开说', async () => {
    mock.detectLocal.mockResolvedValue(
      detectResult({
        failed: [
          {
            endpoint: 'http://127.0.0.1:3000',
            transport: 'http',
            source: 'port',
            error: '127.0.0.1:3000：timeout',
            unresponsive: true,
          },
          {
            endpoint: 'http://127.0.0.1:3001',
            transport: 'http',
            source: 'port',
            error: '127.0.0.1:3001：ECONNREFUSED',
          },
        ],
      }),
    );
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('detect-failed')).toBeTruthy());
    const text = screen.getByTestId('detect-failed').textContent ?? '';
    expect(text).toContain('目标无响应（超时）');
    expect(text).toContain('连不上');
    // 两句不许合并成一句
    expect(text).not.toContain('连不上或超时');
  });

  it('tokenRequired 只作角标，且不出现断言式「需要 access token」', async () => {
    mock.detectLocal.mockResolvedValue(
      detectResult({
        tokenRequired: [
          {
            endpoint: 'http://127.0.0.1:3000',
            transport: 'http',
            source: 'port',
            error: '127.0.0.1:3000：unauthorized',
            needsToken: true,
          },
        ],
      }),
    );
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('detect-candidates')).toBeTruthy());
    const text = document.body.textContent ?? '';
    expect(text).toContain('access token');
    // 「可能需要 access token」可以；断言式的「（没被「可能」修饰的）需要 access token」不行
    expect(text).not.toMatch(/(?<!可能)需要 access token/);
  });

  it('疑似需要 token 且同时超时的候选 → 也标「目标无响应（超时）」', async () => {
    mock.detectLocal.mockResolvedValue(
      detectResult({
        tokenRequired: [
          {
            endpoint: 'http://127.0.0.1:3000',
            transport: 'http',
            source: 'port',
            error: '127.0.0.1:3000：timeout',
            needsToken: true,
            unresponsive: true,
          },
        ],
      }),
    );
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('detect-candidate-0')).toBeTruthy());
    expect(screen.getByTestId('detect-candidate-0').textContent).toContain('目标无响应（超时）');
  });

  it('notes 原样渲染（面板不自己重算数量）', async () => {
    mock.detectLocal.mockResolvedValue(
      detectResult({
        notes: [
          '失败候选共 12 条（其中 3 条疑似需要 token），已按来源各取前 5 条展示，其余 7 条仅计数',
          '未在本机常见位置发现 NapCat 安装目录（只扫了配置里的路径与默认位置）',
        ],
      }),
    );
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    const notes = await screen.findByTestId('detect-notes');
    expect(notes.textContent).toContain('失败候选共 12 条');
    expect(notes.textContent).toContain('未在本机常见位置发现 NapCat 安装目录');
  });
});

describe('B7：状态条摘要行', () => {
  it('检测到本机 NapCat → 摘要带端点', async () => {
    mock.status.mockResolvedValue({
      configured: false,
      connected: false,
      mode: 'unconfigured',
      detection: { found: true, napcatRunning: true, endpoint: 'http://127.0.0.1:3000' },
    });
    await mount();
    const summary = await screen.findByTestId('detect-summary');
    expect(summary.textContent).toContain('检测到本机 NapCat');
    expect(summary.textContent).toContain('http://127.0.0.1:3000');
  });

  it('NapCat 在跑但没开 OneBot Server → 摘要这样说', async () => {
    mock.status.mockResolvedValue({
      configured: false,
      connected: false,
      mode: 'unconfigured',
      detection: { found: false, napcatRunning: true },
    });
    await mount();
    const summary = await screen.findByTestId('detect-summary');
    expect(summary.textContent).toContain('检测到 NapCat（未开启 OneBot Server）');
  });

  it('探测过但什么都没找到 → 摘要说「未检测到本机 NapCat」', async () => {
    mock.status.mockResolvedValue({
      configured: false,
      connected: false,
      mode: 'unconfigured',
      detection: { found: false, napcatRunning: false },
    });
    await mount();
    const summary = await screen.findByTestId('detect-summary');
    expect(summary.textContent).toContain('未检测到本机 NapCat');
  });

  it('从没探测过（detection 键不存在）→ 「尚未检测」，不是「未检测到」', async () => {
    await mount();
    const summary = await screen.findByTestId('detect-summary');
    expect(summary.textContent).toContain('尚未检测');
    expect(summary.textContent).not.toContain('未检测到');
  });

  it('探测结论在两次轮询之间消失 → 「结论已过期，请重新检测」（不是「未检测到」）', async () => {
    // 第一次：探测过（有结论）
    mock.status.mockResolvedValue({
      configured: false,
      connected: false,
      mode: 'unconfigured',
      detection: { found: false, napcatRunning: false },
    });
    await mount();
    await screen.findByTestId('detect-summary');
    // 第二次：配置变了 → 服务端清掉缓存 → detection 键消失
    mock.status.mockResolvedValue({ configured: false, connected: false, mode: 'unconfigured' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('detect-summary').textContent).toContain('结论已过期，请重新检测'),
    );
    expect(screen.getByTestId('detect-summary').textContent).not.toContain('未检测到');
  });
});

describe('B8：设置面板里改 autoDetect.paths', () => {
  it('有路径输入区（每行一个路径）+ 保存按钮；保存后走 configure 并带上 paths', async () => {
    mock.getConfig.mockResolvedValue({
      connection: { mode: 'external', endpoint: 'http://127.0.0.1:3000', token: '***' },
      export: { dir: 'user', includeImages: false },
      inject: { maxInjectChars: 40000 },
      autoDetect: {
        ports: [3000],
        endpoints: [],
        // 服务端**不返回**本机绝对路径（N7）；这里故意塞一条，验证面板不会把它显示出来
        paths: ['D:\\NapCat'],
        pathsCount: 1,
        probeTimeoutMs: 1200,
      },
    });
    await mount();
    fireEvent.click(screen.getByTestId('settings-btn'));
    await waitFor(() => expect(screen.getByTestId('settings-panel')).toBeTruthy());
    const input = (await screen.findByTestId('paths-input')) as HTMLTextAreaElement;
    // N7：本机绝对路径不进工具返回值 → 面板也不许回显它
    expect(input.value).not.toContain('D:\\NapCat');
    // 只显示条数（用户至少知道「已经配了 1 条」）
    expect(screen.getByTestId('paths-count').textContent).toContain('1');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'D:\\NapCat\nD:\\QQChatExporter' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('paths-save'));
    });
    await waitFor(() => expect(mock.configure).toHaveBeenCalled());
    const args = mock.configure.mock.calls[0];
    expect(args[3]).toEqual(['D:\\NapCat', 'D:\\QQChatExporter']);
  });

  it('保存成功 → 面板给出反馈；token 明文绝不回显', async () => {
    await mount();
    fireEvent.click(screen.getByTestId('settings-btn'));
    await waitFor(() => expect(screen.getByTestId('settings-panel')).toBeTruthy());
    const input = (await screen.findByTestId('paths-input')) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'D:\\NapCat' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('paths-save'));
    });
    await waitFor(() => expect(screen.getByTestId('paths-msg')).toBeTruthy());
    expect(screen.getByTestId('paths-msg').textContent).toContain('已保存');
    // 保存时传的是空 token（服务端语义：留空 = 保留已存的 token）
    expect(mock.configure.mock.calls[0][1]).toBe('');
  });

  it('保存失败 → 显示服务端给的错误（相对路径等）', async () => {
    mock.configure.mockRejectedValueOnce(new Error('扫描路径必须是绝对路径：NapCat'));
    await mount();
    fireEvent.click(screen.getByTestId('settings-btn'));
    await waitFor(() => expect(screen.getByTestId('settings-panel')).toBeTruthy());
    const input = (await screen.findByTestId('paths-input')) as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: 'NapCat' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('paths-save'));
    });
    const err = await screen.findByTestId('paths-error');
    expect(err.textContent).toContain('必须是绝对路径');
  });
});

/* ===================== 审查收尾修正（N1–N7） ===================== */

describe('N1：失败态的「重新配置端点」表单也能刷新状态条摘要', () => {
  it('失败态表单里检测 → 状态条摘要更新，且表单不被收起来', async () => {
    mock.status.mockResolvedValue({
      configured: true,
      connected: false,
      mode: 'external',
      error: '连接超时',
    });
    // 失败态没有配置表单（要用户点「重新配置端点」才展开）→ 不能用 mount() 等 setup-form
    await act(async () => {
      render(<App />);
    });
    await waitFor(() => expect(screen.getByTestId('phase-error')).toBeTruthy());
    fireEvent.click(screen.getByTestId('reconfigure-btn'));
    await waitFor(() => expect(screen.getByTestId('setup-form')).toBeTruthy());

    // 探测完成后服务端缓存了结论 → 随后的 status 带出 detection
    mock.status.mockResolvedValue({
      configured: true,
      connected: false,
      mode: 'external',
      error: '连接超时',
      detection: { found: true, napcatRunning: true, endpoint: 'http://127.0.0.1:3000' },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('detect-summary').textContent).toContain('检测到本机 NapCat'),
    );
    // 探测不该把用户正在用的表单收掉（结果还要看）
    expect(screen.getByTestId('setup-form')).toBeTruthy();
  });
});

describe('N2：配置没加载完不许保存扫描路径', () => {
  it('配置尚未加载完成 → 保存按钮不可点（否则会误把路径清空）', async () => {
    // 永不 resolve：模拟「配置还在路上」
    mock.getConfig.mockReturnValue(new Promise(() => {}));
    await mount();
    fireEvent.click(screen.getByTestId('settings-btn'));
    await waitFor(() => expect(screen.getByTestId('settings-panel')).toBeTruthy());
    const save = screen.getByTestId('paths-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // 禁用期间不许触发保存（更不会把 autoDetect.paths 清空）
    await act(async () => {
      fireEvent.click(save);
    });
    expect(mock.configure).not.toHaveBeenCalled();
  });
});

describe('N3：并发探测闸门（ref）', () => {
  it('同一个事件循环内连点两次「检测」→ 只发一次探测', async () => {
    let release: (v: unknown) => void = () => {};
    mock.detectLocal.mockReturnValue(
      new Promise((res) => {
        release = res;
      }),
    );
    await mount();
    const btn = screen.getByTestId('detect-btn');
    // 两次点击在**同一个 act() 内**：此时 React 还没把按钮置灰 →
    // 两次都会进 handler → 只有 ref 闸门能挡住第二次
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(mock.detectLocal).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(detectResult());
    });
  });

  it('探测失败 → 按钮恢复可用，文案回到「检测本机 NapCat」', async () => {
    mock.detectLocal.mockRejectedValueOnce(new Error('探测失败：host unreachable'));
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('detect-error')).toBeTruthy());
    const btn = screen.getByTestId('detect-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('检测本机 NapCat');
    expect(btn.textContent).not.toContain('检测中');
  });
});

describe('N4：阳性结论优先（预算耗尽不该把「检测到了」藏起来）', () => {
  it('扫到端点但预算也耗尽 → 摘要两件事都表达', async () => {
    mock.status.mockResolvedValue({
      configured: false,
      connected: false,
      mode: 'unconfigured',
      detection: {
        found: true,
        napcatRunning: true,
        endpoint: 'http://127.0.0.1:3000',
        budgetExhausted: true,
      },
    });
    await mount();
    const summary = await screen.findByTestId('detect-summary');
    expect(summary.textContent).toContain('检测到本机 NapCat');
    expect(summary.textContent).toContain('http://127.0.0.1:3000');
    expect(summary.textContent).toContain('未完成');
  });
});

describe('N5：非超时失败的措辞要覆盖「连不上」与「被拒绝」', () => {
  it('失败条目用「连不上或被拒绝」（不是断言式的「连不上」）', async () => {
    mock.detectLocal.mockResolvedValue(
      detectResult({
        failed: [
          {
            endpoint: 'http://127.0.0.1:3000',
            transport: 'http',
            source: 'port',
            error: '127.0.0.1:3000：OneBot 错误 1404（unauthorized）',
          },
        ],
      }),
    );
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('detect-btn'));
    });
    await waitFor(() => expect(screen.getByTestId('detect-failed')).toBeTruthy());
    const text = screen.getByTestId('detect-failed').textContent ?? '';
    expect(text).toContain('被拒绝');
    expect(text).not.toContain('目标无响应'); // 非超时不许被说成超时
  });
});

describe('N6：detectionSummary 的直接单元用例', () => {
  it.each([
    [
      'detection 键缺失 + 从没探过 → 尚未检测',
      undefined,
      false,
      (s: string) => s.includes('尚未检测') && !s.includes('未检测到'),
    ],
    [
      'detection 键缺失 + 探过（结论过期）→ 结论已过期，请重新检测',
      undefined,
      true,
      (s: string) => s.includes('结论已过期') && s.includes('重新检测') && !s.includes('未检测到'),
    ],
    [
      'found → 检测到本机 NapCat（端点）',
      { found: true, napcatRunning: true, endpoint: 'http://127.0.0.1:3000' },
      false,
      (s: string) => s.includes('检测到本机 NapCat') && s.includes('http://127.0.0.1:3000'),
    ],
    [
      'found + 预算耗尽 → 两件事都表达',
      { found: true, napcatRunning: true, endpoint: 'http://127.0.0.1:3000', budgetExhausted: true },
      false,
      (s: string) =>
        s.includes('检测到本机 NapCat') &&
        s.includes('http://127.0.0.1:3000') &&
        s.includes('未完成') &&
        !s.includes('不能据此判断本机没有 NapCat'),
    ],
    [
      'NapCat 在跑但没开 OneBot Server',
      { found: false, napcatRunning: true },
      false,
      (s: string) => s.includes('检测到 NapCat（未开启 OneBot Server）'),
    ],
    [
      '什么都没找到 → 未检测到本机 NapCat',
      { found: false, napcatRunning: false },
      false,
      (s: string) => s === '未检测到本机 NapCat',
    ],
    [
      '预算耗尽且没找到 → 绝不说「未检测到本机 NapCat」',
      { found: false, napcatRunning: false, budgetExhausted: true },
      false,
      (s: string) =>
        s.includes('探测未完成') &&
        s.includes('不能据此判断本机没有 NapCat') &&
        !s.includes('未检测到本机 NapCat'),
    ],
  ])('%s', (_name, detection, hadDetection, check) => {
    const text = detectionSummary(detection as never, hadDetection as boolean);
    expect(check(text)).toBe(true);
  });
});

describe('N7（面板侧）：不回显本机绝对路径', () => {
  it('设置面板不显示工具返回的路径串，只显示条数', async () => {
    mock.getConfig.mockResolvedValue({
      connection: { mode: 'external', endpoint: 'http://127.0.0.1:3000', token: '***' },
      export: { dir: 'user', includeImages: false },
      inject: { maxInjectChars: 40000 },
      autoDetect: { ports: [3000], endpoints: [], paths: ['D:\\SecretDir'], pathsCount: 2 },
    });
    await mount();
    fireEvent.click(screen.getByTestId('settings-btn'));
    await waitFor(() => expect(screen.getByTestId('settings-panel')).toBeTruthy());
    const panel = screen.getByTestId('settings-panel').textContent ?? '';
    expect(panel).not.toContain('D:\\SecretDir');
    expect(screen.getByTestId('paths-count').textContent).toContain('2');
  });
});
