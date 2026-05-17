import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const clearConsoleTool = {
  name: 'clear_console',
  description: [
    'Clear the page console + the local PageSession buffer via WIP `Console.clearMessages` (probe-confirmed 2026-05-16).',
    'Both sides are reset: the WebKit-side console (so re-attaching wouldn\'t replay these) AND the in-process rolling buffer fed by `Console.messageAdded`.',
    'Useful before an interaction probe so subsequent `list_console_messages` only returns new entries.',
  ].join(' '),

  inputSchema: {},

  handler: async () => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    const before = ps.consoleBuffer.length;
    try { await ps.session.send('Console.clearMessages', undefined, 5_000); }
    catch (e) { return errorResult(`Console.clearMessages failed: ${describe(e)}`); }
    ps.consoleBuffer.length = 0;
    return textResult(`# clear_console ✓\n\nCleared WebKit console + local buffer (was ${before} entries, now 0).`);
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
