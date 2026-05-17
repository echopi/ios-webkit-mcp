/**
 * `highlight_node` + `hide_highlight` (batch-13 Should) — visual feedback loop
 * for AI agents picking DOM elements.
 *
 * Probe-confirmed (2026-05-17):
 *   - DOM.highlightNode ✅ (needs valid nodeId)
 *   - DOM.hideHighlight ✅
 *
 * The Apple WIP `DOM.highlightNode` schema differs from CDP — uses
 * `highlightConfig: { contentColor: { r, g, b, a } }` etc. Default config draws
 * a translucent blue overlay that's visible on screen + in screenshots.
 */
import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface DomDocResult { root: { nodeId: number } }
interface DomQsResult { nodeId: number }

const DEFAULT_HIGHLIGHT = {
  showInfo: true,
  contentColor:  { r: 111, g: 168, b: 220, a: 0.4 },
  paddingColor:  { r: 147, g: 196, b: 125, a: 0.4 },
  borderColor:   { r: 255, g: 229, b: 153, a: 0.4 },
  marginColor:   { r: 246, g: 178, b: 107, a: 0.4 },
};

export const highlightNodeTool = {
  name: 'highlight_node',
  description: [
    'Visually highlight a DOM element on the inspected iOS WebView page via WIP `DOM.highlightNode` (✅ probe 2026-05-17).',
    'Useful for "AI selected this element — let me confirm visually" loops. The highlight overlay is visible both on the device screen and in subsequent `take_screenshot` results.',
    'Pair with `hide_highlight` to clear, or call again with a different selector to switch target. Highlight clears automatically when the page navigates.',
  ].join(' '),

  inputSchema: {
    selector: z.string().min(1).describe('CSS selector of the element to highlight (first match used).'),
    showInfo: z
      .boolean()
      .optional()
      .describe('Overlay show width × height + tag tooltip (default true).'),
  },

  handler: async ({ selector, showInfo = true }: { selector: string; showInfo?: boolean }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }

    let rootId: number;
    try {
      const doc = await ps.session.send<DomDocResult>('DOM.getDocument', { depth: 0 }, 10_000);
      rootId = doc.root.nodeId;
    } catch (e) { return errorResult(`DOM.getDocument failed: ${describe(e)}`); }

    let nodeId: number;
    try {
      const r = await ps.session.send<DomQsResult>('DOM.querySelector', { nodeId: rootId, selector }, 10_000);
      if (r.nodeId === 0) return textResult(`# highlight_node — 0 nodes match \`${selector}\``);
      nodeId = r.nodeId;
    } catch (e) { return errorResult(`DOM.querySelector failed: ${describe(e)}`); }

    try {
      await ps.session.send('DOM.highlightNode', { highlightConfig: { ...DEFAULT_HIGHLIGHT, showInfo }, nodeId }, 5_000);
    } catch (e) { return errorResult(`DOM.highlightNode failed: ${describe(e)}`); }

    return textResult(`# highlight_node ✓ \`${selector}\` (nodeId=${nodeId})\n\nOverlay visible on device + screenshots. Call \`hide_highlight\` to clear.`);
  },
};

export const hideHighlightTool = {
  name: 'hide_highlight',
  description: 'Clear any active DOM highlight overlay via WIP `DOM.hideHighlight` (✅ probe 2026-05-17). Safe to call unconditionally — no-op if nothing was highlighted.',
  inputSchema: {},
  handler: async () => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    try { await ps.session.send('DOM.hideHighlight', {}, 5_000); }
    catch (e) { return errorResult(`DOM.hideHighlight failed: ${describe(e)}`); }
    return textResult('# hide_highlight ✓');
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
