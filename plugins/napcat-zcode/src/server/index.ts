import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerTools } from './tools.js';
import { registerPanelResource } from './uiresource.js';
import { appState } from './state.js';

// 打包产物是 dist/server.mjs → here = dist/ → 面板在 dist/ui/panel.html
const here = dirname(fileURLToPath(import.meta.url));

const server = new McpServer({ name: 'napcat', version: '0.1.0' });
registerTools(server, appState);
registerPanelResource(server, join(here, 'ui', 'panel.html'));

// stdio 传输：stdout 是协议通道，**不能**往 stdout 写任何日志（只能写 stderr）。
await server.connect(new StdioServerTransport());
