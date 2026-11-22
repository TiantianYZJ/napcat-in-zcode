/**
 * 扫码登录代理（napcat_qr_login 的核心逻辑，fetch 注入、全程不联网）。
 *
 * 协议按 NapCat 4.18.42 产物 bundle 实测：
 * 1. `POST /api/auth/login` body `{ hash: sha256(token + '.napcat') }` → `{ code:0, data:{ Credential } }`；
 * 2. `POST /api/QQLogin/CheckLoginStatus`（Bearer Credential）→ `{ code:0, data:{ isLogin, qrLoginAccepted, qrcodeurl } }`；
 * 3. qrcodeurl 是腾讯扫码跳转链接 → 用 qrcode-generator 渲染成 data:image/gif。
 */
import { describe, expect, it } from 'vitest';
import { pollQrLogin } from '../src/server/host/qrlogin.js';
import type { QrFetcher } from '../src/server/host/qrfetch.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

interface Route {
  status?: number;
  body?: unknown;
}

/** 简易 WebUI 路由表：path → 响应体。 */
function fakeWebui(routes: Record<string, Route>, seen: string[] = []): QrFetcher {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    seen.push(`${path}|${init?.headers?.authorization ?? ''}|${init?.body ?? ''}`);
    const r = routes[path];
    if (!r) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => JSON.stringify({ code: -1, message: 'not found' }),
      };
    }
    return {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      headers: { get: () => null },
      arrayBuffer: async () => new ArrayBuffer(0),
      text: async () => JSON.stringify(r.body ?? {}),
    };
  };
}

const CREDENTIAL = Buffer.from('{"Data":{"CreatedTime":1},"Hmac":"x"}').toString('base64');
const PORT = { webuiPort: 6099, token: 'webui-secret' };

function baseRoutes(status: Record<string, unknown>): Record<string, Route> {
  return {
    '/api/auth/login': {
      body: { code: 0, data: { Credential: CREDENTIAL }, message: 'success' },
    },
    '/api/QQLogin/CheckLoginStatus': { body: { code: 0, data: status, message: 'success' } },
  };
}

describe('pollQrLogin（扫码登录轮询）', () => {
  it('waiting：登录换凭证 → qrcodeurl 渲染成二维码 data URL', async () => {
    const seen: string[] = [];
    const fetcher = fakeWebui(
      {
        ...baseRoutes({ isLogin: false, qrLoginAccepted: false, qrcodeurl: 'https://txz.qq.com/p?k=abc&f=1' }),
      },
      seen,
    );
    const r = await pollQrLogin(fetcher, { webuiPort: 6100, token: PORT.token });
    expect(r.phase).toBe('waiting');
    expect(r.qrDataUrl).toContain('data:image/gif;base64');
    // 登录用的是加盐 hash：body 里的 hash ≠ sha256(裸 token)
    const loginBody = seen.find((s) => s.startsWith('/api/auth/login|')) ?? '';
    expect(loginBody).toContain('"hash"');
    // 状态轮询带上了换来的 Credential
    expect(seen.some((s) => s.startsWith('/api/QQLogin/CheckLoginStatus|Bearer ' + CREDENTIAL.slice(0, 8)))).toBe(true);
  });

  it('accepted：已扫码待确认（不渲染二维码）', async () => {
    const fetcher = fakeWebui(baseRoutes({ isLogin: false, qrLoginAccepted: true }));
    const r = await pollQrLogin(fetcher, { webuiPort: 6101, token: PORT.token });
    expect(r.phase).toBe('accepted');
    expect(r.qrDataUrl).toBeUndefined();
  });

  it('logined：登录完成', async () => {
    const fetcher = fakeWebui(baseRoutes({ isLogin: true }));
    const r = await pollQrLogin(fetcher, { webuiPort: 6102, token: PORT.token });
    expect(r.phase).toBe('logined');
  });

  it('WebUI 不可达：一句话错误（面板显示并可重试）', async () => {
    const fetcher: QrFetcher = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const r = await pollQrLogin(fetcher, { webuiPort: 6103, token: PORT.token });
    expect(r.phase).toBe('error');
    expect(r.message).toContain('WebUI');
  });

  it('登录被拒（hash 错）→ 错误信息透传 message', async () => {
    const fetcher = fakeWebui({
      '/api/auth/login': { body: { code: -1, message: 'token is invalid' } },
    });
    const r = await pollQrLogin(fetcher, { webuiPort: 6104, token: PORT.token });
    expect(r.phase).toBe('error');
    expect(r.message).toContain('token is invalid');
  });

  it('二维码尚未生成（qrcodeurl 为空）→ 等待下一轮轮询', async () => {
    const fetcher = fakeWebui(
      baseRoutes({ isLogin: false, qrLoginAccepted: false, qrcodeurl: '' }),
    );
    const r = await pollQrLogin(fetcher, { webuiPort: 6105, token: PORT.token });
    expect(r.phase).toBe('waiting');
    expect(r.qrDataUrl).toBeUndefined();
    expect(r.message).toContain('正在生成二维码');
  });

  it('loginError（同号已在别处登录）→ 直接说明原因并给出解法', async () => {
    const fetcher = fakeWebui(
      baseRoutes({
        isLogin: false,
        qrLoginAccepted: false,
        loginPhase: 'waiting_qrcode',
        qrcodeurl: 'https://txz.qq.com/p?k=x',
        loginError: '当前账号(2350355494)已登录,无法重复登录',
      }),
    );
    const r = await pollQrLogin(fetcher, { webuiPort: 6106, token: PORT.token });
    expect(r.phase).toBe('error');
    expect(r.message).toContain('已登录');
    expect(r.message).toContain('退出电脑 QQ');
  });

  it('loginPhase=qrcode_scanned → accepted（不依赖 qrLoginAccepted 布尔）', async () => {
    const fetcher = fakeWebui(
      baseRoutes({ isLogin: false, qrLoginAccepted: false, loginPhase: 'qrcode_scanned' }),
    );
    const r = await pollQrLogin(fetcher, { webuiPort: 6107, token: PORT.token });
    expect(r.phase).toBe('accepted');
  });

  it('登录成功 → 热开启 OneBot HTTP Server（免重启 NapCat）', async () => {
    const seen: string[] = [];
    const fetcher = fakeWebui(
      {
        ...baseRoutes({ isLogin: true }),
        '/api/OB11Config/GetConfig': {
          body: { code: 0, data: { network: { httpServers: [], websocketServers: [] } }, message: 'success' },
        },
        '/api/OB11Config/SetConfig': { body: { code: 0, data: {}, message: 'success' } },
      },
      seen,
    );
    const r = await pollQrLogin(fetcher, { webuiPort: 6108, token: PORT.token, onebotPort: 3000 });
    expect(r.phase).toBe('logined');
    expect(r.onebotEnabled).toBe(true);
    const setBody = seen.find((s) => s.startsWith('/api/OB11Config/SetConfig|')) ?? '';
    expect(setBody).toContain('"port":3000');
    expect(setBody).toContain('"enable":true');
  });

  it('OneBot 已开启时不重复写配置', async () => {
    const seen: string[] = [];
    const fetcher = fakeWebui(
      {
        ...baseRoutes({ isLogin: true }),
        '/api/OB11Config/GetConfig': {
          body: {
            code: 0,
            data: { network: { httpServers: [{ name: 'x', enable: true, port: 3000, host: '127.0.0.1' }] } },
            message: 'success',
          },
        },
      },
      seen,
    );
    const r = await pollQrLogin(fetcher, { webuiPort: 6109, token: PORT.token, onebotPort: 3000 });
    expect(r.onebotEnabled).toBe(true);
    expect(seen.some((s) => s.startsWith('/api/OB11Config/SetConfig|'))).toBe(false);
  });
});
