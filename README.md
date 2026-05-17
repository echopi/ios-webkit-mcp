# ios-webkit-mcp

iOS WebView debugging MCP server. Bridges LLM agents (Claude Code, Cursor, etc.) to iPhone WKWebView pages via Apple's **Web Inspector Protocol (WIP)**, transported by `ios_webkit_debug_proxy`.

**57 tools** (54 ✅ end-to-end verified + 3 ⚠ coded but blocked by documented iOS WKWebView runtime limitations). Targets parity with [`chrome-devtools/chrome-devtools-mcp`](https://github.com/chrome-devtools/chrome-devtools-mcp) on the upstream-overlapping surface, plus Apple-specific extensions and composite tools.

> **Spec**: [`docs/spec.md`](docs/spec.md) — full design, WIP capability matrix, 11 decision records, complete tool table with smoke receipts.

## Quick start

```bash
# 1. Install ios_webkit_debug_proxy (macOS, one-time)
brew install ios-webkit-debug-proxy libimobiledevice

# 2. Connect iPhone via USB + trust this Mac
#    On iPhone: Settings → Safari → Advanced → Web Inspector = ON
#    On the app: WKWebView must have isInspectable = true (iOS 16.4+ requirement)

# 3. Start the proxy
ios_webkit_debug_proxy --no-frontend

# 4. Install & build
git clone https://github.com/echopi/ios-webkit-mcp.git
cd ios-webkit-mcp
npm install
npm run build

# 5. Register with Claude Code
claude mcp add ios-webkit --scope user -- \
  node "$PWD/build/src/bin/ios-webkit-mcp.js"
```

Restart Claude Code, then ask the agent to call `list_pages` — it should enumerate inspectable WKWebView pages on the connected iPhone.

## Tool catalog (57)

**chrome-devtools-mcp upstream parity (20)**
`list_pages` / `evaluate_script` / `list_console_messages` / `list_network_requests` / `get_console_message` / `get_network_request` / `take_snapshot` / `take_screenshot` / `navigate_page` / `click` / `fill` / `fill_form` / `type_text` / `press_key` / `hover` / `drag` / `wait_for` / `select_page` / `reload_page` / `handle_dialog`

**Apple WIP-specific extensions (18)**
`query_dom_node` / `take_node_screenshot` / `get_resource_tree` / `get_cookies` / `delete_cookie` / `set_extra_http_headers` / `set_init_script` / `set_outer_html` / `list_indexeddb` / `get_performance_metrics` / `record_timeline` / `pause_debugger` / `resume_debugger` / `set_breakpoint_by_url` / `gc_heap` / `clear_console` / `take_memory_snapshot` / `set_user_agent`

**Advanced debugger / interception (10)**
`set_pause_on_exceptions` / `set_event_breakpoint` / `set_url_breakpoint` / `set_blackbox_url` / `get_event_listeners` / `record_cpu_profile` / `record_memory_tracking` / `highlight_node` / `hide_highlight` / `set_resource_caching_disabled`

**Composite (3)**
`analyze_performance` (Timeline + CPU + memory in one shot) / `debug_element` (DOM + listeners + screenshot + highlight) / `summarize_console_errors` (grouped error summary)

**Capability / interception state machine (5)**
`get_capability_snapshot` / `set_request_interception` / `list_intercepted_requests` / `intercept_continue` / `intercept_respond` (⚠ last 3 are iOS-blocked — see Known Limitations)

**Escape hatch (1)**
`wip_send` — raw WIP method/params passthrough

Full descriptions + parameter schemas + smoke receipts: [`docs/spec.md`](docs/spec.md).

## Known limitations (iOS WKWebView)

These are **iOS-platform constraints**, not implementation bugs. Tools are coded correctly per the WIP spec; the runtime behavior is the issue.

### 1. CSS.* domain hangs (no `CSS.*` tools exposed)

Apple WIP protocol declares CSS as always available, but iOS 26.5.0 WKWebView's WebKit runtime does not respond to `CSS.enable` / `CSS.getMatchedStylesForNode` / etc. — calls hang ≥ 2.5s with no response. Root cause is in `WebCore/inspector/agents/InspectorCSSAgent.cpp` runtime layer on iOS, not the protocol.

**Workaround**: use `evaluate_script` with `getComputedStyle()` / inline style mutation. Example:

```js
// "Get computed color of .foo"
evaluate_script({ expression: 'getComputedStyle(document.querySelector(".foo")).color' })

// "Change .foo background-color"
evaluate_script({ expression: 'document.querySelector(".foo").style.backgroundColor = "red"' })
```

### 2. `Network.requestIntercepted` runtime is a no-op (3 tools blocked)

Protocol declares `Network.setInterceptionEnabled` + `Network.addInterception` + `Network.interceptContinue` + `Network.interceptWithResponse` as always available. All return `{}` success on iOS. **But** `Network.requestIntercepted` event is never fired for matching requests — iOS WKWebView's network loader (CFNetwork/NSURLSession) does not call back into the WebCore inspector hook.

Affected tools: `set_request_interception` / `list_intercepted_requests` / `intercept_continue` / `intercept_respond`. They are kept in the catalog because they work on macOS Safari WIP (validated by [`iwdp-mcp`](https://github.com/nnemirovsky/iwdp-mcp)) and would Just Work the day Apple ships iOS interception runtime.

**Workaround for mocking responses**: monkey-patch `fetch` / `XMLHttpRequest.prototype.open` via `set_init_script` (a `Page.setBootstrapScript` wrapper):

```js
set_init_script({
  source: `
    const _fetch = window.fetch;
    window.fetch = (url, opts) => {
      if (url.includes('/api/foo')) {
        return Promise.resolve(new Response(JSON.stringify({mocked:true}), {
          status: 200,
          headers: {'Content-Type': 'application/json'},
        }));
      }
      return _fetch(url, opts);
    };
  `
})
```

### 3. `Schema.getDomains` not exposed on iOS (graceful fallback)

Apple's iOS WebKit WIP does not expose the `Schema` domain. Capability discovery falls back to optimistic mode — tool calls go through; failures surface as `WipError` with `DOMAIN_UNAVAILABLE` / `METHOD_NOT_FOUND` / `TIMEOUT` codes.

### 4. `Page.navigate` removed upstream (workaround built in)

The WebKit team removed `Page.navigate` from WIP in commit [`5871ac5`](https://github.com/WebKit/WebKit/commit/5871ac5) (2025-11-13). The `navigate_page` tool here automatically falls back to `Runtime.evaluate('location.href = ...')`.

### 5. `Page.setScreenSizeOverride` not on Cocoa (no viewport tool)

Per [WebKit upstream](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/protocol/Page.json), `Page.setScreenSizeOverride` is gated `!PLATFORM_COCOA` — neither iOS nor macOS Safari supports it. Viewport emulation would require a native bridge.

## Capability discovery

`get_capability_snapshot` returns the runtime probe result for the connected device — which domains the WebKit build claims to support, which sentinel methods responded, and any platform-specific notes. The MCP server runs this probe asynchronously after page attach (non-blocking, ~5–10ms when Schema is available).

When `Schema.getDomains` is unavailable (current iOS), `supportedDomains` is `null` and tool dispatch is **optimistic** — calls go through and surface real errors as structured `WipError` instances with one of these codes:

| Code | Meaning |
|---|---|
| `DOMAIN_UNAVAILABLE` | `'<X>' domain was not found` (-32601 at domain level) |
| `METHOD_NOT_FOUND` | `'<X>.<method>'` not found (-32601 at method level) |
| `INVALID_PARAMS` | `-32602` schema mismatch |
| `TIMEOUT` | WIP round-trip exceeded SLA (default 3-15s) |
| `TRANSPORT_ERROR` | ws connection error / peer close |
| `INTERNAL` | unclassified — see message for raw WIP error |

## Runtime kill switch

Disable specific tools at startup via `WDM_DISABLE_TOOLS` (comma-separated list):

```bash
WDM_DISABLE_TOOLS=set_init_script,record_timeline node build/src/bin/ios-webkit-mcp.js
```

Useful for hotfixing a tool that misbehaves on a particular device without rebuilding.

## Troubleshooting

### iwdp's internal HTTP/WS server gets stuck

After an abrupt ws disconnect (e.g. killing a probe process with SIGKILL), `ios_webkit_debug_proxy` v1.9.2's internal CDP HTTP server (`/json/version` and per-page wsURLs) can lock up. Symptoms: `curl http://127.0.0.1:9222/json` hangs, or pages exist in the list but ws connect never receives `Target.targetCreated`.

**Fix**: terminate + relaunch the app holding the WKWebView, then retry. From a Mac:

```bash
DEV='<your-device-udid>'
# Find the app PID
xcrun devicectl device info processes -d "$DEV" | grep -i <app-name>
# Force-terminate
xcrun devicectl device process terminate -d "$DEV" -p <PID> --kill
# Relaunch
xcrun devicectl device process launch -d "$DEV" '<bundle-id>'
```

Or just close the app from the iPhone's app switcher and reopen.

### DOM operations fail with "Missing node for given nodeId"

Apple WIP `DOM.getDocument` bumps the node generation, invalidating prior nodeIds. If you're chaining your own DOM operations via `wip_send`, do them **serially** (not via `Promise.all`).

This MCP's composite tools (e.g. `debug_element`) already serialize DOM ops internally.

### Tests

```bash
npm test  # builds and runs 41 node:test cases
```

Foundation covers `capability.ts` (WipError + classifyWipError + probeCapabilities + assertDomainAvailable), env-var parsing (`_parseDisabledTools`), and `summarize_console_errors` grouping helpers.

## Why a separate package from `chrome-devtools-mcp`

Different protocol (WIP, not CDP), different transport (ws-via-iwdp, not direct), different runtime (WebKit, not Blink). Tool schemas are intentionally aligned with [`chrome-devtools/chrome-devtools-mcp`](https://github.com/chrome-devtools/chrome-devtools-mcp) so LLMs see a uniform surface when an agent's session targets both Android and iOS devices.

For Android WebView debugging, use upstream `chrome-devtools-mcp` directly — it speaks CDP, which Android WebView (Chromium fork) supports natively.

## Legal & compliance

Independent open-source implementation based on the publicly available WebKit Inspector protocol definitions: [`Source/JavaScriptCore/inspector/protocol/*.json`](https://github.com/WebKit/WebKit/tree/main/Source/JavaScriptCore/inspector/protocol). No private SDKs are imported or redistributed.

Not affiliated with, endorsed by, or sponsored by Apple Inc. All product names, logos, and brands are the property of their respective owners.

This project is provided for research, debugging, and educational use under the Apache-2.0 license. No warranty, no commercial support is implied. Issues filed in this repository are best-effort responses from the author.

## License

Apache-2.0 (see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)).
