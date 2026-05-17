import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const getConsoleMessageTool = {
  name: 'get_console_message',
  description: [
    'Return the full detail of a single console message from the rolling buffer (filled by `Console.messageAdded` + `Runtime.exceptionThrown`).',
    'Indexing: `index` is 0-based against the current buffer ordering (oldest → newest). Negative values count from the end (`-1` = newest).',
    'Returns level, source, text, url:line:col, full args (with truncation), and full stack trace if present.',
  ].join(' '),

  inputSchema: {
    index: z
      .number()
      .int()
      .describe('0-based index into the rolling console buffer. Negative counts from the end (-1 = newest).'),
    argMaxLen: z
      .number()
      .int()
      .min(50)
      .max(20_000)
      .optional()
      .describe('Per-arg stringification cap (default 1000).'),
  },

  handler: async ({
    index,
    argMaxLen = 1000,
  }: { index: number; argMaxLen?: number }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    const buf = ps.consoleBuffer;
    if (buf.length === 0) {
      return errorResult('Console buffer is empty. Trigger page activity and call again.');
    }
    let i = index;
    if (i < 0) i = buf.length + i;
    if (i < 0 || i >= buf.length) {
      return errorResult(`Index ${index} out of range (buffer has ${buf.length} entries; valid: 0..${buf.length - 1} or -${buf.length}..-1).`);
    }

    const e = buf[i]!;
    const lines: string[] = [];
    const ts = typeof e.timestamp === 'number' ? new Date(e.timestamp * 1000).toISOString() : '(no timestamp)';
    lines.push(`# console[${i}] / ${i + 1}-of-${buf.length} · ${e.level} · ${e.source}`);
    lines.push('');
    lines.push(`Time: ${ts}`);
    if (e.url) lines.push(`At: ${e.url}${e.line != null ? `:${e.line}` : ''}${e.column != null ? `:${e.column}` : ''}`);
    lines.push('');
    lines.push('## text');
    lines.push('```');
    lines.push(e.text);
    lines.push('```');

    if (e.args && e.args.length > 0) {
      lines.push('');
      lines.push(`## args (${e.args.length})`);
      e.args.forEach((arg, idx) => {
        lines.push(`### args[${idx}]`);
        lines.push('```json');
        lines.push(safeStringify(arg, argMaxLen));
        lines.push('```');
      });
    }

    if (e.stackTrace) {
      lines.push('');
      lines.push('## stackTrace');
      lines.push('```json');
      lines.push(safeStringify(e.stackTrace, 5_000));
      lines.push('```');
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
function safeStringify(o: unknown, maxLen: number): string {
  try {
    const s = JSON.stringify(o, null, 2);
    return s && s.length > maxLen ? s.slice(0, maxLen) + `\n… (truncated, full length ${s.length})` : (s ?? String(o));
  } catch {
    return String(o);
  }
}
