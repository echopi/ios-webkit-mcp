/**
 * batch-13 Should network runtime controls.
 *
 *   - `set_resource_caching_disabled` — `Network.setResourceCachingDisabled`
 *   - `set_request_interception`      — `Network.setInterceptionEnabled` (enable-only switch)
 *
 * `Network.{interceptContinue, interceptWithResponse}` are deferred to batch-14
 * with a complete fulfill/continue state machine — exposing only the on/off
 * switch here avoids the "能力幻觉" pitfall raised in cross-review v2.0.1 R3
 * (LLM sees `intercept_request` and assumes it can fulfill).
 *
 * Probe-confirmed (2026-05-17):
 *   - Network.setInterceptionEnabled ✅
 *   - Network.setResourceCachingDisabled ✅
 *   - Network.addInterception ✅ (not exposed yet — needed for fulfill)
 */
import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const setResourceCachingDisabledTool = {
  name: 'set_resource_caching_disabled',
  description: [
    'Enable or disable resource caching for the current page session via WIP `Network.setResourceCachingDisabled` (✅ probe 2026-05-17).',
    'Useful for hot-debugging — flip on to force every reload to refetch CSS/JS/images even when ETag would normally serve from cache.',
    'State persists for the life of the WIP session; auto-cleared when the MCP server restarts. Reload the page after toggling for the new state to take effect.',
  ].join(' '),
  inputSchema: {
    disabled: z.boolean().describe('`true` disables cache (force network fetch); `false` re-enables normal caching.'),
  },
  handler: async ({ disabled }: { disabled: boolean }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    try {
      await ps.session.send('Network.setResourceCachingDisabled', { disabled }, 5_000);
    } catch (e) {
      return errorResult(`Network.setResourceCachingDisabled failed: ${describe(e)}`);
    }
    return textResult(
      `# set_resource_caching_disabled ✓ \`${disabled}\`\n\n` +
        (disabled
          ? 'Cache disabled. Subsequent navigations will force re-fetch all resources. Reload the page to see effect.'
          : 'Cache re-enabled. Normal HTTP cache semantics apply.'),
    );
  },
};

export const setRequestInterceptionTool = {
  name: 'set_request_interception',
  description: [
    'Enable or disable global request interception via WIP `Network.setInterceptionEnabled` + `Network.addInterception` (✅ probe 2026-05-17).',
    'Apple WIP requires BOTH the master switch AND at least one URL pattern in `addInterception` to actually intercept requests. This tool wires them together: enable=true with `urlPattern` adds the pattern; enable=false clears.',
    'Pair with `list_intercepted_requests` + `intercept_continue` + `intercept_respond` for fulfill/continue. PageSession buffers pending intercepted requests (cap 16, 30s auto-continue safety net) so the page never hangs.',
    '⚠ **iOS WKWebView limitation (实测 2026-05-17)**: methods all return `{}` but `Network.requestIntercepted` event is NOT fired on iOS 26.5 — interception runtime is a no-op. Works on macOS Safari per iwdp-mcp. Tool kept for future iOS builds + macOS contexts.',
  ].join(' '),
  inputSchema: {
    enabled: z.boolean().describe('`true` enables interception with the given `urlPattern`; `false` disables and removes all patterns.'),
    urlPattern: z
      .string()
      .optional()
      .describe('URL substring/glob pattern to intercept when enabled (default `*` matches all). Apple WIP wildcard semantics — `*` matches any prefix/suffix.'),
    stage: z
      .enum(['request', 'response'])
      .optional()
      .describe('Intercept at request issue (`request`, default) or response receipt (`response`).'),
  },
  handler: async ({ enabled, urlPattern = '*', stage = 'request' }: { enabled: boolean; urlPattern?: string; stage?: 'request' | 'response' }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    try {
      if (enabled) {
        await ps.session.send('Network.setInterceptionEnabled', { enabled: true }, 5_000);
        await ps.session.send('Network.addInterception', { url: urlPattern, stage }, 5_000);
        return textResult(
          '# set_request_interception ✓ `enabled`\n\n' +
            `URL pattern: \`${urlPattern}\` (stage=${stage})\n\n` +
            'Matching requests now suspend awaiting a decision. PageSession buffers pending (cap 16, 30s auto-continue safety net). ' +
            'Use `list_intercepted_requests` to inspect, `intercept_continue` to release/abort, or `intercept_respond` to mock a response.',
        );
      }
      // Disable path: remove the pattern, then disable master switch.
      try { await ps.session.send('Network.removeInterception', { url: urlPattern, stage }, 5_000); } catch { /* may have been added with diff pattern */ }
      await ps.session.send('Network.setInterceptionEnabled', { enabled: false }, 5_000);
      return textResult('# set_request_interception ✓ `disabled`\n\nInterception cleared. Pending intercepted requests release.');
    } catch (e) {
      return errorResult(`set_request_interception failed: ${describe(e)}`);
    }
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
