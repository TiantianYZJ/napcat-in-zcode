/**
 * 扫码登录代理（napcat_qr_login 的核心逻辑，fetch 注入、全程不联网）：
 * waiting（二维码转 data URL）/ accepted / logined / 各种失败路径。
 */
import { describe, expect, it } from 'vitest';
import { pollQrLogin, type WebuiFetch } from '../src/server/host/qrlogin.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function fakeWebui(
  routes: Record<string, { status?: number; contentType?: string; body?: unknown; bytes?: Uint8Array }>,
): WebuiFetch {
  return async (url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const r = routes[path];
    if (!r) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0), text: async () => '' };
    const body = r.bytes ? r.bytes : JSON.stringify(r.body ?? {});
    return {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      headers: { get: (n) => (n.toLowerCase() === 'content-type' ? r.contentType ?? 'application/json' : null) },
      arrayBuffer: async () =>
        r.bytes
          ? r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) as ArrayBuffer
          : new TextEncoder().encode(String(body)).buffer as ArrayBuffer,
      text: async () => String(body),
    };
  };
}

const PORT = { webuiPort: 6099, token: 'webui-secret' };

describe('pollQrLogin（扫码登录轮询）', () => {
  it('waiting：二维码 URL 转成 data URL（带 WebUI token 拉图）', async () => {
    const seen: string[] = [];
    const fetcher: WebuiFetch = async (url, init) => {
      seen.push(url + '|' + (init?.headers?.authorization ?? ''));
      if (url.includes('CheckLoginStatus')) return fakeWebui({ '/api/QQLogin/CheckLoginStatus': { body: { isLogin: false, qrLoginAccepted: false } } })(url, init);
      if (url.includes('GetQQLoginQrcode')) return fakeWebui({ '/api/QQLogin/GetQQLoginQrcode': { body: { qrcode: 'http://127.0.0.1:6099/api/QQLogin/qrcode-img' } } })(url, init);
      if (url.includes('qrcode-img')) return fakeWebui({ '/api/QQLogin/qrcode-img': { contentType: 'image/png', bytes: PNG } })(url, init);
      return fakeWebui({})(url, init);
    };
    const r = await pollQrLogin(fetcher, PORT);
    expect(r.phase).toBe('waiting');
    expect(r.qrDataUrl).toContain('data:image/png;base64');
    // WebUI token 用于本机 WebUI 调用
    expect(seen.some((s) => s.includes('Bearer webui-secret'))).toBe(true);
  });

  it('qrcode 直接给 data URL 时原样透传，不再二次拉图', async () => {
    const fetcher = fakeWebui({
      '/api/QQLogin/CheckLoginStatus': { body: { isLogin: false, qrLoginAccepted: false } },
      '/api/QQLogin/GetQQLoginQrcode': { body: { qrcode: 'data:image/png;base64,AAAA' } },
    });
    const r = await pollQrLogin(fetcher, PORT);
    expect(r.phase).toBe('waiting');
    expect(r.qrDataUrl).toBe('data:image/png;base64,AAAA');
  });

  it('accepted：已扫码待确认', async () => {
    const fetcher = fakeWebui({
      '/api/QQLogin/CheckLoginStatus': { body: { isLogin: false, qrLoginAccepted: true } },
    });
    const r = await pollQrLogin(fetcher, PORT);
    expect(r.phase).toBe('accepted');
    expect(r.qrDataUrl).toBeUndefined();
  });

  it('logined：登录完成', async () => {
    const fetcher = fakeWebui({
      '/api/QQLogin/CheckLoginStatus': { body: { isLogin: true } },
    });
    const r = await pollQrLogin(fetcher, PORT);
    expect(r.phase).toBe('logined');
  });

  it('WebUI 不可达：一句话错误（面板显示并可重试）', async () => {
    const fetcher: WebuiFetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const r = await pollQrLogin(fetcher, PORT);
    expect(r.phase).toBe('error');
    expect(r.message).toContain('WebUI');
  });
});
