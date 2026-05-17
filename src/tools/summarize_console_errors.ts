/**
 * `summarize_console_errors` (batch-14 composite, fka `fix_console_errors` in
 * cross-review v2.0.1 — renamed because the tool surfaces signals; "fixing" is
 * LLM-side work).
 *
 * Reads `PageSession.consoleBuffer` directly (already populated by the
 * `Console.messageAdded` + `Runtime.exceptionThrown` subscribers in
 * `PageSession.init`), filters to warning/error level, groups by message
 * similarity (first 80 chars of `text` + url:line), returns top-N groups by
 * frequency with one stack trace each.
 *
 * Useful when the AI agent asks "what's broken here?" — saves it from paging
 * through `list_console_messages` + N × `get_console_message`.
 */
import { z } from 'zod';
import { PageSession, type ConsoleEntry } from '../page-session.js';

export const summarizeConsoleErrorsTool = {
  name: 'summarize_console_errors',
  description: [
    'Summarize buffered console errors and warnings on the inspected iOS WebView page: filter level ≥ warning, group by message similarity (text + source location), return top-N groups by frequency with one representative stack trace each.',
    'Reads from PageSession in-memory buffer (default cap 200 entries). Older entries are evicted as new ones arrive.',
    'Use as a one-call "what is broken here?" — saves N × `get_console_message` round-trips. Pair with `clear_console` if you want a clean window after a fix attempt.',
  ].join(' '),
  inputSchema: {
    minLevel: z
      .enum(['log', 'info', 'warning', 'error'])
      .optional()
      .describe('Minimum severity to include (default `warning`).'),
    topN: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Top-N groups by frequency (default 10).'),
    includeStackTrace: z
      .boolean()
      .optional()
      .describe('Include the first occurrence\'s stack trace per group (default true). Set false for compact output.'),
  },
  handler: async ({ minLevel = 'warning', topN = 10, includeStackTrace = true }: { minLevel?: 'log' | 'info' | 'warning' | 'error'; topN?: number; includeStackTrace?: boolean }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }

    const minRank = LEVEL_RANK[minLevel];
    const filtered = ps.consoleBuffer.filter(e => (LEVEL_RANK[_normalizeLevel(e.level)] ?? -1) >= minRank);
    if (filtered.length === 0) {
      return textResult(`# summarize_console_errors\n\nNo entries at level ≥ ${minLevel} in the current buffer (${ps.consoleBuffer.length} total entries).`);
    }

    const groups = new Map<string, { count: number; first: ConsoleEntry; level: string }>();
    for (const e of filtered) {
      const key = _groupKey(e);
      const cur = groups.get(key);
      if (cur) cur.count += 1;
      else groups.set(key, { count: 1, first: e, level: _normalizeLevel(e.level) });
    }
    const sorted = [...groups.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, topN);

    const lines: string[] = [
      `# summarize_console_errors — ${filtered.length} entries (≥ ${minLevel})`,
      '',
      `Groups: ${groups.size}, showing top ${sorted.length}.`,
      '',
    ];
    for (const [, { count, first, level }] of sorted) {
      lines.push(`## [${level}] × ${count} — \`${_truncate(first.text, 100)}\``);
      const loc = formatLoc(first);
      if (loc) lines.push(loc);
      if (includeStackTrace && first.stackTrace) {
        const frames = _extractFrames(first.stackTrace);
        if (frames.length > 0) {
          lines.push('');
          lines.push('```');
          for (const f of frames.slice(0, 8)) lines.push(f);
          if (frames.length > 8) lines.push(`… ${frames.length - 8} more frames`);
          lines.push('```');
        }
      }
      lines.push('');
    }
    return textResult(lines.join('\n'));
  },
};

// Helpers exported for tests (underscore prefix = internal but reachable).
export const LEVEL_RANK: Record<string, number> = { log: 0, info: 1, warning: 2, error: 3 };

export function _normalizeLevel(level: string): 'log' | 'info' | 'warning' | 'error' {
  if (level === 'error') return 'error';
  if (level === 'warning' || level === 'warn') return 'warning';
  if (level === 'info') return 'info';
  return 'log';
}

export function _groupKey(e: ConsoleEntry): string {
  const text = (e.text || '').slice(0, 80).trim().replace(/\s+/g, ' ');
  const loc = e.url ? `${e.url}:${e.line ?? '?'}` : '(no-loc)';
  return `${text}|${loc}`;
}

function formatLoc(e: ConsoleEntry): string {
  if (!e.url) return '';
  return `Source: \`${e.url}\`${e.line !== undefined ? `:${e.line}` : ''}${e.column !== undefined ? `:${e.column}` : ''}`;
}

export function _extractFrames(stackTrace: unknown): string[] {
  if (!stackTrace || typeof stackTrace !== 'object') return [];
  const st = stackTrace as { callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }> };
  if (!Array.isArray(st.callFrames)) return [];
  return st.callFrames.map(f => `  at ${f.functionName || '<anon>'} (${f.url || '?'}:${f.lineNumber ?? '?'}:${f.columnNumber ?? '?'})`);
}

export function _truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
