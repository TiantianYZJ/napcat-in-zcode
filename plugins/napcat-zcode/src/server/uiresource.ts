import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** 面板资源 URI（与清单 `ui.surfaces[0].resourceUri` 必须一致）。 */
export const PANEL_URI = 'ui://napcat-zcode/panel.html';
/** 宿主强制校验的 mimeType：不是它就不认这个资源是 MCP App 面板。 */
export const PANEL_MIME = 'text/html;profile=mcp-app';

const ERROR_HTML =
  '<!doctype html><html><body><p>panel.html missing — run `npm run build`</p></body></html>';

/**
 * 注册面板 UI 资源。
 *
 * 面板 HTML 由 vite 打成单文件（`dist/ui/panel.html`），随插件一起分发；
 * 文件缺失时返回一段内嵌的错误页，而不是让整个资源读取失败。
 */
export function registerPanelResource(server: McpServer, htmlPath: string): void {
  server.registerResource('panel', PANEL_URI, { mimeType: PANEL_MIME }, async (uri) => {
    let html: string;
    try {
      html = readFileSync(htmlPath, 'utf-8');
    } catch {
      html = ERROR_HTML;
    }
    return { contents: [{ uri: uri.href, mimeType: PANEL_MIME, text: html }] };
  });
}
