/**
 * `get_event_listeners` (batch-13 Must) — list event listeners bound to a DOM
 * node via WIP `DOM.getEventListenersForNode`.
 *
 * Probe-confirmed 2026-05-17 (capability matrix v2): the method exists and
 * returns `-32000 Missing node for given nodeId` when called without a valid
 * id, so chain through DOM.getDocument → querySelector first.
 *
 * Returns one row per listener with type / useCapture / passive / sourceURL +
 * line. Distinguishes inline (set via attribute) vs addEventListener.
 */
import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface DomDocResult { root: { nodeId: number } }
interface DomQsResult { nodeId: number }

interface EventListener {
  type?: string;
  useCapture?: boolean;
  isAttribute?: boolean;
  passive?: boolean;
  once?: boolean;
  scriptId?: string;
  lineNumber?: number;
  columnNumber?: number;
  handlerName?: string;
  nodeId?: number;
  location?: { lineNumber?: number; columnNumber?: number; scriptId?: string };
  [key: string]: unknown;
}
interface ListenersResult { listeners?: EventListener[] }

export const getEventListenersTool = {
  name: 'get_event_listeners',
  description: [
    'List event listeners bound to a DOM node (matched by CSS selector) via WIP `DOM.getEventListenersForNode` (✅ probe 2026-05-17).',
    'Useful to debug "which handler fires on click", catch stale listeners, audit passive/useCapture flags, and find the source script:line of the handler.',
    'Chain: DOM.getDocument → DOM.querySelector → DOM.getEventListenersForNode. Returns first match only (use `query_dom_node` first if you need to disambiguate).',
  ].join(' '),

  inputSchema: {
    selector: z.string().min(1).describe('CSS selector matching exactly one node (first match used).'),
    includeAncestors: z
      .boolean()
      .optional()
      .describe('Walk up parentNode chain and aggregate listeners (default false → target node only). Useful for capture-phase / delegated listeners.'),
  },

  handler: async ({ selector, includeAncestors = false }: { selector: string; includeAncestors?: boolean }) => {
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
      if (r.nodeId === 0) return textResult(`# get_event_listeners — 0 nodes match \`${selector}\``);
      nodeId = r.nodeId;
    } catch (e) { return errorResult(`DOM.querySelector failed: ${describe(e)}`); }

    const queryNodes: number[] = [nodeId];

    if (includeAncestors) {
      // Use Runtime.evaluate to enumerate ancestor nodeIds via the inspector remote object trick.
      // WIP doesn't expose DOM.getParent directly; we walk through getOuterHTML chain via element bridge.
      // Cheaper: iterate up to body via Runtime call returning a list of ancestor selectors → re-query each.
      try {
        const r = await ps.session.send<{ result?: { value?: string[] } }>(
          'Runtime.evaluate',
          {
            expression: `(() => {
              const el = document.querySelector(${JSON.stringify(selector)});
              if (!el) return [];
              const out = [];
              let n = el.parentElement;
              while (n && n !== document.body) {
                let s = n.tagName.toLowerCase();
                if (n.id) s += '#' + CSS.escape(n.id);
                else if (n.className && typeof n.className === 'string') s += '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.');
                out.push(s);
                n = n.parentElement;
              }
              return out;
            })()`,
            returnByValue: true,
          },
          10_000,
        );
        const ancestors = r.result?.value ?? [];
        for (const sel of ancestors) {
          try {
            const q = await ps.session.send<DomQsResult>('DOM.querySelector', { nodeId: rootId, selector: sel }, 5_000);
            if (q.nodeId && q.nodeId !== 0) queryNodes.push(q.nodeId);
          } catch { /* skip ancestor we can't resolve */ }
        }
      } catch (e) {
        return errorResult(`ancestor enumeration failed: ${describe(e)}`);
      }
    }

    const allListeners: Array<{ ownerNodeId: number; ownerLabel: string; listener: EventListener }> = [];
    for (let i = 0; i < queryNodes.length; i++) {
      const nid = queryNodes[i]!;
      try {
        const r = await ps.session.send<ListenersResult>('DOM.getEventListenersForNode', { nodeId: nid }, 10_000);
        const list = r.listeners ?? [];
        const label = i === 0 ? `target (${selector})` : `ancestor[${i}]`;
        for (const l of list) allListeners.push({ ownerNodeId: nid, ownerLabel: label, listener: l });
      } catch (e) {
        // Carry on; some ancestors may legitimately fail.
        if (i === 0) return errorResult(`DOM.getEventListenersForNode failed: ${describe(e)}`);
      }
    }

    if (allListeners.length === 0) {
      return textResult(`# get_event_listeners — \`${selector}\`\n\nNo listeners found on target${includeAncestors ? ' or ancestors' : ''}.`);
    }

    const lines: string[] = [
      `# get_event_listeners — \`${selector}\``,
      '',
      `Listeners: ${allListeners.length}${includeAncestors ? ` (across ${queryNodes.length} nodes)` : ''}`,
      '',
      '| owner | type | capture | passive | once | inline | source |',
      '|---|---|---|---|---|---|---|',
    ];
    for (const { ownerLabel, listener: l } of allListeners) {
      const loc = l.location ?? { scriptId: l.scriptId, lineNumber: l.lineNumber, columnNumber: l.columnNumber };
      const src = loc?.scriptId ? `script ${loc.scriptId}:${loc.lineNumber ?? '?'}:${loc.columnNumber ?? '?'}` : '(unknown)';
      lines.push(
        `| ${ownerLabel} | ${l.type ?? '?'} | ${l.useCapture ? 'Y' : ''} | ${l.passive ? 'Y' : ''} | ${l.once ? 'Y' : ''} | ${l.isAttribute ? 'Y' : ''} | ${src} |`,
      );
    }
    return textResult(lines.join('\n'));
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
