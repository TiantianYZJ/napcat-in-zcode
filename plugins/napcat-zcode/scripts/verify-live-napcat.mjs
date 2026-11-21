/**
 * 真机验证：连真实的 NapCat（OneBot 11）端点，逐条断言**真实语义**，
 * 并把插件的完整工具链在真实数据上跑一遍。
 *
 * 断言对象（2026-11-21 活体实测，计划 §一）：
 *   1. 不带 `message_seq` → 返回的是**最新** count 条，且时间升序；
 *   2. `message_seq=S` → 返回**含 S** 且从 S 向更新；
 *   3. `message_seq=S` + `reverse_order=true` → 返回**含 S** 且从 S 向更早；
 *   4. `message_seq=<不存在的 id>` → **必须报错**；
 *   5. `count` 守约（请求 3 → 返 3；请求 100 → 返 ≤100 且 >0）；
 *   6. `real_seq` 在同一会话内单调递增；
 *   7. record 段**不含时长字段**；
 *   8. 插件工具链往更早翻页**必须真的取到更早的消息**（游标推进）；
 *   9. 搜索能扫到**首页之外**的关键词。
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
/** 调一个动作；retcode≠0 直接抛错。 */
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

/** 调一个动作；**不抛错**，返回整个响应（用来断言「必须报错」）。 */
async function obRaw(action, params = {}) {
  const res = await fetch(`${ENDPOINT.replace(/\/$/, '')}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  return res.json();
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

// 选一个**消息足够多**的会话：只含 1 条消息的会话无法构造 message_seq 锚点，
// 边界语义与游标翻页两项都测不出来（2026-11-21 真机首跑就是踩了这个坑）。
const MIN_MESSAGES = 3;
const PROBE_LIMIT = 15;

async function probe(chat, isGroup) {
  const idKey = isGroup ? 'group_id' : 'user_id';
  const id = String(isGroup ? chat.group_id : chat.user_id);
  const action = isGroup ? 'get_group_msg_history' : 'get_friend_msg_history';
  let count = 0;
  try {
    const r = await ob(action, { [idKey]: id, count: 5 });
    count = (r && r.messages ? r.messages.length : 0);
  } catch {
    count = 0;
  }
  return {
    id,
    idKey,
    action,
    isGroup,
    name: isGroup ? chat.group_name : chat.nickname,
    count,
  };
}

const candidates = [];
for (const g of groups.slice(0, PROBE_LIMIT)) {
  const p = await probe(g, true);
  candidates.push(p);
  if (p.count >= MIN_MESSAGES) break;
}
if (!candidates.some((c) => c.count >= MIN_MESSAGES)) {
  for (const f of friends.slice(0, PROBE_LIMIT)) {
    const p = await probe(f, false);
    candidates.push(p);
    if (p.count >= MIN_MESSAGES) break;
  }
}

const chat = candidates.find((c) => c.count >= MIN_MESSAGES) || candidates[0];
if (!chat) {
  record('存在可读取的会话', false, '该账号没有任何群或好友，无法继续');
  process.exit(1);
}
const chatId = chat.id;
const chatName = chat.name;
const histAction = chat.action;
const idKey = chat.idKey;
/** 选中的会话是群还是好友（工具调用要按 kind 传）。 */
const isGroup = chat.isGroup === true;
record('选定会话', true, `${chatName}（${histAction} ${chatId}，首页 ${chat.count} 条）`);

// ── 1. 真实语义逐条断言 ─────────────────────────────────────────────
info('1. 真实语义逐条断言（2026-11-21 实测口径）');

/** 拉一页；带 shortId 时按锚点拉，backward=true 时向更早。 */
const page = async (count, { shortId, backward } = {}) => {
  const params = { [idKey]: chatId, count };
  if (shortId !== undefined) params.message_seq = String(shortId);
  if (backward) params.reverse_order = true;
  const r = await ob(histAction, params);
  return r.messages || [];
};

// 拉尽可能多的历史作为「基准」（用于判断哪条更新 / 哪条更早）
const base = await page(200);
const baseTimes = base.map((m) => m.time);
const baseSeqs = base.map((m) => m.message_seq);
const isAscending = (arr) => arr.every((v, i) => i === 0 || v >= arr[i - 1]);
record('取到历史', base.length > 0, `本页 ${base.length} 条，时间 ${baseTimes[0]}..${baseTimes[baseTimes.length - 1]}`);

// 1) 不带 message_seq → 最新 count 条，且时间升序
{
  const small = await page(3);
  const expectedLatest = base.slice(-3).map((m) => m.message_seq);
  const got = small.map((m) => m.message_seq);
  record('① 不带 message_seq → 返回最新 count 条，时间升序',
    got.length === 3 && got.every((s) => expectedLatest.includes(s)) && isAscending(small.map((m) => m.time)),
    `请求 count=3 → seq ${JSON.stringify(got)}；基准里的最新 3 条 ${JSON.stringify(expectedLatest)}；时间升序=${isAscending(small.map((m) => m.time))}`);
}

// 2) message_seq=S → 含 S，且从 S 向更新
// 3) message_seq=S + reverse_order=true → 含 S，且从 S 向更早
{
  const anchorIdx = Math.max(0, Math.min(base.length - 1, Math.floor(base.length / 2)));
  const anchor = base[anchorIdx];
  const shortId = anchor.message_seq;

  const forward = await page(5, { shortId });
  const forwardSeqs = forward.map((m) => m.message_seq);
  const forwardHasAnchor = forwardSeqs.includes(shortId);
  const forwardAllNewerOrEqual = forward.every((m) => m.time >= anchor.time);
  const forwardIdxInBase = base.findIndex((m) => m.message_seq === shortId);
  record('② message_seq=S → 含 S，且从 S 向更新',
    forwardHasAnchor && forwardAllNewerOrEqual && forwardIdxInBase >= 0,
    `锚点 seq=${shortId}（第 ${anchorIdx + 1}/${base.length} 条，t=${anchor.time}）；返回 ${forward.length} 条，含锚点=${forwardHasAnchor}，都不早于锚点=${forwardAllNewerOrEqual}`);

  const backward = await page(5, { shortId, backward: true });
  const backwardSeqs = backward.map((m) => m.message_seq);
  const backwardHasAnchor = backwardSeqs.includes(shortId);
  const backwardAllOlderOrEqual = backward.every((m) => m.time <= anchor.time);
  const backwardIsEarlierPage = backward.length > 0 && backward[0].time <= anchor.time;
  record('③ message_seq=S + reverse_order=true → 含 S，且从 S 向更早',
    backwardHasAnchor && backwardAllOlderOrEqual && backwardIsEarlierPage,
    `锚点 seq=${shortId}；返回 ${backward.length} 条，含锚点=${backwardHasAnchor}，都不晚于锚点=${backwardAllOlderOrEqual}，首条 t=${backward[0]?.time}（锚点 t=${anchor.time}）`);

  // 4) 不存在的 message_seq → 必须报错
  const bogus = await obRaw(histAction, { [idKey]: chatId, message_seq: '1', count: 5 });
  record('④ message_seq=<不存在的 id> → 必须报错', bogus.retcode !== 0,
    `retcode=${bogus.retcode}，wording=${JSON.stringify(bogus.wording || bogus.message || '')}`);
}

// 5) count 守约
{
  const three = await page(3);
  const hundred = await page(100);
  record('⑤ count 被服务端守约', three.length === 3 && hundred.length <= 100 && hundred.length > 0,
    `请求 count=3 → ${three.length} 条；请求 count=100 → ${hundred.length} 条`);
}

// 6) real_seq 在同一会话内单调递增
{
  // 真实 NapCat 把 real_seq 发成**字符串**（"8841"）→ 先转成数再比
  const withReal = base
    .map((m) => ({ m, r: Number(m.real_seq) }))
    .filter((x) => Number.isFinite(x.r));
  const mono = withReal.every((x, i) => i === 0 || x.r > withReal[i - 1].r);
  const seqIsNotMonotonic = baseSeqs.some((s, i) => i > 0 && s <= baseSeqs[i - 1]);
  record('⑥ real_seq 在会话内单调递增（而 message_seq 不是）', mono && withReal.length > 0,
    `本页 ${withReal.length}/${base.length} 条带 real_seq，单调递增=${mono}；message_seq 是否单调=${!seqIsNotMonotonic ? '是（本次样本恰好单调）' : '否（短 id 本就随机）'}；示例 real_seq=${withReal.slice(0, 6).map((x) => x.r).join(',')}`);
}

// 7) record 段不含时长字段
{
  const scan = [];
  for (const c of groups.slice(0, 10)) {
    const p = await ob('get_group_msg_history', { group_id: String(c.group_id), count: 100 }).catch(() => ({ messages: [] }));
    scan.push(...(p.messages || []));
  }
  for (const f of friends.slice(0, 10)) {
    const p = await ob('get_friend_msg_history', { user_id: String(f.user_id), count: 100 }).catch(() => ({ messages: [] }));
    scan.push(...(p.messages || []));
  }
  const recordSegs = scan.flatMap((m) => (Array.isArray(m.message) ? m.message : []).filter((s) => s.type === 'record'));
  const keyTally = {};
  for (const s of recordSegs) for (const k of Object.keys(s.data || {})) keyTally[k] = (keyTally[k] || 0) + 1;
  const durationKeys = ['seconds', 'duration', 'duration_time', 'length', 'time'].filter((k) => keyTally[k]);
  record('⑦ record 段不含时长字段（实测：只有 file/path/url/file_size）',
    recordSegs.length > 0 && durationKeys.length === 0,
    `扫描 ${scan.length} 条消息、${recordSegs.length} 个 record 段；出现的字段：${JSON.stringify(keyTally)}；时长类字段：${durationKeys.length ? durationKeys.join(', ') : '（无 —— 确认 record 段不带时长）'}`);
}

// ── 2. 插件自身的工具链（真实产物 over stdio）─────────────────────
info('2. 插件工具链（真实 dist/server.mjs over stdio）');
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
      `${(hist.messages || []).length} 条，nextBeforeTime=${hist.nextBeforeTime}，stopReason=${hist.stopReason}`);

    // ⑧ 往更早翻页必须真的取到更早的消息（游标推进，且与前一页无重叠）
    const older = toolText(await rpc('tools/call', { name: 'napcat_get_history', arguments: { chatKind: isGroup ? 'group' : 'friend', chatId, count: 20, beforeTime: hist.nextBeforeTime } }));
    const histTimes = (hist.messages || []).map((m) => m.time);
    const olderTimes = (older.messages || []).map((m) => m.time);
    const overlap = olderTimes.filter((t) => histTimes.includes(t));
    const strictlyOlder = olderTimes.length > 0 && olderTimes[0] < Math.min(...histTimes);
    record('⑧ 插件往更早翻页取到更早的真实消息（游标推进）',
      olderTimes.length > 0 && strictlyOlder && overlap.length === 0,
      `第二页 ${olderTimes.length} 条，最早 t=${olderTimes[0]}（第一页最早 t=${Math.min(...histTimes)}）；重叠 ${overlap.length} 条；nextBeforeTime=${older.nextBeforeTime}（第一页 ${hist.nextBeforeTime}）`);

    const fmt = toolText(await rpc('tools/call', { name: 'napcat_format_selection', arguments: { messages: hist.messages || [], chatName } }));
    record('napcat_format_selection 产出注入文本', typeof fmt.text === 'string' && fmt.text.length > 0, `首行：${String(fmt.text).split('\n')[0].slice(0, 60)}…（共 ${fmt.count} 条）`);

    const exp = toolText(await rpc('tools/call', { name: 'napcat_export', arguments: { messages: hist.messages || [], chat: { kind: isGroup ? 'group' : 'friend', id: chatId, name: chatName } } }));
    const mdOk = existsSync(exp.mdPath) && readFileSync(exp.mdPath, 'utf-8').length > 0;
    record('napcat_export 导出真实记录到文件', mdOk, `${exp.mdPath}`);

    // ⑨ 搜索能扫到**首页之外**的关键词
    //    取一条「比较早」的消息里的字样当关键词 → 只有真的往更早翻页才扫得到
    const oldest = base.length > 3 ? base[0] : null;
    const oldestText = oldest && Array.isArray(oldest.message)
      ? (oldest.message.find((s) => s.type === 'text')?.data?.text ?? '')
      : '';
    const keyword = String(oldestText).trim().slice(0, 4);
    if (keyword.length >= 2) {
      const searched = toolText(await rpc('tools/call', { name: 'napcat_search_messages', arguments: { chatKind: isGroup ? 'group' : 'friend', chatId, query: keyword } }));
      record('⑨ 搜索能扫到首页之外的关键词', (searched.hits || []).length > 0 && (searched.pages ?? 0) > 1,
        `关键词「${keyword}」（取自最早那条消息）→ 命中 ${(searched.hits || []).length} 条，scanned=${searched.scanned}，pages=${searched.pages}，stopReason=${searched.stopReason}`);
    } else {
      record('⑨ 搜索能扫到首页之外的关键词', false,
        '最早那条消息里没有可用的文本关键词（无法构造搜索用例）');
    }
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
