/**
 * 本地实时预览：浏览器里跑真实面板 + 真实 MCP server 后端。
 *
 *   node scripts/preview-server.mjs [端口]
 *
 * 结构：
 *   浏览器 (harness 页) ──iframe──> panel.html（面板 bundle）
 *        │ window.postMessage（MCP-UI 协议）
 *        ▼
 *   桥脚本（harness 内联）──fetch /rpc──> 本 HTTP 服务器 ──stdio──> dist/server.mjs（真实 MCP server）
 *
 * - `ui/initialize` 与 hostContext 由 harness 合成（宿主能力全开 + 跟随系统主题）；
 * - 其余请求（tools/call、resources/read）原样转发给真实 server 进程——
 *   检测、安装、扫码登录都是**真的**。
 * - 只监听 127.0.0.1。这是开发预览通道，不是插件运行时的组成部分。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, '..');
const PANEL_PATH = join(PLUGIN_DIR, 'dist', 'ui', 'panel.html');
const SERVER_PATH = join(PLUGIN_DIR, 'dist', 'server.mjs');
const PORT = Number(process.argv[2] ?? 6177);

// ── 真实 MCP server 子进程（stdio JSON-RPC） ────────────────────────
const child = spawn(process.execPath, [SERVER_PATH], {
  cwd: PLUGIN_DIR,
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
child.on('exit', (code) => {
  console.error(`[preview] MCP server 退出（${code}），预览结束`);
  process.exit(1);
});

let nextId = 1000;
/** JSON-RPC id → 待回的 HTTP 响应。 */
const pending = new Map();

let stdoutBuf = '';
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString('utf-8');
  // stdio JSON-RPC 用换行分帧（SDK 的传输层就是这样读的）
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (line === '') continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof frame.id === 'number' && pending.has(frame.id)) {
      const { resolve: done, reject: fail, timer } = pending.get(frame.id);
      pending.delete(frame.id);
      clearTimeout(timer);
      if (frame.error) fail(new Error(frame.error.message ?? 'server error'));
      else done(frame.result ?? {});
    }
  }
});

function rpc(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`server timeout: ${method}`));
    }, 60_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

// 先对子进程完成 MCP 握手：SDK 在 initialize 之前会拒绝工具调用
const initialized = (async () => {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'preview-bridge', version: '0.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  console.log('[preview] MCP server 握手完成');
})().catch((err) => {
  console.error('[preview] MCP server 握手失败：', err);
  process.exit(1);
});

// ── HTTP：静态面板 + /rpc 转发 ──────────────────────────────────────
const panelHtml = readFileSync(PANEL_PATH, 'utf-8');

const HARNESS = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>NapCat 面板 · 实时预览</title>
<style>
  html, body { margin: 0; height: 100%; background: var(--color-background, #161616); }
  body { display: flex; justify-content: center; }
  #frame { height: 100%; width: min(100%, 520px); border: none; border-left: 1px solid #333; border-right: 1px solid #333; }
  @media (max-width: 560px) { #frame { width: 100%; border: none; } }
</style>
</head>
<body>
<iframe id="frame" src="/panel.html"></iframe>
<script>
// 桥：panel（iframe）的 MCP-UI 协议 ↔ 真实 server（/rpc）。
(function () {
  const frame = document.getElementById('frame');
  let seq = 0;
  const waiting = new Map();
  frame.addEventListener('load', () => {
    window.addEventListener('message', async (ev) => {
      const data = ev.data;
      if (!data || data.jsonrpc !== '2.0' || typeof data.method !== 'string') return;
      if (data.method === 'ui/initialize') {
        // 合成宿主握手：能力全开 + 跟随系统主题（面板自己读 prefers-color-scheme 由 CSS media 决定——
        // 这里直接给 light；theme 变化没有真实宿主，保持 light）
        replyTo(data, {
          protocolVersion: data.params?.protocolVersion ?? '2026-01-26',
          hostCapabilities: { message: {}, updateModelContext: {}, downloadFile: {}, serverTools: {}, openLinks: {} },
          hostContext: { theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' },
        });
        return;
      }
      // 其余请求：转发给真实 server
      const rid = ++seq;
      const done = (result) => {
        if (!waiting.has(rid)) return;
        waiting.delete(rid);
        replyTo(data, result ?? {});
      };
      const fail = (message) => {
        if (!waiting.has(rid)) return;
        waiting.delete(rid);
        replyTo(data, { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] });
      };
      waiting.set(rid, true);
      try {
        const res = await fetch('/rpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: data.method, params: data.params ?? {} }),
        });
        const payload = await res.json();
        if (payload.error) fail(payload.error.message ?? 'server error');
        else done(payload.result);
      } catch (e) {
        fail(String(e && e.message ? e.message : e));
      }
    });
    function replyTo(req, result) {
      frame.contentWindow.postMessage({ jsonrpc: '2.0', id: req.id, result }, '*');
    }
  });
})();
</script>
</body>
</html>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (url.pathname === '/panel.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(panelHtml);
      return;
    }
    if (url.pathname === '/rpc' && req.method === 'POST') {
      await initialized;
      let body = '';
      for await (const chunk of req) body += chunk;
      const { method, params } = JSON.parse(body);
      const result = await rpc(method, params);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ result }));
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HARNESS);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[preview] 实时预览已启动：http://127.0.0.1:${PORT}`);
  console.log('[preview] 后端是真实 MCP server（检测 / 安装 / 扫码都是真的）。Ctrl+C 停止。');
});
