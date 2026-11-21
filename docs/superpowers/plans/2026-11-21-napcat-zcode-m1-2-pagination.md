# Napcat in ZCode — M1.2 修复计划（按真实 NapCat 语义重做翻页/区间/搜索）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** M1 的取历史/区间/搜索建立在**推断**的 NapCat 语义上，2026-11-21 首次拿到活体 NapCat 后实测证明**推断是错的**，导致「往更早翻页」在真实环境里推不动游标。本计划把插件的翻页模型改成**与真实语义一致**，并把「实测」写进可重复执行的验证脚本。

**为什么必须改：** 已发布的 v0.3.0 里，`napcat_get_history` 的翻页、`napcat_search_messages` 的回溯扫描、`napcat_export` 的区间导出，**在真实 NapCat 上都拿不到更早的消息**（游标原地打转 → 报「推不动」）。这是插件最核心的能力，不能带着它发版。

---

## 一、实测语义（2026-11-21，本机 NapCat v4.18.42 / QQNT 9.9.31-49738 / 账号 2350355494）

### 1.1 消息字段的职责（**与 M1 的假设相反**）

| 字段 | 真实含义 | 样本 |
|---|---|---|
| `real_seq` | **会话内单调递增序号**（每会话独立计数） | 群 A：38；群 B：8838,8839,8840…；好友：5,6,7,8 |
| `message_seq` | **随机 32 位短 id**（=== `message_id` === `real_id`） | 989794892、1288531888、596946045… |
| `time` | unix 秒 | 1795235911 … |

→ M1 假设「`message_seq` 是单调游标」**不成立**；它是随机 id，**只能当 API 锚点**，不能做大小比较、不能做 `cursor+1`。
→ 私聊与群聊**一致**（抽样 4 个群 + 3 个好友，`seq===id` 100% 命中，时间升序 100% 命中）。

### 1.2 `get_group_msg_history` / `get_friend_msg_history` 的真实行为

| 入参 | 返回 |
|---|---|
| 不带 `message_seq` | **最新** `count` 条，时间升序（`reverse_order` 被忽略） |
| `message_seq=S`（S 存在） | 从 S **向更新**取 `count` 条，**含 S**（S 在最前），时间升序 |
| `message_seq=S` + `reverse_order=true` | 从 S **向更早**取 `count` 条，**含 S**（S 在最后），时间升序 |
| `message_seq=S`（S 不存在） | **报错**：`消息S不存在`（retcode≠0） |
| `count` | **守约**（受实际存量限制；实测 count=200→197 条，count=500→该会话全部 288 条） |

补充实测：
- `message_id` 入参 → **被忽略**（等价于不带 seq，返回最新页）
- `reverseOrder`（驼峰旧别名）→ **与 `reverse_order` 等价**（上游源码 `payload.reverse_order || payload.reverseOrder`）
- `real_seq` 当 `message_seq` 传 → **查不到**，返回空 → 锚点只能用短 id

### 1.3 上游实现（`packages/napcat-onebot/action/go-cqhttp/GetGroupMsgHistory.ts`）

```ts
const hasMessageSeq = !!(payload.message_seq) && payload.message_seq !== '0';
const startMsgId = hasMessageSeq
  ? (MessageUnique.getMsgIdAndPeerByShortId(+payload.message_seq)?.MsgId ?? payload.message_seq!)
  : '0';
const msgList = hasMessageSeq
  ? await this.core.apis.MsgApi.getMsgHistory(peer, startMsgId, +payload.count, payload.reverse_order || payload.reverseOrder)
  : await this.core.apis.MsgApi.getAioFirstViewLatestMsgs(peer, +payload.count);
if (msgList.length === 0) throw new Error(`消息${payload.message_seq}不存在`);
```

→ `message_seq` 走的是**短 id → 内部 MsgId** 的映射；查不到就拿原值当 MsgId，查不到就抛错。

### 1.4 record（语音）段**没有时长字段**

实测 NapCat 的 OB11 `record` 段只有 `file` / `path` / `url` / `file_size` 四个字段，**不存在时长**。
→ M1 计划里「record 段时长字段名待实测」的假设**不成立**，应改为「OB11 record 段不携带时长」；插件**不得**编造或推断时长。

---

## 二、要改什么

### Task 1: OneBot 取历史层（`src/server/onebot/actions.ts`）

**现状问题**：`fetchHistoryPage(c, kind, id, beforeSeq, count)` 把 `beforeSeq` 当 `message_seq` 传、**不带 `reverse_order`**，调用方却按「返回 seq < beforeSeq」使用 → 真实 NapCat 返回同一页 → 游标推不动。
**更糟**：`fetchMessagesBetween` 用 `s >= fromSeq && s <= toSeq` 过滤区间，而 seq 是随机 id → 区间过滤本身无意义。

**目标接口**（签名可微调，语义不可变）：

```ts
export interface HistoryAnchor { shortId: string; }   // 短 id（message_seq）

/** 取一页：anchor 缺省=最新页；anchor + backward=true → 取该锚点及更早的消息（锚点在前、时间升序） */
export async function fetchHistoryPage(
  c: OneBotClient, kind: 'group' | 'friend', id: string,
  opts: { anchor?: HistoryAnchor; count?: number; backward?: boolean },
): Promise<OB11Message[]>;

/** 从最新往更早翻页，直到覆盖 [fromTime, toTime] 或历史耗尽；返回闭区间内的消息（时间正序，去重）。 */
export async function fetchMessagesBetween(
  c: OneBotClient, kind: 'group' | 'friend', id: string,
  range: { fromTime?: number; toTime?: number }, opts?: { pageSize?: number },
): Promise<{ messages: OB11Message[]; pages: number; exhausted: boolean }>;
```

**要求**
1. `backward=true` 时必须发 `reverse_order: true`；`anchor` 用**短 id**（`message_seq`），**不得**用 `real_seq`
2. 锚点**含**在返回里 → 调用方按短 id 去重（锚点重复只保留一条）
3. 翻页循环的终止条件：**空页**（历史耗尽）/ **页内最早消息的 `time` 已早于 `fromTime`** / **页数超预算**（抛错，不静默返回残缺区间）
4. 区间过滤一律用 **`time`**（unix 秒）；`real_seq` 只作为**排序的次级键**（同一秒内多条消息时用 `real_seq` 稳定排序，缺失则退化为原始顺序）
5. **不得**用 `real_seq`/`message_seq` 做大小比较（它们不是可比较的数）
6. 服务端若返回的页里没有 `message_seq` → 该页无法定位锚点 → 抛明确错误（沿用现有「无进展」错误风格）
7. NapCat 报错「消息S不存在」→ 转成可读中文（「历史锚点已失效，可能消息已过期」），**不得**当成「历史耗尽」静默返回

### Task 2: 工具层（`src/server/tools.ts`）

- `napcat_get_history` 参数改为：
  - `count`（默认 50）
  - `beforeTime`（可选，unix 秒）：只取**该时间之前**的消息（往更早翻）
  - `fromTime` / `toTime`（可选，unix 秒）：闭区间
  - **移除** `startSeq` / `fromSeq` / `toSeq`（它们建立在「seq 是单调序号」的假设上）
- `napcat_search_messages`：从最新往更早翻页扫描关键词，预算（最大页数 / 最大扫描条数），结果报告 `scanned` / `pages` / `hitsTruncated` / `note`
- `napcat_export`：区间导出改用时间语义
- 游标推进判据从「seq 数值比较」改为「**锚点是否变化** + **时间是否前进**」
- 既有 `nextBeforeSeq` 类字段改为 `nextBeforeTime`（时间）——若面板/文档引用了旧字段名，同步改名
- **既有测试里断言旧语义（独占边界 / seq 区间）的用例要按新语义重写**（这是契约变更，不是「削弱断言」；重写后仍要能咬住回归）

### Task 3: 消息排序与去重（`src/server/model/message.ts` 等）

- 排序键：`time` 升序 → 同秒内用 `real_seq` 升序 → 再同则保持服务端顺序
- 去重键：`message_seq`（短 id）优先，退化到 `message_id`，再退化到 `real_id`

### Task 4: 验证脚本按真语义重写（`scripts/verify-live-napcat.mjs`）

把现在「探测独占/包含」的逻辑换成**对真语义逐条断言**：

1. 不带 `message_seq` → 返回的是**最新** count 条，且时间升序
2. `message_seq=S` → 返回**含 S** 且从 S 向更新
3. `message_seq=S` + `reverse_order=true` → 返回**含 S** 且从 S 向更早
4. `message_seq=<不存在的 id>` → **必须报错**
5. `count` 守约（请求 3 → 返 3；请求 100 → 返 ≤100 且 >0）
6. `real_seq` 单调递增（同一会话内）
7. record 段字段清单 → 断言**不含时长字段**（把「未确定」改成「确认不存在」）
8. 插件工具链：往更早翻页**必须真的取到更早的消息**（游标推进）
9. 搜索能扫到更早页里的关键词

脚本还必须**选一个消息够多的会话**（≥3 条）——2026-11-21 首跑就是因为选了只有 1 条消息的群而两项测不出来（已修：按 `count>=3` 探测挑选）。

### Task 5: 文档

- spec：新增「NapCat 真实语义（实测）」小节，把上面 §1 的表写进去；§3.1 已知限制追加：record 段无时长、seq 是短 id 不能当游标
- README：翻页语义说明（怎么取更早的消息、区间参数是时间）
- `docs/acceptance-m1.md`：把「待实测」的三项改成**已实测的结论 + 验收项**

---

## Global Constraints

- **不得**改动 OneBot 客户端、配置读写、面板骨架的既有契约（除本计划明确列出的参数改名）
- 既有测试若因**契约变更**（参数改名、语义修正）必须调整，**要逐条说明为什么**；不得用「删断言」「放宽断言」的方式让测试变绿
- 真实语义相关的单测必须用**假 OneBot**（模拟上面 §1.2 的行为）来覆盖，不许依赖真实网络
- 所有面向用户的中文文案必须区分三种情况：**历史耗尽** / **锚点失效** / **翻页预算用尽**——不得都笼统说「没有更多了」
- `npm run typecheck` / `npm test` / `npm run build` / `npm run smoke` 全绿；`npm run verify:live` 在真实 NapCat 上全绿
- `dist/` 重建后一并提交（市场安装不跑 `npm install`）
- 版本：`plugin.json` / `marketplace.json` / `package.json` 三处**同步**升到 **0.4.0**（M1.2 单独一版，M3 之后再升 0.5.0）
- Conventional Commits；不 push；不引入运行时依赖

---

## 验收（真机）

1. `npm run verify:live` → 全绿，且**不再**出现「插件游标翻页取到更早的真实消息 FAIL」
2. 人工核对：用「DeepSeek-Reasonix薪火群」取 `count=5`（最新 5 条）→ 再用 `beforeTime=<最早那条的时间>` → 应取到**更早**的 5 条，且与前一页无重叠
3. `napcat_search_messages` 在一个消息较多的群里能扫到**首页之外**的关键词
4. 导出「某天 14:00–15:00 的记录」能导出该区间的真实消息（用时间参数）
5. 面板上「更早的消息 / 加载更多」按钮真的能翻出更早内容
