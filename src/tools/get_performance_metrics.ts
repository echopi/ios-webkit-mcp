import { z } from 'zod';
import { PageSession } from '../page-session.js';

/**
 * WIP has no `Tracing.*` / `Performance.getMetrics` domain, so chrome-devtools-mcp's
 * `performance_start_trace` / `performance_analyze_insight` are unimplementable.
 * However the JavaScript `PerformanceObserver` + `performance.getEntriesByType` APIs
 * are available inside the WebView. This tool reads them via `Runtime.evaluate`
 * and returns structured metrics — a JS-side approximation that covers the
 * majority of the chrome-devtools-mcp Performance use cases (navigation timing,
 * paint timing, LCP, CLS, slow resources).
 */
export const getPerformanceMetricsTool = {
  name: 'get_performance_metrics',
  description: [
    'Read JavaScript-side performance metrics from the inspected iOS WebView page.',
    'NOTE: WIP has no `Tracing.*` or `Performance.getMetrics` domain (chrome-devtools-mcp\'s `performance_*` tools are unimplementable on iOS). This tool wraps `performance.getEntriesByType` for: navigation timing, paint (FP/FCP), Largest Contentful Paint, Cumulative Layout Shift, and slow resources.',
    'All values come from W3C Performance APIs — they reflect the current page state, not a freshly recorded trace. To capture metrics after an interaction, reload + interact + call again.',
  ].join(' '),

  inputSchema: {
    slowResourceMs: z
      .number()
      .int()
      .min(0)
      .max(60_000)
      .optional()
      .describe('Resource entries with `duration` ≥ this many ms are flagged as slow (default 500). Set 0 to include all.'),
    resourceLimit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Cap slow-resource entries returned (default 30).'),
  },

  handler: async ({
    slowResourceMs = 500,
    resourceLimit = 30,
  }: { slowResourceMs?: number; resourceLimit?: number }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    const expression = `
      (() => {
        const out = { navigation: null, paint: [], lcp: null, cls: null, layoutShifts: 0, slowResources: [], counts: {} };
        try {
          const nav = performance.getEntriesByType('navigation')[0];
          if (nav) {
            out.navigation = {
              type: nav.type,
              startTime: nav.startTime,
              fetchStart: nav.fetchStart,
              domainLookup: { start: nav.domainLookupStart, end: nav.domainLookupEnd, ms: nav.domainLookupEnd - nav.domainLookupStart },
              connect: { start: nav.connectStart, end: nav.connectEnd, ms: nav.connectEnd - nav.connectStart },
              tls: nav.secureConnectionStart > 0 ? { start: nav.secureConnectionStart, end: nav.connectEnd, ms: nav.connectEnd - nav.secureConnectionStart } : null,
              request: { start: nav.requestStart, ms: nav.responseStart - nav.requestStart },
              response: { start: nav.responseStart, end: nav.responseEnd, ms: nav.responseEnd - nav.responseStart },
              dom: { interactive: nav.domInteractive, contentLoaded: nav.domContentLoadedEventEnd, complete: nav.domComplete },
              loadEvent: { start: nav.loadEventStart, end: nav.loadEventEnd, ms: nav.loadEventEnd - nav.loadEventStart },
              transferSize: nav.transferSize,
              encodedBodySize: nav.encodedBodySize,
              decodedBodySize: nav.decodedBodySize,
            };
          }
        } catch (e) { out.navigation = { error: String(e) }; }
        try {
          out.paint = performance.getEntriesByType('paint').map(p => ({ name: p.name, startTime: p.startTime }));
        } catch (e) {}
        try {
          const lcps = performance.getEntriesByType('largest-contentful-paint');
          if (lcps.length) {
            const last = lcps[lcps.length - 1];
            out.lcp = { startTime: last.startTime, renderTime: last.renderTime, size: last.size, url: last.url, element: last.element && last.element.tagName };
          }
        } catch (e) {}
        try {
          const shifts = performance.getEntriesByType('layout-shift') || [];
          let sum = 0; for (const s of shifts) if (!s.hadRecentInput) sum += s.value;
          out.cls = sum; out.layoutShifts = shifts.length;
        } catch (e) {}
        try {
          const res = performance.getEntriesByType('resource');
          out.counts.resources = res.length;
          const slow = res.filter(r => r.duration >= ${slowResourceMs}).sort((a, b) => b.duration - a.duration).slice(0, ${resourceLimit});
          out.slowResources = slow.map(r => ({
            name: r.name, initiator: r.initiatorType, duration: r.duration, startTime: r.startTime,
            transferSize: r.transferSize, encodedBodySize: r.encodedBodySize, nextHopProtocol: r.nextHopProtocol,
          }));
        } catch (e) {}
        try { out.counts.measures = performance.getEntriesByType('measure').length; } catch (e) {}
        try { out.counts.marks = performance.getEntriesByType('mark').length; } catch (e) {}
        return out;
      })()
    `;

    let result;
    try {
      result = await ps.session.send<{ result: { value: unknown } }>(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: false },
        15_000,
      );
    } catch (e) {
      return errorResult(`Runtime.evaluate (get_performance_metrics) failed: ${describe(e)}`);
    }

    const v = result?.result?.value as Record<string, unknown> | undefined;
    if (!v || typeof v !== 'object') {
      return errorResult(`# get_performance_metrics: unexpected return\n\n${JSON.stringify(result?.result)}`);
    }

    const lines: string[] = [`# get_performance_metrics`, ''];
    const nav = v.navigation as Record<string, unknown> | null;
    if (nav && !nav.error) {
      lines.push('## navigation timing');
      lines.push(`- type: ${nav.type}`);
      const fmt = (g: Record<string, unknown> | null | undefined, label: string) => g ? `- ${label}: ${(g.ms as number).toFixed(1)} ms` : null;
      const segs = [
        fmt(nav.domainLookup as Record<string, unknown>, 'DNS'),
        fmt(nav.connect as Record<string, unknown>, 'TCP connect'),
        fmt(nav.tls as Record<string, unknown>, 'TLS'),
        fmt(nav.request as Record<string, unknown>, 'request (TTFB)'),
        fmt(nav.response as Record<string, unknown>, 'response download'),
        fmt(nav.loadEvent as Record<string, unknown>, 'load event'),
      ].filter(Boolean);
      lines.push(...(segs as string[]));
      const dom = nav.dom as Record<string, number>;
      lines.push(`- DOM interactive: ${dom.interactive.toFixed(1)} ms · contentLoaded: ${dom.contentLoaded.toFixed(1)} ms · complete: ${dom.complete.toFixed(1)} ms`);
      lines.push(`- transfer: encoded ${nav.encodedBodySize} B / decoded ${nav.decodedBodySize} B / transfer ${nav.transferSize} B`);
    } else if (nav && nav.error) {
      lines.push('## navigation timing');
      lines.push(`⚠ ${nav.error as string}`);
    } else {
      lines.push('## navigation timing');
      lines.push('(no navigation entry — page may not have a full navigation, e.g. SPA route change)');
    }

    const paint = v.paint as Array<{ name: string; startTime: number }>;
    if (paint?.length) {
      lines.push('');
      lines.push('## paint');
      paint.forEach(p => lines.push(`- ${p.name}: ${p.startTime.toFixed(1)} ms`));
    }

    const lcp = v.lcp as Record<string, unknown> | null;
    if (lcp) {
      lines.push('');
      lines.push('## Largest Contentful Paint');
      lines.push(`- startTime: ${(lcp.startTime as number).toFixed(1)} ms${lcp.renderTime ? ` (render ${(lcp.renderTime as number).toFixed(1)} ms)` : ''}`);
      if (lcp.element) lines.push(`- element: <${lcp.element as string}>`);
      if (lcp.url) lines.push(`- url: ${lcp.url as string}`);
      if (lcp.size != null) lines.push(`- size (px²): ${lcp.size}`);
    }

    if (v.cls != null) {
      lines.push('');
      lines.push(`## Cumulative Layout Shift: ${(v.cls as number).toFixed(4)} (${v.layoutShifts as number} shift entries)`);
    }

    const counts = v.counts as Record<string, number>;
    lines.push('');
    lines.push(`## counts: ${counts.resources ?? 0} resources · ${counts.marks ?? 0} marks · ${counts.measures ?? 0} measures`);

    const slow = v.slowResources as Array<Record<string, unknown>>;
    if (slow?.length) {
      lines.push('');
      lines.push(`## slow resources (≥ ${slowResourceMs}ms, top ${slow.length})`);
      lines.push('| duration | initiator | size | url |');
      lines.push('|---|---|---|---|');
      for (const r of slow) {
        lines.push(`| ${(r.duration as number).toFixed(0)} ms | ${r.initiator ?? '?'} | ${r.transferSize ?? '?'} B | ${(r.name as string).slice(0, 80)} |`);
      }
    } else {
      lines.push(`(no resources with duration ≥ ${slowResourceMs}ms)`);
    }

    lines.push('');
    lines.push('⚠ JS-side approximation — no CPU sampling, no flame-graph, no rendering pipeline breakdown (would need `Tracing.*` which WIP lacks). For CPU profiles consider `take_memory_snapshot` (heap) or run a Safari Web Inspector Timeline session via the macOS UI.');

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
