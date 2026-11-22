/**
 * 扫码登录代理：面板通过 `napcat_qr_login` 轮询受管实例的 WebUI，
 * 拿到登录二维码（转成 `data:` URL 给页面渲染）与扫码状态。
 *
 * NapCat WebUI 的鉴权与二维码协议（4.18.42 产物 bundle 内实测）：
 * 1. `POST /api/auth/login`，body `{ hash }`，hash = sha256(webui token + '.napcat')；
 *    成功返回 `{ code: 0, data: { Credential } }`——**后续请求用这个 Credential**，
 *    直接 Bearer 原始 token 会 Unauthorized；
 * 2. `POST /api/QQLogin/CheckLoginStatus` → `{ data: { isLogin, qrLoginAccepted, qrcodeurl } }`；
 *    `qrcodeurl` 是腾讯的扫码跳转链接（如 https://txz.qq.com/p?k=…）——
 *    WebUI 前端就是拿它在前端渲染二维码的，服务端没有现成图片可拉；
 * 3. 这里用 `qrcode-generator`（MIT）把该链接转成 `data:image/gif` 交给面板。
 *
 * WebUI token 与 Credential 全程只在本进程内使用，不经过面板。
 */
import { createHash } from 'node:crypto';
import qrLib from 'qrcode-generator';
import type { QrFetcher as WebuiFetch } from './qrfetch.js';

export type QrPhase = 'waiting' | 'accepted' | 'logined' | 'error';

export interface QrLoginResult {
  phase: QrPhase;
  message: string;
  qrDataUrl?: string;
}

/** 可注入的最小 fetch 形状（POST JSON）。 */
const WEBUI_TIMEOUT_MS = 8_000;

/** NapCat WebUI 的统一响应包装：`{ code, data, message }`。 */
interface WebuiEnvelope {
  code: number;
  data?: unknown;
  message?: string;
}

async function webuiPost(
  fetcher: WebuiFetch,
  url: string,
  credential: string,
  body: Record<string, unknown>,
): Promise<WebuiEnvelope> {
  const res = await fetcher(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WEBUI_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error('这个端口上的 WebUI 属于另一个实例（令牌不匹配）。请停掉其它 NapCat 实例，或改一组端口。');
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('WebUI 返回了无法解析的内容');
  }
  const envelope = parsed as WebuiEnvelope;
  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    throw new Error(envelope.message ?? 'WebUI 请求被拒绝');
  }
  return envelope;
}

/** 用 WebUI token 登录换 Credential（hash 加盐 `.napcat`，见 bundle 的 comparePasswordHash）。 */
async function webuiLogin(fetcher: WebuiFetch, port: number, token: string): Promise<string> {
  const hash = createHash('sha256').update(`${token}.napcat`).digest('hex');
  const envelope = await webuiPost(fetcher, `http://127.0.0.1:${port}/api/auth/login`, '', { hash });
  const data = envelope.data as { Credential?: unknown } | undefined;
  if (typeof data?.Credential !== 'string' || data.Credential === '') {
    throw new Error('WebUI 登录没有返回凭证');
  }
  return data.Credential;
}

function unwrap(envelope: WebuiEnvelope): Record<string, unknown> {
  return typeof envelope.data === 'object' && envelope.data !== null ? (envelope.data as Record<string, unknown>) : {};
}

/** 把腾讯的扫码跳转链接渲染成二维码 data URL（白底 GIF，深浅主题都可扫）。 */
function qrDataUrlOf(text: string): string {
  const qr = qrLib(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 4);
}

/**
 * 拉一次二维码 / 扫码状态。面板每两秒轮询一次：
 * waiting → 展示二维码；accepted → 已扫码待确认；logined → 登录完成。
 */
export async function pollQrLogin(
  fetcher: WebuiFetch,
  opts: { webuiPort: number; token: string },
): Promise<QrLoginResult> {
  const base = `http://127.0.0.1:${opts.webuiPort}`;
  let credential: string;
  try {
    credential = await webuiLogin(fetcher, opts.webuiPort, opts.token);
  } catch (err) {
    return {
      phase: 'error',
      message: `连不上 NapCat 的 WebUI：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let status: Record<string, unknown>;
  try {
    status = unwrap(await webuiPost(fetcher, `${base}/api/QQLogin/CheckLoginStatus`, credential, {}));
  } catch (err) {
    return {
      phase: 'error',
      message: `读取登录状态失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (status.isLogin === true) {
    return { phase: 'logined', message: '登录成功' };
  }
  if (status.qrLoginAccepted === true) {
    return { phase: 'accepted', message: '已扫码，请在手机上确认登录' };
  }

  const qrcodeUrl = typeof status.qrcodeurl === 'string' ? status.qrcodeurl : '';
  if (qrcodeUrl === '') {
    // NapCat 还在初始化 QQ 会话，二维码可能还没生成——下一轮轮询再取
    return { phase: 'waiting', message: '正在生成二维码…' };
  }
  return { phase: 'waiting', message: '请用手机 QQ 扫一扫', qrDataUrl: qrDataUrlOf(qrcodeUrl) };
}
