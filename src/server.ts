import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listPagesTool } from './tools/list_pages.js';
import { evaluateScriptTool } from './tools/evaluate_script.js';
import { listConsoleMessagesTool } from './tools/list_console_messages.js';
import { listNetworkRequestsTool } from './tools/list_network_requests.js';
import { takeSnapshotTool } from './tools/take_snapshot.js';
import { navigatePageTool } from './tools/navigate_page.js';
import { takeScreenshotTool } from './tools/take_screenshot.js';
import { takeMemorySnapshotTool } from './tools/take_memory_snapshot.js';
import { clickTool } from './tools/click.js';
import { waitForTool } from './tools/wait_for.js';
import { fillTool } from './tools/fill.js';
import { typeTextTool } from './tools/type_text.js';
import { pressKeyTool } from './tools/press_key.js';
import { hoverTool } from './tools/hover.js';
import { dragTool } from './tools/drag.js';
import { getConsoleMessageTool } from './tools/get_console_message.js';
import { getNetworkRequestTool } from './tools/get_network_request.js';
import { fillFormTool } from './tools/fill_form.js';
import { handleDialogTool } from './tools/handle_dialog.js';
import { selectPageTool } from './tools/select_page.js';
import { wipSendTool } from './tools/wip_send.js';
import { reloadPageTool } from './tools/reload_page.js';
import { setExtraHttpHeadersTool } from './tools/set_extra_http_headers.js';
import { queryDomNodeTool } from './tools/query_dom_node.js';
import { getResourceTreeTool } from './tools/get_resource_tree.js';
import { getPerformanceMetricsTool } from './tools/get_performance_metrics.js';
import { takeNodeScreenshotTool } from './tools/take_node_screenshot.js';
import { getCookiesTool } from './tools/get_cookies.js';
import { deleteCookieTool } from './tools/delete_cookie.js';
import { gcHeapTool } from './tools/gc_heap.js';
import { clearConsoleTool } from './tools/clear_console.js';
import { setInitScriptTool } from './tools/set_init_script.js';
import { listIndexeddbTool } from './tools/list_indexeddb.js';
import { setOuterHtmlTool } from './tools/set_outer_html.js';
import { recordTimelineTool } from './tools/record_timeline.js';
import { pauseDebuggerTool, resumeDebuggerTool, setBreakpointByUrlTool } from './tools/debugger.js';
import { setPauseOnExceptionsTool, setEventBreakpointTool, setUrlBreakpointTool, setBlackboxUrlTool } from './tools/breakpoints.js';
import { getEventListenersTool } from './tools/get_event_listeners.js';
import { recordCpuProfileTool } from './tools/record_cpu_profile.js';
import { highlightNodeTool, hideHighlightTool } from './tools/highlight_node.js';
import { setResourceCachingDisabledTool, setRequestInterceptionTool } from './tools/network_runtime.js';
import { getCapabilitySnapshotTool } from './tools/get_capability_snapshot.js';
import { recordMemoryTrackingTool } from './tools/record_memory_tracking.js';
import { listInterceptedRequestsTool, interceptContinueTool, interceptRespondTool } from './tools/intercept.js';
import { analyzePerformanceTool } from './tools/analyze_performance.js';
import { debugElementTool } from './tools/debug_element.js';
import { summarizeConsoleErrorsTool } from './tools/summarize_console_errors.js';
import { setUserAgentTool } from './tools/set_user_agent.js';

const PKG = { name: 'ios-webkit-mcp', version: '0.18.3' };

/**
 * Parse `WDM_DISABLE_TOOLS` env var (comma-separated tool name list) — runtime
 * kill switch for individual tools, per spec batch-13 DoD §"回滚开关".
 *
 *   WDM_DISABLE_TOOLS=set_init_script,record_timeline node …
 *
 * Exported for tests; underscore prefix signals "internal but reachable".
 */
export function _parseDisabledTools(value: string | undefined = process.env['WDM_DISABLE_TOOLS']): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  );
}

export function createServer(): McpServer {
  const server = new McpServer(PKG);
  const disabled = _parseDisabledTools();

  const ALL_TOOLS = [
    listPagesTool,
    evaluateScriptTool,
    listConsoleMessagesTool,
    listNetworkRequestsTool,
    takeSnapshotTool,
    navigatePageTool,
    takeScreenshotTool,
    takeMemorySnapshotTool,
    clickTool,
    waitForTool,
    fillTool,
    typeTextTool,
    pressKeyTool,
    hoverTool,
    dragTool,
    getConsoleMessageTool,
    getNetworkRequestTool,
    fillFormTool,
    handleDialogTool,
    selectPageTool,
    wipSendTool,
    reloadPageTool,
    setExtraHttpHeadersTool,
    queryDomNodeTool,
    getResourceTreeTool,
    getPerformanceMetricsTool,
    takeNodeScreenshotTool,
    getCookiesTool,
    deleteCookieTool,
    gcHeapTool,
    clearConsoleTool,
    setInitScriptTool,
    listIndexeddbTool,
    setOuterHtmlTool,
    recordTimelineTool,
    pauseDebuggerTool,
    resumeDebuggerTool,
    setBreakpointByUrlTool,
    // batch-13 Must (cross-review v2.0.1):
    setPauseOnExceptionsTool,
    setEventBreakpointTool,
    setUrlBreakpointTool,
    getEventListenersTool,
    recordCpuProfileTool,
    // batch-13 Should (cross-review v2.0.1):
    highlightNodeTool,
    hideHighlightTool,
    setResourceCachingDisabledTool,
    setRequestInterceptionTool,
    // batch-14 (cross-review v2.0.1, soft-promoted):
    getCapabilitySnapshotTool,
    recordMemoryTrackingTool,
    setBlackboxUrlTool,
    // batch-14 intercept full state machine:
    listInterceptedRequestsTool,
    interceptContinueTool,
    interceptRespondTool,
    // batch-14 composite (cross-review v2.0.1 演进锚点):
    analyzePerformanceTool,
    debugElementTool,
    summarizeConsoleErrorsTool,
    // batch-14 page emulation:
    setUserAgentTool,
  ];

  for (const tool of ALL_TOOLS) {
    if (disabled.has(tool.name)) {
      process.stderr.write(`[wdm] tool '${tool.name}' disabled via WDM_DISABLE_TOOLS\n`);
      continue;
    }
    server.tool(tool.name, tool.description, tool.inputSchema, tool.handler as never);
  }

  return server;
}
