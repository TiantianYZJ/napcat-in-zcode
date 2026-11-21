import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { classifyHost } from './host/download.js';

/**
 * 聊天图片的**只读代理资源**：面板不能直接 `<img src=外域URL>` ——
 * MCP Apps 的默认 CSP 是 `img-src 'self' data:`（宿主不得放行未声明的域，
 * 而 QQ 的图片 CDN 域不固定），外域图片会被宿主拦掉。
 *
 * 规范内的唯一通路：面板 `readServerResource` → 服务端拉图 → `blob`（base64）
 * 返回 → 面板转成 `data:` URL 渲染（`img-src data:` 是放行的）。
 * `resources/read` 的结果**只给发起请求的页面，不进模型上下文** ——
 * 图片字节不会撑爆对话。
 *
 * 安全边界（这是服务端一次**主动出网**，按生成前安全约束做全）：
 * - 仅 `https:`；
 * - host 必须**公网**（复用下载器的 `classifyHost`：拒绝回环 / 内网 / 保留地址，
 *   含 IPv4-mapped IPv6 的展开判定）；
 * - **每一跳重定向**都重新校验协议与 host（手动跟随，最多 3 跳，不交给 fetch 自动跟）；
 * - 响应 `content-type` 必须 `image/*`；
 * - 大小上限 8 MB、总超时 15 s（超限直接失败，面板回退占位符）。
 */

/** 允许的最大图片字节数。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** 重定向跟随上限（手动逐跳校验）。 */
export const MAX_IMAGE_REDIRECTS = 3;
/** 拉图总超时（毫秒）。 */
export const IMAGE_TIMEOUT_MS = 15_000;

/** 图片资源的 URI 前缀（模板：ui://napcat-zcode/image/{urlB64}）。 */
export const IMAGE_URI_PREFIX = 'ui://napcat-zcode/image/';

/** 测试可注入的最小 fetch 形状（对齐全局 fetch 用到的子集）。 */
export type ImageFetch = (
  url: string,
  init?: { redirect?: 'manual'; signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** base64url 编码（URL 模板变量里不能出现 / + =）。 */
export function encodeImageUrl(url: string): string {
  return Buffer.from(url, 'utf-8').toString('base64url');
}

/** 解码模板变量；坏编码 → undefined。 */
export function decodeImageUrl(raw: string): string | undefined {
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf-8');
    return text && /^https?:\/\//i.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** 一跳是否允许访问（协议 + host 分类）。不允许时返回人话原因。 */
export function assertImageHopAllowed(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('图片地址无法解析。');
  }
  if (url.protocol !== 'https:') {
    throw new Error('图片地址必须是 https。');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('图片地址不允许携带凭据。');
  }
  if (classifyHost(url.hostname) !== 'public') {
    throw new Error('图片地址不是公网地址，已拒绝访问。');
  }
}

interface FetchedImage {
  mimeType: string;
  base64: string;
}

/** 拉一张图（校验 + 手动重定向 + 大小/类型限制）。 */
async function fetchImage(rawUrl: string, fetcher: ImageFetch): Promise<FetchedImage> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_IMAGE_REDIRECTS; hop++) {
    assertImageHopAllowed(current);
    const res = await fetcher(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    const status = res.status;
    if (status >= 300 && status < 400) {
      const location = res.headers.get('location');
      if (!location || hop === MAX_IMAGE_REDIRECTS) {
        throw new Error('图片地址重定向过多或缺少目标。');
      }
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) {
      throw new Error(`图片下载失败（HTTP ${status}）。`);
    }
    const mimeType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (!mimeType.startsWith('image/')) {
      throw new Error('目标不是图片（content-type 不是 image/*）。');
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('图片超过 8 MB，不予加载。');
    }
    return { mimeType, base64: Buffer.from(buf).toString('base64') };
  }
  throw new Error('图片地址重定向过多。');
}

/** 提取资源 URI 里的 urlB64 变量（兼容 SDK 传整条 href）。 */
function extractEncoded(href: string): string | undefined {
  const prefix = IMAGE_URI_PREFIX;
  if (!href.startsWith(prefix)) return undefined;
  const rest = href.slice(prefix.length);
  // 形如 ui://napcat-zcode/image/{urlB64}；SDK 可能补查询串，截掉
  return rest.split('?')[0]?.split('/')[0] || undefined;
}

/**
 * 注册聊天图片资源模板：`ui://napcat-zcode/image/{urlB64}`。
 *
 * @param fetcher 测试注入点；生产传全局 fetch 的适配。
 */
export function registerImageResource(server: McpServer, fetcher: ImageFetch): void {
  const template = new ResourceTemplate('ui://napcat-zcode/image/{urlB64}', {
    list: undefined, // 图片按需读取，没有可枚举的静态清单
  });
  server.registerResource(
    'chat-image',
    template,
    { description: '按需拉取聊天图片（仅 https 公网地址，结果只给面板）' },
    async (uri) => {
      const encoded = extractEncoded(uri.href);
      const url = encoded ? decodeImageUrl(encoded) : undefined;
      if (!url) {
        throw new Error('图片资源 URI 无效（无法还原图片地址）。');
      }
      const image = await fetchImage(url, fetcher);
      return {
        contents: [{ uri: uri.href, mimeType: image.mimeType, blob: image.base64 }],
      };
    },
  );
}
