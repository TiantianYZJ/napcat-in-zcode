/**
 * 扫码登录代理：面板通过 `napcat_qr_login` 轮询受管实例的 WebUI，
 * 拿到登录二维码（转成 `data:` URL 给页面渲染）与扫码状态。
 *
 * WebUI 的 token 只在服务端使用（调本机回环的 WebUI API），不经过面板。
 * 目标永远是受管安装自己的 WebUI（127.0.0.1），与出网红线无关
 * （那条线约束的是外网下载；OneBot/WebUI 本就是本机服务）。
 */

export type QrPhase = 'waiting' | 'accepted' | 'logined' | 'error';

export interface QrLoginResult {
  phase: QrPhase;
  message: string;
  qrDataUrl?: string;
}

/** 可注入的最小 fetch 形状。 */
export type WebuiFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

const WEBUI_TIMEOUT_MS = 8_000;

async function webuiJson(
  fetcher: WebuiFetch,
  url: string,
  token: string,
): Promise<Record<string, unknown>> {
  const res = await fetcher(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(WEBUI_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    // 常见于端口冲突：这个端口上的 WebUI 是**另一个**实例的，令牌自然对不上
    throw new Error('这个端口上的 WebUI 属于另一个实例（令牌不匹配）。请停掉其它 NapCat 实例，或在插件设置里换一个 WebUI 端口。');
  }
  if (!res.ok) {
    throw new Error(`WebUI 返回了 ${res.status}`);
  }
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('WebUI 返回了无法解析的内容');
  }
}

/** 二维码字段 → data: URL。WebUI 可能给 data URL，也可能给一个本机图片地址。 */
async function toDataUrl(fetcher: WebuiFetch, qrcode: string, token: string): Promise<string | undefined> {
  if (qrcode.startsWith('data:image')) return qrcode;
  if (qrcode.startsWith('http://') || qrcode.startsWith('https://')) {
    const res = await fetcher(qrcode, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(WEBUI_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const type = (res.headers.get('content-type') ?? 'image/png').split(';')[0];
    const buf = await res.arrayBuffer();
    return `data:${type};base64,${Buffer.from(buf).toString('base64')}`;
  }
  return undefined;
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
  let status: Record<string, unknown>;
  try {
    status = await webuiJson(fetcher, `${base}/api/QQLogin/CheckLoginStatus`, opts.token);
  } catch (err) {
    return {
      phase: 'error',
      message: `连不上 NapCat 的 WebUI：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (status.isLogin === true) {
    return { phase: 'logined', message: '登录成功' };
  }
  if (status.qrLoginAccepted === true) {
    return { phase: 'accepted', message: '已扫码，请在手机上确认登录' };
  }
  let qrcode: unknown;
  try {
    const qr = await webuiJson(fetcher, `${base}/api/QQLogin/GetQQLoginQrcode`, opts.token);
    qrcode = qr.qrcode;
  } catch (err) {
    return {
      phase: 'error',
      message: `二维码获取失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (typeof qrcode !== 'string' || qrcode === '') {
    return { phase: 'error', message: '二维码获取失败。' };
  }
  const qrDataUrl = await toDataUrl(fetcher, qrcode, opts.token);
  if (!qrDataUrl) {
    return { phase: 'error', message: '二维码图片下载失败。' };
  }
  return { phase: 'waiting', message: '请用手机 QQ 扫一扫', qrDataUrl };
}
