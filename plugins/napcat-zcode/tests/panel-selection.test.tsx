/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MessageList } from '../src/panel/components/MessageList.js';
import type { Msg } from '../src/panel/api.js';

// vitest 默认不开 globals → RTL 的自动清理不会注册，这里显式清理，避免用例之间互相污染。
afterEach(cleanup);

const MSGS: Msg[] = [
  { id: 'a', seq: 1, time: 1700000000, senderId: '1', senderName: 'Alice', segments: [{ kind: 'text', text: 'one' }], text: 'one' },
  { id: 'b', seq: 2, time: 1700000060, senderId: '2', senderName: 'Bob', segments: [{ kind: 'text', text: 'two' }], text: 'two' },
];

describe('MessageList selection', () => {
  it('click selects single, ctrl toggles', () => {
    const onToggle = vi.fn();
    const { getByTestId } = render(<MessageList messages={MSGS} selection={new Set(['a'])} onToggle={onToggle} onLoadOlder={vi.fn()} />);
    expect(getByTestId('msg-a').className).toContain('sel');
    fireEvent.click(getByTestId('msg-b'), { ctrlKey: true });
    expect(onToggle).toHaveBeenCalledWith('b', 'ctrl', 1);
  });

  it('renders media placeholder text', () => {
    // 无 url 的图片段：没有可拉的地址 → 保持 [图片] 占位（与 text 一致）
    const msgs: Msg[] = [{ ...MSGS[0], segments: [{ kind: 'image' }], text: '[图片]' }];
    const { getByTestId } = render(<MessageList messages={msgs} selection={new Set()} onToggle={vi.fn()} onLoadOlder={vi.fn()} />);
    expect(getByTestId('msg-a').textContent).toContain('[图片]');
  });

  it('带 url 的图片段走代理加载通道（挂起时是加载占位，不是破图）', () => {
    const msgs: Msg[] = [{ ...MSGS[0], segments: [{ kind: 'image', url: 'https://x/i.png' }], text: '[图片]' }];
    const { getByTestId } = render(<MessageList messages={msgs} selection={new Set()} onToggle={vi.fn()} onLoadOlder={vi.fn()} />);
    // 桥未握手 → readImage 挂起 → 加载占位；真实环境下成功出图、失败回退占位符
    expect(getByTestId('msg-image-loading')).toBeTruthy();
  });

  it('shift 连选把 shift 模式与下标交给上层', () => {
    const onToggle = vi.fn();
    const { getByTestId } = render(<MessageList messages={MSGS} selection={new Set()} onToggle={onToggle} onLoadOlder={vi.fn()} />);
    fireEvent.click(getByTestId('msg-b'), { shiftKey: true });
    expect(onToggle).toHaveBeenCalledWith('b', 'shift', 1);
  });

  it('mac 的 metaKey 也算点选（ctrl 语义）', () => {
    const onToggle = vi.fn();
    const { getByTestId } = render(<MessageList messages={MSGS} selection={new Set()} onToggle={onToggle} onLoadOlder={vi.fn()} />);
    fireEvent.click(getByTestId('msg-a'), { metaKey: true });
    expect(onToggle).toHaveBeenCalledWith('a', 'ctrl', 0);
  });

  it('普通点击是单选模式', () => {
    const onToggle = vi.fn();
    const { getByTestId } = render(<MessageList messages={MSGS} selection={new Set()} onToggle={onToggle} onLoadOlder={vi.fn()} />);
    fireEvent.click(getByTestId('msg-a'));
    expect(onToggle).toHaveBeenCalledWith('a', 'click', 0);
  });

  it('回复消息渲染出上文预览', () => {
    const msgs: Msg[] = [{ ...MSGS[0], replyTo: { messageId: 'z', preview: '之前的消息' } }];
    const { getByTestId } = render(<MessageList messages={msgs} selection={new Set()} onToggle={vi.fn()} onLoadOlder={vi.fn()} />);
    expect(getByTestId('msg-a').textContent).toContain('之前的消息');
  });

  it('「加载更早」按钮触发 onLoadOlder', () => {
    const onLoadOlder = vi.fn();
    const { getByTestId } = render(<MessageList messages={MSGS} selection={new Set()} onToggle={vi.fn()} onLoadOlder={onLoadOlder} />);
    fireEvent.click(getByTestId('load-older'));
    expect(onLoadOlder).toHaveBeenCalled();
  });

  it('没有更多更早消息时不再提供「加载更早」按钮', () => {
    const onLoadOlder = vi.fn();
    const { queryByTestId } = render(
      <MessageList messages={MSGS} selection={new Set()} onToggle={vi.fn()} onLoadOlder={onLoadOlder} noMore />,
    );
    expect(queryByTestId('load-older')).toBeNull();
  });

  it('id 为空串的消息按 seq + time 区分（key / testid 不撞车）', () => {
    // 服务端 normalizeMessage 在 message_id/real_id/message_seq 全缺时 id='' → 直接用 id 会撞车；
    // 只用 seq 也不够（服务端没有 message_seq 时 seq 恒为 0）→ 键里带上 seq 与 time。
    const noId: Msg[] = [
      { ...MSGS[0], id: '', seq: 1 },
      { ...MSGS[1], id: '', seq: 2 },
    ];
    const { getByTestId } = render(
      <MessageList messages={noId} selection={new Set()} onToggle={vi.fn()} onLoadOlder={vi.fn()} />,
    );
    expect(getByTestId('msg-s1@1700000000')).toBeTruthy();
    expect(getByTestId('msg-s2@1700000060')).toBeTruthy();
  });

  it('既无 id、又无 seq 与时间的消息直接不渲染（不共用一个 key）', () => {
    // 服务端的消息既没有 message_id/real_id，也没有 message_seq，且 time 不可信
    // → msgKey 返回 null：这条消息无法与别的消息区分，渲染出来只能撞 key。
    const unusable: Msg[] = [
      { ...MSGS[0], id: '', seq: 0, time: Number.NaN },
    ];
    const { queryAllByTestId } = render(
      <MessageList messages={unusable} selection={new Set()} onToggle={vi.fn()} onLoadOlder={vi.fn()} />,
    );
    expect(queryAllByTestId(/^msg-/)).toHaveLength(0);
  });
});

describe('MessageList 拖拽划选', () => {
  it('按住并划过其它消息 → 上报起点与终点', () => {
    const onDragSelect = vi.fn();
    const { getByTestId } = render(
      <MessageList
        messages={MSGS}
        selection={new Set()}
        onToggle={vi.fn()}
        onLoadOlder={vi.fn()}
        onDragSelect={onDragSelect}
      />,
    );
    fireEvent.mouseDown(getByTestId('msg-a'));
    fireEvent.mouseOver(getByTestId('msg-b'));
    expect(onDragSelect).toHaveBeenCalledWith('a', 'b', false);
  });

  it('Ctrl/Cmd 拖拽 → 叠加语义（additive=true）', () => {
    const onDragSelect = vi.fn();
    const { getByTestId } = render(
      <MessageList
        messages={MSGS}
        selection={new Set()}
        onToggle={vi.fn()}
        onLoadOlder={vi.fn()}
        onDragSelect={onDragSelect}
      />,
    );
    fireEvent.mouseDown(getByTestId('msg-a'), { metaKey: true });
    fireEvent.mouseOver(getByTestId('msg-b'), { metaKey: true });
    expect(onDragSelect).toHaveBeenCalledWith('a', 'b', true);
  });

  it('没有按下就不划选（普通悬停不产生选区变化）', () => {
    const onDragSelect = vi.fn();
    const { getByTestId } = render(
      <MessageList
        messages={MSGS}
        selection={new Set()}
        onToggle={vi.fn()}
        onLoadOlder={vi.fn()}
        onDragSelect={onDragSelect}
      />,
    );
    fireEvent.mouseOver(getByTestId('msg-b'));
    expect(onDragSelect).not.toHaveBeenCalled();
  });

  it('鼠标松开后停止划选', () => {
    const onDragSelect = vi.fn();
    const { getByTestId } = render(
      <MessageList
        messages={MSGS}
        selection={new Set()}
        onToggle={vi.fn()}
        onLoadOlder={vi.fn()}
        onDragSelect={onDragSelect}
      />,
    );
    fireEvent.mouseDown(getByTestId('msg-a'));
    fireEvent.mouseUp(document);
    fireEvent.mouseOver(getByTestId('msg-b'));
    expect(onDragSelect).not.toHaveBeenCalled();
  });
});
