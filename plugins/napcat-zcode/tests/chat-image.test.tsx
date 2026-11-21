/*
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { ChatImage } from '../src/panel/components/ChatImage.js';

const mocks = vi.hoisted(() => ({ readImage: vi.fn() }));
vi.mock('../src/panel/api.js', () => ({ readImage: mocks.readImage }));

beforeEach(() => {
  mocks.readImage.mockReset();
});
afterEach(() => {
  cleanup();
});

describe('ChatImage（聊天图片段）', () => {
  it('加载中显示占位框；成功后渲染 data: URL 的图片', async () => {
    let resolve!: (v: string) => void;
    const gate = new Promise<string>((r) => {
      resolve = r;
    });
    mocks.readImage.mockReturnValue(gate);
    render(<ChatImage url="https://x/a.png" />);
    expect(screen.getByTestId('msg-image-loading')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();

    resolve('data:image/png;base64,AAAA');
    await waitFor(() => expect(screen.getByTestId('msg-image')).toBeTruthy());
    const img = screen.getByTestId('msg-image') as HTMLImageElement;
    expect(img.src).toContain('data:image/png;base64');
    expect(screen.queryByTestId('msg-image-loading')).toBeNull();
  });

  it('加载失败回退占位符（含原因），不渲染破图', async () => {
    mocks.readImage.mockRejectedValue(new Error('图片超过 8 MB，不予加载。'));
    render(<ChatImage url="https://x/big.png" />);
    const fallback = await screen.findByTestId('msg-image-failed');
    expect(fallback.textContent).toContain('8 MB');
    expect(document.querySelector('img')).toBeNull();
  });

  it('同一 URL 只调用一次 readImage（api 层缓存由其负责；组件按 url 重置）', async () => {
    mocks.readImage.mockResolvedValue('data:image/png;base64,BBBB');
    const { rerender } = render(<ChatImage url="https://x/a.png" />);
    await waitFor(() => expect(screen.getByTestId('msg-image')).toBeTruthy());
    expect(mocks.readImage).toHaveBeenCalledTimes(1);
    // 换 URL → 重新拉取
    rerender(<ChatImage url="https://x/b.png" />);
    await waitFor(() => expect(mocks.readImage).toHaveBeenCalledTimes(2));
    expect(mocks.readImage).toHaveBeenLastCalledWith('https://x/b.png');
  });
});
