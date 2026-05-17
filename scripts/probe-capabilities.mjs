#!/usr/bin/env node
/**
 * WIP capability probe — exhaustive sweep of Apple Web Inspector Protocol
 * methods on the first inspectable WKWebView page.
 *
 * v2 (2026-05-17): Apple-specific method names cross-checked against
 * nnemirovsky/iwdp-mcp Go source. Earlier CDP-style names (Memory.getDOMCounters,
 * Profiler.enable, Storage.*) were false-negatives — they don't exist in WIP,
 * but Memory.startTracking / CPUProfiler.* / DOMStorage.* do.
 *
 * Run:
 *   npm run probe          # default: connects via 127.0.0.1:9221 (iwdp default)
 *   PROXY=http://host:9221 npm run probe   # override proxy URL
 *   PAGE_TITLE_INCLUDES=foo npm run probe  # pick page by title substring
 *
 * Use cases:
 *   - regression-check WIP capabilities after iOS major upgrade
 *   - verify newly-discovered methods on a different iOS host app
 *   - feed updated results into docs/spec.md "WIP capability matrix v2"
 */
import { WebSocket } from 'ws';

const PROXY_LIST = (process.env.PROXY || 'http://127.0.0.1:9221') + '/json';

// Domain-grouped probe set. Each entry: [method, params?]. Params reflect
// minimum valid schema discovered during prior probes — methods may still
// return -32602 INVALID_PARAMS for specific arg combos.
const PROBES = {
  // ─── Page domain ───
  Page: [
    ['Page.navigate', { url: 'about:blank' }],
    ['Page.reload', {}],
    ['Page.getResourceTree', {}],
    ['Page.captureScreenshot', {}],
    ['Page.snapshotRect', { x: 0, y: 0, width: 10, height: 10 }],
    ['Page.snapshotNode', {}], // needs valid nodeId — expect INVALID_PARAMS
    ['Page.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }],
    ['Page.setTouchEmulationEnabled', { enabled: true }],
    ['Page.bringToFront', {}],
    ['Page.setLifecycleEventsEnabled', { enabled: true }],
    ['Page.stopLoading', {}],
    ['Page.getNavigationHistory', {}],
    ['Page.handleFileChooser', {}],
    ['Page.setInterceptFileChooserDialog', { enabled: true }],
    ['Page.setBootstrapScript', { source: '' }],
    ['Page.addScriptToEvaluateOnNewDocument', { source: '' }],
    ['Page.getCookies', {}],
    ['Page.deleteCookie', { cookieName: 'wdm_probe', url: 'https://example.com' }],
  ],
  // ─── DOM domain ───
  DOM: [
    ['DOM.getDocument', { depth: 0 }],
    ['DOM.querySelector', {}], // needs valid nodeId
    ['DOM.querySelectorAll', {}],
    ['DOM.getOuterHTML', {}],
    ['DOM.setOuterHTML', {}],
    ['DOM.requestNode', {}],
    ['DOM.resolveNode', {}],
    ['DOM.getBoxModel', {}],
    ['DOM.enable', {}],
  ],
  // ─── Network domain ───
  Network: [
    ['Network.setExtraHTTPHeaders', { headers: {} }],
    ['Network.setUserAgentOverride', { userAgent: 'wdm-probe' }],
    ['Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
    ['Network.getCookies', {}],
    ['Network.deleteCookies', { name: 'wdm_probe' }],
    ['Network.clearBrowserCookies', {}],
    ['Network.setCookie', { url: 'https://example.com', name: 'wdm_probe', value: '1' }],
    ['Network.getResponseBody', { requestId: 'x' }], // expect error, just probe existence
    ['Network.loadResource', { frameId: '0.1', url: 'https://example.com/' }],
  ],
  // ─── Emulation / Input ───
  Emulation: [
    ['Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }],
    ['Emulation.clearDeviceMetricsOverride', {}],
    ['Emulation.setUserAgentOverride', { userAgent: 'wdm-probe' }],
    ['Emulation.setTouchEmulationEnabled', { enabled: true }],
    ['Emulation.setCPUThrottlingRate', { rate: 1 }],
    ['Emulation.setVisibleSize', { width: 390, height: 844 }],
  ],
  Input: [
    ['Input.handleFileChooser', { action: 'cancel' }],
    ['Input.dispatchKeyEvent', {}],
    ['Input.dispatchMouseEvent', {}],
  ],
  // ─── Console / Runtime ───
  Console: [
    ['Console.enable', {}],
    ['Console.disable', {}],
    ['Console.clearMessages', {}],
    ['Console.setLoggingChannelLevel', { source: 'javascript', level: 'verbose' }],
  ],
  Runtime: [
    ['Runtime.enable', {}],
    ['Runtime.evaluate', { expression: '1' }],
    ['Runtime.compileScript', { expression: '1', sourceURL: '', persistScript: true, executionContextId: 1 }],
    ['Runtime.releaseObject', { objectId: 'X' }], // existence check
  ],
  // ─── Debugger / Profiler / Heap / Timeline / Tracing ───
  Debugger: [
    ['Debugger.enable', {}],
    ['Debugger.disable', {}],
    ['Debugger.pause', {}],
    ['Debugger.resume', {}],
    ['Debugger.setBreakpointByUrl', { url: 'https://example.com/x.js', lineNumber: 0 }],
    ['Debugger.setBreakpointsActive', { active: true }],
  ],
  // Apple WIP uses CPUProfiler + ScriptProfiler (NOT CDP Profiler)
  CPUProfiler: [
    ['CPUProfiler.startTracking', {}],
    ['CPUProfiler.stopTracking', {}],
  ],
  ScriptProfiler: [
    ['ScriptProfiler.startTracking', { includeSamples: true }],
    ['ScriptProfiler.stopTracking', {}],
  ],
  Heap: [
    ['Heap.gc', {}],
    ['Heap.snapshot', {}],
    ['Heap.startTracking', {}],
    ['Heap.stopTracking', {}],
  ],
  Timeline: [
    ['Timeline.start', {}],
    ['Timeline.stop', {}],
  ],
  Tracing: [
    ['Tracing.start', {}],
  ],
  // ─── Apple-specific / niche ───
  Animation: [
    ['Animation.enable', {}],
    ['Animation.startTracking', {}],
    ['Animation.stopTracking', {}],
  ],
  Worker: [
    ['Worker.enable', {}],
    ['Worker.disable', {}],
  ],
  Canvas: [
    ['Canvas.enable', {}],
    ['Canvas.disable', {}],
  ],
  Audit: [
    ['Audit.setup', {}],
    ['Audit.run', { test: '() => 1', timeout: 1000 }],
    ['Audit.teardown', {}],
  ],
  LayerTree: [
    ['LayerTree.enable', {}],
    ['LayerTree.layersForNode', { nodeId: 1 }], // expect INVALID_PARAMS, just probe existence
  ],
  Recording: [['Recording.enable', {}]],
  // CSS domain is sensitive — iOS WKWebView hangs on CSS.* (TIMEOUT, not NOT_FOUND;
  // observed on iOS 26.5.0). Probe with a short per-call timeout so we don't block
  // the whole sweep.
  CSS: [
    ['CSS.enable', {}],
    ['CSS.getAllStyleSheets', {}],
  ],
  Schema: [['Schema.getDomains', {}]], // discovery: lists supported domains
  // Apple WIP method names (CDP-style 'getDOMCounters' / 'startTrackingHeapObjects' do NOT exist)
  Memory: [
    ['Memory.enable', {}],
    ['Memory.disable', {}],
    ['Memory.startTracking', {}],
    ['Memory.stopTracking', {}],
  ],
  // Apple WIP uses DOMStorage, not CDP Storage
  DOMStorage: [
    ['DOMStorage.enable', {}],
    ['DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: 'https://example.com', isLocalStorage: true } }],
  ],
  IndexedDB: [
    ['IndexedDB.enable', {}],
    ['IndexedDB.requestDatabaseNames', { securityOrigin: 'https://example.com' }],
    ['IndexedDB.requestData', { securityOrigin: 'https://example.com', databaseName: 'X', objectStoreName: 'Y', skipCount: 0, pageSize: 10 }],
  ],
  Database: [['Database.enable', {}]],
  // Network interception (separate from basic Network ops)
  NetworkInterception: [
    ['Network.setInterceptionEnabled', { enabled: false }],
    ['Network.addInterception', { url: 'https://example.com/*', stage: 'request' }],
    ['Network.setResourceCachingDisabled', { disabled: false }],
    ['Network.setEmulatedConditions', { bytesPerSecondLimit: 0 }],
  ],
  // DOMDebugger advanced breakpoints
  DOMDebugger: [
    ['DOMDebugger.setEventBreakpoint', { breakpointType: 'listener', eventName: 'click' }],
    ['DOMDebugger.setURLBreakpoint', { url: 'foo', isRegex: false }],
  ],
  ApplicationCache: [['ApplicationCache.enable', {}]],
  Target: [
    ['Target.activateTarget', {}],
    ['Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false }],
  ],
  Inspector: [['Inspector.enable', {}]],
};

async function getFirstPageWs() {
  const r = await fetch(PROXY_LIST);
  const devices = await r.json();
  for (const d of devices) {
    const base = d.url.startsWith('http') ? d.url : `http://${d.url}`;
    const r2 = await fetch(base + '/json');
    const pages = await r2.json();
    const target = process.env.PAGE_TITLE_INCLUDES;
    const page = pages.find(p => p.url && !(p.title || '').startsWith('jsi_') && (!target || (p.title || '').includes(target)));
    if (page) return page.webSocketDebuggerUrl;
  }
  throw new Error('no page found via iwdp');
}

const wsUrl = await getFirstPageWs();
console.error(`# WIP capability probe`);
console.error(`# proxy: ${PROXY_LIST}`);
console.error(`# ws:    ${wsUrl}`);
console.error(`# started: ${new Date().toISOString()}\n`);

const ws = new WebSocket(wsUrl);
const state = { id: 0, targetId: null, h: new Map() };
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.method === 'Target.targetCreated' && !state.targetId) {
    const t = m.params.targetInfo;
    if (t?.type === 'page') { state.targetId = t.targetId; runProbes(); }
  } else if (m.method === 'Target.dispatchMessageFromTarget') {
    try { const inner = JSON.parse(m.params.message); const h = state.h.get(inner.id); if (h) h(inner); } catch {}
  }
});
ws.on('error', e => { console.error('ws error', e.message); process.exit(1); });

function send(method, params) {
  const id = ++state.id;
  const innerId = 10000 + id;
  return new Promise(resolve => {
    const t = setTimeout(() => { state.h.delete(innerId); resolve({ status: 'timeout' }); }, 4000);
    state.h.set(innerId, msg => {
      clearTimeout(t); state.h.delete(innerId);
      if (msg.error) resolve({ status: 'error', code: msg.error.code, message: msg.error.message });
      else resolve({ status: 'ok', preview: JSON.stringify(msg.result || {}).slice(0, 80) });
    });
    ws.send(JSON.stringify({ id, method: 'Target.sendMessageToTarget', params: { targetId: state.targetId, message: JSON.stringify({ id: innerId, method, params }) } }));
  });
}

async function runProbes() {
  let total = 0, ok = 0, notFound = 0, invalid = 0, other = 0;
  for (const [domain, methods] of Object.entries(PROBES)) {
    console.error(`## ${domain}`);
    for (const [method, params] of methods) {
      total++;
      const r = await send(method, params);
      let tag;
      if (r.status === 'ok') { ok++; tag = '✅ OK'; }
      else if (r.code === -32601) { notFound++; tag = '❌ NOT_FOUND'; }
      else if (r.code === -32602) { invalid++; tag = '⚠ INVALID_PARAMS'; }
      else if (r.status === 'timeout') { other++; tag = '⏱ TIMEOUT'; }
      else { other++; tag = `⚠ ${r.code ?? '?'}`; }
      const tail = r.message ? ` — ${r.message.slice(0, 70)}` : (r.preview ? ` → ${r.preview}` : '');
      console.error(`  ${tag.padEnd(20)} ${method}${tail}`);
    }
  }
  console.error(`\n# summary: ${total} probed · ${ok} ✅ · ${notFound} ❌ · ${invalid} ⚠ INVALID_PARAMS · ${other} other`);
  ws.close();
  process.exit(0);
}
