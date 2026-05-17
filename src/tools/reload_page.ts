import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const reloadPageTool = {
  name: 'reload_page',
  description: [
    'Reload the inspected iOS WebView page via WIP `Page.reload`.',
    '`Page.reload` is one of the few `Page.*` methods present on WIP (verified 2026-05-16 probe). Cache mode is honored by WebKit.',
    'Side effect: console + network buffers are NOT cleared automatically (they\'re per-attach not per-navigation). Call `select_page` to do that explicitly.',
  ].join(' '),

  inputSchema: {
    ignoreCache: z
      .boolean()
      .optional()
      .describe('Bypass cache (equivalent to hard reload). Default false.'),
    waitAfterMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .optional()
      .describe('Block after issuing reload for this long (default 500). Use `wait_for` for stronger sync to a specific selector.'),
  },

  handler: async ({
    ignoreCache = false,
    waitAfterMs = 500,
  }: { ignoreCache?: boolean; waitAfterMs?: number }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    try {
      await ps.session.send('Page.reload', { ignoreCache }, 10_000);
    } catch (e) {
      return errorResult(`Page.reload failed: ${describe(e)}`);
    }

    if (waitAfterMs > 0) {
      await new Promise(r => setTimeout(r, waitAfterMs));
    }

    return textResult(
      [
        `# reload_page ✓`,
        '',
        `ignoreCache: ${ignoreCache}`,
        `Waited ${waitAfterMs}ms after issuing reload.`,
        '',
        '⚠ Console/Network buffers retain pre-reload entries. Use `select_page` (same pageId) to reattach + reset, or filter by timestamp on the next read.',
      ].join('\n'),
    );
  },
};

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
