# ios-webkit-mcp — iOS WebView 调试 MCP Server

> 本文讲什么：ios-webkit-mcp（Phase 1 iOS 路径）的实现 spec
> 论断分级：✅ 实测 / 🟡 推理 / ⚠ 存疑
> 起草：2026-05-15 · 海愚（072438）
> 上层 spec：[`web-devtools-mcp.md`](./web-devtools-mcp.md)

## 一句话

iOS H5 调试 MCP server，**自写 TS WIP client** 经 `ios_webkit_debug_proxy` 接 iPhone WKWebView，提供跟 `chrome-devtools-mcp` 对齐的高阶工具（命名 / schema 一致），让 LLM 同一套调用形态调试 Android (CDP) + iOS (WIP)。

## 技术栈

🟡 跟 chrome-devtools-mcp 同源工具链：

- **语言**：TypeScript + Node.js 20.19+
- **MCP framework**：`@modelcontextprotocol/sdk`
- **transport**：WebSocket 直连 `ios_webkit_debug_proxy` ws endpoint（USB→ws 透传 WIP，**不翻译**）
- **WIP client**：**自写**，部分实现细节参考：
  - `iwdp-mcp`（Go 实现）— raw WIP method + JSCore worker 处理逻辑
  - `appium/appium-remote-debugger`（JS 实现）— reconnect 策略 / 多 target / 生产级踩坑

## 测试环境 ✅

- iPhone + **iOS WebView app (anonymized) app debug build (`isInspectable=true`) 已就绪**（用户 2026-05-15 确认）
- macOS + ios_webkit_debug_proxy v1.9.2 + libimobiledevice v1.3.0 已装

## iOS 版本 baseline

- **声明 baseline (recommended)** = iOS 17 single-version 🟡 cross-review 综合推荐（receipts 见末尾段）
  - 避开 iOS 17.0-17.3 的远程调试**断连 bug**（codex R1 引 Appium troubleshooting 文档）
  - 17.4 后 WIP 协议已稳定在 `Runtime.*` / `Network.*` / `Page.*` domain（kimi R1）
- **实测验证档** = **iOS 26.5.0** ✅ 2026-05-16 真机全绿
  - 设备：iOS WebView app (anonymized) (<APP-VERSION>)，UDID `<DEVICE-UDID>`
  - UA receipt：`Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X; zh-cn) AppleWebKit/601.1.46 ... <AppIdentifier>/<version> Mobile`
  - 5 工具全跑通 ([首版 5 工具表](#首版-5-工具80-调试场景))；说明 iOS 17.4+ → 26.5.0 区间至少**单方向兼容**（17 → 26 无 break）
- **不主动测** 16.x / 18.x ~ 25.x 中间档；遇到再补
- **Phase 1.x 加 capability probe**（qodercli R1 建议）— 按运行时探测降级，替代版本分支硬编码

## 首版 5 工具（≈80% 调试场景）

跟 chrome-devtools-mcp 上游同名 / 同参数 / 同返回结构对齐。**5/5 ✅ 实测真机通过 (2026-05-16, iOS 26.5.0 + iOS WebView page (anonymized))**：

| # | 工具名 | 包装 WIP method | 状态 | Receipt commit |
|---|---|---|---|---|
| 1 | `list_pages` | HTTP `/json/list` + 解析 ws URL 抽 page id | ✅ 6 target 列出 (1 WKWebView + 5 JSCore worker) | `401c9f2` |
| 2 | `evaluate_script` | `Runtime.evaluate` 经 `Target.sendMessageToTarget` 双层包装 | ✅ `1+1=2` / `document.title=iOS WebView page (anonymized)` / `navigator.userAgent` 返回 UA | `df6949c` |
| 3 | `list_console_messages` | 订阅 `Console.messageAdded` + `Runtime.exceptionThrown` 滚动 buffer (cap 200) | ✅ log/warn/error 全捕获 (含 Console.enable **历史重放** 行为) | `7db87e7` |
| 4 | `list_network_requests` | 订阅 `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` / `loadingFailed` 卷成 entry | ✅ GET 请求完整捕获（method+status+mimeType+type） | `7db87e7` |
| 5 | `take_snapshot` | `DOM.getDocument`（**注意 ✅ 实测：`DOM.enable` 在 WIP 上 `-32601 method not found`，但 `getDocument` 独立工作**） | ✅ DOM outline 渲染 (`<html><head><body>…`) | `7db87e7` |

仓位置：[https://github.com/echopi/ios-webkit-mcp](https://github.com/echopi/ios-webkit-mcp) main 分支 3 commits。

## WIP capability matrix（2026-05-16 真机 probe，iOS 26.5.0 + iOS WebView app (anonymized) H5）

probe receipt:
- 初版 16 methods: `((local /tmp probe script — historical))`
- batch-5 扩 27 methods: `((local probe log — historical))`（基于 `scripts/_tmp-probe-batch5.mjs`，已删）

`-32601` = method not found；`-32602` = invalid params（存在但 schema 不对）。

| WIP method | 结果 | 对应工具 |
|---|---|---|
| `Page.navigate` | ❌ NOT_FOUND | `navigate_page` 走 `Runtime.evaluate('location.href=…')` 兜底 |
| `Page.reload` | ✅ OK | `reload_page` |
| `Page.getResourceTree` | ✅ OK 返 frame tree | (后续 — wrap into `get_frame_tree` if needed) |
| `Page.captureScreenshot` | ❌ NOT_FOUND | `take_screenshot` 用 `Page.snapshotRect` |
| `Page.snapshotRect` | ✅ OK 返 dataURL PNG | `take_screenshot` |
| `Page.snapshotNode` | ✅ exists | (元素截图，后续) |
| `Page.setDeviceMetricsOverride` / `setTouchEmulationEnabled` / `bringToFront` / `stopLoading` / `getNavigationHistory` / `setLifecycleEventsEnabled` / `handleFileChooser` / `setInterceptFileChooserDialog` | ❌ NOT_FOUND（batch-5 probe） | viewport/lifecycle/file chooser 无 native；走 a host-side native bridge 或不实现 |
| `DOM.querySelector` / `All` / `getOuterHTML` | ✅ exists（需先 `getDocument` 拿 nodeId） | (后续) |
| `DOM.getBoxModel` | ❌ NOT_FOUND | 元素坐标无 native path |
| `DOM.enable` | ❌ NOT_FOUND | `take_snapshot` 用 `DOM.getDocument` 不依赖 enable |
| `Network.getResponseBody` | ✅ exists | `get_network_request` (with `withBody=true`) |
| `Network.setExtraHTTPHeaders` | ✅ OK（batch-5 probe） | `set_extra_http_headers` |
| `Network.setUserAgentOverride` | ❌ NOT_FOUND（batch-5 probe） | UA override 无 native（见 [future-opt §1](#future-optimization)） |
| `Network.emulateNetworkConditions` | ❌ NOT_FOUND（batch-5 probe） | 网络节流无 native |
| `Network.{get,set,delete,clearBrowser}Cookies` | ❌ NOT_FOUND（batch-5 probe） | 改走 `Page.getCookies` / `Page.deleteCookie` ✅（batch-8 probe） |
| `Page.getCookies` / `Page.deleteCookie` | ✅ OK（batch-8 probe，真实 cookie 数据 + 删除成功） | `get_cookies` / `delete_cookie` |
| `Page.snapshotNode` | ✅ OK（batch-8 probe 返 dataURL PNG） | `take_node_screenshot` |
| `Page.setBootstrapScript` | ✅ OK（batch-8 probe） | (后续 wrap into `set_init_script`) |
| `Heap.gc` / `Heap.startTracking` | ✅ OK（batch-8 probe） | `gc_heap`（`startTracking` 后续可包） |
| `Console.clearMessages` / `Console.disable` | ✅ OK（batch-8 probe） | `clear_console` |
| `DOM.setOuterHTML` / `DOM.resolveNode` | ✅ OK（batch-8 probe） | (后续 wrap, mutation tools 慎用) |
| `Debugger.enable` | ✅ OK（batch-8 probe） | (后续—断点支持) |
| `IndexedDB.requestDatabaseNames` | ✅ OK（batch-8 probe，返 [] 数组） | (后续 wrap `list_indexeddb`) |
| `Profiler` 域 / `Memory.getDOMCounters` / `Memory.startTrackingHeapObjects` | ❌ NOT_FOUND（batch-8 probe） | 无替代 |
| `Dialog.handleJavaScriptDialog` | ❌ Dialog domain NOT_FOUND | `handle_dialog` 走 JS 层 monkey-patch `window.alert/confirm/prompt` |
| `Heap.snapshot` | ✅ OK（Apple Inspector format） | `take_memory_snapshot` |
| `Target.setAutoAttach` / `exists` / `activateTarget` | ❌ NOT_FOUND（batch-5 probe 再次确认，仅 `sendMessageToTarget` / `dispatchMessageFromTarget` 存在） | 自家 PageSession 已 cover |
| `Emulation.*` 整个 domain | ❌ NOT_FOUND（batch-5 probe） | 走 a host-side native bridge |
| `Input.*` 整个 domain | ❌ NOT_FOUND（多次 probe） | 全部 input 工具走 `Runtime.evaluate` 合成事件 |
| `Storage.*` 整个 domain | ❌ NOT_FOUND（batch-5 probe） | 无 native 清存储路径 |
| `IndexedDB.requestData` | ⚠ -32602 INVALID_PARAMS（domain 存在但需正确参数） | (后续 probe schema) |
| `Animation.enable` / `Inspector.enable` | ✅ OK | nice-to-have |

## WIP capability matrix v2（2026-05-17 修订，fresh-ws-per-domain 隔离 probe）

probe receipt: `((local probe receipt — not in repo))`（test page (Safari) ws://127.0.0.1:9222/devtools/page/8）+ `scripts/_tmp-reprobe-apple.mjs`。

**修订动机**：v1 capability matrix 用 CDP 风格方法名 probe（如 `Memory.getDOMCounters`），多个 Apple WIP 域被错标 ❌ NOT_FOUND。本节以 iwdp-mcp（Go，`nnemirovsky/iwdp-mcp`）的 Apple-specific 方法名重 probe，**flip 25 项**。

### v1 错标 → v2 ✅（25 项 flip）

| WIP method | v1 标记 | v2 实测 | 备注 |
|---|---|---|---|
| `Memory.{startTracking,stopTracking,enable,disable}` | ❌ NOT_FOUND（用 `getDOMCounters` 名错） | ✅ OK 4/4 | 启停 + 订阅 `Memory.trackingUpdate` 拿采样 |
| `CPUProfiler.{startTracking,stopTracking}` | ❌（v1 只 probe 过 `Profiler.enable`） | ✅ OK 2/2 | CPU profile 流式采集 |
| `ScriptProfiler.{startTracking,stopTracking}` | ⚠ INVALID_PARAMS | ✅ OK 2/2 | 加 `includeSamples=true` 即通 |
| `Animation.{enable,startTracking,stopTracking}` | ❌（v1 误测）| ✅ OK 3/3 | 动画 tracking |
| `DOMStorage.enable` | ❌ NOT_FOUND（用 `Storage.*` 名错） | ✅ OK | `getDOMStorageItems` 需有效 securityOrigin |
| `Audit.{setup,run,teardown}` | ❌ NOT_FOUND | ✅ OK 3/3 | run 接受任意 JS test fn，返 `{result:{...}, wasError:false}` |
| `Worker.{enable,disable}` | ❌（用 `disconnectFromAllWorkers` 名错） | ✅ OK 2/2 | |
| `LayerTree.enable` | ❌ NOT_FOUND（用 `layersForNode(nodeId:1)` 探活，被 INVALID_PARAMS 误判） | ✅ OK | layersForNode 需先取真实 nodeId |
| `Canvas.{enable,disable}` | ❌ NOT_FOUND | ✅ OK 2/2 | |
| `Inspector.enable` | ❌（v1 没探）| ✅ OK | |
| `Heap.{snapshot,startTracking,stopTracking,gc}` | snapshot ✅，其它没标 | ✅ OK 4/4 | snapshot 返完整 Apple Inspector format JSON |
| `Network.{setInterceptionEnabled,addInterception,setResourceCachingDisabled}` | ❌ NOT_FOUND（v1 没探）| ✅ OK 3/3 | **网络拦截全套 ✅**（事件 `Network.requestIntercepted/responseIntercepted` + `Network.interceptContinue` + `Network.interceptWithResponse`）|
| `DOM.{hideHighlight,markUndoableState}` + `{getEventListenersForNode,highlightNode,getAttributes}` 存在但需有效 nodeId | 部分错标 ❌ | ✅ OK / ⚠ INVALID_PARAMS | |
| `Debugger.{setPauseOnExceptions,removeBreakpoint}` ✅；`step{Over,Into,Out}` 需 paused 状态 | 错标 ❌ | ✅ OK / ⚠ "Must be paused" | |
| `DOMDebugger.{setEventBreakpoint,setURLBreakpoint}` | ❌（v1 没探）| ✅ OK 2/2 | **事件断点 + URL 断点** |
| `Runtime.{callFunctionOn,getProperties,releaseObject}` | 部分错标 | ✅ OK / ⚠ INVALID_PARAMS | callFunctionOn / getProperties 需有效 objectId |
| `IndexedDB.enable` | ❌ NOT_FOUND（v1 没探）| ✅ OK | |
| `Console.setLoggingChannelLevel` | ❌（v1 没探）| ✅ OK | log 级别动态调整 |

### v2 确认 ❌ NOT_FOUND（5 项保留）

| WIP method | 错误信息 | 处理 |
|---|---|---|
| `Recording.enable` | `'Recording' domain was not found` | 无替代，废弃 |
| `Database.enable` | `'Database' domain was not found` | WebSQL 已废，无替代 |
| `ServiceWorker.getInitializationInfo` | `'ServiceWorker' domain was not found` | iOS WKWebView 不暴露 SW 控制面 |
| `Network.setEmulatedConditions` | `-32601` | `setResourceCachingDisabled` ✅ 是另一种节流入口 |
| `Schema.getDomains` 探到全部 supported domain | (v0.13.0 已接入；iOS 26.5 实测 ❌ NOT_FOUND，fallback 到 sentinel 探活) | 见 §[Capability discovery 架构](#capability-discovery-架构v201-新增v013-落码) |

### CSS.* 域 ⚠ TIMEOUT（待 capability probe + graceful degrade）

实测：CSS.enable / getMatchedStylesForNode / getComputedStyleForNode / getInlineStylesForNode / getAllStyleSheets / forcePseudoState **全部 ⏱ TIMEOUT** —— 不是 `-32601 NOT_FOUND`，是会话级 hang（≥ 3s 无回包）。

iwdp-mcp 在 macOS Safari 走 ✅（CDP method 跑通桌面 Safari）；本机 iOS 26.5.0 设备（iPhone 11，com.example.app + Safari）`CSS.enable` ≥ 2.5s 无回包。

**注**：iOS app 走 Apple 系统 WKWebView，无 fork（App Store 政策）。所以 hang 不是 "iOS WKWebView runtime 裁剪"（((removed: internal architectural footnote))）。

⚠ **真实根因待 probe 验证**：
- ① Apple iOS WKWebView Web Inspector 对 CSS 域的实现差异（iOS Safari Web Inspector 主要给"macOS Safari 远程调试 iOS Safari"用，CSS introspection 可能没移植到 ws transport）
- ② iOS 26.5.0 build 特定 bug
- ③ iwdp v1.9.2 transport 转译失败

**处理策略**（采纳 cross-review v2.0.1 共识）：
- **不暴露任何依赖 CSS.* 的工具**直到 ❶ Schema.getDomains 显示 CSS 在域列表 ❷ 单 method probe 拿到回包
- 一旦确认域不可用 → tools/list 启动时不注册相应 tool（不让 LLM 看到注定 timeout 的工具名）
- 跨 device / iOS 版本差异 → 按 device 缓存 capability snapshot
- 详细架构见 §[Capability discovery](#capability-discovery-架构-v201-新增v013-落码)
- **TODO（v2.0.2）**：在 macOS Safari 自身 inspect 桌面 Safari 页面跑同样 `CSS.enable`，对比 iOS WKWebView vs macOS Safari 行为差异，区分根因 ① / ② / ③

## 已实现工具（57 个 = 54 ✅ E2E 实测 + 3 ⚠ iOS WKWebView 运行时限制，截至 2026-05-17，ios-webkit-mcp v0.18.3）

### Batch-1 + Batch-2（10 个，✅ E2E 实测）

| # | 工具 | 状态 | WIP 实现 | Smoke receipt |
|---|---|---|---|---|
| 1 | `list_pages` | ✅ MVP | HTTP `/json/list` + parse ws URL | 6 target 列出（1 page + 5 worker） |
| 2 | `evaluate_script` | ✅ MVP + share-fix | `Runtime.evaluate` via `Target.sendMessageToTarget`，默认 shared PageSession | `1+1=2` / `document.title` / UA |
| 3 | `list_console_messages` | ✅ MVP | 订阅 `Console.messageAdded` + `Runtime.exceptionThrown` | 7 条（含 Console.enable 历史重放） |
| 4 | `list_network_requests` | ✅ MVP | 订阅 `Network.{requestWillBeSent,responseReceived,loadingFinished,loadingFailed}` | `__post_restart__<ts>` → 200 finished |
| 5 | `take_snapshot` | ✅ MVP | `DOM.getDocument`（不需 DOM.enable） | `<html><head><body>…` outline |
| 6 | `navigate_page` | ✅ batch-2 | `Runtime.evaluate('location.href=…')`（Page.navigate 不存在） | (未本地 smoke 避免跳页) |
| 7 | `take_screenshot` | ✅ batch-2 | `Page.snapshotRect` 返 base64 PNG | 414×896 viewport @ DPR 2 → ~315 KB PNG |
| 8 | `take_memory_snapshot` | ✅ batch-2 | `Heap.snapshot` 返 Apple Inspector format | 4.8 MB JSON, 306k nodes / 922k edges |
| 9 | `click` | ✅ batch-2 (v1) | `Runtime.evaluate('querySelector(sel).click()')`，no_match 错误正确捕获 | 负面 case 验证通过 |
| 10 | `wait_for` | ✅ batch-2 | `Runtime.evaluate` 轮询 selector / text / expression | `body` selector 3ms 命中 |

### Batch-3（7 个，7 ✅ E2E 实测 — commit `4eb03c7`）

| # | 工具 | 状态 | WIP 实现 | Smoke receipt |
|---|---|---|---|---|
| 11 | `fill` | ✅ batch-3 | `Runtime.evaluate` 原型链 `value` setter + `input`/`change` 事件 | `#wdm_in` ← `"hello-fill-2026"`；listener `ev.inputChange="hello-fill-2026"`；`ev.keys=[]`（验证 fill 不触发 per-key） |
| 12 | `type_text` | ✅ batch-3 (v0.3.1 patch) | sync IIFE（`delayMs=0` fast path）或 TS-side per-char loop（`delayMs>0`），避开 [§9 WIP Promise gap](#9-wip-promise-serialization-gap) | fast `text="fast"`, clearFirst → final value 4, keys=[f,a,s,t]；slow `text="slow"`, delayMs=15 → final value 4, keys 追加 [s,l,o,w]；两路径 8 个 key 全捕捉，listener `inputChange="slow"` 匹配 |
| 13 | `press_key` | ✅ batch-3 | `Runtime.evaluate` 单次 `KeyboardEvent`，支持 4 modifier，target=activeElement 或 selector | `key=Enter` to `#wdm_in` → `ev.keys[-1]="Enter"`；`isTrusted=false` 默认行为（表单 submit）未触发，符合 spec |
| 14 | `hover` | ✅ batch-3 | `Runtime.evaluate` 派发 `pointerover/enter/move` + 对应 `mouseover/enter/move`（element 中心坐标） | `#wdm_hover` → listener `ev.hover=1`；元素 rect `{x:20,y:120,w:280,h:28}` 命中 |
| 15 | `drag` | ✅ batch-3 (v0.3.1 patch) | sync IIFE（`stepDelayMs=0` all-in-one）或 TS-side per-step loop（`stepDelayMs>0`），避开 [§9 WIP Promise gap](#9-wip-promise-serialization-gap) | element→element fast: from→to (160,88)→(160,122), steps=8, listener `dragmoves=8 (=steps)` 命中 dest center；offset per-step: dx=40, dy=20, steps=5, stepDelayMs=10 → `dragmoves=5`, lastMovePoint=(200,108)=(160+40,88+20) 正确 |
| 16 | `get_console_message` | ✅ batch-3 | 复用 `consoleBuffer`，单消息全细节（args + stackTrace），支持负索引 | `index=-2` → `wdm_smoke_console_log` 完整 args（2 个，含 object preview）+ 6-frame stackTrace；buffer 35/200 |
| 17 | `get_network_request` | ✅ batch-3 | 复用 `networkBuffer`（已扩 `requestHeaders`/`responseHeaders`/`postData`），可选 `Network.getResponseBody` body | `manifest.json?wdm_smoke=…` finished GET 200；6 req headers + 15 resp headers（含 `eagleeye-traceid`/`x-server-id`）+ 22318 byte HTML body via `Network.getResponseBody` ✅ 通过 |

⚠ 共性已知风险（所有 batch-3 输入事件类工具）：

- `isTrusted=false` — 业务 JS 若用此字段甄别人造事件会拒绝
- iOS gesture recognizer 不会触发（无真 touch 到 host）
- IME / composition 事件无法重放
- 默认行为（form submit / scroll）只在 app JS 显式调用时生效

如需真 touch 事件 / 真 gesture，参考 [Future optimization](#future-optimization) a host-side native bridge 桥接。

### Batch-4（3 个，✅ E2E 实测 — commit `8034b57`）

| # | 工具 | 状态 | WIP 实现 | Smoke receipt |
|---|---|---|---|---|
| 18 | `fill_form` | ✅ batch-4 | 单次 `Runtime.evaluate` 内循环；每字段独立 success/failure，逐条结果不阻塞其余 | `[#wdm_a:"alpha", #wdm_b:"beta", #nonexistent]` → 2/3 ✓ + 1 no_match 正确归集；evaluate_script 复核 input 值匹配 |
| 19 | `handle_dialog` | ✅ batch-4 | JS 层 monkey-patch `window.alert/confirm/prompt`（WIP 无 `Page.javascriptDialogOpening` / `handleJavaScriptDialog`，verified `-32601`）。Modes: `install` / `list` / `set_response` / `uninstall`；捕获队列存 `window.__wdm_dialogs` | install confirm=true/prompt="smoke-answer" → 触发 `alert('alert-1')`/`confirm('confirm-1?')`/`prompt('prompt-1?','def')` → list 拿到 3 条；confirmRet=true、promptRet="smoke-answer" 匹配；uninstall ✓ |
| 20 | `select_page` | ✅ batch-4 | `PageSession.get({ pageId })`：关闭当前 ws → 重新走 `init(proxyBase, pageId)` 选目标 → 重订阅 + buffer 清零 | `pageId=7` 调用 → reset + 重新 attach iOS WebView page (anonymized)，buffer 清空，DOM.enable 报"not found"（已知，符合 spec） |

⚠ `handle_dialog` 限制：override 同步返回，不触发原生 iOS 弹窗 UI；依赖"alert 阻塞至用户点击"的业务行为会与真实 session 分歧。

### Batch-5（3 个，✅ E2E 实测 — commit `c968c39`）

| # | 工具 | 状态 | WIP 实现 | Smoke receipt |
|---|---|---|---|---|
| 21 | `wip_send` | ✅ batch-5 | 直透 `PageSession.session.send(method, params)`，封装 -32601 / -32602 错误为结构化输出 | `Inspector.enable` → 返 `{}` 正常 |
| 22 | `reload_page` | ✅ batch-5 | `Page.reload({ ignoreCache })` ✅ probe 通过；buffer 不自动清 | `ignoreCache=false, waitAfterMs=1500` → 页面重载iOS WebView page (anonymized) |
| 23 | `set_extra_http_headers` | ✅ batch-5 | `Network.setExtraHTTPHeaders` ✅ probe 通过；只影响后续请求 | F17 probe（2026-05-16）：`X-WDM-Probe-Header` 注入后 fetch + XHR 实测请求头**都带**该字段；`reload_page` 后仍保留（同 ws 状态）；`select_page` 后**清空**（ws 重建，符合 [§8 per-ws isolation](#8-wip-per-ws-state-isolation-实测)） |

### Batch-6（2 个，Apple-specific 高价值工具，✅ E2E 实测 — commit `bb7e620`）

batch-6 跳出 chrome-devtools-mcp 上游对齐，利用 WIP-only 的 DOM chain + frame tree 接口加值。

| # | 工具 | 状态 | WIP 实现 | Smoke receipt |
|---|---|---|---|---|
| 24 | `query_dom_node` | ✅ batch-6 | `DOM.getDocument` → `DOM.querySelector(All)` → `DOM.getOuterHTML` | `#wdm_dom` first 模式 → nodeId=18 + outerHTML 32 bytes |
| 25 | `get_resource_tree` | ✅ batch-6 | `Page.getResourceTree`；递归渲染 frame 层级 + per-frame 资源 + URL 子串过滤 | iOS WebView page (anonymized) → 1 frame `0.1`/text-html/origin=https://example.com，`manifest` 过滤 0 命中 |

⚠ batch-6 probe 同时确认以下 Apple-specific 域**全部 timeout**（不可用）：`CSS.enable` / `CSS.getMatchedStylesForNode` / `LayerTree.enable` / `DOMStorage.enable` / `ApplicationCache.enable` / `Database.enable` / `Worker.enable`。等找到正确 schema 再考虑包工具。

### Batch-7（1 个，JS-side Performance API 兜底，✅ E2E 实测 — commit `e7afc13`）

WIP 无 `Tracing.*` / `Performance.getMetrics` 域，chrome-devtools-mcp 的 `performance_*` 工具不可实现；但 JS PerformanceObserver + `performance.getEntriesByType` 在 WebView 内可用，这条路径就是兜底。

| # | 工具 | 状态 | WIP/JS 实现 | Smoke receipt |
|---|---|---|---|---|
| 26 | `get_performance_metrics` | ✅ batch-7 | 单次同步 `Runtime.evaluate` 包 `performance.getEntriesByType('navigation' / 'paint' / 'largest-contentful-paint' / 'layout-shift' / 'resource')`；slow-resource 阈值 + topN | iOS WebView page (anonymized)页 → navigation type=navigate, FCP 173.0ms, CLS 0.0, 55 resources, 0 marks/measures |

⚠ JS-side 近似 — 无 CPU sampling、无 flame-graph、无渲染流水线分解。深度 CPU profile 走 Safari Web Inspector Timeline GUI（macOS UI）兜底。

### Batch-8（5 个，probe-driven Apple-specific 工具，✅ E2E 实测 — commit `b8d0d27`）

batch-8 probe（`((local probe log — historical))`）发现一批 Apple-specific method 实际可用，包成工具：

| # | 工具 | 状态 | WIP 实现 | Smoke receipt |
|---|---|---|---|---|
| 27 | `take_node_screenshot` | ✅ batch-8 | `DOM.getDocument` → `DOM.querySelector` → `Page.snapshotNode`（返 dataURL PNG） | `#__wdm_smoke__` → nodeId=45, ~12 KB PNG（含 alpha/beta inputs + patched DOM）image 渲染正常 |
| 28 | `get_cookies` | ✅ batch-8 | `Page.getCookies`（Network.*Cookies 全 ❌） | `urlSubstring=qianwen, limit=5` → 2 个真实 cookie（`__itrace_wid` / `b-user-id`，含 domain/path/expires/secure 等字段） |
| 29 | `delete_cookie` | ✅ batch-8 | `Page.deleteCookie`；需 cookieName + url 配对 | `cookieName=wdm_smoke_nonexistent, url=https://example.com` → 成功返回（不存在的名也 no-op 成功，符合 CDP 语义） |
| 30 | `gc_heap` | ✅ batch-8 | `Heap.gc`；可选用 `performance.memory.usedJSHeapSize` 测 delta | GC 执行成功；iOS WebKit 不暴露 `performance.memory`（符合 Safari 行为），降级标 ⚠ 提示 |
| 31 | `clear_console` | ✅ batch-8 | `Console.clearMessages` + reset PageSession.consoleBuffer | 调用成功（restart 后 buffer 即为 0） |

batch-8 probe 同时发现的 ❌ NOT_FOUND：`Profiler` 域 / `Memory.getDOMCounters` / `Memory.startTrackingHeapObjects` / `Page.addScriptToEvaluateOnNewDocument`（用 `Page.setBootstrapScript` 替代）/ `Runtime.compileScript` / `Tracing.start`（已知）。

### Batch-9 + Batch-10（3 个收尾，✅ E2E 实测 — commit `20f5b70` / `63ac852`）

| # | 工具 | 状态 | WIP 实现 | Smoke receipt |
|---|---|---|---|---|
| 32 | `set_init_script` | ✅ batch-9 | `Page.setBootstrapScript({ source })` — 每次导航执行；只允许一个 script，replace 语义；`source=""` 清空 | install 66 chars → 成功 + 清空 → 成功 |
| 33 | `list_indexeddb` | ✅ batch-9 | `IndexedDB.requestDatabaseNames({ securityOrigin })`；origin 默认取当前 `location.origin` | `https://example.com` → 0 databases（the test app page不用 IndexedDB，符合预期） |
| 34 | `set_outer_html` | ✅ batch-10 | `DOM.getDocument` → `DOM.querySelector` → `DOM.setOuterHTML`；单 root 元素替换 | `#wdm_dom` (nodeId=31) ← `<div id="wdm_dom">patched-via-set_outer_html</div>`；evaluate_script 复核 outerHTML 已替换 |

### Batch-11（1 个，Apple Timeline 等价 CDP Tracing，✅ E2E 实测 — commit `3020b9b`）

batch-11 probe（`((local probe log — historical))`）发现 Apple WIP `Timeline` 域可用 — 是 chrome-devtools-mcp `performance_*` 工具背后 CDP `Tracing.*` 的 Apple 等价物。先前 spec 说"WIP 无 Tracing 等价" → 推翻。

| # | 工具 | 状态 | WIP 实现 | Smoke receipt |
|---|---|---|---|---|
| 35 | `record_timeline` | ✅ batch-11 | 订阅 `Timeline.eventRecorded` → `Timeline.start` → wait durationMs → `Timeline.stop` → drain 100ms。返事件 type 直方图 + 按 duration top-N | `durationMs=500, topN=5` → 1 `RenderingFrame` event 捕到，type 直方图 + top-N 正确渲染（idle 页面事件少为预期） |

batch-11 probe 同时新发现可用 WIP 方法（后续可包工具）：

- `Debugger.disable` / `Debugger.pause` / `Debugger.setBreakpointByUrl` / `Debugger.setBreakpointsActive` ✅
- `Animation.enable` ✅ (但 `Animation.getPlaybackRate` ❌)
- `Worker.enable` ✅
- `ScriptProfiler.startTracking` ✅
- `Audit.setup` ✅ — Audit 域存在
- `Canvas.enable` ✅
- `Heap.stopTracking` ✅
- `LayerTree.layersForNode` ⚠（存在，要 valid nodeId）

❌ NOT_FOUND：`Recording` 域 / `ScriptProfiler.enable`（用 `startTracking`） / `Animation.getPlaybackRate` / `Worker.disconnectFromAllWorkers`

### Batch-12（3 个，Debugger 三件套，✅ E2E 实测 — commit `9828fb3`）

| # | 工具 | 状态 | WIP 实现 | Smoke receipt |
|---|---|---|---|---|
| 36 | `pause_debugger` | ✅ batch-12 | `Debugger.enable`（idempotent）+ `Debugger.pause`；返回即返，actual pause 在下次 JS 执行时 | 调用成功；并行调用 `handle_dialog uninstall`（依赖 Runtime.evaluate）触发 10s timeout — 验证 pause 确实生效（事故复现，spec 警告坐实） |
| 37 | `resume_debugger` | ✅ batch-12 | `Debugger.resume`，"Was not paused" 友好降级为 no-op | resume 成功；后续 evaluate_script / uninstall 立即恢复 |
| 38 | `set_breakpoint_by_url` | ✅ batch-12 | `Debugger.setBreakpointByUrl({url, lineNumber, columnNumber, condition})`；返 breakpointId + 已解析的 source 位置 | `https://example.com/test.js:10:0` → breakpointId 注册成功，0 已解析位置（脚本未加载，符合预期） |
| 39 | `set_pause_on_exceptions` | ✅ batch-13 (v0.14.0) | `Debugger.setPauseOnExceptions({state})`，state ∈ {none, uncaught, all} | `state=none` / `state=uncaught` 真机调通（`scripts/smoke-batch13-must.js`，2026-05-17） |
| 40 | `set_event_breakpoint` | ✅ batch-13 (v0.14.0) | `DOMDebugger.setEventBreakpoint({breakpointType, eventName})`；type ∈ {listener, timer, animation-frame, interval} | `click` listener 真机调通（同 smoke） |
| 41 | `set_url_breakpoint` | ✅ batch-13 (v0.14.0) | `DOMDebugger.setURLBreakpoint({url, isRegex})` —— 网络/XHR URL 断点（≠ `set_breakpoint_by_url` 的 JS 源 URL 断点） | `api` 子串真机调通（同 smoke） |
| 42 | `get_event_listeners` | ✅ batch-13 (v0.14.0) | DOM.getDocument → DOM.querySelector → DOM.getEventListenersForNode；可选 `includeAncestors` 走 Runtime.evaluate 列祖先选择器 | `body` 真机调通返 77 listeners（同 smoke） |
| 43 | `record_cpu_profile` | ✅ batch-13 (v0.14.0) | `CPUProfiler.startTracking` + `ScriptProfiler.startTracking({includeSamples:true})` 启动；`durationMs` 后停 + 收敛 `ScriptProfiler.trackingUpdate` 事件聚合 top-N 调用栈 | 2000ms 真机调通 0 samples（页面闲置时 ScriptProfiler 不发 sample 事件，符合预期） |
| 44 | `highlight_node` | ✅ batch-13 (v0.15.0) | DOM.getDocument → DOM.querySelector → DOM.highlightNode（默认蓝色 content + 黄绿橙边框）。设备屏幕 + 后续 take_screenshot 都能看到 overlay | `body` / `div` 真机调通 (`scripts/smoke-batch13-should.js`，2026-05-17) |
| 45 | `hide_highlight` | ✅ batch-13 (v0.15.0) | DOM.hideHighlight；无参，no-op safe | 真机调通（同 smoke） |
| 46 | `set_resource_caching_disabled` | ✅ batch-13 (v0.15.0) | Network.setResourceCachingDisabled({disabled})，热调试用 | true / false 切换真机调通（同 smoke） |
| 47 | `set_request_interception` | ✅ batch-13 (v0.15.0) | Network.setInterceptionEnabled({enabled}) **switch only** —— `intercept_continue` / `intercept_respond` 移 batch-14 + 完整契约（避免 LLM "能力幻觉"） | enable / disable 调通（同 smoke）；启用后立即关闭，避免页面 hang |
| 48 | `get_capability_snapshot` | ✅ batch-14 (v0.16.0) | 透出 `PageSession.capability()` 给 LLM —— supportedDomains / schemaProbeSucceeded / sentinels / notes / attachInfo | 真机调通 (`scripts/smoke-batch14-quickwin.js`，2026-05-17) — Schema.getDomains ❌ → supportedDomains: null + notes 完整 |
| 49 | `record_memory_tracking` | ✅ batch-14 (v0.16.0) | `Memory.startTracking` + `Memory.stopTracking` + `Memory.trackingUpdate` events；按 category (javascript/images/jit/layers/page/other) 聚合 first vs last 差值 | 2000ms 真机调通：4 samples，javascript +9.59 MB (13.8%), page +0.19 MB（同 smoke） |
| 50 | `set_blackbox_url` | ✅ batch-14 (v0.16.1) | `Debugger.setShouldBlackboxURL({url, shouldBlackbox})` —— Apple WIP 用 per-URL bool（CDP `setBlackboxPatterns` ❌ NOT_FOUND） | jquery URL 切换 blackbox 真机调通 (2026-05-17) |
| 51 | `list_intercepted_requests` | ⚠ batch-14 (v0.17.0) iOS 运行时无效 | 列出 PageSession 缓冲的 `Network.requestIntercepted` 事件 | 实测 iOS 26.5 WKWebView 永远空 — Apple Network.setInterceptionEnabled / addInterception 都返 `{}` 但 requestIntercepted 事件不触发，是 iOS 系统 WebKit 限制（macOS Safari 走 iwdp-mcp 验证 ✅）|
| 52 | `intercept_continue` | ⚠ batch-14 (v0.17.0) iOS 运行时无效 | `Network.interceptContinue({requestId, errorReason?})` —— abort=true 走 BlockedByClient | 同 #51 — 工具按 WIP spec 实现，iOS 26.5 WKWebView 运行时无 fire 事件 |
| 53 | `intercept_respond` | ⚠ batch-14 (v0.17.0) iOS 运行时无效 | `Network.interceptWithResponse({requestId, statusCode, headers, content, base64Encoded:true})` | 同 #51 — body 自动 base64 编码 |
| 54 | `analyze_performance` | ✅ batch-14 composite (v0.18.0) | Promise.all 并行调 `record_timeline` + `record_cpu_profile` + `record_memory_tracking`，同一 durationMs 窗口；输出统一 markdown + cross-correlation hints | 2500ms 真机调通：1 timeline event / 0 CPU samples / 5 memory samples 聚合到一份报告 |
| 55 | `debug_element` | ✅ batch-14 composite (v0.18.1) | 串行调 `query_dom_node` → `get_event_listeners`（→ optional `take_node_screenshot` / `highlight_node`）—— DOM 操作必须串行（Apple WIP `DOM.getDocument` bumps node generation 让并发 nodeId 失效） | `body` 真机调通：45690 bytes outerHTML + 77 listeners 一份报告 |
| 56 | `summarize_console_errors` | ✅ batch-14 composite (v0.18.2) | 直读 `PageSession.consoleBuffer` → 按 minLevel 过滤 → 按 (text 前 80 字 + url:line) 分组 → top-N 频率排序 + 一份代表 stack trace | 真机 49 entries → 5 groups (top: 20 × empty / 14 × `[apm] infra_sec_web_api_walify` / 6 × `[apm] httpRequestTiming`) |
| 57 | `set_user_agent` | ✅ batch-14 (v0.18.3) | `Page.overrideUserAgent({value})` + 默认 `Page.reload({ignoreCache:true})` —— **upstream protocol-level 替代 host-side UA override 路径** | 真机调通：override→reload 后 `navigator.userAgent` 与 outgoing Network.requestWillBeSent UA 都变；xhs 后端立即返"安全限制"页面证明 UA 真到了网络层 |

⚠ pause 后子 `Runtime.evaluate` 调用会 block — 本 session smoke 已复现：与 `handle_dialog uninstall` 并行调用触发 10s timeout，必须先 resume 再做 JS 评估。

⚠ **Apple WIP per-target 串行处理 (batch-13 实测，2026-05-17)**：会 hang 的方法（CSS.* 等）不能跟其他工具调用复用同一 ws —— 会阻塞 5+ 秒。这是 capability discovery 移除 CSS sentinel 的根因（详见 §[Capability discovery → Receipt](#receiptv014-真机实测2026-05-17)）。

## 待对齐工具（chrome-devtools-mcp upstream (chrome-devtools/chrome-devtools-mcp) parity）

🟡 剩余 — 基于 batch-5 probe，以下方法在 WIP 上**确认不可用**：

- `resize_page` / `emulate` (viewport / network / CPU) — Emulation 整域 ❌ + Network.emulateNetworkConditions ❌；走 [future-opt §1](#future-optimization) a host-side native bridge 或不实现
- `new_page` / `close_page` — Target 域无 activateTarget，iOS WebView 多实例由 host app 管，WIP 无法新建/关闭页面
- `upload_file` — Input 整域 ❌ + `Page.{handle,setIntercept}FileChooser` ❌；唯一路径是 JS-side File API 注入（脆弱）
- `performance_*` / `lighthouse_audit` — 永不实现（spec §「无法对齐」）

### 无法对齐（WIP 协议本身缺，永远不实现）

✅ 协议本身限制（probe receipt 同上 capability matrix）：

- `lighthouse_audit` — WIP 无对应 audit 流程引擎
- `performance_start_trace` / `performance_stop_trace` / `performance_analyze_insight` — WIP 无 `Tracing.*` domain（Web Vitals 类指标可通过 [兜底注入](#兜底方案) 提供子集）

## Future optimization

~~UA override~~ → 已被 v0.18.3 `set_user_agent` 工具（`Page.overrideUserAgent`）替代，无需 native bridge。the host-side bridge would still be needed for viewport + true touch event dispatch：

1. ~~`cdp_setPCUserAgent`~~ → `set_user_agent` 工具直接走 `Page.overrideUserAgent` ✅（实测 v0.18.3）
2. `cdp_setViewport` / `cdp_overrideViewport` — viewport override（`Page.setScreenSizeOverride` upstream 标 `!PLATFORM_COCOA`，iOS + macOS 都不支持，**这条仍需 native bridge**）
3. **真 touch event dispatch**：`touchStart/touchEnd/touchMove/touchCancel` + touchPoints array — 弥补当前 `click` 走 `el.click()` 合成事件不触发 gesture-only handler 的局限

后续若 ios-webkit-mcp 要支持高质量 gesture 模拟（long press / drag / scroll-driven）或正确 viewport 模拟，would need a host-side JSAPI bridge to dispatch real touch events，而非纯 `Runtime.evaluate` 兜底。

🟡 但这条路径属于 Phase 2（host-app-specific 扩展），跟 ios-webkit-mcp Phase 1 "iOS-side codeless" 边界冲突 — 立项时需重新评估。

## 兜底方案

✅ Performance domain 子集兜底（qodercli R1 建议）：

- 通过 `Runtime.evaluate` 注入 `PerformanceObserver` + Long Tasks API + Layout Shift API
- 采集 LCP / FCP / CLS / Long Tasks
- 组装 Lighthouse-shaped JSON 子集，返回结构跟 chrome-devtools-mcp `performance_analyze_insight` 对齐
- **不是真的 Lighthouse**：能拿 Web Vitals 几个指标，拿不到 Lighthouse 完整 audit 报告

## Capability discovery 架构（v2.0.1 新增，v0.13.0 落码）

来源：cross-review v2.0.1（codex + kimi + qoder 3/3 共识）。受 [WIP capability matrix v2](#wip-capability-matrix-v22026-05-17-修订fresh-ws-per-domain-隔离-probe) 中 CSS.* TIMEOUT 启发 —— 跨 device / iOS 版本（iOS 16 vs 17 vs 26）/ WebKit build 的能力差异需在工具层做防御性处理。

### 架构

```
启动 WipSession
   ↓
1. ws connect → Target.targetCreated
   ↓
2. tools/list 注册（启动立即返回，不阻塞）
   ↓ 异步并行
3. 后台调 Schema.getDomains
   ↓
4. capability snapshot 写 PageSession 状态
   ↓
5. tools/list 热更新（不可用工具被 filter 掉，LLM 重 list 即生效）
```

### 关键决策

1. **异步非阻塞**：tools/list 启动 < 50ms 返回，capability probe 后台跑（典型 RPC < 50ms 但跨设备网络可能更慢）；首次 probe 完成前所有工具按 v1 capability matrix 默认可见
2. **预过滤 tools/list**：probe 完成后，已知不可用域（如 CSS.* 在 iOS 26.5 实测 hang）对应的 tool 不进 tools/list；LLM 调用 `tools/list` 拿到的就是该 device + iOS 版本实际可用集
3. **结构化 error 兜底**：缓存失效或域级 hang 漏过预过滤 → 工具调用层超时回退返回机器可读 error：`{code: "DOMAIN_UNAVAILABLE", domain: "CSS", reason: "domain not exposed on this iOS WebKit build", fallback: null}`
4. **错误码分层**（避免再把协议缺失误判为超时）：
   - `DOMAIN_UNAVAILABLE` — Schema.getDomains 显示该域不在 supported list
   - `INVALID_PARAMS` — `-32602`，schema 不对
   - `METHOD_NOT_FOUND` — `-32601`，方法名错
   - `TIMEOUT` — 超过 ws round-trip SLA（默认 3s）
   - `TRANSPORT_ERROR` — ws 连接断开 / iwdp 不可达

### Capability snapshot 结构

```ts
type CapabilitySnapshot = {
  deviceOSVersion: string;        // "26.5.0"
  webKitFork: 'safari' | 'quark-u4' | 'unknown';
  supportedDomains: string[];     // Schema.getDomains 结果
  probedAt: number;               // 时间戳，跨 session 可缓存
  cssTimeout: boolean;            // CSS.* TIMEOUT 显式探测结果（启动时一次性 enable 探活）
};
```

### Receipt（v0.14.0 真机实测，2026-05-17）

`scripts/smoke-capability-discovery.js` on iOS 26.5.0 (iPhone 11) + Apple 系统 WKWebView，test page (Safari) (Safari)：

```json
{
  "probedAt": "2026-05-17T02:33:52.559Z",
  "probeDurationMs": 4,
  "schemaProbeSucceeded": false,
  "supportedDomains": null,
  "sentinels": {},
  "notes": ["Schema.getDomains DOMAIN_UNAVAILABLE: 'Schema' domain was not found"]
}
```

**关键发现**（实测）：
- **Schema.getDomains ❌ NOT_FOUND on iOS 26.5 WKWebView** — Apple WIP 标准 discovery method 在该 iOS 版本/build 上不暴露。`assertDomainAvailable()` fallback 到 optimistic（`supportedDomains === undefined` 时不 block 工具调用）—— 这是 v2.0.1 spec 明确设计的容错路径。
- **probe duration 4ms** — capability discovery 完全非阻塞（v0.13.0 是 2505ms 因 CSS sentinel timeout 主导，但 v0.14.0 移除了 CSS sentinel）。
- **⚠ Apple WIP per-target 消息处理是串行的 (v0.14.0 实测踩坑)**：CSS.* 等"会 hang"的方法不能放进 sentinel pool —— 在共享 ws 上发出后会阻塞所有后续工具调用 5+ 秒。后果是 batch-13 工具看似 "WipSession closed by peer"。当前 `SENTINEL_PROBES = []`，CSS 不可用通过 ① Schema.getDomains 缺失 ② tool-level 超时兜底 检测，**不再 in-band sentinel**。
- **probe duration 2.5s** = CSS sentinel timeout 主导；Schema probe 立即失败不计。

**实现位置**：
- `src/capability.ts` — `WipError` + `classifyWipError` + `probeCapabilities` + `CapabilitySnapshot` + `assertDomainAvailable`
- `src/page-session.ts` — async fire-and-forget probe + `capability()` getter
- `src/server.ts` — `WDM_DISABLE_TOOLS` env var 实现回滚开关

### ⚠ 协议"可用但语义不一致"风险

来源：cross-review v2.0.1 codex 独家洞察。

同 method 在不同 iOS 版本 / WebKit build 行为可能不一致 —— Schema.getDomains 显示域 ✅ 不等于工具调用语义符合预期。telemetry **不能只看调用成功率**，需结合：

- 输出 schema 校验（method 返回字段缺失 → 标记降级）
- 跨 device 行为对比（同 method 在 iOS 17 vs 26 / macOS Safari vs iOS WKWebView 输出 diff）
- `unsupported / timeout / transport / DOMAIN_UNAVAILABLE` 错误码分层独立计数

## 演进路线图（v2.0.1，2026-05-17 cross-review 收敛）

来源：3 轮 cross-review（codex MCP + kimi CLI + qodercli CLI），R1/R2/R3 receipts 见 §[Cross-review receipts](#cross-review-receipts)。

### 路径决策

✅ **C 路径** = 保留 ios-webkit-mcp 独立仓 + 修订 capability matrix + batch-13 增 8 工具，不 fork / 不 adopt iwdp-mcp。

R1 投票：3/3 全票（codex 38 分 / qoder 23 分压倒性 / kimi "C 评分明显胜")。

**核心理由**：
- 116 vs 38 不是 3 倍价值差距（iwdp 拆分粒度细 + 我们倾向复合工具）
- Adopt iwdp 断 chrome-devtools-mcp tool name parity（LLM 跨 iOS+Android UX 锚点）
- iwdp 是 Go binary，断绝任何 Node.js server 内嵌路径
- Playwright MCP 走 10 个高层抽象工具，是 LLM agent 主流；iwdp 116 全量映射是反模式

### iwdp-mcp 关系定位

- **不 fork 不 adopt**：保持工具名空间清洁
- **覆盖率参考**：Apple WIP 方法名查询源（如本节 capability matrix v2 修订即 grep iwdp-mcp Go 源拿到正确名字）
- **alias 安全阀（48h telemetry quick check）**：上线后 48h 内若 telemetry 显示 LLM 错调 iwdp 命名 ≥ N 次（具体阈值 batch-13 上线时定），按需加 1-2 个 alias，**不批量做兼容名**

### Batch-13（cross-review v2.0.1 收敛 8 工具）

| 档位 | 工具 | 底层 method | 选定理由 |
|------|------|------|------|
| **Must (5)** | `set_pause_on_exceptions(state)` | Debugger.setPauseOnExceptions | 调试 crash 场景刚需，等价 DevTools "pause on exceptions" 按钮 |
| | `set_event_breakpoint(eventName, type)` | DOMDebugger.setEventBreakpoint | 事件冒泡/泄漏调试核心入口 |
| | `set_url_breakpoint(url, isRegex)` | DOMDebugger.setURLBreakpoint | 网络/导航调试核心入口 |
| | `get_event_listeners(selector)` | DOM.getEventListenersForNode | 事件绑定排查刚需 |
| | `record_cpu_profile()` | CPUProfiler.startTracking + stopTracking + 收敛 events | 性能归因 / 卡顿排查最高频，CDP `Profile.*` 在 Apple WIP 稳定 |
| **Should (3)** | `highlight_node(selector)` + `hide_highlight()` | DOM.highlightNode / hideHighlight | 视觉反馈闭环（LLM 选中 → 高亮 → 确认） |
| | `set_resource_caching_disabled(disabled)` | Network.setResourceCachingDisabled | 热调试场景（改 CSS/JS 立即见效） |
| | `set_request_interception(enable)` | Network.setInterceptionEnabled | **仅暴露开关** —— `intercept_continue` / `intercept_respond` 移 batch-14（避免 pass-through 简版"能力幻觉"） |

### Batch-14 候选（v2.0.1 已点名）

- **intercept 完整状态机**：`intercept_continue(reqId)` / `intercept_respond(reqId, body)` —— 配套 §[冻结契约](#intercept-完整状态机-batch-14-契约) 实现完整 fulfill/continue
- **`run_audit(testFn)`** — Audit.setup + run + teardown（Lighthouse 与 WebView 关联弱，先观察期）
- **`record_memory_tracking()`** — Memory.startTracking + stopTracking（与 take_memory_snapshot 重叠，等性能三件套路线图判定）
- **`set_blackbox_patterns(patterns[])`** — Debugger.setBlackboxPatterns / Debugger.setShouldBlackboxURL（跳过库堆栈，调试高频）
- **复合工具**（演进锚点）：`analyze_performance`（CPU→内存→网络时序关联）/ `debug_element` / `fix_console_errors`
- **域补齐**：Console.* 增强（log level filter）/ Network.* 增强（cookie 管理 / clear cache）

### intercept 完整状态机（batch-14 契约）

来源：cross-review v2.0.1 codex 独家洞察 + kimi/qoder 共识"先简版埋雷"反对意见。

**冻结契约**（batch-13 暴露 `set_request_interception(enable)` 时即声明，避免 batch-14 实现破坏兼容）：

- **requestId 生命周期**：`Network.requestIntercepted` 事件 → 工具层缓冲 → LLM 取 → `intercept_continue/respond` 消费；超时未消费视为隐式 continue（默认 30s）
- **并发上限**：单 PageSession 最多 16 条 pending 拦截请求；超出新请求自动 continue（不 block 页面）
- **超时取消语义**：LLM 工具调用层 timeout 不等于拦截取消；显式调 `intercept_continue(reqId, abort=true)` 才中止
- **batch-13 暴露的 set_request_interception 仅开关**：tool description 显式标注 "fulfill/continue 在 batch-14 跟进"，避免"能力幻觉"

### Must 工具的 DoD（v2.0.1 cross-review codex 独家）

每个 Must 工具上线前需通过：

1. **延迟阈值**：首调 < 200ms（含 capability probe 缓存命中），稳态调 < 100ms
2. **失败率阈值**：< 1% 调用失败（按错误码分层独立计数，`DOMAIN_UNAVAILABLE` 不计为失败）
3. **回归 smoke 用例**：至少 1 个 npm script smoke 验证（参考现有 `scripts/smoke-list-pages.js` 风格）
4. **回滚开关**：环境变量 `WDM_DISABLE_TOOLS=tool1,tool2` 支持运行时禁用（应对突发兼容问题）

### Telemetry 设计（v2.0.1）

驱动 batch-14+ 决策的数据基础：

- **每工具调用计数 + 错误码分层**（按 `DOMAIN_UNAVAILABLE` / `INVALID_PARAMS` / `METHOD_NOT_FOUND` / `TIMEOUT` / `TRANSPORT_ERROR` 分桶）
- **capability snapshot 上报**（device → supported domains，用于发现新 iOS 版本 / WebKit build 行为差异）
- **错调 iwdp 命名监测**（48h 快速 check 是否需要加 alias）
- **schema diff 监测**（同 method 在不同 iOS 版本输出字段差异，捕获"可用但语义不一致"）

## 架构

```
LLM (Claude Code / Cursor / Qoder)
   ↓ stdio MCP
ios-webkit-mcp (TS, Node.js 20.19+)
   ├─ tools/ — 5 个高阶工具，schema 跟 chrome-devtools-mcp 对齐
   ├─ wip-client/ — 自写 WIP client (TS)
   │   ├─ transport/ — ws 连 ios_webkit_debug_proxy
   │   ├─ protocol/ — WIP method 类型定义（来源 WebKit Source/WebInspectorUI/Protocol/*.json）
   │   └─ session/ — target lifecycle / reconnect 管理
   └─ capability/ — 工具能力 matrix
   ↓ ws (WIP frames, not CDP)
ios_webkit_debug_proxy v1.9.2 (Mac, 透传 WIP，不翻译)
   ↓ usbmuxd
iPhone (iOS 17.4+, Qwen app, WKWebView with isInspectable=true)
```

## 关键设计决策

### 1. 工具 schema 跟 chrome-devtools-mcp 对齐

LLM 同一套调用形态 → iOS/Android UX 一致。实现：参考 chrome-devtools-mcp 上游的 ToolDefinition 类型，必要时手动 mirror，不强依赖 npm dep（避免被上游 bump 拖着走）。

### 2. capability matrix

工具内嵌 capability 字段。不支持的工具（如 `lighthouse_audit`）返：
```json
{"error": "not available on iOS", "capability": "ios:wip:no-tracing-domain"}
```
让 LLM 按能力降级，避免盲调。来源：codex + qodercli R1（上一轮 cross-review 已共识）。

### 3. WIP 权威 spec 源

🟡 用 WebKit `Source/WebInspectorUI/Protocol/*.json`（Apple 官方协议定义），**不靠 binary strings 逆向**或 iwdp-mcp 输出猜协议。来源：qodercli R1（cross-review 上一轮）。

### 4. iOS 版本 baseline = iOS 17 (single)

cross-review 3/3 测试机选 17.x，2/3 推荐单版本 (a)；17.4+ 避 17.0-17.3 远程调试断连 bug。

### 5. WIP client 形态：自写 TS

🟡 用户决策 2026-05-15：自写 TS WIP client，部分实现细节可参考 iwdp-mcp。理由：跟 ios-webkit-mcp 同语言 / 同 toolchain，避免 subprocess IPC 复杂性，可深度集成 reconnect / target 生命周期管理。

### 6. WIP 协议线格式：Target.sendMessageToTarget 双层包装 ✅ 实测

2026-05-16 真机 (iOS 26.5.0) 实测确认 WIP wire format（之前是 🟡 hypothesis）：

- 顶层 ws (`ws://<host>:<port>/devtools/page/N`) 只暴露 Apple 的 `Target.*` envelope domain
- 顶层直接发 `Runtime.evaluate` → 返 `-32601 'Runtime' domain was not found`
- 实际机制：
  - 出向：`{id: <outerId>, method: "Target.sendMessageToTarget", params: {targetId, message: "<stringified inner JSON-RPC>"}}`
  - 入向：`{method: "Target.dispatchMessageFromTarget", params: {targetId, message: "<stringified inner JSON-RPC>"}}`
  - 隐式 auto-attach：ws 一 open 就喷 `Target.targetCreated`（page + frame 各一）
  - `Target.setAutoAttach` 在 WIP 上 `-32601 method not found`（跟 CDP 不一样）
- Implementation: [ios-webkit-mcp 仓 `src/wip-client/ws-session.ts`](https://github.com/echopi/ios-webkit-mcp/blob/main/src/wip-client/ws-session.ts) 把 outer envelope 藏在 API 后面，公开接口 = `connect(url) → waitForPageTarget() → send(method, params)`

### 7. WIP domain enable 行为差异 ✅ 实测

跟 CDP 不完全对齐的几个点（2026-05-16 真机）：

- `DOM.enable` 不存在 (`-32601`)，但 `DOM.getDocument` **独立工作**（无需 enable）
- `Console.enable` **重放历史消息**（订阅时把 iOS 侧的 message buffer 全吐出来）— 对 "what just happened" 场景反而有用
- `Network.enable` / `Runtime.enable` / `Console.enable` 都 OK，正常 enable
- 多余 `Network.dataReceived` event 也会喷（目前未单独捕获，可加 dataLength 累计）
- Receipt: smoke `enableErrors` 输出 + WDM_WS_DEBUG=1 wire frame trace

### 8. WIP per-ws state isolation ✅ 实测

每个 ws 连接的 `Network.enable` / `Console.enable` / `Runtime.enable` 状态**独立** — 在 ws A 上 enable 后只有 ws A 收 event，**不跨 ws 广播**。

**实测复现**（2026-05-16 MCP path E2E）:

- 旧 `evaluate_script` 用 transient WipSession 自开 ws 跑 `fetch(...)`, fetch 触发的 `Network.requestWillBeSent` 只回到 transient ws (随后关闭丢弃)
- 同时 `list_network_requests` 读 PageSession 的持久 buffer，**0 of 0 buffered**
- 不是 PageSession 没 attach 也不是 Network.enable 失败 — 纯粹是事件按 ws 隔离投递

**实现策略 (commit `03b85b3`)**:

- `evaluate_script` 默认（无 `pageId` / `proxyDeviceListUrl`）路由到 **shared PageSession** (`PageSession.session.send`)，让 fetch 触发的 Network event 跟 `list_network_requests` 的订阅同 ws
- 显式 `pageId` / `proxyDeviceListUrl` 仍走 transient session — 用于 poke worker / 替代 proxy / 非默认 page，不污染持久 attach
- 输出 metadata 标 "(shared session)" / "(transient session)" 让 LLM 看见模式选择

**Receipt**:

- 修前 MCP path: `evaluate_script` fetch → `list_network_requests` 0 of 0 (上文 §7 之后即时复现)
- 修后本地 smoke (`((local share-test script — historical))`): PageSession.networkBuffer = 1, `GET https://example.com/__share_test__<ts>` → 200 finished
- 修后 MCP path E2E (post-restart): `evaluate_script` 标 "(shared session)" + `list_network_requests` 抓到 `GET .../__post_restart__<ts>` → 200 finished

### 9. WIP Promise serialization gap ✅ 实测

WIP `Runtime.evaluate` 即便带 `awaitPromise: true`，对返回 Promise 的表达式**取不到 resolve 值** — 副作用照常执行（listener / DOM 改动都生效），但 caller 拿到的 `result.value` 是空 `{}`。

**最小复现**（2026-05-16 MCP `mcp__ios-webkit__evaluate_script`，page 7 iOS WebView page (anonymized)）:

```
expression: `Promise.resolve(42)`
→ result.value: {}            # 期望 42

expression: `(async () => 42)()`
→ result.value: {}            # 期望 42

expression: `(async () => { return JSON.stringify({ok:true}) })()`
→ result.value: {}            # 期望 "{\"ok\":true}"

expression: `42`              # 同步 baseline
→ result.value: 42            # ✅ 正常
```

`evaluate_script` 默认 `awaitPromise=true` 已正确传透（[`src/tools/evaluate_script.ts`](../src/tools/evaluate_script.ts)），问题在 Apple WIP 自身。

**影响**：

- 任何 batch-3 工具的 inner expression 用了 `async () => { … }` IIFE 或 `await new Promise(r => setTimeout(r, delay))` 来做"页面内延迟"，对外都会变成假阴性（实际事件已 fired 但 caller 报 failed）
- v0.3.0 `type_text` (per-key delay) + `drag` (per-step delay) 因此默认路径误报失败

**实现策略 (commit `4eb03c7`, v0.3.1)**:

- inner expression 全部保持**同步**（IIFE 无 `async` 关键字 / 无 `await`）
- 当需要 inter-step delay 时，由 TS handler 端发多次同步 `Runtime.evaluate`，`setTimeout` 在 Node 这边 sleep
- 两路径：
  - `delayMs=0` / `stepDelayMs=0`：单次同步 IIFE 一次到位（快 path）
  - `>0`：TS 循环，每步一次 RPC

**Receipt**:

- 复现脚本：上述 4 个 `evaluate_script` call 直接来自本次 session 的 MCP path E2E
- Fix commit: `4eb03c7` (`type_text.ts`, `drag.ts`)
- v0.3.1 sync 路径 E2E 验证（post-restart 2026-05-16）：
  - type_text fast (`delayMs=0`, "fast") + slow (`delayMs=15`, "slow")：listener keys=[f,a,s,t,s,l,o,w] 全 8 个；两路径都返回正确 `chars typed` / `final field length`
  - drag fast (`stepDelayMs=0`, element→element, steps=8)：dragstart=1, dragmoves=8, dragend=1，lastMovePoint 命中 dest center
  - drag per-step (`stepDelayMs=10`, dx/dy offset, steps=5)：dragmoves=5, lastMovePoint=(srcX+dx, srcY+dy) 精确

## Cross-review receipts

### iOS 版本 baseline R1（2026-05-15）

- 测试机选 17.x: **3/3 全票** ✅
- 单版本 (a) iOS 17: 2/3（codex + kimi）
- 16.4+ minimum (b): 1/3（qodercli，但 dev/test 也用 17）
- 矩阵 (d) / 双版本 (c)：0/3 否决
- log：`((cross-review log — not bundled))` + `((cross-review log — not bundled))` + codex via MCP（inline 综合）

### 上层方案选型 R1（2026-05-15）

Option C wrapper MCP **3/3 全票**（log：`((cross-review log — not bundled))` + `((cross-review log — not bundled))`），见 [`web-devtools-mcp.md`](./web-devtools-mcp.md) iOS 段。

### v2.0.1 路径 + batch-13 收敛（2026-05-17）

完整 3 轮 cross-review（codex MCP via gpt-5.3-codex + kimi CLI + qodercli CLI）。

**议题**：发现先驱 `nnemirovsky/iwdp-mcp`（Go，116 工具，27 域）后，下一阶段路径选 A（adopt）/ B（fork+翻译）/ C（保留独立 + 修 capability matrix + batch-13 加 8-10 工具）。

**关键论断 3 轮投票**：

| 决策项 | R1 | R2 | R3 |
|---|---|---|---|
| 路径 = C | **3/3 全票** | (已收敛) | (已收敛) |
| 116 vs 38 不是 3 倍价值 | 3/3 | (已收敛) | (已收敛) |
| Adopt 断 chrome-devtools-mcp parity | 3/3 | (已收敛) | (已收敛) |
| Schema.getDomains 异步非阻塞 | (R2 提)| **3/3 共识 / 异步 2/3** | (已收敛) |
| capability degrade tools/list 预过滤 + 结构化 error | (R2 提) | 3/3 | (已收敛) |
| run_audit 降 batch-14 | (R1 分歧 1 must / 1 should / 1 nice) | (R2 收敛 Should) | **3/3 全票降 batch-14** |
| intercept 三件套先简版 pass-through | (R1 2/3 must) | (R2 维持 Must) | **3/3 全票反对：拆开，简版埋雷** |
| record_cpu_profile 升 Must | (R1 1 must) | (R2 2/3 升)| (已收敛) |
| Must 工具加 DoD | (没提) | (没提) | 1/3（codex 独家，production-ready 必备 → 采纳） |
| 协议"可用但语义不一致"风险 | (没提) | (没提) | 1/3（codex 独家但严重 → 采纳） |
| 48h telemetry quick check 替代季度 | (没提) | (没提) | 1/3（qoder 独家但合理 → 采纳） |

**最终落档（v2.0.1）**：本节 §[演进路线图](#演进路线图v201-2026-05-17-cross-review-收敛) 全文。

**Receipts 路径**：((cross-review logs — not bundled))。

## 仓位置 ✅ 已定（2026-05-15）

**独立仓 `echopi/ios-webkit-mcp`**，targeting parity with `chrome-devtools/chrome-devtools-mcp` (Google upstream)。

- URL: [https://github.com/echopi/ios-webkit-mcp](https://github.com/echopi/ios-webkit-mcp)
- main 分支 commits（截至 2026-05-16）：
  - `401c9f2` FEATURE: scaffold + first tool list_pages
  - `df6949c` FEATURE: evaluate_script + WIP Target.sendMessageToTarget wrapping
  - `7db87e7` FEATURE: 3 event-stream tools (Console / Network / DOM)
- 上层 spec [`web-devtools-mcp.md`](./web-devtools-mcp.md) 提到的「Phase 1b monorepo `packages/webkit`」**短期不落** — 独立 repo 先跑通 MVP，monorepo 合并留到 Phase 1.x 后期视复用程度评估
- 跟现有 `chrome-devtools-mcp` 仓**完全独立**：无 npm dep / 无 git submodule，仅 spec / 工具 schema 对齐

## 不在本文范围

- Phase 1 Android (chrome-devtools-mcp) 路径 — 见 [`web-devtools-mcp.md`](./web-devtools-mcp.md) + `chrome-devtools/chrome-devtools-mcp` upstream
- Phase 2 host-app-specific 工具扩展
- WIP client 详细 API 设计 — 见仓内 `src/wip-client/ws-session.ts` 头部 docstring
- iOS 16.4 / 18.x ~ 25.x 兼容矩阵 — Phase 1.x 探索，不阻塞 MVP
- chrome-devtools-mcp 上游 41 工具完整 mirror — 仅首版 5 + Phase 1.1+ ~10 个 cherry-pick
- Performance domain 子集兜底 (PerformanceObserver 注入) — qodercli R1 设计要点，归档 Phase 1.x 待立项
