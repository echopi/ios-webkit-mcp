import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const clickTool = {
  name: 'click',
  description: [
    'Click an element on the inspected iOS WebView page.',
    'NOTE: WIP has no `Input.*` domain (verified `-32601` on Dialog/Input methods). This tool dispatches a synthetic click via `Runtime.evaluate("el.click()")` — it triggers the click handler but does NOT replay an authentic touch event sequence (touchstart/touchend/mousedown/mouseup). For interactions that require gesture-quality events (long press, drag, native scroll triggers), evaluate yourself with `dispatchEvent`.',
    'Selector matches via `document.querySelector(selector)`. Returns whether the element was found + clicked.',
  ].join(' '),

  inputSchema: {
    selector: z.string().min(1).describe('CSS selector for the element to click.'),
    nth: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('When the selector matches multiple, pick the Nth (0-indexed). Default 0.'),
    waitAfterMs: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe('Block after the click for this long (default 200) so subsequent reads see post-click state.'),
  },

  handler: async ({
    selector,
    nth = 0,
    waitAfterMs = 200,
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
        if (${nth} >= matches.length) return { ok: false, reason: 'nth_out_of_range', selector: ${selJson}, found: matches.length };
        const el = matches[${nth}];
        const rect = el.getBoundingClientRect();
        const tag = el.tagName.toLowerCase();
        const visible = rect.width > 0 && rect.height > 0;
        try {
          el.click();
        } catch (e) {
          return { ok: false, reason: 'click_threw', error: String(e), tag };
        }
        return { ok: true, tag, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, visible, foundCount: matches.length };
      })()
    `;

    let result;
    try {
      result = await ps.session.send<{ result: { value: string }; wasThrown?: boolean }>(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: false },
        10_000,
      );
    } catch (e) {
      return errorResult(`Runtime.evaluate (click) failed: ${describe(e)}`);
    }

    if (waitAfterMs > 0) {
      await new Promise(r => setTimeout(r, waitAfterMs));
    }

    const value = result?.result?.value as unknown;
    const v = value as Record<string, unknown> | undefined;
    if (!v || v.ok !== true) {
      return errorResult(`# click: failed\n\nselector: \`${selector}\`\n\n${JSON.stringify(value)}`);
    }

    return textResult(
      [
        `# click ✓ ${selector}`,
        '',
        `tag: \`<${v.tag as string}>\``,
        `match count: ${v.foundCount as number} (picked nth=${nth})`,
        `visible: ${v.visible as boolean}`,
        `rect: ${JSON.stringify(v.rect)}`,
        '',
        '⚠ This is a synthetic `el.click()` invocation, not a real touch event. Long-press / drag / gesture-only handlers will NOT fire.',
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
