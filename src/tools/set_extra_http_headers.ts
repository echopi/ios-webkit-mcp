import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const setExtraHttpHeadersTool = {
  name: 'set_extra_http_headers',
  description: [
    'Set extra HTTP headers attached to every subsequent request issued by the inspected iOS WebView page. Wraps WIP `Network.setExtraHTTPHeaders` (one of the few `Network.*` methods present on WIP — verified 2026-05-16 probe).',
    'Use this to inject `Authorization` / `X-User-Id` / experiment-bucket headers when debugging gated APIs.',
    'NOTE: WIP does NOT expose `Network.setUserAgentOverride` or any other Emulation domain (probe ❌ NOT_FOUND). For UA override on iOS, use the dedicated `set_user_agent` tool (Apple WIP `Page.overrideUserAgent` + reload).',
  ].join(' '),

  inputSchema: {
    headers: z
      .record(z.string())
      .describe('Header name → value map. Pass `{}` to clear previously-set extras.'),
  },

  handler: async ({ headers }: { headers: Record<string, string> }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    try {
      await ps.session.send('Network.setExtraHTTPHeaders', { headers }, 5_000);
    } catch (e) {
      return errorResult(`Network.setExtraHTTPHeaders failed: ${describe(e)}`);
    }

    const lines = [
      `# set_extra_http_headers ✓ ${Object.keys(headers).length} header(s)`,
      '',
    ];
    if (Object.keys(headers).length === 0) {
      lines.push('(Cleared all previously-set extra headers.)');
    } else {
      for (const [k, v] of Object.entries(headers)) {
        lines.push(`- ${k}: ${v}`);
      }
    }
    lines.push('');
    lines.push('Applies to subsequent requests from the page only. Already-issued requests are unaffected.');
    return textResult(lines.join('\n'));
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
