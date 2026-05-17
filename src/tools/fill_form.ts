import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const fillFormTool = {
  name: 'fill_form',
  description: [
    'Fill multiple form fields in one round-trip on the inspected iOS WebView page.',
    'Each entry mirrors the behavior of `fill`: native `value` setter (React `onChange` compatible) + synthetic `input` + `change` events. WIP has no `Input.*` domain so all events are `isTrusted=false`.',
    'Selector matches via `document.querySelectorAll(selector)[nth]`. Per-field failures are reported but do NOT abort the rest of the batch.',
  ].join(' '),

  inputSchema: {
    fields: z
      .array(
        z.object({
          selector: z.string().min(1).describe('CSS selector for the input/textarea/contenteditable.'),
          value: z.string().describe('Text to fill (empty string clears).'),
          nth: z.number().int().min(0).optional().describe('Nth match (default 0).'),
        }),
      )
      .min(1)
      .max(50)
      .describe('Form fields to fill in order.'),
    waitAfterMs: z
      .number()
      .int()
      .min(0)
      .max(10_000)
      .optional()
      .describe('Block after the whole batch for this long (default 150).'),
  },

  handler: async ({
    fields,
    waitAfterMs = 150,
  }: {
    fields: Array<{ selector: string; value: string; nth?: number }>;
    waitAfterMs?: number;
  }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    const fieldsJson = JSON.stringify(
      fields.map(f => ({ selector: f.selector, value: f.value, nth: f.nth ?? 0 })),
    );
    const expression = `
      (() => {
        const fields = ${fieldsJson};
        const results = [];
        for (const f of fields) {
          const matches = document.querySelectorAll(f.selector);
          if (matches.length === 0) { results.push({ selector: f.selector, ok: false, reason: 'no_match' }); continue; }
          if (f.nth >= matches.length) { results.push({ selector: f.selector, ok: false, reason: 'nth_out_of_range', found: matches.length }); continue; }
          const el = matches[f.nth];
          const tag = el.tagName.toLowerCase();
          const isInput = tag === 'input' || tag === 'textarea';
          const isCE = el.isContentEditable === true;
          if (!isInput && !isCE) { results.push({ selector: f.selector, ok: false, reason: 'not_fillable', tag }); continue; }
          try {
            el.focus();
            if (isInput) {
              const proto = tag === 'input' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
              if (setter) setter.call(el, f.value); else el.value = f.value;
            } else {
              el.textContent = f.value;
            }
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (e) { results.push({ selector: f.selector, ok: false, reason: 'fill_threw', error: String(e), tag }); continue; }
          results.push({ selector: f.selector, ok: true, tag, valueLen: f.value.length });
        }
        return results;
      })()
    `;

    let result;
    try {
      result = await ps.session.send<{ result: { value: unknown } }>(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: false },
        15_000,
      );
    } catch (e) {
      return errorResult(`Runtime.evaluate (fill_form) failed: ${describe(e)}`);
    }

    if (waitAfterMs > 0) {
      await new Promise(r => setTimeout(r, waitAfterMs));
    }

    const results = result?.result?.value as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(results)) {
      return errorResult(`# fill_form: unexpected return\n\n${JSON.stringify(result?.result)}`);
    }
    const ok = results.filter(r => r.ok === true).length;
    const failed = results.length - ok;
    const lines = [`# fill_form ${failed === 0 ? '✓' : '⚠'} ${ok}/${results.length} fields filled`, ''];
    results.forEach((r, i) => {
      if (r.ok) {
        lines.push(`- [${i + 1}] ✓ \`${r.selector as string}\` ← \`<${r.tag as string}>\` (len ${r.valueLen as number})`);
      } else {
        lines.push(`- [${i + 1}] ✗ \`${r.selector as string}\` → ${r.reason as string}${r.tag ? ` (tag: ${r.tag as string})` : ''}${r.found != null ? ` (found ${r.found as number})` : ''}${r.error ? ` (${r.error as string})` : ''}`);
      }
    });
    if (failed > 0) {
      lines.push('');
      lines.push('⚠ Per-field failures do not abort the batch. Re-run with corrected selectors.');
    }
    lines.push('');
    lines.push('⚠ Synthetic `value=…` + `input`/`change` events (isTrusted=false). Use `type_text` per-field for per-keystroke listeners.');
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
