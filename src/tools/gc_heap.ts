import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const gcHeapTool = {
  name: 'gc_heap',
  description: [
    'Force JavaScript garbage collection via WIP `Heap.gc` (Apple-specific, probe-confirmed 2026-05-16).',
    'Useful before `take_memory_snapshot` to surface only "live" objects, or to confirm objects are eligible for GC after closing modals / unmounting components.',
    'Optionally measure heap size delta via `Runtime.evaluate("performance.memory")` (Apple WebKit exposes a Chrome-compatible `performance.memory.usedJSHeapSize`).',
  ].join(' '),

  inputSchema: {
    measureDelta: z.boolean().optional().describe('Read `performance.memory.usedJSHeapSize` before + after gc and report the delta. Default true.'),
  },

  handler: async ({ measureDelta = true }: { measureDelta?: boolean }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }

    let before: number | null = null;
    let after: number | null = null;
    if (measureDelta) {
      try {
        const r = await ps.session.send<{ result: { value: number } }>('Runtime.evaluate', {
          expression: '(performance.memory && performance.memory.usedJSHeapSize) || -1',
          returnByValue: true,
        }, 5_000);
        before = r?.result?.value ?? null;
      } catch {}
    }

    try { await ps.session.send('Heap.gc', undefined, 30_000); }
    catch (e) { return errorResult(`Heap.gc failed: ${describe(e)}`); }

    if (measureDelta) {
      try {
        const r = await ps.session.send<{ result: { value: number } }>('Runtime.evaluate', {
          expression: '(performance.memory && performance.memory.usedJSHeapSize) || -1',
          returnByValue: true,
        }, 5_000);
        after = r?.result?.value ?? null;
      } catch {}
    }

    const lines = [`# gc_heap ✓`, ''];
    if (before != null && after != null && before > 0 && after > 0) {
      const fmt = (n: number) => `${(n / 1024 / 1024).toFixed(2)} MB`;
      const delta = after - before;
      lines.push(`heap usedJSHeapSize: ${fmt(before)} → ${fmt(after)} (Δ ${delta >= 0 ? '+' : ''}${fmt(Math.abs(delta))})`);
    } else if (measureDelta) {
      lines.push('⚠ `performance.memory` unavailable on this WebView — delta not measured.');
    }
    lines.push('');
    lines.push('Run `take_memory_snapshot` next for the post-GC heap distribution.');
    return textResult(lines.join('\n'));
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
