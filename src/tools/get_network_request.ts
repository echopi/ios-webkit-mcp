import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const getNetworkRequestTool = {
  name: 'get_network_request',
  description: [
    'Return the full detail of a single network request from the rolling buffer (filled by `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` / `loadingFailed`).',
    'Lookup by `requestId` (preferred — exact match) or `index` (0-based against current buffer ordering; negative counts from end).',
    'Returns lifecycle state, request line, request/response headers, and optionally the response body via `Network.getResponseBody` when `withBody=true`.',
    'NOTE: WIP `Network.getResponseBody` only returns bodies for requests that completed AND were not evicted from WebKit\'s resource buffer — large or binary bodies may fail with `-32000 No data found`.',
  ].join(' '),

  inputSchema: {
    requestId: z.string().optional().describe('Exact requestId returned by `list_network_requests` (e.g. `loader-id.123`).'),
    index: z.number().int().optional().describe('0-based buffer index. Negative counts from the end. Mutually exclusive with requestId.'),
    withBody: z.boolean().optional().describe('Also fetch response body via `Network.getResponseBody`. Default false.'),
    bodyMaxLen: z.number().int().min(100).max(200_000).optional().describe('Response body truncation cap (default 20000).'),
  },

  handler: async ({
    requestId,
    index,
    withBody = false,
    bodyMaxLen = 20_000,
  }: { requestId?: string; index?: number; withBody?: boolean; bodyMaxLen?: number }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    const buf = ps.networkBuffer;
    if (buf.length === 0) {
      return errorResult('Network buffer is empty. Trigger page activity and call again.');
    }

    if (requestId === undefined && index === undefined) {
      return errorResult('Provide either `requestId` or `index`.');
    }
    if (requestId !== undefined && index !== undefined) {
      return errorResult('Provide only one of `requestId` / `index`.');
    }

    let entry;
    if (requestId !== undefined) {
      entry = ps.networkById.get(requestId);
      if (!entry) {
        return errorResult(`requestId ${JSON.stringify(requestId)} not in buffer (${buf.length} entries). Use \`list_network_requests\` to enumerate.`);
      }
    } else {
      let i = index!;
      if (i < 0) i = buf.length + i;
      if (i < 0 || i >= buf.length) {
        return errorResult(`Index ${index} out of range (buffer has ${buf.length} entries).`);
      }
      entry = buf[i]!;
    }

    const lines: string[] = [];
    lines.push(`# network[${entry.requestId}] · ${entry.state} · ${entry.method ?? '?'} ${entry.url}`);
    lines.push('');
    lines.push(`Status: ${entry.status ?? '(no status)'} ${entry.statusText ?? ''}`);
    lines.push(`MIME type: ${entry.mimeType ?? '(unknown)'}`);
    lines.push(`Resource type: ${entry.type ?? '(unknown)'}${entry.initiatorType ? ` · initiator=${entry.initiatorType}` : ''}`);
    if (entry.startedAt != null) lines.push(`Started at (proxy clock): ${entry.startedAt}`);
    if (entry.endedAt != null) lines.push(`Ended at (proxy clock): ${entry.endedAt}`);
    if (entry.encodedDataLength != null) lines.push(`Encoded data length: ${entry.encodedDataLength}`);
    if (entry.errorText) lines.push(`Error: ${entry.errorText}`);

    if (entry.requestHeaders && Object.keys(entry.requestHeaders).length > 0) {
      lines.push('');
      lines.push('## Request headers');
      for (const [k, v] of Object.entries(entry.requestHeaders)) {
        lines.push(`- ${k}: ${truncate(String(v), 500)}`);
      }
    }
    if (entry.postData) {
      lines.push('');
      lines.push('## Request body (postData)');
      lines.push('```');
      lines.push(truncate(entry.postData, 2_000));
      lines.push('```');
    }
    if (entry.responseHeaders && Object.keys(entry.responseHeaders).length > 0) {
      lines.push('');
      lines.push('## Response headers');
      for (const [k, v] of Object.entries(entry.responseHeaders)) {
        lines.push(`- ${k}: ${truncate(String(v), 500)}`);
      }
    }

    if (withBody) {
      if (entry.state === 'pending') {
        lines.push('');
        lines.push('⚠ Response body unavailable: request still pending.');
      } else {
        try {
          const r = await ps.session.send<{ body: string; base64Encoded: boolean }>(
            'Network.getResponseBody',
            { requestId: entry.requestId },
            10_000,
          );
          lines.push('');
          lines.push(`## Response body${r.base64Encoded ? ' (base64)' : ''}`);
          lines.push('```');
          lines.push(truncate(r.body ?? '', bodyMaxLen));
          lines.push('```');
        } catch (e) {
          lines.push('');
          lines.push(`⚠ Network.getResponseBody failed: ${describe(e)}`);
        }
      }
    }

    return textResult(lines.join('\n'));
  },
};

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n… (truncated, full length ${s.length})` : s;
}
function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
