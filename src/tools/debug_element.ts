/**
 * `debug_element` (batch-14 composite) — one-call deep-dive on a DOM element.
 *
 * Combines:
 *   - `query_dom_node` (selector → outerHTML)
 *   - `get_event_listeners` (selector → bound handlers)
 *   - `take_node_screenshot` (selector → PNG dataURL preview, optional)
 *   - `highlight_node` (selector → visual overlay, optional)
 *
 * Useful when an AI agent says "what is this `.feed-item` doing?" and wants
 * one consolidated answer instead of 4 round-trips.
 */
import { z } from 'zod';
import { queryDomNodeTool } from './query_dom_node.js';
import { getEventListenersTool } from './get_event_listeners.js';
import { takeNodeScreenshotTool } from './take_node_screenshot.js';
import { highlightNodeTool } from './highlight_node.js';

interface ToolResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

export const debugElementTool = {
  name: 'debug_element',
  description: [
    'Run a one-shot deep-dive on a DOM element matching `selector`: outerHTML + event listeners + optional screenshot + optional highlight.',
    'Composes `query_dom_node` + `get_event_listeners` (+ `take_node_screenshot`/`highlight_node` if requested) into a single markdown report — saves the AI 3-4 round-trips when investigating "what is this element doing?".',
  ].join(' '),
  inputSchema: {
    selector: z.string().min(1).describe('CSS selector. First match used.'),
    perNodeMaxLen: z.number().int().min(100).max(50_000).optional().describe('Truncation cap on outerHTML (default 4000).'),
    withScreenshot: z.boolean().optional().describe('Capture node screenshot (default false — bandwidth heavy).'),
    withHighlight: z.boolean().optional().describe('Apply visible highlight overlay so the user/AI can verify the picked element on screen (default false; remember to call hide_highlight later).'),
    includeAncestors: z.boolean().optional().describe('Walk parent chain in event listener enumeration (default false).'),
  },
  handler: async ({
    selector,
    perNodeMaxLen = 4_000,
    withScreenshot = false,
    withHighlight = false,
    includeAncestors = false,
  }: { selector: string; perNodeMaxLen?: number; withScreenshot?: boolean; withHighlight?: boolean; includeAncestors?: boolean }) => {
    // DOM-touching sub-tools must NOT run in parallel — Apple WIP `DOM.getDocument`
    // bumps node generation, invalidating concurrent nodeId lookups. Serialize them.
    const domR = (await queryDomNodeTool.handler({ selector, mode: 'first', perNodeMaxLen } as never)) as ToolResult;
    const evtR = (await getEventListenersTool.handler({ selector, includeAncestors } as never)) as ToolResult;
    const results: ToolResult[] = [domR, evtR];
    if (withScreenshot) results.push((await takeNodeScreenshotTool.handler({ selector } as never)) as ToolResult);
    if (withHighlight) results.push((await highlightNodeTool.handler({ selector } as never)) as ToolResult);
    const lines: string[] = [`# debug_element ✓ \`${selector}\``, ''];
    lines.push('## DOM');
    lines.push(stripTitle(domR!.content[0]?.text ?? '(no dom output)'));
    lines.push('');
    lines.push('## Event Listeners');
    lines.push(stripTitle(evtR!.content[0]?.text ?? '(no listeners output)'));
    let next = 2;
    if (withScreenshot) {
      lines.push('');
      lines.push('## Screenshot');
      lines.push(stripTitle(results[next]!.content[0]?.text ?? '(no screenshot)'));
      next += 1;
    }
    if (withHighlight) {
      lines.push('');
      lines.push('## Highlight');
      lines.push(stripTitle(results[next]!.content[0]?.text ?? '(no highlight)'));
      lines.push('⚠ Remember to call `hide_highlight` to clear the overlay when done.');
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
};

function stripTitle(text: string): string {
  return text.replace(/^# [^\n]*\n+/, '');
}
