import { z } from 'zod';
import { PageSession, type NetworkEntry } from '../page-session.js';

export const listNetworkRequestsTool = {
  name: 'list_network_requests',
  description: [
    'Return recent network requests captured from the inspected iOS WebView page.',
    'Wraps WIP `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` / `loadingFailed` events.',
    'Requests are captured in a rolling buffer (cap 200) once the session attaches.',
    'Filters: urlSubstring (case-insensitive), state, method.',
  ].join(' '),

  inputSchema: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Max requests to return (most recent first). Default 50.'),
    urlSubstring: z
      .string()
      .optional()
      .describe('Case-insensitive substring filter on request URL.'),
    state: z
      .enum(['pending', 'response-received', 'finished', 'failed'])
      .optional()
      .describe('Filter by lifecycle state.'),
    method: z
      .string()
      .optional()
      .describe('Filter by HTTP method (e.g. GET, POST).'),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .optional()
      .describe('If buffer is empty, wait up to this many ms for requests to arrive before returning. Default 0.'),
  },

  handler: async ({
    limit = 50,
    urlSubstring,
    state,
    method,
    waitMs = 0,
  }: {
    limit?: number;
    urlSubstring?: string;
    state?: NetworkEntry['state'];
    method?: string;
    waitMs?: number;
  }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    if (ps.networkBuffer.length === 0 && waitMs > 0) {
      await sleep(waitMs);
    }

    let entries = ps.networkBuffer.slice();
    if (urlSubstring) {
      const needle = urlSubstring.toLowerCase();
      entries = entries.filter(e => e.url.toLowerCase().includes(needle));
    }
    if (state) {
      entries = entries.filter(e => e.state === state);
    }
    if (method) {
      const upper = method.toUpperCase();
      entries = entries.filter(e => (e.method ?? '').toUpperCase() === upper);
    }
    entries = entries.slice(-limit).reverse();

    const lines: string[] = [];
    lines.push(`# Network requests — ${entries.length} of ${ps.networkBuffer.length} buffered`);
    lines.push('');
    if (ps.attachInfo) {
      lines.push(`Attached to: \`${ps.attachInfo.pageTitle || ps.attachInfo.pageUrl}\` (page id ${ps.attachInfo.pageId}, device ${ps.attachInfo.deviceId.slice(0, 12)}…)`);
      lines.push(`Attached at: ${new Date(ps.attachInfo.attachedAt).toISOString()}`);
      lines.push('');
    }

    if (entries.length === 0) {
      lines.push(ps.networkBuffer.length === 0
        ? 'No requests captured yet. Trigger network activity (reload / interact) and call again.'
        : '(All buffered requests filtered out.)');
      return textResult(lines.join('\n'));
    }

    lines.push('| # | state | method | status | type | url |');
    lines.push('|---|-------|--------|--------|------|-----|');
    entries.forEach((e, i) => {
      lines.push(
        `| ${i + 1} | ${e.state} | ${e.method ?? '?'} | ${e.status ?? ''} | ${e.type ?? ''} | ${escapeCell(e.url)} |`,
      );
    });

    const fails = entries.filter(e => e.state === 'failed' || (e.status ?? 0) >= 400);
    if (fails.length > 0) {
      lines.push('');
      lines.push(`## Failures / 4xx-5xx (${fails.length})`);
      for (const f of fails) {
        lines.push(`- ${f.method ?? '?'} ${f.url} → ${f.state === 'failed' ? `failed: ${f.errorText}` : `${f.status} ${f.statusText ?? ''}`}`);
      }
    }

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
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
