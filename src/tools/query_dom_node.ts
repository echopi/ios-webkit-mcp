import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface DomDocResult { root: { nodeId: number } }
interface DomQsResult { nodeId: number }
interface DomQsaResult { nodeIds: number[] }
interface DomOuterResult { outerHTML: string }

export const queryDomNodeTool = {
  name: 'query_dom_node',
  description: [
    'Query and serialize matching DOM nodes on the inspected iOS WebView page via WIP `DOM.querySelector(All)` + `DOM.getOuterHTML`.',
    'Targeted alternative to `take_snapshot` (which dumps whole document). Useful when the AI needs only a specific element\'s HTML — saves context and lets you scope inspection.',
    'Probe-confirmed chain (2026-05-16): `DOM.getDocument` → `DOM.querySelector` / `DOM.querySelectorAll` → `DOM.getOuterHTML`. `DOM.enable` is NOT required.',
  ].join(' '),

  inputSchema: {
    selector: z.string().min(1).describe('CSS selector to query.'),
    mode: z
      .enum(['first', 'all'])
      .optional()
      .describe('`first` (default) = querySelector single match; `all` = querySelectorAll multiple matches.'),
    maxMatches: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('When mode=all, cap returned matches (default 20).'),
    perNodeMaxLen: z
      .number()
      .int()
      .min(100)
      .max(100_000)
      .optional()
      .describe('Per-node outerHTML truncation cap (default 4000).'),
  },

  handler: async ({
    selector,
    mode = 'first',
    maxMatches = 20,
    perNodeMaxLen = 4_000,
  }: { selector: string; mode?: 'first' | 'all'; maxMatches?: number; perNodeMaxLen?: number }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    let rootId: number;
    try {
      const doc = await ps.session.send<DomDocResult>('DOM.getDocument', { depth: 0 }, 10_000);
      rootId = doc.root.nodeId;
    } catch (e) {
      return errorResult(`DOM.getDocument failed: ${describe(e)}`);
    }

    let nodeIds: number[] = [];
    try {
      if (mode === 'first') {
        const r = await ps.session.send<DomQsResult>('DOM.querySelector', { nodeId: rootId, selector }, 10_000);
        if (r.nodeId === 0) {
          return textResult(`# query_dom_node — 0 matches for \`${selector}\``);
        }
        nodeIds = [r.nodeId];
      } else {
        const r = await ps.session.send<DomQsaResult>('DOM.querySelectorAll', { nodeId: rootId, selector }, 10_000);
        nodeIds = (r.nodeIds || []).slice(0, maxMatches);
      }
    } catch (e) {
      return errorResult(`DOM.querySelector${mode === 'all' ? 'All' : ''} failed: ${describe(e)}`);
    }

    const lines: string[] = [
      `# query_dom_node — \`${selector}\` (mode=${mode})`,
      '',
      `Matches: ${nodeIds.length}${mode === 'all' && nodeIds.length === maxMatches ? ` (capped at ${maxMatches})` : ''}`,
      '',
    ];

    for (let i = 0; i < nodeIds.length; i++) {
      const nodeId = nodeIds[i]!;
      let html: string;
      try {
        const r = await ps.session.send<DomOuterResult>('DOM.getOuterHTML', { nodeId }, 10_000);
        html = r.outerHTML ?? '';
      } catch (e) {
        lines.push(`## [${i + 1}] nodeId=${nodeId} — getOuterHTML failed: ${describe(e)}`);
        lines.push('');
        continue;
      }
      const truncated = html.length > perNodeMaxLen
        ? html.slice(0, perNodeMaxLen) + `\n… (truncated, full length ${html.length})`
        : html;
      lines.push(`## [${i + 1}] nodeId=${nodeId} · ${html.length} bytes`);
      lines.push('```html');
      lines.push(truncated);
      lines.push('```');
      lines.push('');
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
