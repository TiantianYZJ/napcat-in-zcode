# Napcat in ZCode — M2 实现计划（本机 NapCat 自动探测）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让插件能**自动发现**本机正在运行的 NapCat，并在面板上一键连接——用户不必手填端点。

**Architecture:** 新增「探测层」：把候选来源（用户显式配置 → 本机 NapCat 安装目录里的配置文件 → 常见端口）合并成候选端点列表，逐个用 `get_login_info` 确认，产出结构化结果。服务端暴露 `napcat_detect_local` 工具，`napcat_status` 带上探测结论；面板在「未配置」态显示「检测本机 NapCat」入口与候选列表。

**Tech Stack:** 与 M1 相同（TypeScript + esbuild + React + Vite）；探测用 Node 内置 `fetch` 与已有的 WS 传输。

**Spec:** `docs/superpowers/specs/2026-11-20-napcat-zcode-design.md` §5.2（路径表）与 §8（错误处理表）；M1 计划 `docs/superpowers/plans/2026-11-20-napcat-zcode-m1.md`（M1 已建立的全部模块）

## Global Constraints

- 复用 `D:\Develop\Napcat in ZCode\plugins\napcat-zcode` 现有模块；**不得重写**已有的 `createClient` / `getLoginInfo` / 配置读写 / 面板骨架
- 探测**只允许回环地址**（`127.0.0.1` / `::1` / `localhost`）与用户显式配置的端点；**绝不**扫描局域网或公网地址
- 探测必须有**总时间预算**（默认 ≤ 5 秒）与单候选超时（默认 ≤ 1.2 秒），且并发执行
- 探测失败**不得**抛异常给用户；必须返回结构化结果（区分「没找到」「NapCat 在跑但没开 OneBot」「找到了但连不上」）
- 探测**不得**修改用户的 NapCat 配置、不启动/结束任何进程
- 所有新增行为要有承重测试（能咬住回归）；既有 409 条用例不得被改写断言
- Conventional Commits；不 push；不新增运行时依赖（devDependency 可接受）
- 面板仍须能打成单文件 `dist/ui/panel.html`；命令 `npm run typecheck` / `npm test` / `npm run build` / `npm run smoke` 全绿

---

### Task 1: 候选端点构造与探测内核

**Files:**
- Create: `src/server/onebot/detect.ts`
- Test: `tests/detect.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface DetectCandidate {
    endpoint: string;            // 规范化后的端点（http://127.0.0.1:3000）
    transport: 'http' | 'ws';
    source: 'config' | 'install' | 'port';   // 候选来源
    detail?: string;             // 来源说明（如配置文件路径）
  }
  export interface DetectResult {
    found: boolean;
    candidates: DetectCandidate[];             // 全部尝试过的候选
    live: (DetectCandidate & { login?: { user_id: string; nickname: string }; error?: string })[];
    napcatRunning: boolean;      // NapCat WebUI(6099) 有响应 → NapCat 在跑
    webuiPort?: number;
    scanned: { ports: number[]; paths: string[]; extraEndpoints: number };
  }
  export async function probeEndpoint(c: DetectCandidate, timeoutMs: number): Promise<{ ok: boolean; login?: {user_id,nickname}; error?: string }>;
  export async function detectLocal(opts: { ports: number[]; extraEndpoints: string[]; timeoutMs: number }): Promise<DetectResult>;
  ```
- Consumes: `createClient`（`./client.js`）、`getLoginInfo`（`./actions.js`）

**要求**
1. `probeEndpoint`：用 `createClient({endpoint, token})` 建连 → `getLoginInfo(c)` → 成功则 `{ok:true, login}`；失败则 `{ok:false, error: 脱敏后的消息}`；**无论成败都要 `close()`**。
2. **token**：探测时**不带 token**（多数本机实例未设 token）；若 `get_login_info` 返回鉴权类错误（retcode 401/1404 或错误文案含 token/鉴权），在结果里标记 `needsToken: true`，让面板提示「该端点可能需要 token」。
3. `detectLocal`：候选来源按顺序合并并**去重**（规范化：去尾斜杠、小写 scheme、默认端口归一）：
   - `config`：`extraEndpoints` 里的每条（用户显式配置，允许非回环）
   - `port`：`ports` 列表每个端口 × `http://127.0.0.1:<port>` 与 `ws://127.0.0.1:<port>`
   - `install`：由 Task 2 提供（先留空实现或 stub，Task 2 接入）
4. **并发探测**，单候选超时 `timeoutMs`（默认 1200），整体用 `Promise.allSettled`；任何单候选失败**不得**影响其它候选。
5. `napcatRunning`：额外探测 `http://127.0.0.1:6099/`（NapCat WebUI 端口）——**只要有 HTTP 响应**（哪怕 401/404）即视为 NapCat 在跑；把它也作为一个 `source:'port'` 候选参与 OneBot 探测（6099 不是 OneBot 端口，通常不会响应 `get_login_info`，但要真的试过才能区分「NapCat 在跑但没开 OneBot Server」）。
6. 结果里 `live` 只含探测成功的端点；`found = live.length > 0`。

**测试要求**（用本地 http server 假 OneBot）
- 假端点能被发现并返回 login 昵称
- 假端点返回 401 时 → `ok:false`，`error` 不含 token 明文，`needsToken:true`
- 探测不存在的端口 → 不抛异常，结果 `found:false`
- 候选去重：同一端点以不同写法（尾斜杠 / 大小写 scheme）出现两次 → 只探测一次
- 探测后连接被关闭（假服务端能看到连接数回落）
- 整体耗时有上界（用假端点延迟响应，断言整体 < 预算）

---

### Task 2: 本机 NapCat 安装与配置发现

**Files:**
- Create: `src/server/host/local-napcat.ts`
- Test: `tests/local-napcat.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface InstalledNapCat {
    configDir: string;             // 找到的 NapCat 配置目录
    onebotConfigs: string[];       // onebot11*.json 的绝对路径
    endpoints: { endpoint: string; transport: 'http'|'ws'; detail: string }[];  // 从配置里读到的端点
    webui?: { port: number; hasToken?: boolean; disabled?: boolean };
    //   ⚠️ 故意**没有** token 字段：WebUI token 的明文不进返回值
    //   （它不是 OneBot access token，两者不能混用）
    //   ⚠️ 字段名是 hasToken 而不是 tokenRequired：探测内核的
    //   `DetectResult.tokenRequired` 是**数组**（需要 token 的候选列表），同名不同义
    truncated?: boolean;           // 端点数超限被截断
    notes?: string[];              // 说明（截断原因等）
  }
  export function findLocalNapCat(roots: string[]): InstalledNapCat[];
  export function defaultNapCatRoots(homeDir: string, platform: NodeJS.Platform): string[];
  export function discoverNapCatInstallRoots(platform?: NodeJS.Platform, opts?: { maxRoots?: number; driveRoots?: string[] }): string[];
  export function discoverNapCatInstallRootsDetailed(platform?: NodeJS.Platform, opts?: { maxRoots?: number; driveRoots?: string[] }): { roots: string[]; truncated: boolean };
  //   ↑ 盘根枚举的详细版：**每个盘各自计数**上限（避免一盘挤掉另一盘），
  //     盘内「名字像 NapCat 的优先」；truncated = 触顶信号（可能有安装被漏掉）。
  //     `maxRoots: 0` = 禁用盘根发现。
  export function collectNapCatRoots(homeDir: string, platform?: NodeJS.Platform, opts?: { env?; maxRoots?; scanDrives? }): string[];
  export function toInstallCandidates(installed: InstalledNapCat[]): DetectCandidate[];  // source:'install'
  export function installPathsOf(installed: InstalledNapCat[]): string[];
  ```
- Consumes: `node:fs`（`readdirSync`/`readFileSync`，**不用**递归遍历整盘）

**要求**
1. **候选根目录**（`defaultNapCatRoots`）：
   - 全部平台：`<home>/.napcat`、`<home>/NapCat`、`<home>/.config/napcat`
   - Windows：`<APPDATA>/NapCat`、`<LOCALAPPDATA>/NapCat`、`<ProgramFiles>/NapCat`、`<ProgramFiles(x86)>/NapCat`、`<USERPROFILE>/AppData/Roaming/NapCatQQ`
   - macOS/Linux：`<home>/Library/Application Support/QQ/NapCat`（上游实际路径）、`<home>/Library/Application Support/NapCat`、`<home>/.local/share/NapCat`
   - **盘根枚举**（`discoverNapCatInstallRoots` / `discoverNapCatInstallRootsDetailed`）：上游 `writePath` 在 Windows/Linux 上**就是安装目录本身**
     （用户可装在 `D:\NapCat`、`D:\QQChatExporter`…），默认根清单命中不了 →
     枚举存在的盘根（`A:\`…`Z:\`，只 stat 判断存在），取其**一级子目录**里名字像 `*NapCat*`/`*NapCatQQ*`
     或**其下有 `config` 目录**的，收为候选根。**不做全盘递归**。
     - 候选根上限**按盘各自计数**（一盘不能挤掉另一盘），盘内**名字像 NapCat 的优先**；
     - 触顶有信号：详细版返回 `{ roots, truncated }`；
     - `maxRoots: 0` = **禁用盘根发现**（可配，见 Task 3 的 `autoDetect.maxRoots`）。
   - **调用方（Task 4）必须合并三类根**再传给 `findLocalNapCat`：`cfg.autoDetect.paths`（用户显式配置，**排在最前**、优先级最高）
     → `defaultNapCatRoots(...)` → `discoverNapCatInstallRoots(...)`。
2. 在每个根目录下**最多两层**查找 `onebot11*.json`（NapCat 把每个账号的配置写成 `onebot11_<uin>.json`）与 `webui.json`；**不做**全盘递归。
3. 从找到的 `onebot11*.json` 里读 `network.httpServers` / `network.websocketServers`，取 `enable:true` 的项 → 生成端点：`http://<host>:<port>` / `ws://<host>:<port>`；`host` 为 `0.0.0.0` 或 `::` 时**改写成回环**（`127.0.0.1` / `[::1]`），因为本机探测只连回环。
4. 从 `webui.json` 读 `port`；`token` **只给「有没有」**（`hasToken` 布尔），**明文不进返回值**。
5. 找不到任何 NapCat → 返回空数组，**不抛错**。
6. 目录/文件不可读（权限、占用）→ 跳过，**不抛错**。

**测试要求**
- 在临时目录里造出 `onebot11_123.json`（含一个 httpServers、一个禁用的 wsServers、一个 `0.0.0.0` 主机）→ 断言找到的端点正确、`0.0.0.0` 被改写为回环、禁用的 server 被排除
- `webui.json` 被读出 port/token
- 目录不存在 / 不可读 → 返回空数组且不抛
- 深度超过两层的文件**不**被找到（防止递归失控）
- 多个账号的多个 `onebot11_*.json` 都被发现

---

### Task 3: 配置扩展

**Files:**
- Modify: `src/server/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `PluginConfig.autoDetect` 扩展为
  `{ ports: number[]; endpoints: string[]; paths: string[]; probeTimeoutMs: number; scanDrives: boolean; maxRoots: number }`
- 默认值：`ports: [3000, 3001, 6099]`、`endpoints: []`、`paths: []`、`probeTimeoutMs: 1200`、`scanDrives: true`、`maxRoots: 32`
- **向后兼容**：`loadConfig` 读旧配置文件（没有 `paths`/`probeTimeoutMs`/`scanDrives`/`maxRoots`）时用默认值补齐（现有深合并机制应已覆盖，验证即可）

**要求**
- `paths` 只允许**绝对路径**；相对路径在 `loadConfig` 时被丢弃（避免相对当前工作目录的歧义）
- `ports` 只接受 1–65535 的整数，越界丢弃
- `probeTimeoutMs` 只接受 100–10000 的整数，越界回默认
- `scanDrives` 只接受布尔值
- `maxRoots` 只接受 0–512 的整数，越界回默认（`0` = 禁用盘根发现，合法）
- 新增字段的 env 覆盖不需要（userConfig 只暴露两项）

**测试要求**：旧配置文件能正常加载并补齐新字段；非法 `paths`/`ports`/`probeTimeoutMs` 被丢弃或回落默认值。

---

### Task 4: `napcat_detect_local` 工具 + status 集成

**Files:**
- Modify: `src/server/tools.ts`
- Modify: `src/server/state.ts`
- Test: `tests/mcp-tools.test.ts`（追加用例）

**Interfaces:**
- Produces:
  - 工具 `napcat_detect_local` `{}` → 返回 `DetectResult`（见 Task 1）
  - `napcat_status` 的返回**新增**字段 `detection?: { found: boolean; napcatRunning: boolean; endpoint?: string }`（**向后兼容**：新增可选字段，不改既有字段）
- Consumes: Task 1 的 `detectLocal`、Task 2 的 `findLocalNapCat`、Task 3 的配置

**要求**
1. `napcat_detect_local` 把 `config.autoDetect.{ports,endpoints,paths,probeTimeoutMs}` 与「本机安装发现的结果」合并成候选后调用 `detectLocal`；**参数为空**（不接参）。
2. 探测**默认不读 token**；若探测结果里某端点 `needsToken`，返回里保留该标记。
3. `napcat_status`：**只在**用户显式调用 `napcat_detect_local` 后，把最近一次探测结论缓存起来供 status 读取（避免每次 status 都触发一次端口扫描——那会让状态条每刷新一次就等几秒）。缓存**仅存于内存**，进程重启即失效；`napcat_configure` 成功后清除缓存。
4. 工具描述要写明「只探测回环地址与用户显式配置的端点，不会扫描网络」。

**测试要求**
- `napcat_detect_local` 在有假 OneBot 时返回 `found:true` 与正确的 endpoint
- `napcat_status` 未探测过时**不**返回 `detection`（不触发扫描）
- 探测过一次后 status 带出 `detection`
- `napcat_configure` 成功后缓存被清除

---

### Task 5: 面板「检测本机 NapCat」入口

**Files:**
- Modify: `src/panel/api.ts`、`src/panel/App.tsx`、`src/panel/components/UnconfiguredForm.tsx`、`src/panel/components/Statusbar.tsx`
- Test: `tests/panel-app.test.tsx`、`tests/panel-actions.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 4 的 `napcat_detect_local`
- Produces: 面板能力

**要求**
1. `UnconfiguredForm`（未配置态）新增按钮 **「检测本机 NapCat」**（`data-testid="detect-btn"`），点击后调用 `napcat_detect_local`：
   - 找到候选 → 列出候选（endpoint + 登录昵称），每行一个 **「使用这个」** 按钮 → 点击即 `api.configure(endpoint, '')`（不带 token；若该候选 `needsToken` → 提示需要 token 并聚焦 token 输入框）
   - `napcatRunning === true` 但没找到 OneBot 端点 → 明确提示：**「检测到 NapCat 正在运行，但没有开启 OneBot Server」**，并给出开启位置（NapCat WebUI → 网络配置），附 WebUI 地址（若探测到端口）
   - 什么都没找到 → 提示「未检测到本机 NapCat」，保留手填端点的路径
2. 探测中：按钮置灰 + 文案「检测中…」，**不得**并发重复触发。
3. `Statusbar`：在未配置/连接失败态显示探测结论的一行摘要（如「未检测到本机 NapCat」/「检测到 NapCat（未开启 OneBot Server）」）。
4. 探测**不得**自动连接——只列候选，由用户点。

**测试要求**
- 点击「检测」→ 出现候选列表 → 点「使用这个」→ 触发 configure 且参数为该 endpoint
- 探测结果为「NapCat 在跑但无 OneBot 端点」→ 显示对应提示文案
- 探测中按钮置灰
- 探测失败（工具报错）→ 显示错误提示，不崩

---

### Task 6: 收尾（文档 + 验收 + spec）

**Files:**
- Modify: `README.md`、`docs/acceptance-m1.md`、`docs/superpowers/specs/2026-11-20-napcat-zcode-design.md`
- Test: `tests/manifest-contract.test.ts`（如需）

**要求**
1. README 新增「自动探测本机 NapCat」小节：说明探测范围（回环 + 显式配置）、配置项 `autoDetect.{ports,endpoints,paths,probeTimeoutMs}`、以及「检测到 NapCat 在跑但没开 OneBot Server」的处置步骤（WebUI → 网络配置 → 开启 HTTP Server）。
2. `docs/acceptance-m1.md` 追加 M2 验收项（本机 NapCat 在跑时面板应列出候选；WebUI 在跑但没开 OneBot 时应给明确提示；探测不应改动用户的 NapCat 配置）。
3. spec §5.2 的 `local` 行补上 M2 已实现的细节；§3.1 的已知限制补一条：「探测只连回环，用户显式配置的端点除外；NapCat 未开 OneBot Server 时需要用户手动开启（插件不代改用户配置）」。
4. **不要**在 README 里写「插件会自动开启 NapCat 的 OneBot Server」——插件不改用户的 NapCat 配置。

---

## 计划级备注

1. **M2 不做「自带宿主」（M3）**：不下载/不启动 NapCat、不改用户配置。M2 只**发现**并**连接**。
2. **探测的边界**：回环 + 用户显式配置。局域网扫描一律不做——那既是隐私问题也是安全风险。
3. **端口 6099 双重身份**：NapCat 的 WebUI 默认端口，也可能是用户配的 OneBot 端口。探测时既当 WebUI 探针（判断「NapCat 在跑」），也当 OneBot 候选（`get_login_info` 若有响应就是 OneBot 端点）。
4. **`message_seq` 等 NapCat 语义仍待 T14 实测**：M2 不依赖它们，但真机验证脚本（`scripts/verify-live-napcat.mjs`）的结论会反过来影响 M1.1 的分诊。两件事可以并行。
