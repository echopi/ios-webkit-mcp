import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface DomNode {
  nodeId?: number;
  nodeType?: number;
  nodeName?: string;
  localName?: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
  contentDocument?: DomNode;
  shadowRoots?: DomNode[];
}

export const takeSnapshotTool = {
  name: 'take_snapshot',
  description: [
    'Capture a DOM snapshot of the inspected iOS WebView page.',
    'Wraps WIP `DOM.getDocument` with optional depth + pierce (shadow DOM / iframes).',
    'Returns a compact markdown outline by default. Set `format=raw_json` to get the full DOM tree JSON.',
  ].join(' '),

  inputSchema: {
    depth: z
      .number()
      .int()
      .min(-1)
      .max(20)
      .optional()
      .describe('Recursion depth. -1 = full tree (default), 1 = root only.'),
    pierce: z
      .boolean()
      .optional()
      .describe('Include shadow DOM and iframe content (default true).'),
    format: z
      .enum(['outline', 'raw_json'])
      .optional()
      .describe('Output format: `outline` (default, compact tree) or `raw_json` (full DOM.getDocument result).'),
    maxNodes: z
      .number()
      .int()
      .min(10)
      .max(2_000)
      .optional()
      .describe('In outline mode, cap nodes rendered (default 200).'),
  },

  handler: async ({
    depth = -1,
    pierce = true,
    format = 'outline',
    maxNodes = 200,
  }: {
    depth?: number;
    pierce?: boolean;
    format?: 'outline' | 'raw_json';
    maxNodes?: number;
  }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    let result: { root: DomNode };
    try {
      result = await ps.session.send<{ root: DomNode }>('DOM.getDocument', { depth, pierce }, 20_000);
    } catch (e) {
      return errorResult(`DOM.getDocument failed: ${describe(e)}`);
    }

    if (format === 'raw_json') {
      return textResult('```json\n' + JSON.stringify(result, null, 2) + '\n```');
    }

    const lines: string[] = [];
    lines.push(`# DOM snapshot`);
    lines.push('');
    if (ps.attachInfo) {
      lines.push(`Page: \`${ps.attachInfo.pageTitle || ps.attachInfo.pageUrl}\` (page id ${ps.attachInfo.pageId})`);
      lines.push('');
    }

    const outline: string[] = [];
    const ctx = { count: 0, cap: maxNodes };
    renderNode(result.root, 0, outline, ctx);
    if (ctx.count >= ctx.cap) {
      outline.push(`… (truncated at ${ctx.cap} nodes; use \`format: "raw_json"\` for full tree)`);
    }

    lines.push('```');
    lines.push(...outline);
    lines.push('```');

    return textResult(lines.join('\n'));
  },
};

function renderNode(node: DomNode | undefined, indent: number, out: string[], ctx: { count: number; cap: number }): void {
  if (!node) return;
  if (ctx.count >= ctx.cap) return;
  ctx.count++;
  const pad = '  '.repeat(indent);

  if (node.nodeType === 3) {
    // text
    const text = (node.nodeValue ?? '').trim();
    if (text) {
      const truncated = text.length > 80 ? text.slice(0, 80) + '…' : text;
      out.push(`${pad}"${truncated.replace(/"/g, '\\"')}"`);
    }
    return;
  }
  if (node.nodeType === 8) {
    out.push(`${pad}<!-- ${(node.nodeValue ?? '').slice(0, 80)} -->`);
    return;
  }

  const name = (node.localName ?? node.nodeName ?? '?').toLowerCase();
  const attrs = renderAttrs(node.attributes);
  out.push(`${pad}<${name}${attrs}>`);

  if (node.children) {
    for (const c of node.children) {
      renderNode(c, indent + 1, out, ctx);
    }
  }
  if (node.contentDocument) renderNode(node.contentDocument, indent + 1, out, ctx);
  if (node.shadowRoots) {
    for (const r of node.shadowRoots) {
      out.push(`${'  '.repeat(indent + 1)}#shadow-root`);
      renderNode(r, indent + 2, out, ctx);
    }
  }
}

function renderAttrs(arr: string[] | undefined): string {
  if (!arr || arr.length === 0) return '';
  const pairs: string[] = [];
  for (let i = 0; i < arr.length; i += 2) {
    const k = arr[i];
    const v = arr[i + 1];
    if (k == null) continue;
    if (k === 'class' || k === 'id') {
      pairs.push(`${k}="${(v ?? '').slice(0, 80)}"`);
    } else if (k === 'src' || k === 'href') {
      const short = (v ?? '').slice(0, 60);
      pairs.push(`${k}="${short}${(v?.length ?? 0) > 60 ? '…' : ''}"`);
    } else {
      // Skip noisy attrs in outline mode (style/data-*); keep tag terse.
      if (k.startsWith('data-') || k === 'style') continue;
      pairs.push(`${k}${v ? `="${(v ?? '').slice(0, 40)}"` : ''}`);
    }
  }
  return pairs.length > 0 ? ' ' + pairs.join(' ') : '';
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
