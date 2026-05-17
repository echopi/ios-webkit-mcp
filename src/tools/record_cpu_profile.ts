/**
 * `record_cpu_profile` (batch-13 Must) — record an Apple WIP CPU profile.
 *
 * Composes WIP `CPUProfiler.startTracking` + `CPUProfiler.stopTracking` +
 * `ScriptProfiler.startTracking(includeSamples=true)` + `ScriptProfiler.stopTracking`
 * for `durationMs`, plus the lightweight `Runtime.evaluate` `performance.memory`
 * delta as a coarse memory hint. Apple WIP does not return a single normalized
 * profile blob — it streams `*.trackingUpdate` events ending with a `*.trackingComplete`
 * payload that carries the actual samples.
 *
 * Probe-confirmed (capability matrix v2, 2026-05-17):
 *   - CPUProfiler.startTracking / stopTracking ✅
 *   - ScriptProfiler.startTracking({includeSamples:true}) / stopTracking ✅
 *
 * The output summarizes hottest call sites by sample count + samples/total
 * ratio. We don't ship a full v8-style flamegraph yet (Apple's sample format
 * is union-typed); batch-14 will compose with `analyze_performance`.
 */
import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface ScriptSample {
  timestamp?: number;
  stackTrace?: { callFrames?: CallFrame[] };
  [key: string]: unknown;
}
interface CallFrame {
  functionName?: string;
  scriptId?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
}
interface ScriptTrackingUpdate {
  event?: { samples?: { stackTraces?: ScriptSample[] } };
  samples?: ScriptSample[];
  [key: string]: unknown;
}
interface MemoryReading { jsHeapSizeUsed?: number; jsHeapSizeLimit?: number }

export const recordCpuProfileTool = {
  name: 'record_cpu_profile',
  description: [
    'Record a CPU profile for a fixed duration on the inspected iOS WebView page using Apple WIP `CPUProfiler.startTracking` + `ScriptProfiler.startTracking({includeSamples:true})` (✅ probe 2026-05-17).',
    'WIP does NOT expose CDP `Profiler.takePreciseCoverage` — instead samples stream as `ScriptProfiler.trackingUpdate` events. The tool subscribes, runs for `durationMs`, then aggregates samples into hottest call-frame summary.',
    'Pair with `record_timeline` for cross-axis timing breakdown (timeline = wall-clock events; cpu profile = stack-sampled hot paths).',
  ].join(' '),

  inputSchema: {
    durationMs: z
      .number()
      .int()
      .min(200)
      .max(60_000)
      .optional()
      .describe('How long to record (default 3000).'),
    topN: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('Top-N hottest call frames returned (default 20).'),
    includeAnonymous: z
      .boolean()
      .optional()
      .describe('Include frames with empty functionName (anonymous closures). Default true.'),
  },

  handler: async ({
    durationMs = 3_000,
    topN = 20,
    includeAnonymous = true,
  }: { durationMs?: number; topN?: number; includeAnonymous?: boolean }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }

    const samples: ScriptSample[] = [];
    const unsubscribers: Array<() => void> = [];

    unsubscribers.push(ps.session.on('ScriptProfiler.trackingUpdate', (p: unknown) => {
      const params = p as ScriptTrackingUpdate;
      const stacks = params?.event?.samples?.stackTraces ?? params?.samples;
      if (Array.isArray(stacks)) for (const s of stacks) samples.push(s);
    }));
    unsubscribers.push(ps.session.on('ScriptProfiler.trackingComplete', (p: unknown) => {
      const params = p as ScriptTrackingUpdate;
      const stacks = params?.samples ?? params?.event?.samples?.stackTraces;
      if (Array.isArray(stacks)) for (const s of stacks) samples.push(s);
    }));

    let memBefore: MemoryReading | undefined;
    try {
      const r = await ps.session.send<{ result?: { value?: MemoryReading } }>(
        'Runtime.evaluate',
        { expression: '({jsHeapSizeUsed: performance.memory?.usedJSHeapSize, jsHeapSizeLimit: performance.memory?.jsHeapSizeLimit})', returnByValue: true },
        5_000,
      );
      memBefore = r.result?.value;
    } catch { /* not all WebKits expose performance.memory */ }

    try {
      await ps.session.send('CPUProfiler.startTracking', undefined, 5_000);
    } catch (e) {
      unsubscribers.forEach(u => u());
      return errorResult(`CPUProfiler.startTracking failed: ${describe(e)}`);
    }
    try {
      await ps.session.send('ScriptProfiler.startTracking', { includeSamples: true }, 5_000);
    } catch (e) {
      try { await ps.session.send('CPUProfiler.stopTracking', undefined, 5_000); } catch { /* best-effort */ }
      unsubscribers.forEach(u => u());
      return errorResult(`ScriptProfiler.startTracking failed: ${describe(e)}`);
    }

    await new Promise(r => setTimeout(r, durationMs));

    try { await ps.session.send('ScriptProfiler.stopTracking', undefined, 10_000); } catch (e) {
      unsubscribers.forEach(u => u());
      return errorResult(`ScriptProfiler.stopTracking failed: ${describe(e)}`);
    }
    try { await ps.session.send('CPUProfiler.stopTracking', undefined, 10_000); } catch { /* best-effort tail */ }

    // Allow tail trackingComplete events to drain.
    await new Promise(r => setTimeout(r, 200));
    unsubscribers.forEach(u => u());

    let memAfter: MemoryReading | undefined;
    try {
      const r = await ps.session.send<{ result?: { value?: MemoryReading } }>(
        'Runtime.evaluate',
        { expression: '({jsHeapSizeUsed: performance.memory?.usedJSHeapSize, jsHeapSizeLimit: performance.memory?.jsHeapSizeLimit})', returnByValue: true },
        5_000,
      );
      memAfter = r.result?.value;
    } catch { /* skip */ }

    // Aggregate frames.
    const frameCount = new Map<string, { count: number; topSample?: CallFrame }>();
    for (const sample of samples) {
      const top = sample.stackTrace?.callFrames?.[0];
      if (!top) continue;
      const key = `${top.functionName ?? '<anon>'} ${top.url ?? ''}:${top.lineNumber ?? '?'}`;
      if (!includeAnonymous && (!top.functionName || top.functionName === '')) continue;
      const cur = frameCount.get(key) ?? { count: 0, topSample: top };
      cur.count += 1;
      frameCount.set(key, cur);
    }
    const totalSamples = samples.length;
    const top = [...frameCount.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, topN);

    const lines: string[] = [
      `# record_cpu_profile ✓ ${durationMs}ms`,
      '',
      `Samples captured: ${totalSamples}`,
      `Unique top-of-stack frames: ${frameCount.size}`,
    ];
    if (memBefore && memAfter && typeof memBefore.jsHeapSizeUsed === 'number' && typeof memAfter.jsHeapSizeUsed === 'number') {
      const delta = memAfter.jsHeapSizeUsed - memBefore.jsHeapSizeUsed;
      lines.push(`JS heap delta: ${(delta / 1024 / 1024).toFixed(2)} MB (${memBefore.jsHeapSizeUsed} → ${memAfter.jsHeapSizeUsed} bytes)`);
    }

    if (totalSamples === 0) {
      lines.push('');
      lines.push('⚠ No samples captured. Possible causes:');
      lines.push('- Page idle during recording — interact with it (scroll / tap) and re-record.');
      lines.push('- ScriptProfiler.trackingUpdate event schema differs on this iOS build — file a probe issue.');
      lines.push('- includeSamples=true unsupported (rare, capability matrix says ✅).');
    } else if (top.length > 0) {
      lines.push('');
      lines.push(`## Top ${top.length} hottest frames`);
      lines.push('| samples | % | function | source |');
      lines.push('|---|---|---|---|');
      for (const [key, { count, topSample }] of top) {
        const pct = ((count / totalSamples) * 100).toFixed(1);
        const fn = topSample?.functionName || '<anonymous>';
        const src = topSample?.url
          ? `${topSample.url}:${topSample.lineNumber ?? '?'}:${topSample.columnNumber ?? '?'}`
          : '(no source)';
        lines.push(`| ${count} | ${pct}% | \`${fn}\` | ${src.replace(/\|/g, '\\|')} |`);
        void key;
      }
    }
    lines.push('');
    lines.push('⚠ Apple WIP CPU sample format is union-typed across iOS builds. If samples look empty or mis-attributed, set `WDM_WS_DEBUG=1` to dump raw `ScriptProfiler.trackingUpdate` payloads to stderr for schema inspection.');
    return textResult(lines.join('\n'));
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
