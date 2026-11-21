/**
 * 真机验证：连真实的 NapCat（OneBot 11）端点，跑通插件的完整工具链，
 * 并**实测**三条此前只能靠推断的 NapCat 语义。
 *
 * 前置条件：
 *   1. NapCat 正在运行，且已开启 OneBot Server（默认 http://127.0.0.1:3000）
 *      —— 见 docs/acceptance-m1.md §2「配置 NapCat」
 *   2. 已 npm run build（脚本跑的是构建产物 dist/server.mjs）
 *
 * 用法：
 *   node scripts/verify-live-napcat.mjs [endpoint]      # 默认 http://127.0.0.1:3000
 *   NAPCAT_ENDPOINT=http://127.0.0.1:3001 node scripts/verify-live-napcat.mjs
 *
 * 退出码 0 = 全部通过；非 0 = 有失败项（详见输出）。
 * 注意：导出会落在临时 HOME 下，不污染用户真实导出目录。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(HERE, '..');
const SERVER = join(PLUGIN_DIR, 'dist', 'server.mjs');
const ENDPOINT = process.argv[2] || process.env.NAPCAT_ENDPOINT || 'http://127.0.0.1:3000';

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n        ' + String(detail).replace(/\n/g, '\n        ') : ''}`);
};
const info = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);

// ── 直接打 OneBot 端点 ─────────────────────────────────────────────
async function ob(action, params = {}) {
  const res = await fetch(`${ENDPOINT.replace(/\/$/, '')}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json();
  if (json.retcode !== 0) throw new Error(`${action} 失败：${json.wording || json.message || json.retcode}`);
  return json.data;
}

console.log(`端点：${ENDPOINT}`);

// ── 0. 连通性 ───────────────────────────────────────────────────────
info('0. 连通性');
let login;
try {
  login = await ob('get_login_info');
  record('OneBot 端点可达', true, `已登录：${login.nickname}（${login.user_id}）`);
} catch (e) {
  record('OneBot 端点可达', false, `${e.message}\n        端点未就绪。请确认 NapCat 已启动且开启了 OneBot Server。`);
  console.log('\n0/1 步通过（端点未就绪，后续检查无法进行）');
  process.exit(1);
}

const groups = await ob('get_group_list');
const friends = await ob('get_friend_list');
record('get_group_list / get_friend_list', Array.isArray(groups) && Array.isArray(friends),
  `群 ${groups.length} 个 / 好友 ${friends.length} 个`);

const chat = groups[0] || friends[0];
if (!chat) {
  record('存在可读取的会话', false, '该账号没有任何群或好友，无法继续');
  process.exit(1);
}
const isGroup = groups.length > 0;
const chatId = String(isGroup ? chat.group_id : chat.user_id);
const chatName = isGroup ? chat.group_name : chat.nickname;
const histAction = isGroup ? 'get_group_msg_history' : 'get_friend_msg_history';
const idKey = isGroup ? 'group_id' : 'user_id';
record('选定会话', true, `${chatName}（${histAction} ${chatId}）`);

// ── 1. 实测 message_seq 的边界语义 ──────────────────────────────────
info('1. 实测 message_seq 边界语义（独占 vs 包含）');
const page = await ob(histAction, { [idKey]: chatId, count: 20 });
const msgs = page.messages || [];
const seqs = msgs.map((m) => m.message_seq).filter((s) => typeof s === 'number');
record('拉到消息', msgs.length > 0, `本页 ${msgs.length} 条，seq 范围 ${Math.min(...seqs)}..${Math.max(...seqs)}`);

if (msgs.length >= 2) {
  const minSeq = Math.min(...seqs);
  const midSeq = seqs.slice().sort((a, b) => a - b)[Math.floor(seqs.length / 2)];
  const bySeq = (list) => new Set((list.messages || []).map((m) => m.message_seq));

  // 用一个「确实存在」的 seq 作为锚点：若返回结果里仍含该 seq → 包含语义；不含 → 独占语义
  const atAnchor = await ob(histAction, { [idKey]: chatId, message_seq: String(midSeq), count: 20 });
  const atSet = bySeq(atAnchor);
  const inclusive = atSet.has(midSeq);

  // 锚点 ±1 的对比
  const atAnchorMinus = await ob(histAction, { [idKey]: chatId, message_seq: String(midSeq - 1), count: 20 });
  const atAnchorPlus = await ob(histAction, { [idKey]: chatId, message_seq: String(midSeq + 1), count: 20 });
  const setMinus = bySeq(atAnchorMinus);
  const setPlus = bySeq(atAnchorPlus);

  const boundary = inclusive
    ? '包含语义：message_seq = s 会返回 seq <= s（含锚点本身）'
    : '独占语义：message_seq = s 只返回 seq < s（不含锚点本身）';
  record('message_seq 边界语义已实测', true,
    `${boundary}\n        锚点 seq=${midSeq}：请求 s=${midSeq} → 命中锚点=${atSet.has(midSeq)}；请求 s=${midSeq - 1} → 命中锚点=${setMinus.has(midSeq)}；请求 s=${midSeq + 1} → 命中锚点=${setPlus.has(midSeq)}\n        → 插件据此选择游标偏移：${inclusive ? '应当用 cursor（不 +1）' : '应当用 cursor + 1'}`);

  // cursor+1 区间边界的实际效果
  const viaPlus1 = new Set([...(await ob(histAction, { [idKey]: chatId, message_seq: String(minSeq + 1), count: 20 })).messages || []]
    .map((m) => m.message_seq));
  const viaCursor = new Set([...(await ob(histAction, { [idKey]: chatId, message_seq: String(minSeq), count: 20 })).messages || []]
    .map((m) => m.message_seq));
  record('cursor+1 与 cursor 的差异已实测', true,
    `以本页最小 seq=${minSeq} 为界：请求 s=${minSeq} 返回 ${viaCursor.size} 条（含 seq>=${minSeq} 的? ${[...viaCursor].some((s) => s >= minSeq)}）；请求 s=${minSeq + 1} 返回 ${viaPlus1.size} 条（含 seq>=${minSeq + 1} 的? ${[...viaPlus1].some((s) => s >= minSeq + 1)}）`);
} else {
  record('message_seq 边界语义已实测', false, '该会话消息不足 2 条，无法构造锚点');
}

// ── 2. 实测 count 是否被守约 ───────────────────────────────────────
info('2. 实测 count 是否被守约');
const small = await ob(histAction, { [idKey]: chatId, count: 3 });
const big = await ob(histAction, { [idKey]: chatId, count: 50 });
record('count 被服务端守约', (small.messages || []).length <= 3,
  `请求 count=3 → 返回 ${(small.messages || []).length} 条；请求 count=50 → 返回 ${(big.messages || []).length} 条`);

// ── 3. 实测 message_seq=0 的行为 ───────────────────────────────────
info('3. 实测 message_seq=0 的行为');
try {
  const zero = await ob(histAction, { [idKey]: chatId, message_seq: '0', count: 5 });
  const zeroSeqs = (zero.messages || []).map((m) => m.message_seq);
  const latest = await ob(histAction, { [idKey]: chatId, count: 5 });
  const latestSeqs = (latest.messages || []).map((m) => m.message_seq);
  const same = JSON.stringify(zeroSeqs) === JSON.stringify(latestSeqs);
  record('message_seq=0 的行为已实测', true,
    `seq=0 返回 ${(zero.messages || []).length} 条 ${JSON.stringify(zeroSeqs)}；不带参数返回 ${(latest.messages || []).length} 条 ${JSON.stringify(latestSeqs)} → ${same ? '两者相同（0 被当作「最新页」，插件不会因 seq=0 而错乱）' : '两者不同（0 不是「最新页」，插件的 minSeq-1 探测会落到意料之外的位置）'}`);
} catch (e) {
  record('message_seq=0 的行为已实测', true, `服务端对 seq=0 直接报错：${e.message}（插件不会下发 0，除极端边界）`);
}

// ── 4. 实测 record 段的时长字段名 ──────────────────────────────────
info('4. 实测 record（语音）段的时长字段名');
const scan = [];
for (const c of groups.slice(0, 5)) {
  const p = await ob('get_group_msg_history', { group_id: String(c.group_id), count: 50 }).catch(() => ({ messages: [] }));
  scan.push(...(p.messages || []));
}
for (const f of friends.slice(0, 5)) {
  const p = await ob('get_friend_msg_history', { user_id: String(f.user_id), count: 50 }).catch(() => ({ messages: [] }));
  scan.push(...(p.messages || []));
}
const recordSegs = scan.flatMap((m) => (m.message || []).filter((s) => s.type === 'record'));
const keyTally = {};
for (const s of recordSegs) for (const k of Object.keys(s.data || {})) keyTally[k] = (keyTally[k] || 0) + 1;
const durationKeys = ['seconds', 'duration', 'time'].filter((k) => keyTally[k]);
record('record 段时长字段名已实测', true,
  `扫描 ${scan.length} 条消息、${recordSegs.length} 个 record 段；出现的字段：${JSON.stringify(keyTally)}\n        → 时长候选字段中真实存在的是：${durationKeys.length ? durationKeys.join(', ') : '（本次样本里没有 record 段，时长字段名仍未确定）'}`);
if (recordSegs.length === 0) {
  record('record 样本充足（可用于判定时长字段名）', false, '样本里没有语音消息，需换一个含语音的会话再跑一次');
}

// ── 5. 跑插件自身的工具链（真实产物 over stdio）─────────────────────
info('5. 插件工具链（真实 dist/server.mjs over stdio）');
if (!existsSync(SERVER)) {
  record('构建产物存在', false, `未找到 ${SERVER}，请先 npm run build`);
} else {
  const DATA = mkdtempSync(join(tmpdir(), 'napcat-live-data-'));
  const FAKE_HOME = mkdtempSync(join(tmpdir(), 'napcat-live-home-'));
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ZCODE_PLUGIN_DATA: DATA, HOME: FAKE_HOME, USERPROFILE: FAKE_HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
    }
  });
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  let seq = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = ++seq;
    waiters.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => rej(new Error(`${method} 超时`)), 20000);
  });
  const toolText = (r) => JSON.parse(r.content[0].text);

  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live', version: '0.0.1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    record('插件 server 启动并握手', true);

    const cfg = toolText(await rpc('tools/call', { name: 'napcat_configure', arguments: { endpoint: ENDPOINT } }));
    record('napcat_configure 连上真实 NapCat', cfg.connected === true, JSON.stringify(cfg));

    const st = toolText(await rpc('tools/call', { name: 'napcat_status', arguments: {} }));
    record('napcat_status 已连接', st.connected === true, JSON.stringify(st));

    const list = toolText(await rpc('tools/call', { name: 'napcat_list_chats', arguments: { kind: isGroup ? 'group' : 'friend' } }));
    record('napcat_list_chats 取到真实会话', (list.chats || []).length > 0, `${(list.chats || []).length} 个`);

    const hist = toolText(await rpc('tools/call', { name: 'napcat_get_history', arguments: { chatKind: isGroup ? 'group' : 'friend', chatId, count: 20 } }));
    record('napcat_get_history 取到真实消息', (hist.messages || []).length > 0,
      `${(hist.messages || []).length} 条，seq=${(hist.messages || []).slice(0, 5).map((m) => m.seq).join(',')}`);

    const older = toolText(await rpc('tools/call', { name: 'napcat_get_history', arguments: { chatKind: isGroup ? 'group' : 'friend', chatId, count: 20, beforeSeq: hist.nextBeforeSeq } }));
    const firstSeq = older.messages?.[0]?.seq;
    record('插件游标翻页取到更早的真实消息', (older.messages || []).length > 0 && (firstSeq === undefined || firstSeq < hist.messages[0].seq),
      `${(older.messages || []).length} 条，最早 seq=${firstSeq}（本页最早 seq=${hist.messages?.[0]?.seq}）`);

    const fmt = toolText(await rpc('tools/call', { name: 'napcat_format_selection', arguments: { messages: hist.messages || [], chatName } }));
    record('napcat_format_selection 产出注入文本', typeof fmt.text === 'string' && fmt.text.length > 0, `首行：${String(fmt.text).split('\n')[0].slice(0, 60)}…（共 ${fmt.count} 条）`);

    const exp = toolText(await rpc('tools/call', { name: 'napcat_export', arguments: { messages: hist.messages || [], chat: { kind: isGroup ? 'group' : 'friend', id: chatId, name: chatName } } }));
    const mdOk = existsSync(exp.mdPath) && readFileSync(exp.mdPath, 'utf-8').length > 0;
    record('napcat_export 导出真实记录到文件', mdOk, `${exp.mdPath}`);

    const searched = toolText(await rpc('tools/call', { name: 'napcat_search_messages', arguments: { chatKind: isGroup ? 'group' : 'friend', chatId, query: '的' } }));
    record('napcat_search_messages 在真实数据上扫描', typeof searched.scanned === 'number',
      `scanned=${searched.scanned} hits=${(searched.hits || []).length} note=${String(searched.note || '').slice(0, 60)}`);
  } catch (e) {
    record('插件工具链全链路', false, e.message);
  } finally {
    child.kill();
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const report = {
  at: new Date().toISOString(),
  endpoint: ENDPOINT,
  chat: chatName,
  results,
};
const out = join(tmpdir(), 'napcat-live-verify-report.json');
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} 步通过`);
console.log(`详细报告：${out}`);
if (failed.length) {
  console.log('失败项：\n' + failed.map((f) => '  - ' + f.name).join('\n'));
}
process.exit(failed.length ? 1 : 0);
