import { describe, expect, it } from 'vitest';
import {
  compareMessages,
  messageDedupKey,
  messageShortId,
  normalizeMessage,
  segmentsText,
  sortMessages,
} from '../src/server/model/message.js';
import type { OB11Message } from '../src/server/onebot/types.js';

describe('normalizeMessage', () => {
  it('normalizes a group text message', () => {
    const raw: OB11Message = {
      message_id: 1,
      message_seq: 42,
      time: 1700000000,
      group_id: 123,
      sender: { user_id: 10001, nickname: 'Alice', card: 'Alice[产品]' },
      message: [{ type: 'text', data: { text: '场地定了吗？' } }],
    };
    const m = normalizeMessage(raw);
    expect(m.seq).toBe(42);
    expect(m.senderName).toBe('Alice[产品]');
    expect(m.text).toBe('场地定了吗？');
    expect(m.segments).toEqual([{ kind: 'text', text: '场地定了吗？' }]);
  });

  it('projects media segments to placeholders', () => {
    const raw: OB11Message = {
      message_id: 2,
      message_seq: 43,
      time: 1700000001,
      sender: { user_id: 2, nickname: 'Bob' },
      message: [
        { type: 'image', data: { url: 'https://x/img.png', file: 'img.png' } },
        { type: 'text', data: { text: '看这个' } },
        { type: 'face', data: { id: '13' } },
        { type: 'record', data: { url: 'https://x/a.amr' } },
        { type: 'at', data: { qq: 10001, name: 'Bob' } },
      ],
    };
    const m = normalizeMessage(raw);
    expect(m.text).toBe('[图片]看这个[表情][语音]@Bob');
    expect(m.segments[0]).toMatchObject({ kind: 'image', url: 'https://x/img.png' });
    expect(m.segments[3]).toMatchObject({ kind: 'voice', url: 'https://x/a.amr' });
    // at 段有 name 时投影为 @name；没有 name 时回退为 @qq（标准 OB11 at 段只保证有 qq）。
    expect(m.segments[4]).toMatchObject({ kind: 'at', qq: '10001', name: 'Bob' });
    expect(segmentsText([{ kind: 'at', qq: '10001' }])).toBe('@10001');
  });

  it('extracts reply preview', () => {
    const raw: OB11Message = {
      message_id: 3,
      message_seq: 44,
      time: 1700000002,
      sender: { user_id: 3, nickname: 'Carol' },
      message: [
        { type: 'reply', data: { id: '1' } },
        { type: 'text', data: { text: '知道了' } },
      ],
    };
    const m = normalizeMessage(raw);
    expect(m.replyTo?.messageId).toBe('1');
    expect(m.segments[0].kind).toBe('reply');
  });

  it('parses string message body via CQ fallback', () => {
    const raw: OB11Message = {
      message_id: 4,
      message_seq: 45,
      time: 1700000003,
      sender: { user_id: 4, nickname: 'Dave' },
      message: '你好 [CQ:image,file=abc.jpg] 世界',
      raw_message: '你好 [CQ:image,file=abc.jpg] 世界',
    };
    const m = normalizeMessage(raw);
    expect(m.segments).toEqual([
      { kind: 'text', text: '你好 ' },
      { kind: 'image', fileId: 'abc.jpg' },
      { kind: 'text', text: ' 世界' },
    ]);
  });

  it('segmentsText for forward', () => {
    expect(segmentsText([{ kind: 'forward', messageId: '9' }])).toBe('[合并转发]');
  });

  // —— 以下为 brief 5 个测试之外补充的映射覆盖（自审要求：段类型映射表覆盖完整）——

  it('maps every standard OneBot 11 segment type', () => {
    const raw: OB11Message = {
      message_id: 5,
      message_seq: 46,
      time: 1700000004,
      sender: { user_id: 5, nickname: 'Eve' },
      message: [
        { type: 'text', data: { text: 'hi' } },
        { type: 'at', data: { qq: 10001, name: 'Alice' } },
        { type: 'face', data: { id: '13' } },
        { type: 'reply', data: { id: '7' } },
        { type: 'image', data: { url: 'https://x/i.png', file: 'i.png', width: '320', height: '240' } },
        { type: 'record', data: { url: 'https://x/v.amr', seconds: '3' } },
        { type: 'video', data: { url: 'https://x/v.mp4', file: 'v.mp4' } },
        { type: 'file', data: { url: 'https://x/f.pdf', name: 'f.pdf', size: '1024' } },
        { type: 'json', data: { data: '{"a":1}' } },
        { type: 'forward', data: { id: '9' } },
      ],
    };
    const m = normalizeMessage(raw);
    expect(m.segments.map((s) => s.kind)).toEqual([
      'text',
      'at',
      'face',
      'reply',
      'image',
      'voice',
      'video',
      'file',
      'json',
      'forward',
    ]);
    expect(m.segments[2]).toMatchObject({ kind: 'face', faceId: '13' });
    expect(m.segments[3]).toEqual({ kind: 'reply', messageId: '7' });
    expect(m.segments[4]).toMatchObject({
      kind: 'image',
      url: 'https://x/i.png',
      fileId: 'i.png',
      width: 320,
      height: 240,
    });
    expect(m.segments[5]).toMatchObject({ kind: 'voice', url: 'https://x/v.amr', duration: 3 });
    expect(m.segments[6]).toMatchObject({ kind: 'video', url: 'https://x/v.mp4', fileName: 'v.mp4' });
    expect(m.segments[7]).toMatchObject({ kind: 'file', url: 'https://x/f.pdf', fileName: 'f.pdf', size: 1024 });
    expect(m.segments[8]).toMatchObject({ kind: 'json', raw: '{"a":1}' });
    expect(m.segments[9]).toMatchObject({ kind: 'forward', messageId: '9' });
  });

  it('falls back to a placeholder for unknown segment types', () => {
    const raw: OB11Message = {
      message_id: 6,
      message_seq: 47,
      time: 1700000005,
      sender: { user_id: 6, nickname: 'Frank' },
      message: [{ type: 'dice', data: { result: '3' } }],
    };
    const m = normalizeMessage(raw);
    expect(m.segments).toEqual([{ kind: 'text', text: '[dice]' }]);
    expect(m.text).toBe('[dice]');
  });

  it('keeps CQ escaped commas and query-string urls intact', () => {
    const raw: OB11Message = {
      message_id: 7,
      message_seq: 48,
      time: 1700000006,
      sender: { user_id: 7, nickname: 'Grace' },
      message: '[CQ:image,file=a&#44;b.jpg,url=https://x/i.png?w=1&h=2]',
      raw_message: '[CQ:image,file=a&#44;b.jpg,url=https://x/i.png?w=1&h=2]',
    };
    const m = normalizeMessage(raw);
    expect(m.segments).toEqual([
      { kind: 'image', fileId: 'a,b.jpg', url: 'https://x/i.png?w=1&h=2' },
    ]);
    expect(m.text).toBe('[图片]');
  });

  // —— 审查硬化项补测 ——

  it('projects file, json and video segments to placeholders', () => {
    const raw: OB11Message = {
      message_id: 8,
      message_seq: 49,
      time: 1700000007,
      sender: { user_id: 8, nickname: 'Heidi' },
      message: [
        { type: 'file', data: { name: 'report.pdf', size: '2048', url: 'https://x/r.pdf' } },
        { type: 'json', data: { data: '{"a":1}' } },
        { type: 'video', data: { file: 'v.mp4', url: 'https://x/v.mp4' } },
      ],
    };
    const m = normalizeMessage(raw);
    expect(m.text).toBe('[文件 report.pdf][卡片][视频]');
  });

  it('reply contributes nothing to the text projection and carries a preview', () => {
    const raw: OB11Message = {
      message_id: 9,
      message_seq: 50,
      time: 1700000008,
      sender: { user_id: 9, nickname: 'Ivan' },
      message: [
        { type: 'reply', data: { id: '42' } },
        { type: 'text', data: { text: '好的' } },
      ],
    };
    const m = normalizeMessage(raw);
    expect(m.text).toBe('好的');
    expect(m.replyTo).toEqual({ messageId: '42', preview: '[引用]' });
    // 只有 reply 段时正文投影为空串（不产生任何字符）
    expect(segmentsText([{ kind: 'reply', messageId: '42' }])).toBe('');
  });

  it('parses CQ codes without params, several codes in one string, and a CQ reply', () => {
    const base = {
      message_id: 10,
      message_seq: 51,
      time: 1700000009,
      sender: { user_id: 10, nickname: 'Judy' },
    };

    const noParam = normalizeMessage({ ...base, message: '[CQ:shake]' });
    expect(noParam.segments).toEqual([{ kind: 'text', text: '[shake]' }]);

    const several = normalizeMessage({ ...base, message: '[CQ:face,id=1][CQ:at,qq=10001] 尾巴' });
    expect(several.segments).toEqual([
      { kind: 'face', faceId: '1' },
      { kind: 'at', qq: '10001' },
      { kind: 'text', text: ' 尾巴' },
    ]);
    expect(several.text).toBe('[表情]@10001 尾巴');

    const reply = normalizeMessage({ ...base, message: '[CQ:reply,id=77]' });
    expect(reply.replyTo).toEqual({ messageId: '77', preview: '[引用]' });
    expect(reply.segments[0].kind).toBe('reply');
  });

  it('unescapes CQ escapes in text fragments', () => {
    const raw: OB11Message = {
      message_id: 11,
      message_seq: 52,
      time: 1700000010,
      sender: { user_id: 11, nickname: 'Karl' },
      message: 'AT&amp;T &#91;括号&#93; &#44;',
    };
    const m = normalizeMessage(raw);
    expect(m.text).toBe('AT&T [括号] ,');
    expect(m.segments).toEqual([{ kind: 'text', text: 'AT&T [括号] ,' }]);
  });

  it('normalizes numeric fields, tolerates invalid ones and accepts duration aliases', () => {
    const raw: OB11Message = {
      message_id: 12,
      message_seq: 53,
      time: 1700000011,
      sender: { user_id: 12, nickname: 'Lena' },
      message: [
        { type: 'image', data: { file: 'i.png', width: '0', height: 'abc' } },
        { type: 'record', data: { file: 'a.amr', duration: '5' } },
        { type: 'record', data: { file: 'b.amr', seconds: '3' } },
        { type: 'record', data: { file: 'c.amr', time: '1700000000' } },
        { type: 'file', data: { name: 'r.pdf', size: '1024' } },
      ],
    };
    const m = normalizeMessage(raw);
    expect(m.segments[0]).toEqual({ kind: 'image', fileId: 'i.png', width: 0, height: undefined });
    expect(m.segments[1]).toEqual({ kind: 'voice', duration: 5 });
    expect(m.segments[2]).toEqual({ kind: 'voice', duration: 3 });
    // `time` **不是**时长字段（实测 NapCat 的 record 段根本不带时长）→ 不编造、不推断
    expect(m.segments[3]).toEqual({ kind: 'voice', duration: undefined });
    expect(m.segments[4]).toEqual({ kind: 'file', fileName: 'r.pdf', size: 1024 });
  });

  it('projects segments without a name without dangling separators', () => {
    expect(segmentsText([{ kind: 'file' }])).toBe('[文件]');
    expect(segmentsText([{ kind: 'file', fileName: 'a.txt' }])).toBe('[文件 a.txt]');
    expect(segmentsText([{ kind: 'at', qq: '10001', name: '' }])).toBe('@10001');
    expect(segmentsText([{ kind: 'at', qq: '10001' }])).toBe('@10001');
  });

  // M1.1-3：seq / time 也走 toNum —— 非数值字符串不再得到 NaN。
  // NaN 会一路传染到排序、游标比较、去重键与时间渲染。
  it('never produces NaN for a non-numeric seq or time', () => {
    const raw: OB11Message = {
      message_id: 13,
      message_seq: 'not-a-number' as unknown as number,
      time: 'not-a-number' as unknown as number,
      sender: { user_id: 13, nickname: 'Mallory' },
      message: [{ type: 'text', data: { text: 'hi' } }],
    };
    const m = normalizeMessage(raw);
    expect(Number.isNaN(m.seq)).toBe(false);
    expect(m.seq).toBe(0); // 没有可用的 message_seq → 没有游标（0），不是 NaN
    expect(m.time).toBeUndefined(); // 没有有效时间 → undefined（不是 NaN，也不是假的 epoch 0）
  });

  it('keeps numeric strings as numbers and drops a missing time', () => {
    const raw: OB11Message = {
      message_id: 14,
      message_seq: '77' as unknown as number,
      time: '1700000099' as unknown as number,
      sender: { user_id: 14, nickname: 'Nina' },
      message: [{ type: 'text', data: { text: 'hi' } }],
    };
    const m = normalizeMessage(raw);
    expect(m.seq).toBe(77);
    expect(m.time).toBe(1700000099);

    const noTime = normalizeMessage({
      message_id: 15,
      message_seq: 78,
      sender: { user_id: 15, nickname: 'Owen' },
      message: [{ type: 'text', data: { text: 'hi' } }],
    } as OB11Message);
    expect(noTime.time).toBeUndefined();
  });

  // M1.2（2026-11-21 实测）：NapCat 的 OB11 `record` 段只有 file/path/url/file_size，
  // **根本不带时长** → 插件不编造也不推断时长（`time` 更不能当时长：它是绝对时间戳）。
  it('never infers a voice duration from a record time field', () => {
    const base = {
      message_id: 16,
      message_seq: 79,
      time: 1700000012,
      sender: { user_id: 16, nickname: 'Paul' },
    };
    // `time` 是绝对时间戳（epoch 秒）→ 绝不能被当成「7 秒的语音」
    const timestamp = normalizeMessage({ ...base, message: [{ type: 'record', data: { time: '1700000000' } }] });
    expect(timestamp.segments[0]).toEqual({ kind: 'voice', duration: undefined });

    // 即使看起来像个时长（7 < 一小时），也不推断 —— 没有明确的时长字段就是没有时长
    const short = normalizeMessage({ ...base, message: [{ type: 'record', data: { time: '7' } }] });
    expect(short.segments[0]).toEqual({ kind: 'voice', duration: undefined });

    // seconds / duration 是**明确的**时长字段名 → 照收
    const explicit = normalizeMessage({ ...base, message: [{ type: 'record', data: { seconds: '7200' } }] });
    expect(explicit.segments[0]).toEqual({ kind: 'voice', duration: 7200 });
  });

  // M1.1-5：段数组路径的 text 段也要还原 CQ 转义（与 CQ 路径口径一致）。
  // 同一条消息因 NapCat 交付形态不同而残留不同的转义 → 搜索与导出表现不一致。
  it('unescapes CQ escapes in the segment-array path too', () => {
    const asSegments = normalizeMessage({
      message_id: 17,
      message_seq: 80,
      time: 1700000013,
      sender: { user_id: 17, nickname: 'Quinn' },
      message: [{ type: 'text', data: { text: 'AT&amp;T &#91;括号&#93; &#44;' } }],
    });
    expect(asSegments.text).toBe('AT&T [括号] ,');
    expect(asSegments.segments).toEqual([{ kind: 'text', text: 'AT&T [括号] ,' }]);

    // 同一段内容走 CQ 路径必须得到**逐字相同**的结果
    const asCq = normalizeMessage({
      message_id: 18,
      message_seq: 81,
      time: 1700000014,
      sender: { user_id: 18, nickname: 'Quinn' },
      message: 'AT&amp;T &#91;括号&#93; &#44;',
    });
    expect(asCq.text).toBe(asSegments.text);
  });
});

// —— M1.2：排序键与去重键（按真实 NapCat 语义重做）——
describe('排序与去重键（真实语义）', () => {
  const msg = (over: Partial<OB11Message>): OB11Message => ({
    message_id: 1,
    message_seq: 100,
    real_id: 100,
    time: 1700000000,
    sender: { user_id: 1, nickname: 'u' },
    message: [{ type: 'text', data: { text: 'x' } }],
    ...over,
  });

  it('排序键：time 升序 → 同秒用 real_seq 升序', () => {
    const list = [
      msg({ message_seq: 3, real_seq: 3, time: 1700000002 }),
      msg({ message_seq: 2, real_seq: 2, time: 1700000001 }),
      msg({ message_seq: 9, real_seq: 9, time: 1700000001 }), // 与上一条同秒
    ];
    const sorted = sortMessages(list);
    // 同秒内按 real_seq 升序（不是 message_seq —— 那是随机短 id）
    expect(sorted.map((m) => m.real_seq)).toEqual([2, 9, 3]);
  });

  it('排序键：real_seq 也相同 → 保持服务端顺序（稳定排序）', () => {
    const a = msg({ message_seq: 1, real_seq: 5, time: 1700000000 });
    const b = msg({ message_seq: 2, real_seq: 5, time: 1700000000 });
    const c = msg({ message_seq: 3, real_seq: 5, time: 1700000000 });
    expect(sortMessages([a, b, c]).map((m) => m.message_seq)).toEqual([1, 2, 3]);
    expect(compareMessages(a, b)).toBe(0);
  });

  it('排序键：没有有效时间的排在最后（排不进时间轴）', () => {
    const withTime = msg({ message_seq: 1, time: 1700000000 });
    const noTime = msg({ message_seq: 2, time: undefined });
    expect(sortMessages([noTime, withTime]).map((m) => m.message_seq)).toEqual([1, 2]);
  });

  it('去重键：message_seq → message_id → real_id', () => {
    expect(messageDedupKey(msg({ message_seq: 7, message_id: 9, real_id: 11 }))).toBe('s7');
    expect(messageDedupKey(msg({ message_seq: undefined, message_id: 9, real_id: 11 }))).toBe('i9');
    expect(messageDedupKey(msg({ message_seq: undefined, message_id: undefined, real_id: 11 }))).toBe('i11');
    expect(messageDedupKey(msg({ message_seq: undefined, message_id: undefined, real_id: undefined }))).toBeUndefined();
  });

  it('锚点短 id 只认 message_seq（real_seq 查不到）', () => {
    expect(messageShortId(msg({ message_seq: 7 }))).toBe('7');
    expect(messageShortId(msg({ message_seq: undefined, message_id: 9 }))).toBeUndefined();
  });

  it('normalizeMessage 带上 realSeq（同秒内的定序键）', () => {
    const m = normalizeMessage(msg({ message_seq: 7, real_seq: 42, time: 1700000000 }));
    expect(m.realSeq).toBe(42);
    expect(m.seq).toBe(7); // seq 仍是短 id（不是序号）
  });
});
