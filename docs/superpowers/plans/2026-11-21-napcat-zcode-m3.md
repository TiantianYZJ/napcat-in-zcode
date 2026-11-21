# Napcat in ZCode — M3 实现计划（受管宿主：检测 / 下载 / 启停管理）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让插件**自己管住 NapCat**：本机已装 → 面板上一键「启动 / 停止」；没装 → 面板上给「下载 NapCat」+ 选安装路径 → 下载完成后同样进入启停管理。用户不再需要手动敲命令行、翻目录、找启动脚本。

**Architecture:** 新增「受管宿主（managed host）」层，四个模块串成一条链：

```
面板 ──► MCP 工具（install / install_status / start / stop / host_status）
          │
          ├─ host/manager.ts    受管安装的台账（安装目录、版本、模式、进程 PID），落盘在 ${ZCODE_PLUGIN_DATA}
          ├─ host/download.ts    HTTP(S) 下载（可选代理）+ 进度上报 + sha256 校验
          ├─ host/unzip.ts       最小 ZIP 解析（中央目录 + zlib.inflateRaw），Node 无内置 zip
          └─ host/supervise.ts   启停：detached 拉起 / 进程树结束 / 三态状态判定
```

探测层沿用 M2 的 `detectLocal`（已实现且已真机验证），M3 只补「受管」维度：**能装、能启、能停、能看状态**。

**Tech Stack:** 与 M1/M2 相同（TypeScript + esbuild + React + Vite）；下载用 Node 内置 `https`/`zlib`；进程用 `child_process`。

**Spec:** `docs/superpowers/specs/2026-11-20-napcat-zcode-design.md`（§5.2 本机路径、§6 配置、§7 可移植性红线、§8 错误处理）；本计划是 §3 里程碑表中「M3 自带宿主」的落地。

---

## 本轮新增的硬事实（2026-11-21 真机实测，务必遵守）

1. **QQ 9.9.36+ 有原生完整性检查。** QQ 启动器（`D:\QQ\QQ.exe`）在 Electron bootstrap **之前**校验版本化 app 目录；一旦目录里有任何多余文件、或系统 DLL 的原生代码字节被改写，QQ 直接报「**文件已损坏, 请重新安装QQ**」并中止启动。
   → 结论一：NapCat **不得**往 QQ 的 `resources\app` 目录写任何文件。
   → 结论二：依赖**内联改写系统 API 原生代码**（老版 hook 的做法）的注入方式，在本机 QQ 上必然触发该检查。
   → 结论三：桌面上 `D:\QQ\QQ.exe`（9.9.37-54395）**可以单独正常启动**，但**不能**承载注入式 NapCat。

2. **可用路线是「独立模式」。** NapCat 的 `NapCat.Shell.Windows.Node.zip` 内含 `node.exe` + 内嵌 QQNT（9.9.31-49738），以独立进程运行，**完全不碰桌面 QQ 目录、不注入任何进程** → 不存在完整性检查这一环。
   → 受管宿主的**默认且推荐模式 = 独立模式**（`napcat.bat` → `node.exe index.js`）。
   → 注入模式（`napcat\launcher-user.bat` → `NapCatWinBootMain.exe`）**保留为可选**，但必须在面板上标注「会注入桌面 QQ，QQ 9.9.36+ 可能报文件已损坏」。

3. **制品与来源。**
   - 制品：`NapCat.Shell.Windows.Node.zip`，v4.18.42，**124,162,399 字节**，sha256 = `77397ac38d66f46383e48f08f35d5f9d37ec575c22069f62d6c600e73b4521ed`。
   - 来源：上游 `NapNeko/NapCatQQ` **已清空**（仓库只剩一句「到这里告一段落」，releases 为空，资源库 404）→ 唯一可得官方 CI 产物的源是**归档镜像** `XingYunStar/NapCatQQ`。
   - 下载 URL：`https://github.com/XingYunStar/NapCatQQ/releases/download/v4.18.42/NapCat.Shell.Windows.Node.zip`
   - **必须钉 sha256**（镜像不是官方一手源），校验不过 → 删除临时文件并报错，**绝不**安装未校验的包。

4. **本机网络：github.com 直连被阻断**（`Connection reset` / 21s 超时），必须经 Clash 代理 `127.0.0.1:7897`（实测代理 857KB/s–2.4MB/s，直连 80KB/s 且不稳）。
   → 下载器必须支持**可选代理**（`userConfig` 新增 `downloadProxy`）。

5. **Node 没有内置 ZIP 解包**：`zlib` 只有 deflate/inflate（raw），ZIP 需要自己解析中央目录。本项目**不引入运行时依赖**，故自带最小实现。

6. **插件面板的入口只有右侧边栏，且「新建任务」区永远没有入口**（2026-11-21 对 `D:\ZCode` 逆向核实的结论，已写进 `src/panel/protocol-notes.md`）：
   - 宿主把 `ui.surfaces` 一律开成**右侧 side pane tab**（tab id 形如 `plugin-ui:<workspace>:<parentSessionId>:<pluginId>:<server>:<resourceUri>:surface:<surfaceId>`）
   - 渲染层 `listSurfaces` 只有 4 个调用点：侧栏「概览」页签的「应用插件」推荐区、插件市场条目「打开」、扩展槽位 `nav.primary`、文件扩展名分流 `file.viewer`
   - `composer.status` / `composer.mention` 两个与输入框相关的扩展槽位 **targets 不接受 `surface`**；命令面板无 surface 条目；composer 区域代码里 `surface` 零命中
   - `availability` 只有 `"session"` 一个合法值，写别的值该 surface 被整个丢弃
   - **插件 manifest schema 里没有 `slotItems`**（GLM runtime `zcode.cjs` 里 `slotItems` 零命中）→ `nav.primary` / `file.viewer` 是**扩展（extension）**机制，**MCP 插件用不了**
   - 侧栏推荐区数据来自服务端下发的 `uiPluginRecommendations`，插件自身无法把自己加进去
   - → **唯一由插件自己控制、且不依赖插件市场的入口**：MCP 工具结果带 `_meta.ui.resourceUri` → 对话内嵌渲染面板 + 「在侧边面板打开」按钮（M3 新增，见 Task 4/5）

---

## Global Constraints

- 复用 `D:\Develop\Napcat in ZCode\plugins\napcat-zcode` 现有模块；**不得重写** `createClient` / `detectLocal` / 配置读写 / 面板骨架
- **可移植性红线（spec §7）**：MCP 启动命令只能是 `command: "node"`；manifest 只允许 `${ZCODE_PLUGIN_ROOT}` / `${ZCODE_PLUGIN_DATA}` / `${ZCODE_PROJECT_DIR}` / `${user_config.*}` 四类占位符；**不得**硬编码 `D:\`、ZCode 安装路径、Node 绝对路径；**不得**新增运行时依赖（devDependency 可接受）；`dist/` 必须随仓库提交（市场安装不跑 `npm install`）
- **URL 出网红线（Mimosa 生成前约束）**：下载请求的 URL **只允许 http/https**；发请求前**校验 host**：必须在**允许清单**内（`github.com` / `objects.githubusercontent.com` / `api.github.com` / `raw.githubusercontent.com`），且**拒绝 loopback / 私有 / 保留地址**；用户可在设置里改下载源，但**改完仍要过同一道校验**（不满足就明确报错，不静默改用别的源）
  - 代理是**用户显式配置的传输跳板**，不是被请求的 URL：代理地址只允许 `http`/`https` scheme 且必须落在本机回环范围（代理天然是本地的），被请求的资源 URL 仍走上面的允许清单 + 私网拒绝
- **启停是可见副作用**：面板上的「启动 / 停止」必须二次确认（至少停止要确认）；**只管插件自己拉起的进程**；外部已在跑的实例**只提示不接管**（不越权 kill）
- **不得读写用户桌面 QQ 的任何文件**（`resources/app`、`versions/` 一律只读）
- 既有 571 条用例不得被改写断言；新增行为必须有承重测试
- Conventional Commits；不 push；`npm run typecheck` / `npm test` / `npm run build` / `npm run smoke` 全绿；`dist/` 重建后一并提交

---

### Task 1: 下载器 + 最小 ZIP 解包

**Files:**
- Create: `src/server/host/download.ts`
- Create: `src/server/host/unzip.ts`
- Test: `tests/download.test.ts`, `tests/unzip.test.ts`

**Interfaces:**
```ts
// download.ts
export interface DownloadProgress {
  bytesReceived: number; totalBytes?: number; percent?: number;
  phase: 'connecting' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'failed';
  message?: string;
}
export interface DownloadOptions {
  url: string;
  destFile: string;              // 落盘的 zip 临时文件
  sha256: string;                // 期望的 sha256（小写 hex）
  proxy?: string;                // 可选代理，如 http://127.0.0.1:7897
  allowedHosts: string[];        // 允许清单
  onProgress?: (p: DownloadProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export async function downloadVerified(opts: DownloadOptions): Promise<{ path: string; bytes: number; sha256: string }>;
export function assertDownloadUrlAllowed(url: string, allowedHosts: string[]): URL;  // 抛错即拒绝
export function assertProxyUrlAllowed(proxy: string): URL;
```

```ts
// unzip.ts
export interface ZipEntry { name: string; size: number; compressedSize: number; method: number; offset: number; }
export function listZipEntries(buf: Buffer): ZipEntry[];
export function extractZip(buf: Buffer, entries: ZipEntry[], destDir: string, opts?: { filter?: (e: ZipEntry) => boolean }): { files: number; bytes: number };
```

**要求**
1. `assertDownloadUrlAllowed`：
   - scheme 必须是 `http`/`https`（其他一律拒绝）
   - host 必须在 `allowedHosts` 内（大小写不敏感）
   - **拒绝** loopback（`127.0.0.0/8`、`::1`、`localhost`）、私有网段（`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`fc00::/7`）、以及 `0.0.0.0`
   - 返回解析后的 `URL`，供调用方直接用
2. `assertProxyUrlAllowed`：scheme 只允许 `http`/`https`；host **必须是回环地址**（代理是本机跳板）；允许 `localhost`/`127.0.0.1`/`::1`
3. `downloadVerified`：
   - 无代理时用 `https` 模块直连；有代理时用 `CONNECT` 隧道（`http`/`https` 都要支持）——实现可复用 `node:https` + 手工 CONNECT
   - 跟随重定向**最多 5 跳**，每跳都重新过 `assertDownloadUrlAllowed`（重定向到 `objects.githubusercontent.com` 是正常路径）
   - 边下边算 sha256；**同时**支持 `Content-Length` → 进度百分比；总大小未知时 percent 为 `undefined`（不要伪造 0）
   - 落盘到 `destFile` 的**临时名**（`.part`），校验通过后再改名
   - sha256 不匹配 → 删除临时文件并抛错（错误文案必须说清「校验失败，已丢弃」）
   - 超时（默认 10 分钟）→ abort 并清理临时文件
4. `unzip.ts`：
   - 解析 **End of Central Directory**（含注释情形）、中央目录项、局部文件头
   - 支持 method 0（stored）与 8（deflate，用 `zlib.inflateRawSync`）
   - **拒绝**含 `..` 或绝对路径的条目名（Zip Slip），拒绝符号链接条目（外部属性高位）
   - `filter` 用于只解出需要的目录（例如只解 `napcat/` 与顶层运行文件）
   - 解压路径同样做越界校验（`path.resolve` 后必须仍在 `destDir` 内）
5. **不得**引入任何第三方 zip 库。

**测试**（承重）
- URL 校验：`ftp://` 拒绝、`http://127.0.0.1/x` 拒绝、`http://10.0.0.1/x` 拒绝、`http://192.168.1.1/x` 拒绝、host 不在允许清单拒绝、`https://github.com/...` 放行
- 代理校验：`http://127.0.0.1:7897` 放行、`socks5://127.0.0.1:1080` 拒绝、`http://example.com:7897` 拒绝（非回环）
- zip：构造一个含 stored + deflate 条目的最小 zip → 解出内容一致；含 `../evil.txt` 的条目 → 抛错且**不写盘**；方法 12（bzip2）→ 明确报错
- 下载：用本地 HTTP 服务器喂一个已知 sha256 的字节流 → 校验通过落盘；喂错哈希 → 抛错且临时文件被删

---

### Task 2: 受管安装台账 + 安装作业

**Files:**
- Create: `src/server/host/manager.ts`
- Test: `tests/manager.test.ts`

**Interfaces:**
```ts
export type ManagedMode = 'standalone' | 'inject';
export interface ManagedInstall {
  id: string;                    // 稳定 id（如 `napcat-4.18.42` 或含路径 hash）
  dir: string;                   // 安装目录（绝对路径）
  version: string;               // '4.18.42'
  mode: ManagedMode;
  installedAt: string;           // ISO 时间
  artifactSha256: string;
}
export interface InstallJob {
  id: string; startedAt: string; finishedAt?: string;
  state: 'running' | 'succeeded' | 'failed';
  phase: DownloadProgress['phase'];
  bytesReceived: number; totalBytes?: number; percent?: number;
  error?: string;                // 脱敏后的中文人话
  install?: ManagedInstall;
}
export class ManagedHost {
  constructor(opts: { dataDir: string; registryPath?: string });
  list(): ManagedInstall[];
  get(id: string): ManagedInstall | undefined;
  add(install: ManagedInstall): void;
  remove(id: string): boolean;
  startInstall(job: InstallJob): void;     // 内部推进状态机
  updateJob(job: InstallJob): void;
  getJob(id: string): InstallJob | undefined;
  listJobs(): InstallJob[];
}
```

**要求**
1. 台账落盘 `${ZCODE_PLUGIN_DATA}/managed-hosts.json`（原子写：先写 `.tmp` 再 rename）；**不含**任何凭据
2. `id` 稳定：由 `version` + 目录路径派生（同一目录重复安装不产生两条）
3. 安装作业状态机：`connecting → downloading → verifying → extracting → done/failed`，失败必须带中文原因且**不留半成品目录**（失败清理临时目录）
4. 落盘目录布局（Windows）：
   ```
   <dir>/
     node.exe  QQNT.dll  wrapper.node  index.js  napcat.bat  config.json  package.json ...
     napcat/
       napcat.mjs  loadNapCat.js  qqnt.json  NapCatWinBootMain.exe  NapCatWinBootHook.dll
       launcher-user.bat  native/  static/  config/
   ```
5. 安装完成后**生成 `qqnt.json`**：以本机桌面 QQ 的 `resources/app/package.json` 为底，把 `main` 换成 `./loadNapCat.js`（注入模式需要）；桌面 QQ 不存在时用制品自带的 `napcat/qqnt.json` 原样保留
6. 独立模式的 `config/` 里要写好 `webui.json`（端口 6099、token 由插件生成并**只**存插件数据目录）与 `onebot11_<uin>.json`（若已知 uin）
   - **token 不进仓库、不进日志、不进工具返回值**；写进受管安装目录的 `webui.json` 是必要的（NapCat 要用），但**返回给用户/模型的一律是掩码**
7. 独立模式**不依赖**桌面 QQ → 不需要 `qqnt.json` 改写；注入模式才需要

**测试**
- 台账读写往返；`add` 同 id 幂等；`remove` 后重新读盘仍无
- 原子写：中途失败不产生半截 JSON（旧文件仍可解析）
- 安装作业失败时目录被清理

---

### Task 3: 进程监管（启动 / 停止 / 状态）

**Files:**
- Create: `src/server/host/supervise.ts`
- Test: `tests/supervise.test.ts`

**Interfaces:**
```ts
export type HostState = 'not-installed' | 'stopped' | 'starting' | 'running' | 'degraded' | 'unknown';
export interface HostStatus {
  state: HostState;
  install?: ManagedInstall;
  pid?: number;
  webuiPort?: number; webuiReachable?: boolean;
  onebotPort?: number; onebotReachable?: boolean;
  login?: { user_id: string; nickname: string };
  uptimeMs?: number;
  message?: string;              // 面向用户的中文说明
}
export async function startManagedHost(install: ManagedInstall, opts: { logFile?: string }): Promise<{ pid: number }>;
export async function stopManagedHost(status: HostStatus): Promise<{ stopped: boolean; message: string }>;
export async function probeManagedHost(install: ManagedInstall): Promise<HostStatus>;
```

**要求**
1. **启动（独立模式）**：`spawn(<dir>\napcat.bat, [], { cwd: <dir>, detached: true, stdio: 'ignore', windowsHide: true })` → `unref()`；记录 pid 到台账
   - 也允许直接 `spawn(<dir>\node.exe, ['index.js'])`（等价，跨平台更稳）
2. **启动（注入模式）**：`spawn(<dir>\napcat\launcher-user.bat)`，并**明确**在返回里带风险提示文案
3. **停止**：Windows 用 `taskkill /PID <pid> /T /F`；非 Windows 用进程组 kill；**必须**杀掉子孙进程（QQ 内嵌进程也是子孙）
   - 只能停**插件自己记录过 pid** 的进程；pid 不在台账 → 拒绝并说明「不是本插件启动的实例」
4. **状态判定**：
   - pid 存活 → 再探 WebUI（`http://127.0.0.1:6099/webui` 或配置的端口）与 OneBot（配置的端口）
   - WebUI 通、OneBot 通 → `running`
   - WebUI 通、OneBot 不通 → `degraded`（NapCat 在跑但没开 OneBot Server）
   - pid 死了但端口通 → `unknown`（外部实例接管了端口；**不得**宣称是自己的）
   - 都没 → `stopped`
5. 状态探测**不得**改用户的 NapCat 配置；不得自动启动任何东西
6. 所有面向用户的文案走中文，且**不含**绝对路径以外的敏感信息；本地绝对路径只出现在「诊断」字段（spec 的路径策略）

**测试**
- 启停一个真实子进程（用 `process.execPath -e "setInterval(...)"` 冒充）→ 停止后进程真没了，子孙也没了
- 台账里没有的 pid → 拒绝停止
- 端口占用但 pid 不在台账 → `unknown`
- 状态文案三态齐全

---

### Task 4: MCP 工具层

**Files:**
- Modify: `src/server/tools.ts`
- Modify: `src/server/state.ts`（配置项 + 台账句柄）
- Modify: `src/server/config.ts`（`downloadProxy` / `napcatVersion` / `installDir`）
- Modify: `plugins/napcat-zcode/.zcode-plugin/plugin.json` 与 `.mcp.json`（`userConfig` 新增项 + env 映射）
- Test: `tests/tools-managed.test.ts`

**新增工具**
| 工具 | 入参 | 出参要点 |
|---|---|---|
| `napcat_host_status` | 无 | 受管安装列表 + 每个的 `HostStatus` + 当前生效模式 |
| `napcat_install` | `version?` `dir?` `mode?` | 返回 `jobId`（异步作业立刻返回） |
| `napcat_install_status` | `jobId?` | 进度（phase/bytes/percent）+ 最终结果 |
| `napcat_start` | `id?`（默认最近一个受管安装） | 启动结果 + 风险提示 |
| `napcat_stop` | `id?` | 停止结果 |
| `napcat_uninstall` | `id` | 删目录（**需确认**，面板二次确认后才调用） |
| `napcat_open_panel` | 无 | **对话内嵌打开面板**：结果带 `_meta.ui.resourceUri = ui://napcat-zcode/panel.html` |

**修改**
- `napcat_status` 增加 `host` 段（受管宿主状态摘要）
- `napcat_detect_local` 结果增加 `managed` 标记：该安装是否由插件受管

**要求**
1. 工具**不阻塞**在 124MB 下载上：`napcat_install` 起后台作业立即返回 `jobId`
2. 面板轮询 `napcat_install_status`；`jobId` 非法 → 明确错误
3. **token 一律掩码**（复用现有 `state.redact`）；`napcat_host_status` 不返回 WebUI token 明文
4. 工具返回的中文文案要覆盖：未安装 / 下载中 / 校验失败 / 解压失败 / 已在运行 / 不是本插件启动的实例 / 端口被外部实例占用
5. `napcat_install` 的 `dir` 必须是**绝对路径**；相对路径 → 明确报错；默认目录 `${ZCODE_PLUGIN_DATA}/napcat-<version>`
6. `downloadProxy` 非法 → 明确报错并说明「只支持本机回环地址的 http/https 代理」

---

### Task 5: 面板（管理区块）

**Files:**
- Modify: `src/panel/App.tsx` 与 `src/panel/components/*`
- Create: `src/panel/components/ManagedHost.tsx`
- Test: `tests/panel-managed.test.tsx`（或复用既有面板测试基建）

**要求**
1. 新增「本机 NapCat 管理」区块，三态：
   - **未安装**：显示「下载 NapCat」按钮 + 安装路径输入框（默认 `${ZCODE_PLUGIN_DATA}/napcat-<version>`）+ 版本下拉（当前钉 `4.18.42`）+ 代理输入（可留空）+ 下载进度条（phase 文案 + 百分比 + 已下载/总大小）
   - **已安装未运行**：显示「启动」按钮（独立模式 / 注入模式二选一，注入模式旁标注风险）+ 「卸载」
   - **运行中**：显示状态（运行中 / 降级 / 外部占用）+ 「停止」按钮（二次确认）+ 「打开 WebUI」+ 登录状态（昵称/uin）+ OneBot 端点
2. **未检测到但外部已装**（M2 探测到外部安装）：提示「检测到外部安装」+「使用这个端点」按钮；**不提供**启停（不是受管实例）
3. 「停止」必须二次确认；「卸载」必须二次确认且提示会删除目录
4. 下载中禁用重复点击；面板重开（重新挂载）后能从 `napcat_install_status` 恢复进度显示
5. 文案红线：不出现 `http://127.0.0.1` 以外的凭据；不出现明文 token；不出现「已成功」这类没有证据的断言

---

### Task 6: 收尾（文档 / 验收 / 版本 / dist）

- README 新增「受管宿主」小节：安装路径、模式说明、下载源与 sha256、代理配置、卸载方式
- spec §5.2 补 M3 细节；§3.1 已知限制追加（本轮实测：QQ 9.9.36+ 完整性检查、注入模式不可用、直连被墙需代理、上游已清空只能用归档镜像）
- `docs/acceptance-m1.md` 追加 §15（M3 验收项 + 文案红线表）
- `plugin.json` / `marketplace.json` 版本 `0.3.0` → `0.4.0`
- **重建 `dist/`**（`server.mjs` + `ui/panel.html`）并一并提交
- `package.json` 的 `version` 同步（此前 M2 漏过）

---

## 真机验证清单（M3 交付前必做）

本机已具备条件：独立版 NapCat v4.18.42 正在 `D:\NapCat-v4.18.42` 运行（WebUI 6099 已监听），可直接用于启停与端点联调。

1. 插件调用 `napcat_install` → 观察进度 → 落盘目录正确、`sha256` 校验通过
2. `napcat_start` → 进程起、WebUI 通 → `napcat_status` 显示 `running` + 登录信息
3. `napcat_stop` → 进程树被杀干净 → 状态 `stopped`
4. `napcat_start` → `napcat_status` → OneBot `get_login_info` 成功
5. 已有活体 NapCat 时跑 `npm run verify:live`，把 `message_seq` 边界语义 / `count` 是否被尊重 / `record` 真实时长字段名**实测**下来，修正 M1 的假设
6. 按 `docs/acceptance-m1.md` 逐条过（含面板 UI 与活体连接）

---

## 风险与对策

| 风险 | 对策 |
|---|---|
| 下载源是第三方归档镜像 | 钉 sha256；文档标注非官方；允许用户改源但仍走允许清单校验 |
| 124MB 下载耗时长 | 后台作业 + 进度；支持代理；失败可断点重来（不做分片续传） |
| 本机 github 直连被阻断 | `downloadProxy` 配置项；文案明确提示「直连不通时填本机代理」 |
| 注入模式在本机触发 QQ 完整性检查 | 默认独立模式；注入模式明确标注风险，且**默认关闭** |
| 启停误伤用户进程 | 只管台账里自己拉起的 pid；端口被外部占用时如实报 `unknown` |
| 桌面 QQ 仍可能报错 | 受管宿主走独立模式，桌面 QQ 完全不碰；已实测桌面 QQ 可单独正常启动 |
