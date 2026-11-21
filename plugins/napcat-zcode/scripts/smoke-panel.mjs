/**
 * 端到端冒烟：构建出的面板产物（dist/ui/panel.html）在 DOM 中加载，
 * 由一个「说 MCP-UI 协议的模拟宿主」驱动，验证渲染与交互状态机。
 *
 * 覆盖单测覆盖不到的层面：Vite 单文件打包后的真实产物、
 * 宿主 postMessage 协议的真实往返、置灰/启用状态机的真实迁移。
 *
 * 用法：node scripts/smoke-panel.mjs   （退出码 0 = 全通过）
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, '..');
const PANEL = join(PLUGIN_DIR, 'dist', 'ui', 'panel.html');

const require = createRequire(join(PLUGIN_DIR, 'package.json'));
const { JSDOM } = require('jsdom');

if (!existsSync(PANEL)) {
  console.error(`未找到构建产物 ${PANEL}，请先运行 npm run build`);
  process.exit(1);
}

const raw = readFileSync(PANEL, 'utf-8');
// jsdom 不执行 type="module"；产物本身是无 import/export 的自包含 IIFE，
// 因此先剥离 module 脚本让 DOM 解析完成，再用 window.eval 在窗口作用域执行同一份代码
// （等价于浏览器对 module 脚本的延迟执行语义）。
const m = raw.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到面板脚本'); process.exit(1); }
const bundle = m[1];
const html = raw.replace(/<script type="module"[^>]*>[\s\S]*?<\/script>/, '');

const TOOL_RESULTS = {
  napcat_status: { configured: true, connected: true, mode: 'external', login: { user_id: '1', nickname: '模拟宿主' } },
  napcat_list_chats: (args) => ({
    chats: args?.kind === 'group'
      ? [{ kind: 'group', id: '12345', name: '冒烟群' }, { kind: 'group', id: '222', name: '另一个群' }]
      : [{ kind: 'friend', id: '777', name: '冒烟好友' }],
  }),
  napcat_get_history: {
    messages: [
      { id: 'a', seq: 101, time: 1700000000, senderId: '1', senderName: 'Alice', segments: [{ kind: 'text', text: '场地定了吗？' }], text: '场地定了吗？' },
      { id: 'b', seq: 102, time: 1700000060, senderId: '2', senderName: 'Bob', segments: [{ kind: 'text', text: '定了，周五十点' }], text: '定了，周五十点' },
      { id: 'c', seq: 103, time: 1700000120, senderId: '3', senderName: 'Carol', segments: [{ kind: 'image', url: 'https://x/i.png' }], text: '[图片]' },
    ],
    nextBeforeTime: 1700000000,
    exhausted: false,
  },
  napcat_get_config: { connection: { mode: 'auto', endpoint: 'http://127.0.0.1:3000', token: '' }, export: { dir: 'user', includeImages: false } },
};

const calls = [];
const steps = [];
const check = (name, ok, detail) => {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://localhost/panel.html',
  pretendToBeVisual: true,
  beforeParse(window) {
    const host = {
      postMessage(msg) {
        calls.push(msg);
        const reply = (result) => {
          window.setTimeout(() => {
            window.dispatchEvent(new window.MessageEvent('message', { data: { jsonrpc: '2.0', id: msg.id, result } }));
          }, 0);
        };
        if (msg.method === 'ui/initialize') {
          reply({ protocolVersion: '2026-01-26', hostCapabilities: { message: {}, updateModelContext: {}, downloadFile: {}, serverTools: {} } });
        } else if (msg.method === 'tools/call') {
          const fn = TOOL_RESULTS[msg.params.name];
          const data = typeof fn === 'function' ? fn(msg.params.arguments ?? {}) : fn;
          reply({ content: [{ type: 'text', text: JSON.stringify(data ?? {}) }] });
        } else {
          reply({});
        }
      },
    };
    Object.defineProperty(window, 'parent', { value: host, configurable: true });
    window.scrollTo = () => {};
  },
});

const { window } = dom;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (sel) => window.document.querySelector(sel);
const qa = (sel) => Array.from(window.document.querySelectorAll(sel));
const click = (el) => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

try {
  window.eval(bundle);
  await sleep(600);
  check('面板脚本执行后有内容渲染', (window.document.body.textContent || '').length > 0);

  const statusbar = q('[data-testid="statusbar"]');
  check('状态条渲染且显示已连接', !!statusbar && /已连接/.test(statusbar.textContent || ''), statusbar?.textContent?.slice(0, 40));

  const chats = qa('[data-testid^="chat-"]').filter((el) => el.getAttribute('data-testid') !== 'chat-search');
  check('会话列表渲染出 3 个会话且不重复', chats.length === 3, chats.map((c) => c.getAttribute('data-testid')).join(','));

  const msgBtn = q('[data-testid="act-message"]');
  check('未打开会话时动作按钮置灰且有原因', msgBtn?.disabled === true && !!msgBtn.getAttribute('data-reason'), msgBtn?.getAttribute('data-reason'));

  // 会话项的 testid 带 kind（群与好友的 id 是两套编号空间，数值可以完全相同）
  click(q('[data-testid="chat-group-12345"]'));
  await sleep(400);
  const msgs = qa('[data-testid^="msg-"]');
  check('点击会话后消息流渲染出 3 条', msgs.length === 3, msgs.map((m) => m.getAttribute('data-testid')).join(','));
  check('消息行含发言人名与正文',
    (msgs[0]?.textContent || '').includes('Alice') && (msgs[0]?.textContent || '').includes('场地定了吗'),
    msgs[0]?.textContent?.slice(0, 40));

  const msgBtn2 = q('[data-testid="act-message"]');
  check('打开会话后动作按钮仍置灰（未选消息）', msgBtn2?.disabled === true, msgBtn2?.getAttribute('data-reason'));

  const selBefore = q('[data-testid="sel-count"]')?.textContent || '';
  click(msgs[1]);
  await sleep(150);
  const selAfter = q('[data-testid="sel-count"]')?.textContent || '';
  check('点击消息后选中计数变化', selBefore !== selAfter && /已选 1 条/.test(selAfter), `${selBefore} → ${selAfter}`);

  const msgBtn3 = q('[data-testid="act-message"]');
  check('选中消息后「发送到对话」可点', msgBtn3?.disabled === false, msgBtn3?.getAttribute('data-reason') || 'enabled');

  check('动作条按钮齐全', ['act-message', 'act-context', 'act-attach', 'act-export'].every((id) => q(`[data-testid="${id}"]`)));

  // 设置面板：M2 Task 5 加了「本机 NapCat 扫描路径」编辑区（B8）
  click(q('[data-testid="settings-btn"]'));
  await sleep(200);
  check('设置面板里有扫描路径输入区与保存按钮',
    !!q('[data-testid="paths-input"]') && !!q('[data-testid="paths-save"]'),
    q('[data-testid="paths-input"]') ? 'paths-input ok' : 'paths-input missing');
  click(q('[data-testid="settings-close"]'));
  await sleep(100);
  check('设置面板能关闭', !q('[data-testid="settings-panel"]'));

  const toolCalls = calls.filter((c) => c.method === 'tools/call').map((c) => c.params.name);
  check('面板通过 tools/call 取数', toolCalls.includes('napcat_status') && toolCalls.includes('napcat_get_history'), [...new Set(toolCalls)].join(','));

  check('宿主握手被发出', calls.some((c) => c.method === 'ui/initialize'), calls.map((c) => c.method).join(','));
} catch (e) {
  check('面板冒烟异常', false, e.message);
} finally {
  window.close();
}

const failed = steps.filter((s) => !s.ok);
console.log(`\n${steps.length - failed.length}/${steps.length} 步通过`);
if (failed.length) {
  console.log('失败项：\n' + failed.map((f) => '  - ' + f.name).join('\n'));
}
process.exit(failed.length ? 1 : 0);
