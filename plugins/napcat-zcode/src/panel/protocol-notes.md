# MCP-UI 面板协议 —— 实测验证笔记

> 结论先行：**MCP-UI 扩展协议没有公开文档**，下面的字段形状全部是从
> ZCode 官方 `documents` 插件的 bundle（面板侧 SDK）与 ZCode 宿主实现（`app.asar`）里
> **逆向出来的**。本文件是 `src/panel/bridge.ts` 的唯一事实来源。
>
> 验证时间：2026-11-21（审查修复轮 1 补验了宿主 `ui/download-file` 处理器，见 §6.1）　验证对象：
> - 面板侧 SDK：`~/.zcode/cli/plugins/cache/zcode-plugins-official/documents/0.2.2/dist/ui/panel.html`
>   （`documents` 0.2.9 / `presentations` 0.2.9 / `spreadsheets` 0.2.9 / `pdf` 0.2.10 / `zcode-site` 0.5.1 同源）
> - 宿主实现：`D:\ZCode\resources\app.asar`（内含同一套 SDK + 宿主侧的 `AppBridge` + `ui/download-file` 处理器）
>
> ⚠️ **本文件优先于 design doc**：凡是 design doc 描述的宿主行为，一律以这里的**宿主源码实测**为准
> （`ui/download-file` 就是这样一个反例 —— design doc 说成功返回 `{success, filePath}`，实际是 `{}`）。
>
> 复现命令见文末「验证命令」。

---

## 1. 传输层

| 事实 | 实测结论 |
| --- | --- |
| 发送 | `window.parent.postMessage(jsonRpcMessage, "*")`（SDK 传输类 `gc`：`constructor(t = window.parent, n)`，`send(){ this.eventTarget.postMessage(t, "*") }`） |
| 接收 | `window.addEventListener("message", listener)` |
| 来源过滤 | SDK 严格过滤 `o.source !== this.eventSource`（`eventSource` 传的是 `window.parent`）→ 面板应忽略非宿主来源的消息 |
| 消息形状 | 标准 JSON-RPC 2.0：`{jsonrpc:"2.0", id, method, params}` / `{jsonrpc:"2.0", id, result}` / `{jsonrpc:"2.0", id?, error:{code,message,data?}}` |
| id 关联 | SDK 侧 `_requestMessageId++` 自增，响应按 `Number(e.id)` 从 `_responseHandlers` Map 里取；**通知没有 id** |

**结论**：brief 的「`window.parent.postMessage({jsonrpc:'2.0', id, method, params}, '*')` + 按 id 关联」
与实测一致，**方法名 / id 关联机制不需要改**。

---

## 2. `ui/initialize`（握手）

### 2.1 请求（面板 → 宿主）

实测 schema（bundle 里 `rj`）：

```js
m.object({
  method: m.literal("ui/initialize"),
  params: m.object({
    appInfo: dt,            // { name: string, title?: string, icons?: [], version: string, websiteUrl?: string, description?: string }
    appCapabilities: EP,    // { experimental?: ..., tools?: {listChanged?: boolean}, availableDisplayModes?: [...] } —— 全部可选
    protocolVersion: m.string(),   // ← 必填！
  }),
})
```

SDK 实际发出的参数：

```js
params: { appCapabilities: this._appCapabilities, appInfo: this._appInfo, protocolVersion: "2026-01-26" }
```

### 2.2 响应（宿主 → 面板）

实测 schema（bundle 里 `AP`）：

```js
m.object({
  protocolVersion: m.string(),
  hostInfo: dt,
  hostCapabilities: TP,
  hostContext: ...,
}).passthrough()
```

### 2.3 宿主能力集 `hostCapabilities`（bundle 里 `TP`）

```js
m.object({
  experimental:  Record<string, Record<string, any>>  ,   // .optional()
  openLinks:     {}  ,                                    // .optional()
  downloadFile:  {}  ,                                    // .optional()  ← 宿主支持 ui/download-file
  serverTools:   { listChanged?: boolean }  ,             // .optional()  ← 宿主能把 tools/call 代理到 MCP server
  serverResources:{ listChanged?: boolean }  ,             // .optional()
  logging:       {}  ,                                    // .optional()
  sandbox:       { permissions?, csp? }  ,                 // .optional()
  updateModelContext: { text?: {}, image?: {}, structuredContent?: {} } , // .optional()
  message:            { text?: {}, image?: {} } ,         // .optional()
  sampling:     { tools?: {} }  ,                         // .optional()
})
```

### 2.4 宿主**实际**会返回哪些位（`app.asar` 里宿主侧的能力构造函数）

```js
{
  openLinks: {},
  serverTools: {},                                   // ← 恒在
  serverResources: e.canSubscribeResources ? { listChanged: true } : {},
  logging: {},
  ...(e.canSample             ? { sampling: {} } : {}),
  ...(e.canDownloadFile       ? { downloadFile: {} } : {}),
  ...(e.canSendFollowUpMessage? { message: { text: {}, image: {} } } : {}),
  ...(e.canUpdateModelContext ? { updateModelContext: { text: {}, structuredContent: {}, image: {} } } : {}),
  experimental: { ... },
}
```

**语义结论（重要）**：

1. 能力位是「**键存在 = 支持**」，值是个描述子对象（可含子开关 `text`/`image`/`structuredContent`）。
   SDK 自己的判断也是这个口径：`if (!this._hostCapabilities?.sampling) throw ...`。
2. `serverTools` 在 ZCode 宿主里**恒为真**；`downloadFile` / `message` / `updateModelContext`
   取决于宿主开关 `canDownloadFile` / `canSendFollowUpMessage` / `canUpdateModelContext`。
   → 面板**必须**能降级，不能假设这四个位都在。
3. 未知能力位（`experimental` / `openLinks` / `logging` / …）只是**被忽略**，不能崩。

### 2.5 `ui/notifications/initialized`

实测 schema：`m.object({ method: m.literal("ui/notifications/initialized"), params: m.object({}).optional() })`
—— 是**通知**（无 id），`params` 可省略。SDK 发的是 `notification({method:"ui/notifications/initialized"})`。

---

## 3. `tools/call`（宿主代理到 MCP server）

实测（SDK 的 `callServerTool`）：

```js
async callServerTool(params) {
  return await this.request({ method: "tools/call", params });   // params: { name: string, arguments?: Record<string, any> }
}
```

宿主侧 `AppBridge` 注册了 `tools/call` 的请求处理器，转发给真正的 MCP client
（宿主能力位 `serverTools` 的描述原文：*"Host can proxy tool calls to the MCP server."*）。

**返回形状**：MCP `CallToolResult` —— `{ content: [{type:"text", text:"<一段 JSON 文本>"}], isError?: true }`。

**错误有两种载荷形状（桥不许改写，原样透传）**：

| 来源 | 载荷 | 桥的行为 |
| --- | --- | --- |
| 工具自己抛错（本插件的工具层捕获后 `isError:true` + `{error}`） | **result**：`{content:[{type:"text",text:'{"error":"..."}'}], isError:true}` | 原样返回 result；**不解析** |
| SDK / zod 入参校验失败（`@modelcontextprotocol/sdk` 1.32.2 `server/mcp.js:232`） | **JSON-RPC error 帧**：`{code:-32602, message:"MCP error -32602: Input validation error: ..."}` | reject，Error.message 逐字保留 `MCP error -32602: …`，并把原始 frame 挂在 `err.payload` |

> `McpError` 的 message 拼法见 SDK `types.js:2031`：`super(\`MCP error ${code}: ${message}\`)`。

**为什么「解析成 JSON」要留给面板**：错误文本既可能是 JSON（`{"error":"..."}`）也可能是纯文本
（`MCP error -32602: …`），只有面板的 API 层知道该怎么区分、怎么给用户看。桥一旦替它解析，
错误信息就会在桥里被压扁成一种形状。

---

## 4. `ui/message`（把内容作为用户消息发进对话）

请求 schema：

```js
m.object({
  method: m.literal("ui/message"),
  params: m.object({
    role: m.literal("user"),                        // 目前只支持 "user"
    content: m.array(pt),                           // 内容块数组
  }),
})
```

内容块 `pt` 的并集：`{type:"text", text}` / `{type:"image", data, mimeType}` /
`{type:"audio", …}` / `{type:"resource_link", …}` / `{type:"resource", resource:{…}}`。

**结果 schema**：`m.object({ isError: m.boolean().optional() }).passthrough()`
→ `isError:true` = **宿主拒绝或投递失败**。桥必须把它变成可见的失败，不能当成功静默吞掉。

---

## 5. `ui/update-model-context`（设为模型上下文）

请求 schema：

```js
m.object({
  method: m.literal("ui/update-model-context"),
  params: m.object({
    content: m.array(pt).optional(),
    structuredContent: m.record(m.string(), m.unknown()).optional(),
  }),
})
```

**结果 schema**：`oe.strict()` —— 严格空对象（只允许 `_meta`）。没有 `isError` 位。

---

## 6. `ui/download-file`（宿主弹另存为对话框；**但保存路径不跨协议，插件拿不到**）

请求 schema（bundle 里 `XN` / `app.asar` 里 `q`）：

```js
m.object({
  method: m.literal("ui/download-file"),
  params: m.object({
    contents: m.array(m.union([Kr, Gr])).describe(
      "Resource contents to download — embedded (inline data) or linked (host fetches). Uses standard MCP resource types."
    ),
  }),
})
```

其中：

```js
_i = m.object({ uri: string, mimeType?: string, _meta?: ... })
Si = _i.extend({ text: string })                 // 内嵌文本资源
bi = _i.extend({ blob: base64string })           // 内嵌二进制资源
Kr = m.object({ type: m.literal("resource"), resource: m.union([Si, bi]), ... })
Gr = m.object({ type: m.literal("resource_link"), uri, description, mimeType, size, ... })
```

**结果 schema**：`m.object({ isError: m.boolean().optional() }).passthrough()`
→ 协议层只有 `isError`。

### 6.1 宿主实现（**实测，`app.asar`；不是 design doc 的描述**）

宿主侧 `ui/download-file` 的处理器（压缩后原样）：

```js
return async n => {
  let r = !1;
  for (let [i, a] of n.entries()) {
    let { data: n, name: o } = await t(qye(a, i));
    if (n.byteLength === 0 || n.byteLength > 52428800)
      throw S_(-32602, `file_too_large: ${o} must be 1..${N_e} bytes`);
    (await e.saveFile({ data: n, suggestedName: o })).success || (r = !0);
  }
  return r ? { isError: !0 } : {};
};
```

**结论（当前宿主实测）**：

| 情况 | 宿主返回 | 插件能拿到什么 |
| --- | --- | --- |
| 全部保存成功 | `{}` | **什么都没有**：没有 `success`、没有 `filePath`、没有 `canceled` |
| 保存失败 **或** 用户取消 | `{ isError: true }` | **分不清取消与失败**（宿主只读了 `saveFile(...).success`） |
| 内容过大 / blob 非法 / 资源读不到 | 抛 `-32602`（`file_too_large` / `invalid_blob` / `resource_not_found`） | JSON-RPC **error 帧**（不是 `{isError:true}`） |

**保存路径被宿主丢弃**：`saveFile` 本身（Electron 的保存对话框）返回 `{success, canceled, error, …}`，
但宿主只读了 `.success`，**路径从未跨协议传回来**。

> ⚠️ **给 T13：当前宿主不返回保存路径。**
> `ui/download-file` 只能当「让用户自己另存一份」，插件拿不到文件在哪、也分不清取消与失败，
> **面板文案必须中性**（例：「已触发另存为，宿主未返回保存结果（可能已取消或失败）」）。
> 「保存为附件」的主路径应是服务端 `napcat_export` → 拿到真实 `mdPath` → 复制 `@<mdPath>` 到剪贴板 → 用户粘贴。

### 6.2 宿主怎么给「另存为」对话框取建议文件名

二进制里的**原文**（压缩后的 `app.asar`，逐字照抄）：

```js
function Gye(e){let t=(e.split(/[?#]/)[0]??``).split(`/`).filter(Boolean).at(-1)??``;try{return decodeURIComponent(t)}catch{return t}}
function Kye(e){return e.replace(/[\\/\u0000-\u001f]/g,`_`).replace(/^\.+/,``).trim().slice(0,120)}
function x_(e,t){let n=Kye(e.name?.trim()||(e.uri?Gye(e.uri):``)||`download-${t+1}`),r=Uye[Wye(e.mimeType)??``];return r&&!/\.[A-Za-z0-9]{1,8}$/.test(n)?`${n}.${r}`:n}
```

（上面三行是**未改写**的原文；此前的引文把 `Gye` 里的 `decodeURIComponent` 与 try/catch
省略了 —— 那两处正是「uri 最后一段要做 URL 解码」的依据，不能省。）

即：**建议文件名 = 内嵌资源 `uri` 的最后一段（URL 解码后；解码失败则用原样）**，
必要时按 mimeType 补扩展名。
（协议的内嵌资源 schema 里没有 `name` 字段，所以走 `uri` 这条路。）
桥用的 `uri` 是 `ui://napcat-zcode/<encodeURIComponent(filename)>` → 解码后正好是原文件名。✓

### 6.3 复核命令

⚠️ **同名定义**：整个 `app.asar` 里 `function Gye` 一共出现 3 处
（`grep -a -b -o 'function Gye' app.asar`）：

| # | 字节偏移 | 是什么 | 与本节的关系 |
| --- | --- | --- | --- |
| 1 | ~229431889 | TypeScript 编译器 bundle 里的 `binarySearch` | **无关** |
| 2 | ~318521712 | `readPositiveInt`（`i(Gye,"readPositiveInt")`） | **无关** |
| 3 | ~368377890 | uri 最后一段（本节这个） | ✅ **正确的就是第 3 个** |

旧的复核命令 `grep -a -o 'function Gye(e){.\{0,700\}' app.asar | head -2` 只命中 **2 处**
（第 2、3 个 —— 第 1 个的形参是 `(t,e,r)`），而且**先命中的是无关的那个**（`readPositiveInt`）。
下面的命令改用**函数体特征**（`Gye(e){let t=`）作锚点，只会命中正确的那一处：

```bash
cd /d/ZCode/resources
grep -a -o 'saveFile({data:.\{0,200\}' app.asar | head -3
grep -a -o '.\{600\}saveFile({data:n,suggestedName:o}).\{0,80\}' app.asar | head -2
# 正确的那处 Gye（函数体特征锚定）：命中 1 条
grep -a -o 'function Gye(e){let t=.\{0,240\}' app.asar
# 同名的其它定义（对照用，命中 3 条）
grep -a -b -o 'function Gye' app.asar
```

---

## 7. 其它相关方法（本次未用，列出以免误用）

`ui/open-link`、`ui/request-display-mode`、`ui/notifications/size-changed`、
`ui/notifications/host-context-changed`、`ui/notifications/request-teardown`、
`ui/resource-teardown`、`ui/notifications/tool-input` / `tool-input-partial` /
`tool-result` / `tool-cancelled`、`ui/notifications/sandbox-proxy-ready` /
`sandbox-resource-ready`、`resources/read` / `resources/list`、`sampling/createMessage`。

---

## 8. 与 brief 的差异（**已按实测调整 `bridge.ts`**）

| # | brief 写的 | 实测 | 处理 |
| --- | --- | --- | --- |
| 1 | `ui/initialize` params = `{appInfo, appCapabilities}` | schema 里 `protocolVersion` **必填**，SDK 也发它 | 已补 `protocolVersion: "2026-01-26"` |
| 2 | `ui/download-file` params = `{contents:[{uri,mimeType,text}]}` | 协议要求 `{contents:[{type:"resource", resource:{uri,mimeType,text}}]}`（内容块，不是裸资源） | 已按协议包裹 `type:"resource"` |
| 3 | `downloadFile` 返回 `{success,filePath,canceled,error}` | 协议层只有 `{isError?}`；**宿主实测**：成功返回 `{}`、失败与取消都返回 `{isError:true}`，**路径被丢弃、取消与失败分不清** | 归一（不编造）：优先用宿主给的 `success`，否则由 `isError` 反推；`filePath/canceled` 透传但**当前宿主不会填**；宿主没给 error 文案时给中性的机器可读标记 `download_not_confirmed`（不造人话）；原始载荷放 `raw`（不丢信息） |
| 4 | `uiMessage` 忽略返回值 | 结果是 `{isError?}`，`isError:true` = 投递失败 | `isError:true` → reject（不静默） |
| 5 | 能力位用 `'message' in hc` 判定 | 「键存在 = 支持」；值为 `null/undefined/false` 视为不支持 | 判定函数 `capEnabled()`：键存在 **且** 值不是 `null/undefined/false` |
| 6 | 传输/方法名/id 关联 | **与实测完全一致** | 不改 |
| 7 | brief 的 `downloadFile` 返回值看起来像宿主会回 `{success,filePath}` | 那是 design doc §5.9 的**设计**，不是宿主实现（宿主源码见 §6.1） | 桥按**实测**实现；面板文案中性；真实路径走服务端 `napcat_export` |

---

## 9. 验证命令

```bash
cd "/c/Users/TiantianYZJ/.zcode/cli/plugins/cache/zcode-plugins-official/documents/0.2.2"

# ui/initialize 的请求/响应 schema
grep -o '.\{80\}ui/initialize.\{300\}' dist/ui/panel.html | head -4
grep -o 'AP=m.object(.\{0,700\}'   dist/ui/panel.html | head -4   # 响应 schema

# 能力位
grep -o 'TP=m.object(.\{0,2000\}'  dist/ui/panel.html | head -2   # hostCapabilities
grep -o '.\{80\}appCapabilities.\{200\}' dist/ui/panel.html | head -4
grep -o '.\{60\}serverTools.\{120\}'   dist/ui/panel.html | head -4

# 方法名清单
grep -o 'method:m\.literal("[^"]*")' dist/ui/panel.html | sort -u

# 各方法的 params/结果 schema
grep -o 'method:m.literal("ui/message"),params:.\{0,200\}'            dist/ui/panel.html | head -2
grep -o 'method:m.literal("ui/download-file"),params:.\{0,260\}'      dist/ui/panel.html | head -2
grep -o 'method:m.literal("ui/update-model-context"),params:.\{0,260\}' dist/ui/panel.html | head -2

# 宿主侧的能力构造（app.asar 里）
cd /d/ZCode/resources
grep -a -o -m 4 '.\{300\}serverTools:{.\{0,300\}' app.asar

# 宿主侧的 ui/download-file 处理器（§6.1 的实测来源）
grep -a -o 'saveFile({data:.\{0,200\}' app.asar | head -3
grep -a -o '.\{600\}saveFile({data:n,suggestedName:o}).\{0,80\}' app.asar | head -2
# 建议文件名的取名函数（§6.2）：用函数体特征锚定，避开同名的另外两个定义
grep -a -o 'function Gye(e){let t=.\{0,240\}' app.asar
grep -a -b -o 'function Gye' app.asar   # 同名定义共 3 处，正确的是最后一处
```
