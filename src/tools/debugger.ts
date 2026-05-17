import { z } from 'zod';
import { PageSession } from '../page-session.js';

/**
 * Apple WIP `Debugger` domain is exposed on iOS (probe-confirmed 2026-05-16):
 *   Debugger.{enable,disable,pause,resume,setBreakpointByUrl,setBreakpointsActive}
 *
 * Caveats:
 *   - `Debugger.pause` marks "pause on next JS execution opportunity" — the
 *     actual pause happens asynchronously when the page next runs script,
 *     visible via `Debugger.paused` events. The tool returns immediately.
 *   - While paused, subsequent `Runtime.evaluate` calls may block the WIP
 *     event loop or execute in pause context (different scope). Use
 *     `resume_debugger` before further work to be safe.
 *   - `Debugger.enable` is idempotent on Apple WIP — we call it lazily.
 */

const ensureEnabled = async (ps: PageSession) => {
  try { await ps.session.send('Debugger.enable', undefined, 5_000); } catch { /* idempotent */ }
};

export const pauseDebuggerTool = {
  name: 'pause_debugger',
  description: [
    'Request a JavaScript execution pause on the inspected iOS WebView page via WIP `Debugger.pause` (probe-confirmed 2026-05-16).',
    'NOTE: Pause is async — actual pause happens when the page next executes script. The tool returns immediately. While paused, other tools may behave unexpectedly. Call `resume_debugger` before further interaction.',
    'Always re-enable Debugger lazily (idempotent on Apple WIP).',
  ].join(' '),
  inputSchema: {},
  handler: async () => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    await ensureEnabled(ps);
    try { await ps.session.send('Debugger.pause', undefined, 5_000); }
    catch (e) { return errorResult(`Debugger.pause failed: ${describe(e)}`); }
    return textResult('# pause_debugger ✓\n\nPause requested. The page will pause on its next JS execution (timer fire / event handler / promise tick). Call `resume_debugger` to unblock.');
  },
};

export const resumeDebuggerTool = {
  name: 'resume_debugger',
  description: 'Resume JavaScript execution if paused, via WIP `Debugger.resume` (probe-confirmed 2026-05-16). Safe to call unconditionally — silently no-ops if not paused.',
  inputSchema: {},
  handler: async () => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    await ensureEnabled(ps);
    try { await ps.session.send('Debugger.resume', undefined, 5_000); }
    catch (e) {
      const err = e as { message?: string };
      if (err.message?.includes('Was not paused')) return textResult('# resume_debugger ✓ (was not paused, no-op)');
      return errorResult(`Debugger.resume failed: ${describe(e)}`);
    }
    return textResult('# resume_debugger ✓');
  },
};

interface BreakpointResult { breakpointId: string; locations: Array<Record<string, unknown>> }

export const setBreakpointByUrlTool = {
  name: 'set_breakpoint_by_url',
  description: 'Set a JavaScript breakpoint by source URL + line via WIP `Debugger.setBreakpointByUrl` (probe-confirmed 2026-05-16). Returns breakpointId for later removal (not yet exposed) and resolved source locations.',
  inputSchema: {
    url: z.string().min(1).describe('Source URL pattern (exact match unless urlRegex used).'),
    lineNumber: z.number().int().min(0).describe('0-based line number in source.'),
    columnNumber: z.number().int().min(0).optional().describe('0-based column (default 0).'),
    condition: z.string().optional().describe('JS expression — break only when expression evaluates truthy in scope.'),
  },
  handler: async ({ url, lineNumber, columnNumber = 0, condition }: { url: string; lineNumber: number; columnNumber?: number; condition?: string }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    await ensureEnabled(ps);
    let r: BreakpointResult;
    try {
      r = await ps.session.send<BreakpointResult>('Debugger.setBreakpointByUrl', {
        url, lineNumber, columnNumber, ...(condition ? { condition } : {}),
      }, 10_000);
    } catch (e) { return errorResult(`Debugger.setBreakpointByUrl failed: ${describe(e)}`); }
    const lines = [
      `# set_breakpoint_by_url ✓ \`${r.breakpointId}\``,
      '',
      `URL: ${url}:${lineNumber}:${columnNumber}${condition ? ` (when: ${condition})` : ''}`,
      `Resolved locations: ${r.locations?.length ?? 0}${(r.locations?.length ?? 0) === 0 ? ' (no script loaded matches yet — breakpoint will activate when matching script loads)' : ''}`,
    ];
    if (r.locations?.length) {
      lines.push('');
      for (const loc of r.locations) lines.push(`- scriptId=${loc.scriptId} line=${loc.lineNumber} col=${loc.columnNumber}`);
    }
    return textResult(lines.join('\n'));
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
