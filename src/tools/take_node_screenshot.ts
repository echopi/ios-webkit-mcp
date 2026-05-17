import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface DomDocResult { root: { nodeId: number } }
interface DomQsResult { nodeId: number }
interface SnapshotResult { dataURL: string }

export const takeNodeScreenshotTool = {
  name: 'take_node_screenshot',
  description: [
    'Capture a screenshot of a specific element on the inspected iOS WebView page via WIP `Page.snapshotNode` (Apple-specific, probe-confirmed 2026-05-16).',
    'Resolves selector → nodeId via `DOM.getDocument` + `DOM.querySelector`, then snapshots the element only (not the surrounding viewport).',
    'Returns base64 PNG. More context-efficient than `take_screenshot` when AI only needs to see one widget.',
  ].join(' '),

  inputSchema: {
    selector: z.string().min(1).describe('CSS selector for the element to screenshot.'),
  },

  handler: async ({ selector }: { selector: string }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }

    let nodeId: number;
    try {
      const doc = await ps.session.send<DomDocResult>('DOM.getDocument', { depth: 0 }, 10_000);
      const qs = await ps.session.send<DomQsResult>('DOM.querySelector', { nodeId: doc.root.nodeId, selector }, 10_000);
      if (qs.nodeId === 0) return errorResult(`# take_node_screenshot — no match for \`${selector}\``);
      nodeId = qs.nodeId;
    } catch (e) { return errorResult(`DOM resolve failed: ${describe(e)}`); }

    let r: SnapshotResult;
    try {
      r = await ps.session.send<SnapshotResult>('Page.snapshotNode', { nodeId }, 30_000);
    } catch (e) { return errorResult(`Page.snapshotNode failed: ${describe(e)}`); }

    if (!r.dataURL?.startsWith('data:image/')) return errorResult(`Unexpected dataURL: ${String(r.dataURL).slice(0, 60)}`);
    const m = r.dataURL.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!m) return errorResult('Unrecognized dataURL format.');
    const mimeType = m[1]!;
    const base64 = m[2]!;
    const sizeKb = Math.round((base64.length * 3) / 4 / 1024);
    return {
      content: [
        { type: 'image' as const, data: base64, mimeType },
        { type: 'text' as const, text: `# take_node_screenshot · ${mimeType} (~${sizeKb} KB)\n\nselector: \`${selector}\` · nodeId: ${nodeId}` },
      ],
    };
  },
};

function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
