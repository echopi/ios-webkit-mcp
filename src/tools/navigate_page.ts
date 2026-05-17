import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const navigatePageTool = {
  name: 'navigate_page',
  description: [
    'Navigate the inspected iOS WebView page to a new URL.',
    'NOTE: WIP `Page.navigate` is NOT implemented on iOS (-32601). This tool falls back to `Runtime.evaluate` setting `location.href` — semantics match a regular client-side navigation, but you cannot abort/intercept the way Page.navigate would allow.',
    'After issuing, call `list_pages` to confirm the new page id (it may change if the navigation crosses an origin boundary).',
  ].join(' '),

  inputSchema: {
    url: z.string().url().describe('Target URL (must be absolute http(s) or about: URL).'),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .optional()
      .describe('Block this long after issuing navigation to let load events settle (default 1500).'),
  },

  handler: async ({ url, waitMs = 1500 }: { url: string; waitMs?: number }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    const safe = JSON.stringify(url);
    try {
      await ps.session.send('Runtime.evaluate', {
        expression: `location.href = ${safe}`,
        returnByValue: true,
        awaitPromise: false,
      });
    } catch (e) {
      return errorResult(`Runtime.evaluate (navigation) failed: ${describe(e)}`);
    }

    if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Verify by reading location.href back
    let after = '(unread)';
    try {
      const r = await ps.session.send<{ result: { value?: string } }>('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      });
      after = String(r?.result?.value ?? '(unread)');
    } catch {
      // ignore — page may have detached
    }

    return textResult(
      [
        `# navigate_page`,
        '',
        `Requested: ${url}`,
        `After ${waitMs}ms: ${after}`,
        '',
        '⚠ Page.navigate is not implemented on iOS WIP; this used `location.href = …` instead. If a redirect happened, the URL above is the final landing.',
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
