import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const hoverTool = {
  name: 'hover',
  description: [
    'Dispatch hover-style pointer events (`pointerover` + `mouseover` + `pointermove` + `mousemove` + `pointerenter` + `mouseenter`) on an element on the inspected iOS WebView page.',
    'NOTE: WIP has no `Input.dispatchMouseEvent`. Synthetic Events via `Runtime.evaluate` — `isTrusted=false`, native :hover styles still apply because the events flow through normal DOM bubbling, but underlying iOS WebKit hit-testing is NOT involved (no real mouse cursor on touch devices).',
    'Selector matches via `document.querySelectorAll(selector)[nth]`. Coordinates default to the element\'s center.',
  ].join(' '),

  inputSchema: {
    selector: z.string().min(1).describe('CSS selector for the element to hover.'),
    nth: z.number().int().min(0).optional().describe('Pick the Nth match. Default 0.'),
    waitAfterMs: z.number().int().min(0).max(10_000).optional().describe('Block after hover for this long (default 100).'),
  },

  handler: async ({
    selector,
    nth = 0,
    waitAfterMs = 100,
  }: { selector: string; nth?: number; waitAfterMs?: number }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    const selJson = JSON.stringify(selector);
    const expression = `
      (() => {
        const matches = document.querySelectorAll(${selJson});
        if (matches.length === 0) return { ok: false, reason: 'no_match', selector: ${selJson} };
        if (${nth} >= matches.length) return { ok: false, reason: 'nth_out_of_range', found: matches.length };
        const el = matches[${nth}];
        const rect = el.getBoundingClientRect();
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const tag = el.tagName.toLowerCase();
        const visible = rect.width > 0 && rect.height > 0;
        const init = {
          bubbles: true, cancelable: true,
          clientX: cx, clientY: cy,
          pointerType: 'mouse', pointerId: 1, isPrimary: true,
          button: 0, buttons: 0,
        };
        try {
          el.dispatchEvent(new PointerEvent('pointerover', init));
          el.dispatchEvent(new MouseEvent('mouseover', init));
          el.dispatchEvent(new PointerEvent('pointerenter', init));
          el.dispatchEvent(new MouseEvent('mouseenter', init));
          el.dispatchEvent(new PointerEvent('pointermove', init));
          el.dispatchEvent(new MouseEvent('mousemove', init));
        } catch (e) {
          return { ok: false, reason: 'dispatch_threw', error: String(e), tag };
        }
        return { ok: true, tag, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, visible, foundCount: matches.length };
      })()
    `;

    let result;
    try {
      result = await ps.session.send<{ result: { value: unknown } }>(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: false },
        10_000,
      );
    } catch (e) {
      return errorResult(`Runtime.evaluate (hover) failed: ${describe(e)}`);
    }

    if (waitAfterMs > 0) {
      await new Promise(r => setTimeout(r, waitAfterMs));
    }

    const v = result?.result?.value as Record<string, unknown> | undefined;
    if (!v || v.ok !== true) {
      return errorResult(`# hover: failed\n\nselector: \`${selector}\`\n\n${JSON.stringify(v)}`);
    }

    return textResult(
      [
        `# hover ✓ ${selector}`,
        '',
        `tag: \`<${v.tag as string}>\``,
        `match count: ${v.foundCount as number} (picked nth=${nth})`,
        `visible: ${v.visible as boolean}`,
        `rect: ${JSON.stringify(v.rect)}`,
        '',
        '⚠ Synthetic Pointer / Mouse events. iOS is a touch platform, so genuine `:hover` only persists until the next pointer cancel; long-lived hover UIs may rely on real mouse cursors and will not stick.',
      ].join('\n'),
    );
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
