/**
 * 聊天图片代理资源（M3.5 / 0.7.0）：
 * 面板默认 CSP `img-src 'self' data:` 拦外域 → 面板走 resources/read，
 * 服务端拉图后以 blob（base64）返回。这里验证**出网闸门**与返回形状：
 * 仅 https 公网、逐跳重定向校验、mimeType 必须 image/*、8MB 上限。
 * fetch 可注入 → 全程不联网。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  assertImageHopAllowed,
  decodeImageUrl,
  encodeImageUrl,
  registerImageResource,
  type ImageFetch,
} from '../src/server/imageresource.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function fakeFetch(
  respond: (url: string) =>
    | { status: number; location?: string; contentType?: string; body?: Uint8Array }
    | 'network-error',
): ImageFetch {
  return async (url) => {
    const r = respond(url);
    if (r === 'network-error') throw new Error('fetch failed');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: {
        get(name: string) {
          if (name.toLowerCase() === 'content-type') return r.contentType ?? null;
          if (name.toLowerCase() === 'location') return r.location ?? null;
          return null;
        },
      },
      arrayBuffer: async () => r.body ? r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength) as ArrayBuffer : new ArrayBuffer(0),
    };
  };
}

function makeServer(fetcher: ImageFetch): { server: McpServer; client: Client } {
  const server = new McpServer({ name: 't', version: '0.0.0' });
  registerImageResource(server, fetcher);
  const client = new Client({ name: 'c', version: '0.0.0' });
  void client;
  return { server, client };
}

describe('图片地址闸门（assertImageHopAllowed）', () => {
  it('允许 https 公网地址', () => {
    expect(() => assertImageHopAllowed('https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=x')).not.toThrow();
    expect(() => assertImageHopAllowed('https://gchat.qpic.cn/a.png')).not.toThrow();
  });

  it('拒绝 http / 内网 / 回环 / 保留地址 / 带凭据', () => {
    expect(() => assertImageHopAllowed('http://multimedia.nt.qq.com.cn/a.png')).toThrow(/https/);
    expect(() => assertImageHopAllowed('https://127.0.0.1/a.png')).toThrow(/公网/);
    expect(() => assertImageHopAllowed('https://10.0.0.5/a.png')).toThrow(/公网/);
    expect(() => assertImageHopAllowed('https://192.168.1.2/a.png')).toThrow(/公网/);
    expect(() => assertImageHopAllowed('https://169.254.3.4/a.png')).toThrow(/公网/);
    expect(() => assertImageHopAllowed('https://[::ffff:127.0.0.1]/a.png')).toThrow(/公网/);
    expect(() => assertImageHopAllowed('https://user:pass@multimedia.nt.qq.com.cn/a.png')).toThrow(/凭据/);
    expect(() => assertImageHopAllowed('https://0.0.0.0/a.png')).toThrow(/公网/);
  });
});

describe('编码往返', () => {
  it('encode → decode 保持 URL；坏编码返回 undefined', () => {
    const url = 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=中文+值';
    expect(decodeImageUrl(encodeImageUrl(url))).toBe(url);
    expect(decodeImageUrl('!!!!')).toBeUndefined();
  });
});

describe('资源读取（注入 fetch，不联网）', () => {
  it('成功：返回 image/* blob（base64）', async () => {
    const { server } = makeServer(fakeFetch(() => ({ status: 200, contentType: 'image/png', body: PNG_BYTES })));
    const client = new Client({ name: 'c', version: '0.0.0' });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(sTransport), client.connect(cTransport)]);
    const uri = `ui://napcat-zcode/image/${encodeImageUrl('https://multimedia.nt.qq.com.cn/a.png')}`;
    const r = await client.readResource({ uri });
    expect(r.contents).toHaveLength(1);
    const first = r.contents[0] as { mimeType?: string; blob?: string };
    expect(first.mimeType).toBe('image/png');
    expect(Buffer.from(first.blob ?? '', 'base64').subarray(0, 4).toString('latin1')).toBe('\x89PNG');
    await client.close();
    await server.close();
  });

  it('拒绝 http 与内网（闸门在 resources/read 里同样生效）', async () => {
    const { server } = makeServer(fakeFetch(() => ({ status: 200, contentType: 'image/png', body: PNG_BYTES })));
    const client = new Client({ name: 'c', version: '0.0.0' });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(sTransport), client.connect(cTransport)]);
    await expect(
      client.readResource({ uri: `ui://napcat-zcode/image/${encodeImageUrl('http://multimedia.nt.qq.com.cn/a.png')}` }),
    ).rejects.toThrow(/https/);
    await expect(
      client.readResource({ uri: `ui://napcat-zcode/image/${encodeImageUrl('https://192.168.1.2/a.png')}` }),
    ).rejects.toThrow(/公网/);
    await client.close();
    await server.close();
  });

  it('重定向到内网地址：每一跳都校验，拒绝跟随', async () => {
    const { server } = makeServer(
      fakeFetch((url) => {
        if (url.includes('multimedia')) return { status: 302, location: 'https://10.0.0.5/steal' };
        return { status: 200, contentType: 'image/png', body: PNG_BYTES };
      }),
    );
    const client = new Client({ name: 'c', version: '0.0.0' });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(sTransport), client.connect(cTransport)]);
    await expect(
      client.readResource({ uri: `ui://napcat-zcode/image/${encodeImageUrl('https://multimedia.nt.qq.com.cn/a.png')}` }),
    ).rejects.toThrow(/公网/);
    await client.close();
    await server.close();
  });

  it('非 image/* 与超 8MB 拒绝', async () => {
    let mode = 'html';
    const { server } = makeServer(
      fakeFetch(() =>
        mode === 'html'
          ? { status: 200, contentType: 'text/html', body: new Uint8Array([1, 2, 3]) }
          : { status: 200, contentType: 'image/png', body: new Uint8Array(9 * 1024 * 1024) },
      ),
    );
    const client = new Client({ name: 'c', version: '0.0.0' });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(sTransport), client.connect(cTransport)]);
    const uri = `ui://napcat-zcode/image/${encodeImageUrl('https://multimedia.nt.qq.com.cn/a.png')}`;
    await expect(client.readResource({ uri })).rejects.toThrow(/不是图片/);
    mode = 'big';
    await expect(client.readResource({ uri })).rejects.toThrow(/8 MB/);
    await client.close();
    await server.close();
  });

  it('网络错误：错误消息保留原始信息（面板回退占位符）', async () => {
    const { server } = makeServer(fakeFetch(() => 'network-error'));
    const client = new Client({ name: 'c', version: '0.0.0' });
    const [cTransport, sTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(sTransport), client.connect(cTransport)]);
    await expect(
      client.readResource({ uri: `ui://napcat-zcode/image/${encodeImageUrl('https://multimedia.nt.qq.com.cn/a.png')}` }),
    ).rejects.toThrow(/fetch failed/);
    await client.close();
    await server.close();
  });
});
