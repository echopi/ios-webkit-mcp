import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const listConsoleMessagesTool = {
  name: 'list_console_messages',
  description: [
    'Return recent console messages and uncaught exceptions captured from the inspected iOS WebView page.',
    'Wraps WIP `Console.messageAdded` + `Runtime.exceptionThrown` events.',
    'Messages are captured in a rolling buffer (cap 200) once the session attaches.',
    'Optional `waitMs` will block up to that long if the buffer is currently empty (useful right after attach).',
  ].join(' '),

  inputSchema: {
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Max messages to return (most recent first). Default 50.'),
    levels: z
      .array(z.string())
      .optional()
      .describe('Filter by level (e.g. ["error","warning"]). Default: all.'),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .optional()
      .describe('If buffer is empty, wait up to this many ms for messages to arrive before returning. Default 0.'),
  },

  handler: async ({
    limit = 50,
    levels,
    waitMs = 0,
  }: {
    limit?: number;
    levels?: string[];
    waitMs?: number;
  }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    if (ps.consoleBuffer.length === 0 && waitMs > 0) {
      await sleep(waitMs);
    }

    let entries = ps.consoleBuffer.slice();
    if (levels && levels.length > 0) {
      const set = new Set(levels.map(s => s.toLowerCase()));
      entries = entries.filter(e => set.has(e.level.toLowerCase()));
    }
    entries = entries.slice(-limit).reverse();

    const lines: string[] = [];
    lines.push(`# Console messages — ${entries.length} of ${ps.consoleBuffer.length} buffered`);
    lines.push('');
    if (ps.attachInfo) {
      lines.push(`Attached to: \`${ps.attachInfo.pageTitle || ps.attachInfo.pageUrl}\` (page id ${ps.attachInfo.pageId}, device ${ps.attachInfo.deviceId.slice(0, 12)}…, iOS ${ps.attachInfo.deviceOSVersion ?? '?'})`);
      lines.push(`Attached at: ${new Date(ps.attachInfo.attachedAt).toISOString()}`);
      lines.push('');
    }
    if (ps.enableErrors.length > 0) {
      lines.push(`⚠ enable errors: ${ps.enableErrors.map(e => `${e.method}(${e.error})`).join(', ')}`);
      lines.push('');
    }

    if (entries.length === 0) {
      lines.push(ps.consoleBuffer.length === 0
        ? 'No messages captured yet. Trigger page activity (reload / interact) and call again.'
        : '(All buffered messages filtered out by levels.)');
      return textResult(lines.join('\n'));
    }

    for (const [i, e] of entries.entries()) {
      const ts = typeof e.timestamp === 'number' ? new Date(e.timestamp * 1000).toISOString() : '';
      lines.push(`## [${i + 1}] ${e.level} · ${e.source}${ts ? ` · ${ts}` : ''}`);
      lines.push(`  ${escapeNewlines(e.text)}`);
      if (e.url) lines.push(`  at ${e.url}${e.line != null ? `:${e.line}` : ''}${e.column != null ? `:${e.column}` : ''}`);
      if (e.args && e.args.length > 0) {
        const compact = e.args.map(a => safeStringify(a, 100)).join(', ');
        lines.push(`  args: [${compact}]`);
      }
      lines.push('');
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
function escapeNewlines(s: string): string {
  return s.replace(/\n/g, ' ⏎ ');
}
function safeStringify(o: unknown, maxLen = 200): string {
  try {
    const s = JSON.stringify(o);
    return s && s.length > maxLen ? s.slice(0, maxLen) + '…' : (s ?? String(o));
  } catch {
    return String(o);
  }
}
