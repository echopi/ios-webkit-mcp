/**
 * `analyze_performance` (batch-14 composite tool, cross-review v2.0.1)
 *
 * Runs the "性能三件套" concurrently for a single duration window and emits
 * a cross-correlated report:
 *
 *   - `record_timeline`        → wall-clock event types + hottest entries
 *   - `record_cpu_profile`     → hot JS functions + heap delta
 *   - `record_memory_tracking` → category memory deltas
 *
 * Apple WIP per-target message processing is serialized, but the three
 * tracking domains operate independently — `Timeline.start` / `CPUProfiler.startTracking`
 * / `Memory.startTracking` can coexist on one ws session and their event
 * streams are tagged by domain so the buffers don't collide.
 *
 * The composite output is one markdown document with three sections + a
 * cross-correlation hint footer.
 */
import { z } from 'zod';
import { recordTimelineTool } from './record_timeline.js';
import { recordCpuProfileTool } from './record_cpu_profile.js';
import { recordMemoryTrackingTool } from './record_memory_tracking.js';

interface ToolResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export const analyzePerformanceTool = {
  name: 'analyze_performance',
  description: [
    'Run the performance 三件套 (Timeline + CPU profile + Memory tracking) concurrently for a single duration window and return a cross-correlated report.',
    'Composes `record_timeline` + `record_cpu_profile` + `record_memory_tracking`. The 3 domains run independently on the same ws session — their event streams are tagged by domain so buffers do not collide.',
    'Use when the AI needs a one-shot "what happened during this window" answer rather than 3 separate tool calls. For deeper one-axis dives, call the underlying tools directly.',
  ].join(' '),

  inputSchema: {
    durationMs: z
      .number()
      .int()
      .min(500)
      .max(60_000)
      .optional()
      .describe('Recording window across all three sub-tools (default 3000).'),
    timelineTopN: z.number().int().min(1).max(100).optional().describe('Top-N timeline events (default 10).'),
    cpuTopN: z.number().int().min(1).max(100).optional().describe('Top-N CPU frames (default 10).'),
    interactionHint: z
      .string()
      .optional()
      .describe('Free-text hint shown in the report header — useful for AI memory ("during this window the user scrolled feed for 3s").'),
  },

  handler: async ({
    durationMs = 3_000,
    timelineTopN = 10,
    cpuTopN = 10,
    interactionHint,
  }: { durationMs?: number; timelineTopN?: number; cpuTopN?: number; interactionHint?: string }) => {
    const t0 = Date.now();
    const [tl, cpu, mem] = await Promise.all([
      recordTimelineTool.handler({ durationMs, topN: timelineTopN } as never) as Promise<ToolResult>,
      recordCpuProfileTool.handler({ durationMs, topN: cpuTopN } as never) as Promise<ToolResult>,
      recordMemoryTrackingTool.handler({ durationMs } as never) as Promise<ToolResult>,
    ]);
    const elapsed = Date.now() - t0;

    const tlText = tl.content[0]?.text ?? '(no timeline output)';
    const cpuText = cpu.content[0]?.text ?? '(no cpu output)';
    const memText = mem.content[0]?.text ?? '(no memory output)';

    const lines: string[] = [
      `# analyze_performance ✓ ${durationMs}ms (wall ${elapsed}ms)`,
      '',
    ];
    if (interactionHint) lines.push(`User interaction during window: ${interactionHint}`, '');
    lines.push('## Timeline');
    lines.push(stripTitle(tlText));
    lines.push('');
    lines.push('## CPU Profile');
    lines.push(stripTitle(cpuText));
    lines.push('');
    lines.push('## Memory Tracking');
    lines.push(stripTitle(memText));
    lines.push('');
    lines.push('---');
    lines.push('## Cross-correlation hints');
    lines.push(crossCorrelate(tl, cpu, mem));
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
};

function stripTitle(text: string): string {
  // Remove the leading `# tool_name ✓ ...` line so the composite has only one H1.
  return text.replace(/^# [^\n]*\n+/, '');
}

function crossCorrelate(tl: ToolResult, cpu: ToolResult, mem: ToolResult): string {
  const hints: string[] = [];
  // Try to extract a few signals.
  const tlMatch = tl.content[0]?.text.match(/Total events: (\d+)/);
  const cpuMatch = cpu.content[0]?.text.match(/Samples captured: (\d+)/);
  const memMatch = mem.content[0]?.text.match(/Samples: (\d+)/);
  const heapDelta = cpu.content[0]?.text.match(/JS heap delta: (-?[\d.]+) MB/);
  const memJs = mem.content[0]?.text.match(/^\| javascript \| ([\d.]+) \| ([\d.]+) \| (-?[\d.]+) \| ([-\d.]+%) \|/m);

  if (tlMatch) hints.push(`- ${tlMatch[1]} timeline events captured`);
  if (cpuMatch) hints.push(`- ${cpuMatch[1]} CPU samples captured`);
  if (memMatch) hints.push(`- ${memMatch[1]} memory samples captured`);
  if (heapDelta) hints.push(`- JS heap delta (Runtime.evaluate snapshot): ${heapDelta[1]} MB`);
  if (memJs) hints.push(`- Memory.javascript bucket: ${memJs[1]} MB → ${memJs[2]} MB (Δ ${memJs[3]} MB / ${memJs[4]})`);
  if (heapDelta && memJs) {
    const a = Number(heapDelta[1]);
    const b = Number(memJs[3]);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const skew = Math.abs(a - b);
      hints.push(`- CPU profile heap delta vs Memory.javascript bucket: |Δ| = ${skew.toFixed(2)} MB${skew > 5 ? ' (notable divergence — investigate timing)' : ' (consistent)'}`);
    }
  }
  if (hints.length === 0) {
    hints.push('No quantitative signals captured — the page may have been idle. Re-run while interacting.');
  }
  return hints.join('\n');
}
