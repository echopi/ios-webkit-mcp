import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface DomDocResult { root: { nodeId: number } }
interface DomQsResult { nodeId: number }

export const setOuterHtmlTool = {
  name: 'set_outer_html',
  description: [
    'Replace an element\'s outerHTML in place on the inspected iOS WebView page via WIP `DOM.setOuterHTML` (Apple-specific, probe-confirmed 2026-05-16).',
    'Resolves selector → nodeId via `DOM.getDocument` + `DOM.querySelector` then sets new HTML. Useful for fix-in-place experiments (test a CSS tweak / fix a typo without reload).',
    'WARNING: mutates the live DOM — if the page later re-renders via React/Vue/Lynx, your patch is lost. Treat as a one-shot probe, not a persistent fix.',
  ].join(' '),

  inputSchema: {
    selector: z.string().min(1).describe('CSS selector for the element to replace.'),
    outerHTML: z.string().describe('New outerHTML to substitute in. Must be a single root element.'),
  },

  handler: async ({ selector, outerHTML }: { selector: string; outerHTML: string }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }

    let nodeId: number;
    try {
      const doc = await ps.session.send<DomDocResult>('DOM.getDocument', { depth: 0 }, 10_000);
      const qs = await ps.session.send<DomQsResult>('DOM.querySelector', { nodeId: doc.root.nodeId, selector }, 10_000);
      if (qs.nodeId === 0) return errorResult(`# set_outer_html — no match for \`${selector}\``);
      nodeId = qs.nodeId;
    } catch (e) { return errorResult(`DOM resolve failed: ${describe(e)}`); }

    try { await ps.session.send('DOM.setOuterHTML', { nodeId, outerHTML }, 10_000); }
    catch (e) { return errorResult(`DOM.setOuterHTML failed: ${describe(e)}`); }

    return textResult(
      [
        `# set_outer_html ✓`,
        '',
        `selector: \`${selector}\` (nodeId=${nodeId})`,
        `new HTML: ${outerHTML.length} bytes`,
        '',
        '⚠ Live DOM mutated. If the page re-renders via framework, your patch will be overwritten. For persistent patches use `set_init_script`.',
      ].join('\n'),
    );
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
