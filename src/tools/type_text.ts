import { z } from 'zod';
import { PageSession } from '../page-session.js';

/**
 * WIP gotcha: `Runtime.evaluate` with `awaitPromise:true` does NOT correctly
 * serialize the resolved value of a returned Promise — even `Promise.resolve(42)`
 * comes back as `{}`. So this tool MUST keep the inner expression synchronous.
 * Per-char delay is implemented by issuing one Runtime.evaluate per character
 * from TS land when `delayMs > 0`. When `delayMs === 0`, a single sync IIFE
 * types the whole string in one round-trip.
 */
export const typeTextTool = {
  name: 'type_text',
  description: [
    'Type text into the currently focused element (or a selector-targeted one) character-by-character on the inspected iOS WebView page.',
    'NOTE: WIP has no `Input.dispatchKeyEvent`. Each character is simulated via `dispatchEvent(new KeyboardEvent(...))` for `keydown` + `keypress` + `keyup`, with the input value updated and an `input` event between keys. Listeners that read `event.isTrusted` will see `false`; IME / composition events are NOT replayed.',
    'If `selector` is omitted, types into `document.activeElement`. Pass `clearFirst:true` to wipe the field before typing.',
  ].join(' '),

  inputSchema: {
    text: z.string().min(1).describe('Text to type, one character at a time.'),
    selector: z
      .string()
      .min(1)
      .optional()
      .describe('Optional CSS selector to focus before typing. If omitted uses document.activeElement.'),
    nth: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('When the selector matches multiple, pick the Nth (0-indexed). Default 0.'),
    clearFirst: z
      .boolean()
      .optional()
      .describe('Clear the field via value setter before typing. Default false.'),
    delayMs: z
      .number()
      .int()
      .min(0)
      .max(500)
      .optional()
      .describe('Delay between characters (default 0). Use small values like 10–30 to mimic human cadence.'),
    waitAfterMs: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe('Block after typing for this long (default 100).'),
  },

  handler: async ({
    text,
    selector,
    nth = 0,
    clearFirst = false,
    delayMs = 0,
    waitAfterMs = 100,
  }: {
    text: string;
    selector?: string;
    nth?: number;
    clearFirst?: boolean;
    delayMs?: number;
    waitAfterMs?: number;
  }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    const selJson = selector !== undefined ? JSON.stringify(selector) : 'null';
    const prelude = `
      (() => {
        let el = null;
        if (${selJson} !== null) {
          const matches = document.querySelectorAll(${selJson});
          if (matches.length === 0) return { ok: false, reason: 'no_match', selector: ${selJson} };
          if (${nth} >= matches.length) return { ok: false, reason: 'nth_out_of_range', found: matches.length };
          el = matches[${nth}];
        } else {
          el = document.activeElement;
          if (!el || el === document.body) return { ok: false, reason: 'no_active_element' };
        }
        const tag = el.tagName.toLowerCase();
        const isInput = tag === 'input' || tag === 'textarea';
        const isCE = el.isContentEditable === true;
        if (!isInput && !isCE) return { ok: false, reason: 'not_typable', tag };
        try { el.focus(); } catch (e) {}
        window.__wdm_type_target = el;
        window.__wdm_type_mode = isInput ? 'input' : 'ce';
        if (${clearFirst}) {
          if (isInput) {
            const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
            if (setter) setter.call(el, ''); else el.value = '';
          } else {
            el.textContent = '';
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return { ok: true, tag, mode: isInput ? 'input-keystroke' : 'contenteditable-keystroke' };
      })()
    `;

    let pre;
    try {
      pre = await ps.session.send<{ result: { value: unknown } }>(
        'Runtime.evaluate',
        { expression: prelude, returnByValue: true, awaitPromise: false },
        10_000,
      );
    } catch (e) {
      return errorResult(`Runtime.evaluate (type_text prelude) failed: ${describe(e)}`);
    }
    const preVal = pre?.result?.value as Record<string, unknown> | undefined;
    if (!preVal || preVal.ok !== true) {
      return errorResult(`# type_text: failed at prelude\n\n${JSON.stringify(preVal)}`);
    }

    const fastSync = `
      (() => {
        const el = window.__wdm_type_target;
        const isInput = window.__wdm_type_mode === 'input';
        const tag = el.tagName.toLowerCase();
        const setter = isInput
          ? (Object.getOwnPropertyDescriptor(tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value') || {}).set
          : null;
        const text = ${JSON.stringify(text)};
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ch }));
          el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: ch }));
          if (isInput) {
            const next = (el.value || '') + ch;
            if (setter) setter.call(el, next); else el.value = next;
          } else {
            el.textContent = (el.textContent || '') + ch;
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
          el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ch }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const finalValue = isInput ? el.value : el.textContent;
        return { ok: true, chars: text.length, finalLen: (finalValue || '').length };
      })()
    `;

    const perChar = (ch: string, isLast: boolean) => `
      (() => {
        const el = window.__wdm_type_target;
        const isInput = window.__wdm_type_mode === 'input';
        const tag = el.tagName.toLowerCase();
        const setter = isInput
          ? (Object.getOwnPropertyDescriptor(tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value') || {}).set
          : null;
        const ch = ${JSON.stringify(ch)};
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ch }));
        el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key: ch }));
        if (isInput) {
          const next = (el.value || '') + ch;
          if (setter) setter.call(el, next); else el.value = next;
        } else {
          el.textContent = (el.textContent || '') + ch;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ch }));
        ${isLast ? 'el.dispatchEvent(new Event("change", { bubbles: true }));' : ''}
        const finalValue = isInput ? el.value : el.textContent;
        return { ok: true, finalLen: (finalValue || '').length };
      })()
    `;

    let finalLen = 0;
    try {
      if (delayMs === 0) {
        const r = await ps.session.send<{ result: { value: unknown } }>(
          'Runtime.evaluate',
          { expression: fastSync, returnByValue: true, awaitPromise: false },
          15_000,
        );
        const v = r?.result?.value as Record<string, unknown> | undefined;
        if (!v || v.ok !== true) {
          return errorResult(`# type_text: failed at fast loop\n\n${JSON.stringify(v)}`);
        }
        finalLen = v.finalLen as number;
      } else {
        for (let i = 0; i < text.length; i++) {
          const r = await ps.session.send<{ result: { value: unknown } }>(
            'Runtime.evaluate',
            { expression: perChar(text[i]!, i === text.length - 1), returnByValue: true, awaitPromise: false },
            10_000,
          );
          const v = r?.result?.value as Record<string, unknown> | undefined;
          if (!v || v.ok !== true) {
            return errorResult(`# type_text: failed at char ${i} (${JSON.stringify(text[i])})\n\n${JSON.stringify(v)}`);
          }
          finalLen = v.finalLen as number;
          if (i < text.length - 1) {
            await new Promise(r => setTimeout(r, delayMs));
          }
        }
      }
    } catch (e) {
      return errorResult(`Runtime.evaluate (type_text loop) failed: ${describe(e)}`);
    }

    if (waitAfterMs > 0) {
      await new Promise(r => setTimeout(r, waitAfterMs));
    }

    return textResult(
      [
        `# type_text ✓`,
        '',
        `tag: \`<${preVal.tag as string}>\` (mode: ${preVal.mode as string})`,
        `chars typed: ${text.length}${delayMs > 0 ? ` (per-char, ${delayMs}ms between)` : ' (single sync round-trip)'}`,
        `final field length: ${finalLen}`,
        '',
        '⚠ Synthetic KeyboardEvent sequence — `isTrusted=false`, no IME / composition. For fast bulk assignment use `fill`.',
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
