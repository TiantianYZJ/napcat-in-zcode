import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTools } from './tools.js';
import { registerPanelResource } from './uiresource.js';
import { appState, closeConnection } from './state.js';

// 打包产物是 dist/server.mjs → here = dist/ → 面板在 dist/ui/panel.html
const here = dirname(fileURLToPath(import.meta.url));

const server = new McpServer({ name: 'napcat', version: '0.1.0' });
registerTools(server, appState);
registerPanelResource(server, join(here, 'ui', 'panel.html'));

// stdio 传输：stdout 是协议通道，**不能**往 stdout 写任何日志（只能写 stderr）。
await server.connect(new StdioServerTransport());

/**
 * 关闭钩子：传输层关闭时把 OneBot 连接也收掉。
 *
 * 没有它的话，`ws://` 端点的连接会一直挂到进程被强杀为止
 * （MCP SDK 的 `_onclose` 只回调 `onclose`，不会替我们关客户端）。
 * 这里**不**注册 SIGTERM/SIGINT 处理器——那会吞掉宿主的终止信号、让进程退不掉。
 *
 * 注意 `McpServer` 是包装类：真正带 `onclose` 的是它内部的 `Server` 实例。
 */
server.server.onclose = () => {
  void closeConnection(appState);
};
