import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface HeapSnapshotResult {
  timestamp: number;
  snapshotData: string; // JSON string in Apple's Inspector heap format
}

export const takeMemorySnapshotTool = {
  name: 'take_memory_snapshot',
  description: [
    'Capture a JavaScript heap snapshot from the inspected iOS WebView page using WIP `Heap.snapshot`.',
    'IMPORTANT: The snapshot is in **Apple Inspector heap format** (`{version, type, nodes, edges, …}`), NOT the V8 / Chrome `.heapsnapshot` format. Tools that ingest CDP `HeapProfiler.takeHeapSnapshot` output will not understand this directly.',
    'Returns a summary (node count, edge count, root count) plus optionally the raw JSON.',
  ].join(' '),

  inputSchema: {
    includeRaw: z
      .boolean()
      .optional()
      .describe('Include the full raw `snapshotData` JSON in output (large; default false — only summary).'),
    maxRawChars: z
      .number()
      .int()
      .min(1_000)
      .max(2_000_000)
      .optional()
      .describe('Cap raw JSON output length when includeRaw=true (default 50_000, truncated with "…" marker).'),
  },

  handler: async ({
    includeRaw = false,
    maxRawChars = 50_000,
  }: { includeRaw?: boolean; maxRawChars?: number }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    let result: HeapSnapshotResult;
    try {
      result = await ps.session.send<HeapSnapshotResult>('Heap.snapshot', {}, 60_000);
    } catch (e) {
      return errorResult(`Heap.snapshot failed: ${describe(e)}`);
    }

    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = JSON.parse(result.snapshotData) as Record<string, unknown>;
    } catch {
      // raw output may not be JSON in some unforeseen cases
    }

    const lines: string[] = [];
    lines.push(`# take_memory_snapshot`);
    lines.push('');
    if (ps.attachInfo) {
      lines.push(`Target: page id ${ps.attachInfo.pageId} (${ps.attachInfo.pageTitle || ps.attachInfo.pageUrl})`);
    }
    lines.push(`Timestamp (WIP): ${result.timestamp}`);
    lines.push(`Raw size: ${result.snapshotData.length} chars`);

    if (parsed) {
      const nodes = Array.isArray(parsed['nodes']) ? (parsed['nodes'] as unknown[]).length : '(unknown)';
      const edges = Array.isArray(parsed['edges']) ? (parsed['edges'] as unknown[]).length : '(unknown)';
      const roots = Array.isArray(parsed['roots']) ? (parsed['roots'] as unknown[]).length : '(unknown)';
      const version = parsed['version'];
      const type = parsed['type'];
      lines.push(`Format: ${type ?? '(unknown type)'} v${version ?? '?'}`);
      lines.push(`Nodes: ${nodes} · Edges: ${edges} · Roots: ${roots}`);
    } else {
      lines.push('(snapshotData was not parseable JSON — content shown below as-is)');
    }
    lines.push('');
    lines.push('⚠ Apple Inspector heap format — NOT V8 `.heapsnapshot`. Chrome DevTools cannot load this directly.');

    if (includeRaw) {
      lines.push('');
      lines.push('## Raw snapshotData');
      lines.push('```json');
      lines.push(
        result.snapshotData.length > maxRawChars
          ? result.snapshotData.slice(0, maxRawChars) + `…\n(truncated, ${result.snapshotData.length - maxRawChars} more chars)`
          : result.snapshotData,
      );
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
