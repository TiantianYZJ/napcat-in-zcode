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
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import qrLib from 'qrcode-generator';
import type { QrFetcher as WebuiFetch } from './qrfetch.js';

const execFileAsync = promisify(execFile);

export type QrPhase = 'waiting' | 'accepted' | 'logined' | 'error';

export interface QrLoginResult {
  phase: QrPhase;
  message: string;
  qrDataUrl?: string;
  /** 电脑上的桌面 QQ 正在运行（同号会被顶号，扫码前要先退出它）。 */
  desktopQqRunning?: boolean;
  /** 登录成功后已把 OneBot HTTP Server 热开启（免重启 NapCat）。 */
  onebotEnabled?: boolean;
  /** OneBot 开启失败时的原因（成功则为空）。 */
  onebotMessage?: string;
  /** OneBot 开启成功后的端点（插件据此把自己连上去）。 */
  onebotEndpoint?: string;
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
 * WebUI 凭证缓存（端口 → 凭证）。
 *
 * **必须有**：登录接口有频率限制（webui.json 的 loginRate），而面板每 2 秒轮询一次
 * 扫码状态——每次都重新登录必然撞上限（表现为「login rate limit」）。
 * 凭证本身一小时有效，缓存复用即可。
 */
const credentialCache = new Map<number, { credential: string; at: number }>();
const CREDENTIAL_TTL_MS = 50 * 60 * 1000;

/** 取凭证：优先用缓存；没有或过期才登录一次。 */
async function credentialFor(
  fetcher: WebuiFetch,
  port: number,
  token: string,
): Promise<string> {
  const cached = credentialCache.get(port);
  if (cached && Date.now() - cached.at < CREDENTIAL_TTL_MS) return cached.credential;
  const credential = await webuiLogin(fetcher, port, token);
  credentialCache.set(port, { credential, at: Date.now() });
  return credential;
}

/**
 * 登录成功后**热开启 OneBot HTTP Server**。
 *
 * 为什么需要：NapCat 登录后会自建账号级 `onebot11_<uin>.json`，里面默认**不含**
 * 开启的 OneBot Server → 面板永远连不上。安装时写的全局配置会被账号级文件盖过优先级，
 * 靠重启 NapCat 生效对新手太重 —— WebUI 的 `OB11Config/SetConfig` 会热加载配置，
 * 这里直接用它开启（免重启）。
 *
 * **协议要点（NapCat 4.18.42 产物 bundle 内实测）**：
 * - `POST /api/OB11Config/GetConfig` → 返回**配置对象**（已按账号级/全局优先级解析）；
 * - `POST /api/OB11Config/SetConfig` → body 必须是 `{ config: "<JSON 字符串>" }`！
 *   服务端内部是 `JSON.parse(t.body.config)`，**传对象会被判为「config is empty」**。
 *   （早期版本传对象 → WebUI 回 `config is empty`，表现为「热开启永远失败」。）
 *
 * 写完配置 NapCat 会 `reloadNetwork` 热重载，但端口是**异步**开的 →
 * 必须等它真的监听上才算成功（否则会出现「说开了、连不上」）。
 */
async function ensureOneBotEnabled(
  fetcher: WebuiFetch,
  port: number,
  credential: string,
  onebotPort: number,
  probe: (port: number) => Promise<boolean>,
): Promise<{ onebotEnabled?: boolean; onebotMessage?: string; onebotEndpoint?: string }> {
  const base = `http://127.0.0.1:${port}`;
  let current: Record<string, unknown>;
  try {
    current = unwrap(await webuiPost(fetcher, `${base}/api/OB11Config/GetConfig`, credential, {}));
  } catch (err) {
    return {
      onebotEnabled: false,
      onebotMessage: `读取数据通道配置失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (Object.keys(current).length === 0) {
    return { onebotEnabled: false, onebotMessage: 'NapCat 没有返回数据通道配置' };
  }
  const network = (current.network ?? {}) as { httpServers?: unknown[] };
  const servers = Array.isArray(network.httpServers) ? [...network.httpServers] : [];
  const already = servers.some(
    (s) =>
      typeof s === 'object' &&
      s !== null &&
      (s as { enable?: boolean }).enable === true &&
      (s as { port?: number }).port === onebotPort,
  );
  if (!already) {
    servers.push({
      name: 'napcat-zcode',
      enable: true,
      port: onebotPort,
      host: '127.0.0.1',
      enableCors: false,
      enableWebsocket: false,
      messagePostFormat: 'array',
      token: '',
      debug: false,
    });
    try {
      await webuiPost(fetcher, `${base}/api/OB11Config/SetConfig`, credential, {
        // config 必须是 **JSON 字符串**（WebUI 内部按字符串解析）
        config: JSON.stringify({ ...current, network: { ...network, httpServers: servers } }),
      });
    } catch (err) {
      return {
        onebotEnabled: false,
        onebotMessage: `开启数据通道失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  // 等端口真的监听：热重载是异步的，立刻探会误判成失败
  const listening = await waitPortListening(onebotPort, 5000, probe);
  if (!listening) {
    return {
      onebotEnabled: false,
      onebotMessage: `NapCat 没有在 ${onebotPort} 端口上开数据通道`,
    };
  }
  return { onebotEnabled: true, onebotEndpoint: `http://127.0.0.1:${onebotPort}` };
}

/**
 * 等某个端口真的开始监听（最多等 `timeoutMs`）。
 *
 * 「配置写成功」≠「端口开了」——NapCat 热重载网络是异步的。
 * 提前返回会让面板说「已开启」而插件连不上，用户看到的是又一次死胡同。
 */
async function waitPortListening(
  port: number,
  timeoutMs: number,
  probe: (port: number) => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const step = 250;
  for (;;) {
    if (await probe(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** 默认的端口探活（真实 TCP 连接回环）。 */
async function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 拉一次二维码 / 扫码状态。面板每两秒轮询一次：
 * waiting → 展示二维码；accepted → 已扫码待确认；logined → 登录完成。
 *
 * `opts.refresh` = 强制换新凭证（重新登录 → 新的二维码；旧的扫码会话已作废时用）。
 * `opts.probePort` = 端口探活（测试注入；默认真实 TCP 连回环）。
 */
export async function pollQrLogin(
  fetcher: WebuiFetch,
  opts: {
    webuiPort: number;
    token: string;
    refresh?: boolean;
    onebotPort?: number;
    probePort?: (port: number) => Promise<boolean>;
  },
): Promise<QrLoginResult> {
  const base = `http://127.0.0.1:${opts.webuiPort}`;
  const probe = opts.probePort ?? tcpProbe;
  if (opts.refresh === true) credentialCache.delete(opts.webuiPort);
  let credential: string;
  try {
    credential = await credentialFor(fetcher, opts.webuiPort, opts.token);
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
    // 凭证失效（WebUI 重启过）→ 清缓存，下次轮询重新登录
    credentialCache.delete(opts.webuiPort);
    return {
      phase: 'error',
      message: `读取登录状态失败（WebUI 没响应）：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 登录失败原因优先透出（最常见：同号已在别处登录 → 扫码会被顶号）
  const loginError = typeof status.loginError === 'string' ? status.loginError.trim() : '';
  if (loginError !== '') {
    return {
      phase: 'error',
      message: `${loginError}。请先退出电脑 QQ 上的同一账号，再重新扫码。`,
    };
  }

  if (status.isLogin === true || status.coreReady === true) {
    // 登录成功 → 顺手把 OneBot HTTP Server 热开启（NapCat 登录后自建的账号级配置
    // 不含 OneBot Server，不开就永远连不上；WebUI 的 SetConfig 会热加载，免重启）
    const onebot = await ensureOneBotEnabled(
      fetcher,
      opts.webuiPort,
      credential,
      opts.onebotPort ?? 3000,
      probe,
    );
    return { phase: 'logined', message: '登录成功', ...onebot };
  }

  // 登录阶段比布尔字段可靠：waiting_qrcode → qrcode_scanned → initializing
  const loginPhase = typeof status.loginPhase === 'string' ? status.loginPhase : '';
  if (loginPhase === 'qrcode_scanned' || loginPhase === 'initializing' || status.qrLoginAccepted === true) {
    return { phase: 'accepted', message: '已扫码，请在手机上确认登录' };
  }

  const qrcodeUrl = typeof status.qrcodeurl === 'string' ? status.qrcodeurl : '';
  if (qrcodeUrl === '') {
    // NapCat 还在初始化 QQ 会话，二维码可能还没生成——下一轮轮询再取
    return { phase: 'waiting', message: '正在生成二维码…' };
  }
  const desktopQqRunning = await isDesktopQqRunning();
  return {
    phase: 'waiting',
    message: '请用手机 QQ 扫一扫',
    qrDataUrl: qrDataUrlOf(qrcodeUrl),
    desktopQqRunning,
  };
}

/**
 * 电脑上的桌面 QQ 是否在运行。
 *
 * **这是扫码失败的头号原因**：同一账号在桌面 QQ 已登录时，扫码会被顶号
 * （WebUI 返回「当前账号已登录，无法重复登录」）。提前告诉用户。
 */
async function isDesktopQqRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process QQ -ErrorAction SilentlyContinue) -ne $null"],
      { timeout: 5000 },
    );
    return stdout.trim().toLowerCase() === 'true';
  } catch {
    return false; // 查不到就当没有（不因此阻断扫码）
  }
}
