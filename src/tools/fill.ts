import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const fillTool = {
  name: 'fill',
  description: [
    'Set the value of an input / textarea / contenteditable on the inspected iOS WebView page in one shot.',
    'NOTE: WIP has no `Input.*` domain. This tool runs `Runtime.evaluate` to assign `el.value` (via the native setter so React `onChange` fires) and dispatches synthetic `input` + `change` events. Real key sequences are NOT simulated — for per-keystroke behavior use `type_text`.',
    'Selector matches via `document.querySelectorAll(selector)[nth]`.',
  ].join(' '),

  inputSchema: {
    selector: z.string().min(1).describe('CSS selector for the input / textarea / contenteditable element.'),
    value: z.string().describe('Text to fill. Empty string is allowed (clears the field).'),
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
      .describe('Block after fill for this long (default 100) so subsequent reads see post-fill state.'),
  },

  handler: async ({
    selector,
    value,
    nth = 0,
    waitAfterMs = 100,
  }: { selector: string; value: string; nth?: number; waitAfterMs?: number }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    const selJson = JSON.stringify(selector);
    const valJson = JSON.stringify(value);
    const expression = `
      (() => {
        const matches = document.querySelectorAll(${selJson});
        if (matches.length === 0) return { ok: false, reason: 'no_match', selector: ${selJson} };
        if (${nth} >= matches.length) return { ok: false, reason: 'nth_out_of_range', found: matches.length };
        const el = matches[${nth}];
        const tag = el.tagName.toLowerCase();
        const isInput = tag === 'input' || tag === 'textarea';
        const isCE = el.isContentEditable === true;
        if (!isInput && !isCE) return { ok: false, reason: 'not_fillable', tag };
        try {
          el.focus();
          if (isInput) {
            const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
            if (setter) setter.call(el, ${valJson}); else el.value = ${valJson};
          } else {
            el.textContent = ${valJson};
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (e) {
          return { ok: false, reason: 'fill_threw', error: String(e), tag };
        }
        return {
          ok: true,
          tag,
          mode: isInput ? 'value-setter' : 'contenteditable',
          valueLen: ${valJson}.length,
          foundCount: matches.length,
        };
      })()
    `;

    let result;
    try {
      result = await ps.session.send<{ result: { value: unknown }; wasThrown?: boolean }>(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: false },
        10_000,
      );
    } catch (e) {
      return errorResult(`Runtime.evaluate (fill) failed: ${describe(e)}`);
    }

    if (waitAfterMs > 0) {
      await new Promise(r => setTimeout(r, waitAfterMs));
    }

    const v = result?.result?.value as Record<string, unknown> | undefined;
    if (!v || v.ok !== true) {
      return errorResult(`# fill: failed\n\nselector: \`${selector}\`\n\n${JSON.stringify(v)}`);
    }

    return textResult(
      [
        `# fill ✓ ${selector}`,
        '',
        `tag: \`<${v.tag as string}>\` (mode: ${v.mode as string})`,
        `value length: ${v.valueLen as number}`,
        `match count: ${v.foundCount as number} (picked nth=${nth})`,
        '',
        '⚠ Synthetic `value = …` + `input` / `change` events. Listeners depending on per-key events (composition, IME, key counters) will NOT fire. Use `type_text` for keystroke-level simulation.',
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
