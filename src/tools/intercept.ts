/**
 * batch-14 intercept full state machine — fulfills the contract frozen in
 * cross-review v2.0.1 R3 + spec §"intercept 完整状态机 (batch-14 契约)":
 *
 *   - requestId 生命周期：`Network.requestIntercepted` → buffered in PageSession
 *     → consumed by `intercept_continue` / `intercept_respond` → drained.
 *   - 并发上限：16 pending. Overflow auto-continues the oldest.
 *   - 超时：30s without consumption → auto-continue (page does NOT hang).
 *   - 显式 abort 语义：`intercept_continue(reqId, abort=true)` blocks the
 *     request via `Network.interceptContinue` with `errorReason=BlockedByClient`.
 *
 * Apple WIP methods (probe-confirmed 2026-05-17):
 *   - Network.setInterceptionEnabled ✅ returns {}
 *   - Network.addInterception ✅ returns {} for any url pattern
 *   - Network.interceptContinue ✅ (probe shows method exists)
 *   - Network.interceptWithResponse ✅ (probe shows method exists)
 *
 * ⚠ **iOS WKWebView limitation (2026-05-17 实测)**: Even though the methods
 * above all return `{}` success, `Network.requestIntercepted` event is NEVER
 * fired for matching requests on iOS 26.5.0 + Apple system WKWebView. The
 * underlying WebKit interception machinery is a no-op on iOS. iwdp-mcp's
 * fulfill/continue flow validated against macOS Safari, where it works.
 *
 * Tools below are coded correctly per the WIP spec — they will Just Work the
 * day Apple ships interception runtime in iOS WKWebView (or when this MCP is
 * pointed at macOS Safari via a different transport). For now, calling
 * `set_request_interception` does nothing observable; `list_intercepted_requests`
 * always returns 0.
 */
import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const listInterceptedRequestsTool = {
  name: 'list_intercepted_requests',
  description: [
    'List currently-pending intercepted requests buffered by the page session.',
    'Each entry has a `requestId` you can pass to `intercept_continue` (release / block) or `intercept_respond` (mock body).',
    'Buffer cap: 16 concurrent (oldest auto-continues on overflow). Auto-continue: 30s if not consumed (page does not hang).',
  ].join(' '),
  inputSchema: {},
  handler: async () => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    const list = [...ps.intercepted.values()];
    if (list.length === 0) {
      return textResult('# list_intercepted_requests\n\nNo pending intercepted requests. Call `set_request_interception({enabled:true})` and trigger network activity to populate.');
    }
    const lines: string[] = [
      `# list_intercepted_requests — ${list.length} pending`,
      '',
      '| requestId | method | url | stage | age (s) |',
      '|---|---|---|---|---|',
    ];
    const now = Date.now();
    for (const e of list) {
      const age = ((now - e.arrivedAt) / 1000).toFixed(1);
      const url = e.url.length > 80 ? e.url.slice(0, 77) + '…' : e.url;
      lines.push(`| \`${e.requestId}\` | ${e.method ?? '?'} | ${url.replace(/\|/g, '\\|')} | ${e.stage ?? '?'} | ${age} |`);
    }
    return textResult(lines.join('\n'));
  },
};

export const interceptContinueTool = {
  name: 'intercept_continue',
  description: [
    'Release a pending intercepted request via WIP `Network.interceptContinue`. By default the request flows to the network unchanged; pass `abort=true` to block (page will see a network-error).',
    'Pair with `list_intercepted_requests` to discover requestIds.',
  ].join(' '),
  inputSchema: {
    requestId: z.string().min(1).describe('Intercepted requestId from `list_intercepted_requests`.'),
    abort: z
      .boolean()
      .optional()
      .describe('`true` blocks the request (page sees error); default false continues normally.'),
  },
  handler: async ({ requestId, abort = false }: { requestId: string; abort?: boolean }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    const entry = ps.consumeIntercepted(requestId);
    if (!entry) {
      return textResult(`# intercept_continue — requestId \`${requestId}\` not in pending set (may have already been continued / timed out / never intercepted)`);
    }
    try {
      if (abort) {
        // WIP "abort" pattern — interceptContinue with errorReason. Apple WIP errorReason values vary.
        await ps.session.send('Network.interceptContinue', { requestId, errorReason: 'BlockedByClient' }, 5_000);
        return textResult(`# intercept_continue ✓ \`${requestId}\` aborted\n\nRequest blocked. Page will see a network error.`);
      }
      await ps.session.send('Network.interceptContinue', { requestId }, 5_000);
      return textResult(`# intercept_continue ✓ \`${requestId}\` released\n\nURL: ${entry.url}\nFlowing to network unchanged.`);
    } catch (e) {
      return errorResult(`Network.interceptContinue failed: ${describe(e)}`);
    }
  },
};

export const interceptRespondTool = {
  name: 'intercept_respond',
  description: [
    'Reply to an intercepted request with a mock response via WIP `Network.interceptWithResponse`. Useful for testing error handling, staging fixture data, or diverting an API call without backend changes.',
    'Body can be plain text/JSON (string) or base64-encoded binary (set `base64=true`).',
    'Pair with `list_intercepted_requests` to discover requestIds.',
  ].join(' '),
  inputSchema: {
    requestId: z.string().min(1).describe('Intercepted requestId from `list_intercepted_requests`.'),
    statusCode: z
      .number()
      .int()
      .min(100)
      .max(599)
      .optional()
      .describe('HTTP status code (default 200).'),
    headers: z
      .record(z.string(), z.string())
      .optional()
      .describe('Additional response headers map (Content-Type defaults to text/plain unless overridden).'),
    body: z.string().describe('Response body. Plain text or JSON string when `base64=false`; base64-encoded bytes when `base64=true`.'),
    base64: z
      .boolean()
      .optional()
      .describe('Treat `body` as base64 (default false).'),
  },
  handler: async ({ requestId, statusCode = 200, headers, body, base64 = false }: { requestId: string; statusCode?: number; headers?: Record<string, string>; body: string; base64?: boolean }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    const entry = ps.consumeIntercepted(requestId);
    if (!entry) {
      return textResult(`# intercept_respond — requestId \`${requestId}\` not in pending set (may have already been responded / timed out / never intercepted)`);
    }
    const hdrs: Record<string, string> = { 'Content-Type': 'text/plain', ...(headers ?? {}) };
    const content = base64 ? body : Buffer.from(body, 'utf-8').toString('base64');
    try {
      await ps.session.send(
        'Network.interceptWithResponse',
        { requestId, statusCode, headers: hdrs, content, base64Encoded: true },
        5_000,
      );
      return textResult(
        `# intercept_respond ✓ \`${requestId}\` mocked\n\n` +
          `URL: ${entry.url}\n` +
          `Status: ${statusCode}\n` +
          `Body: ${base64 ? `${body.length} bytes (base64)` : `"${body.slice(0, 80)}${body.length > 80 ? '…' : ''}"`}\n`,
      );
    } catch (e) {
      return errorResult(`Network.interceptWithResponse failed: ${describe(e)}`);
    }
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
