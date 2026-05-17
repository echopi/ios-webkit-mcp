import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const setInitScriptTool = {
  name: 'set_init_script',
  description: [
    'Install a JavaScript snippet that runs on EVERY subsequent navigation of the inspected iOS WebView page via WIP `Page.setBootstrapScript` (Apple-specific, probe-confirmed 2026-05-16).',
    'NOTE: WIP does NOT expose `Page.addScriptToEvaluateOnNewDocument` (the chrome-devtools-mcp counterpart) — `Page.setBootstrapScript` is the Apple equivalent. Only ONE script can be active at a time; calling again replaces the previous one. Pass `source=""` (empty) to clear.',
    'Useful for persistent test hooks (e.g. install `handle_dialog` overrides before every page load).',
  ].join(' '),

  inputSchema: {
    source: z.string().describe('JavaScript source to run on each navigation. Empty string clears the bootstrap script.'),
  },

  handler: async ({ source }: { source: string }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    try { await ps.session.send('Page.setBootstrapScript', { source }, 10_000); }
    catch (e) { return errorResult(`Page.setBootstrapScript failed: ${describe(e)}`); }
    const lines = [`# set_init_script ✓ ${source.length === 0 ? '(cleared)' : `${source.length} char(s) installed`}`, ''];
    if (source.length > 0) {
      const preview = source.length > 200 ? source.slice(0, 200) + '…' : source;
      lines.push('## installed snippet (preview)');
      lines.push('```js');
      lines.push(preview);
      lines.push('```');
    }
    lines.push('');
    lines.push('Runs on EVERY subsequent navigation (incl. SPA programmatic ones if they trigger document reload). One script max — recall to replace.');
    return textResult(lines.join('\n'));
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
