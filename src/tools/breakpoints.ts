/**
 * Advanced breakpoint controls for batch-13 (cross-review v2.0.1 Must).
 *
 *   - `set_pause_on_exceptions` — `Debugger.setPauseOnExceptions`
 *   - `set_event_breakpoint`     — `DOMDebugger.setEventBreakpoint`
 *   - `set_url_breakpoint`       — `DOMDebugger.setURLBreakpoint`
 *
 * `Debugger.setBreakpointByUrl` (JS source-URL breakpoint, ≠ network URL
 * breakpoint here) lives in `debugger.ts` since batch-12.
 *
 * Capability matrix v2 (2026-05-17 fresh-ws probe) confirmed all three ✅
 * on iOS 26.5.0 WKWebView. Receipts: docs/spec.md §"WIP capability matrix v2".
 */
import { z } from 'zod';
import { PageSession } from '../page-session.js';

const ensureDebuggerEnabled = async (ps: PageSession) => {
  try { await ps.session.send('Debugger.enable', undefined, 5_000); } catch { /* idempotent */ }
};

export const setPauseOnExceptionsTool = {
  name: 'set_pause_on_exceptions',
  description: [
    'Set pause-on-exceptions mode via WIP `Debugger.setPauseOnExceptions` (✅ probe 2026-05-17).',
    'Equivalent to Safari Web Inspector "Pause on Exceptions" toggle. Persists across resume_debugger calls until cleared.',
    'States: `none` (default; never pause), `uncaught` (pause only on uncaught), `all` (pause on every throw — noisy but useful for tracing).',
  ].join(' '),
  inputSchema: {
    state: z
      .enum(['none', 'uncaught', 'all'])
      .describe('`none` clears the pause-on-exceptions mode; `uncaught` pauses only on uncaught throws; `all` pauses on every throw.'),
  },
  handler: async ({ state }: { state: 'none' | 'uncaught' | 'all' }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    await ensureDebuggerEnabled(ps);
    try {
      await ps.session.send('Debugger.setPauseOnExceptions', { state }, 5_000);
    } catch (e) {
      return errorResult(`Debugger.setPauseOnExceptions failed: ${describe(e)}`);
    }
    return textResult(`# set_pause_on_exceptions ✓ \`${state}\`\n\n${describeMode(state)}`);
  },
};

function describeMode(state: 'none' | 'uncaught' | 'all'): string {
  if (state === 'none') return 'Cleared. Page no longer auto-pauses on exceptions.';
  if (state === 'uncaught') return 'Page will pause when an uncaught exception is thrown. Use `resume_debugger` to continue.';
  return 'Page will pause on EVERY thrown exception (caught or not). Noisy but powerful for tracing throw sites. Use `resume_debugger` to continue.';
}

export const setEventBreakpointTool = {
  name: 'set_event_breakpoint',
  description: [
    'Break when a specified DOM/JS event fires, via WIP `DOMDebugger.setEventBreakpoint` (✅ probe 2026-05-17).',
    'breakpointType=`listener` covers DOM events (click, scroll, keydown…). breakpointType=`timer` covers setTimeout/setInterval/requestAnimationFrame. breakpointType=`animation-frame` for rAF specifically. breakpointType=`interval` for setInterval.',
    'Use this to catch the moment an event fires without knowing the handler\'s file:line. Pair with `pause_debugger` mental model: when the event triggers, the page stops at the listener entry.',
  ].join(' '),
  inputSchema: {
    eventName: z.string().min(1).describe('Event name without prefix, e.g. `click`, `keydown`, `setTimeout`, `requestAnimationFrame`.'),
    breakpointType: z
      .enum(['listener', 'timer', 'animation-frame', 'interval'])
      .optional()
      .describe('Breakpoint category. Default `listener` (DOM events). Use `timer` for setTimeout, `animation-frame` for rAF, `interval` for setInterval.'),
  },
  handler: async ({ eventName, breakpointType = 'listener' }: { eventName: string; breakpointType?: 'listener' | 'timer' | 'animation-frame' | 'interval' }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    await ensureDebuggerEnabled(ps);
    try {
      await ps.session.send('DOMDebugger.setEventBreakpoint', { breakpointType, eventName }, 5_000);
    } catch (e) {
      return errorResult(`DOMDebugger.setEventBreakpoint failed: ${describe(e)}`);
    }
    return textResult(
      `# set_event_breakpoint ✓\n\n` +
        `Event: \`${eventName}\` (type=${breakpointType})\n\n` +
        `Page will pause when this event fires. Trigger the action manually (or via \`click\` / \`type_text\` etc.) — execution will halt at the listener entry. Call \`resume_debugger\` to continue.\n\n` +
        `⚠ Removal not yet exposed (batch-14). Set the same event again to re-enable; restart MCP server to clear all event breakpoints.`,
    );
  },
};

export const setUrlBreakpointTool = {
  name: 'set_url_breakpoint',
  description: [
    'Break when a network request URL matches a substring or regex, via WIP `DOMDebugger.setURLBreakpoint` (✅ probe 2026-05-17).',
    'Distinct from `set_breakpoint_by_url` (which is `Debugger.setBreakpointByUrl` — JS source-URL line breakpoint). This one fires when XHR / fetch / script-src etc. requests match.',
    'Use for "where in the code does this fetch get triggered" investigations.',
  ].join(' '),
  inputSchema: {
    url: z.string().min(1).describe('URL substring (when isRegex=false) or regex pattern (when isRegex=true). Empty matches all requests.'),
    isRegex: z
      .boolean()
      .optional()
      .describe('Treat `url` as JS regex (default false → substring match).'),
  },
  handler: async ({ url, isRegex = false }: { url: string; isRegex?: boolean }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    await ensureDebuggerEnabled(ps);
    try {
      await ps.session.send('DOMDebugger.setURLBreakpoint', { url, isRegex }, 5_000);
    } catch (e) {
      return errorResult(`DOMDebugger.setURLBreakpoint failed: ${describe(e)}`);
    }
    return textResult(
      `# set_url_breakpoint ✓\n\n` +
        `URL: \`${url}\`${isRegex ? ' (regex)' : ' (substring)'}\n\n` +
        `Page will pause when a request URL matches. Trigger network activity (navigation / XHR / fetch) — execution halts at the call site. Call \`resume_debugger\` to continue.\n\n` +
        `⚠ Removal not yet exposed (batch-14). Restart MCP server to clear all URL breakpoints.`,
    );
  },
};

export const setBlackboxUrlTool = {
  name: 'set_blackbox_url',
  description: [
    'Mark a script URL as blackboxed (or un-blackbox it) via WIP `Debugger.setShouldBlackboxURL` (✅ probe 2026-05-17).',
    'Apple WIP uses per-URL booleans (NOT CDP-style `setBlackboxPatterns` — that one ❌ NOT_FOUND on iOS).',
    'When blackboxed, the debugger steps OVER all frames in matching URLs instead of stepping in. Use to skip framework / library code (jquery, react-dom, polyfills etc.) when stepping through your own code.',
  ].join(' '),
  inputSchema: {
    url: z.string().min(1).describe('Script URL pattern (Apple WIP treats this as a substring/glob — exact semantics build-specific).'),
    shouldBlackbox: z
      .boolean()
      .optional()
      .describe('`true` (default) blackboxes; `false` removes blackbox.'),
  },
  handler: async ({ url, shouldBlackbox = true }: { url: string; shouldBlackbox?: boolean }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    await ensureDebuggerEnabled(ps);
    try {
      await ps.session.send('Debugger.setShouldBlackboxURL', { url, shouldBlackbox }, 5_000);
    } catch (e) {
      return errorResult(`Debugger.setShouldBlackboxURL failed: ${describe(e)}`);
    }
    return textResult(
      `# set_blackbox_url ✓ \`${url}\` → ${shouldBlackbox ? 'blackboxed' : 'cleared'}\n\n` +
        (shouldBlackbox
          ? `Debugger will step OVER frames whose script URL matches \`${url}\`. Useful for hiding framework/library noise.`
          : `Blackbox cleared for \`${url}\`. Debugger will once again step into matching scripts.`),
    );
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
