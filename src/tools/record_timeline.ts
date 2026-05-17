import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface TimelineEvent { type: string; data?: Record<string, unknown>; startTime?: number; endTime?: number; children?: unknown[] }

export const recordTimelineTool = {
  name: 'record_timeline',
  description: [
    'Record an Apple WIP Timeline trace for a fixed duration on the inspected iOS WebView page.',
    'WIP exposes `Timeline.start` / `Timeline.stop` + `Timeline.eventRecorded` events (probe-confirmed 2026-05-16). This is the Apple equivalent of CDP `Tracing.*` — captures rendering / scripting / layout / paint events while the timeline is active.',
    'The tool subscribes to events, calls `Timeline.start`, waits `durationMs`, then `Timeline.stop` and returns aggregated event counts + top-N hottest entries by duration.',
  ].join(' '),

  inputSchema: {
    durationMs: z
      .number()
      .int()
      .min(100)
      .max(60_000)
      .optional()
      .describe('How long to record (default 3000).'),
    topN: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Top-N hottest events (by duration) returned (default 20).'),
    eventTypeFilter: z
      .string()
      .optional()
      .describe('Case-insensitive substring filter on event type (e.g. "script", "layout", "paint").'),
  },

  handler: async ({
    durationMs = 3_000,
    topN = 20,
    eventTypeFilter,
  }: { durationMs?: number; topN?: number; eventTypeFilter?: string }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }

    const events: TimelineEvent[] = [];
    const unsubscribe = ps.session.on('Timeline.eventRecorded', (p: unknown) => {
      const params = p as { record?: TimelineEvent };
      if (params?.record) events.push(params.record);
    });

    try {
      await ps.session.send('Timeline.start', undefined, 10_000);
    } catch (e) {
      unsubscribe();
      return errorResult(`Timeline.start failed: ${describe(e)}`);
    }

    await new Promise(r => setTimeout(r, durationMs));

    try {
      await ps.session.send('Timeline.stop', undefined, 10_000);
    } catch (e) {
      unsubscribe();
      return errorResult(`Timeline.stop failed: ${describe(e)}`);
    }
    // Allow tail events to drain.
    await new Promise(r => setTimeout(r, 100));
    unsubscribe();

    let kept = events;
    if (eventTypeFilter) {
      const n = eventTypeFilter.toLowerCase();
      kept = kept.filter(e => (e.type || '').toLowerCase().includes(n));
    }

    const byType = new Map<string, number>();
    for (const e of kept) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    const typeRows = [...byType.entries()].sort((a, b) => b[1] - a[1]);

    const withDuration = kept
      .filter(e => typeof e.startTime === 'number' && typeof e.endTime === 'number')
      .map(e => ({ ...e, _dur: (e.endTime as number) - (e.startTime as number) }))
      .sort((a, b) => b._dur - a._dur)
      .slice(0, topN);

    const lines = [
      `# record_timeline ✓ ${durationMs}ms recorded`,
      '',
      `Total events: ${events.length}${eventTypeFilter ? ` (${kept.length} after filter "${eventTypeFilter}")` : ''}`,
      '',
    ];
    if (typeRows.length > 0) {
      lines.push('## events by type');
      typeRows.slice(0, 30).forEach(([t, n]) => lines.push(`- ${t}: ${n}`));
      if (typeRows.length > 30) lines.push(`- … ${typeRows.length - 30} more types`);
    }
    if (withDuration.length > 0) {
      lines.push('');
      lines.push(`## top ${withDuration.length} hottest events`);
      lines.push('| dur (ms) | type | startTime | data |');
      lines.push('|---|---|---|---|');
      for (const e of withDuration) {
        const data = e.data ? JSON.stringify(e.data).slice(0, 80) : '';
        lines.push(`| ${e._dur.toFixed(2)} | ${e.type} | ${(e.startTime as number).toFixed(2)} | ${data.replace(/\|/g, '\\|')} |`);
      }
    } else if (kept.length > 0) {
      lines.push('');
      lines.push('(no events with start/end timestamps for hottest ranking)');
    }
    lines.push('');
    lines.push('⚠ Apple WIP `Timeline` semantically maps to CDP `Tracing` but the event schema differs. Common types: `RenderingFrame` / `ScheduleStyleRecalculation` / `Paint` / `Layout` / `EvaluateScript` / `FunctionCall` / `TimerFire`.');
    return textResult(lines.join('\n'));
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
