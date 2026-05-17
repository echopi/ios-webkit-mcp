/**
 * `record_memory_tracking` (batch-14, soft-promoted from "推到 batch-14 nice")
 *
 * Pairs with `record_cpu_profile` to form the "性能三件套路线图" foundation
 * (cross-review v2.0.1 codex). Different signal:
 *   - `record_cpu_profile` → who (which JS function) is hot
 *   - `record_memory_tracking` → what (jsHeap / images / layers) is using memory
 *   - `record_timeline` → when (frame events) on the wall clock
 *
 * WIP: `Memory.startTracking` + `Memory.stopTracking` + `Memory.trackingUpdate`
 * events (probe-confirmed 2026-05-17).
 *
 * Apple's `Memory.trackingUpdate` payload contains a `categories` array
 * carrying per-bucket sizes (JavaScript / Images / Layers / Page / Other).
 * We sample the latest per category, then return delta vs initial sample.
 */
import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface MemoryCategory { type?: string; size?: number }
interface MemoryEvent { timestamp?: number; categories?: MemoryCategory[] }

export const recordMemoryTrackingTool = {
  name: 'record_memory_tracking',
  description: [
    'Record an Apple WIP Memory tracking sample for a fixed duration on the inspected iOS WebView page.',
    'Subscribes to `Memory.trackingUpdate` events between `Memory.startTracking` and `Memory.stopTracking` (probe-confirmed 2026-05-17).',
    'Returns per-category memory size delta (JavaScript / Images / Layers / Page / Other) so the AI can answer "which bucket grew during this interaction?".',
    'Pair with `record_cpu_profile` (hot functions) and `record_timeline` (frame events) for the performance三件套.',
  ].join(' '),

  inputSchema: {
    durationMs: z
      .number()
      .int()
      .min(200)
      .max(60_000)
      .optional()
      .describe('How long to track (default 3000).'),
  },

  handler: async ({ durationMs = 3_000 }: { durationMs?: number }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }

    const samples: MemoryEvent[] = [];
    const unsubscribers: Array<() => void> = [];
    unsubscribers.push(ps.session.on('Memory.trackingUpdate', (p: unknown) => {
      const params = p as { event?: MemoryEvent; sample?: MemoryEvent } | MemoryEvent;
      const evt = (params as { event?: MemoryEvent })?.event ?? (params as { sample?: MemoryEvent })?.sample ?? (params as MemoryEvent);
      if (evt && Array.isArray(evt.categories)) samples.push(evt);
    }));
    unsubscribers.push(ps.session.on('Memory.trackingComplete', () => { /* terminal */ }));

    try { await ps.session.send('Memory.startTracking', undefined, 5_000); } catch (e) {
      unsubscribers.forEach(u => u());
      return errorResult(`Memory.startTracking failed: ${describe(e)}`);
    }

    await new Promise(r => setTimeout(r, durationMs));

    try { await ps.session.send('Memory.stopTracking', undefined, 10_000); } catch { /* best-effort */ }
    await new Promise(r => setTimeout(r, 200)); // let trackingComplete drain
    unsubscribers.forEach(u => u());

    if (samples.length === 0) {
      return textResult(
        `# record_memory_tracking ✓ ${durationMs}ms\n\n` +
          'No `Memory.trackingUpdate` events received. The page may have produced no allocation deltas during the window — interact with it (scroll / load images / open detail view) and re-record. Schema may also differ on this iOS build; set WDM_WS_DEBUG=1 to see raw event payloads.',
      );
    }

    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const lookup = (s: MemoryEvent, type: string): number => s.categories?.find(c => c.type === type)?.size ?? 0;
    const cats = new Set<string>();
    for (const s of samples) for (const c of s.categories ?? []) if (c.type) cats.add(c.type);

    const lines = [
      `# record_memory_tracking ✓ ${durationMs}ms`,
      '',
      `Samples: ${samples.length}`,
      `First @ ${first.timestamp ?? 'unknown'} → Last @ ${last.timestamp ?? 'unknown'}`,
      '',
      '| category | first (MB) | last (MB) | delta (MB) | delta % |',
      '|---|---|---|---|---|',
    ];
    for (const t of [...cats].sort()) {
      const a = lookup(first, t);
      const b = lookup(last, t);
      const delta = b - a;
      const pct = a > 0 ? `${((delta / a) * 100).toFixed(1)}%` : '—';
      lines.push(`| ${t} | ${(a / 1024 / 1024).toFixed(2)} | ${(b / 1024 / 1024).toFixed(2)} | ${(delta / 1024 / 1024).toFixed(2)} | ${pct} |`);
    }
    lines.push('');
    lines.push('⚠ Apple WIP `Memory.trackingUpdate` event schema is union-typed across iOS builds. If categories look empty or mis-attributed, dump raw with WDM_WS_DEBUG=1 and file a probe.');
    return textResult(lines.join('\n'));
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
