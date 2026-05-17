import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const pressKeyTool = {
  name: 'press_key',
  description: [
    'Dispatch a single key press (`keydown` + `keyup`, plus `keypress` for printable keys) on the inspected iOS WebView page.',
    'NOTE: WIP has no `Input.dispatchKeyEvent`. This is a synthetic `KeyboardEvent` dispatched via `Runtime.evaluate` — listeners see `isTrusted=false`, and browser default actions (form submit on Enter, scrolling on PageDown) will NOT fire unless explicitly triggered by JS handlers.',
    'Target is `document.activeElement` by default. Pass `selector` to focus an element first.',
  ].join(' '),

  inputSchema: {
    key: z.string().min(1).describe('KeyboardEvent.key value, e.g. "Enter", "ArrowDown", "a", "Escape".'),
    code: z.string().optional().describe('KeyboardEvent.code, e.g. "Enter", "ArrowDown", "KeyA". Defaults to a guess from key.'),
    selector: z.string().optional().describe('Optional CSS selector to focus before dispatching.'),
    nth: z.number().int().min(0).optional().describe('Pick the Nth selector match. Default 0.'),
    shift: z.boolean().optional().describe('Hold Shift modifier. Default false.'),
    ctrl: z.boolean().optional().describe('Hold Control modifier. Default false.'),
    alt: z.boolean().optional().describe('Hold Alt modifier. Default false.'),
    meta: z.boolean().optional().describe('Hold Meta (⌘) modifier. Default false.'),
    waitAfterMs: z.number().int().min(0).max(10_000).optional().describe('Block after press for this long (default 100).'),
  },

  handler: async ({
    key,
    code,
    selector,
    nth = 0,
    shift = false,
    ctrl = false,
    alt = false,
    meta = false,
    waitAfterMs = 100,
  }: {
    key: string;
    code?: string;
    selector?: string;
    nth?: number;
    shift?: boolean;
    ctrl?: boolean;
    alt?: boolean;
    meta?: boolean;
    waitAfterMs?: number;
  }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    const selJson = selector !== undefined ? JSON.stringify(selector) : 'null';
    const keyJson = JSON.stringify(key);
    const codeJson = JSON.stringify(code ?? guessCode(key));

    const expression = `
      (() => {
        let el = null;
        if (${selJson} !== null) {
          const matches = document.querySelectorAll(${selJson});
          if (matches.length === 0) return { ok: false, reason: 'no_match', selector: ${selJson} };
          if (${nth} >= matches.length) return { ok: false, reason: 'nth_out_of_range', found: matches.length };
          el = matches[${nth}];
          try { el.focus(); } catch (e) {}
        } else {
          el = document.activeElement || document.body;
        }
        const init = {
          bubbles: true,
          cancelable: true,
          key: ${keyJson},
          code: ${codeJson},
          shiftKey: ${shift},
          ctrlKey: ${ctrl},
          altKey: ${alt},
          metaKey: ${meta},
        };
        const tag = el.tagName ? el.tagName.toLowerCase() : '#';
        try {
          el.dispatchEvent(new KeyboardEvent('keydown', init));
          if (${keyJson}.length === 1) el.dispatchEvent(new KeyboardEvent('keypress', init));
          el.dispatchEvent(new KeyboardEvent('keyup', init));
        } catch (e) {
          return { ok: false, reason: 'dispatch_threw', error: String(e), tag };
        }
        return { ok: true, tag, target: ${selJson} === null ? 'activeElement' : ${selJson} };
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
      return errorResult(`Runtime.evaluate (press_key) failed: ${describe(e)}`);
    }

    if (waitAfterMs > 0) {
      await new Promise(r => setTimeout(r, waitAfterMs));
    }

    const v = result?.result?.value as Record<string, unknown> | undefined;
    if (!v || v.ok !== true) {
      return errorResult(`# press_key: failed\n\n${JSON.stringify(v)}`);
    }

    const mods = [shift && 'Shift', ctrl && 'Ctrl', alt && 'Alt', meta && 'Meta'].filter(Boolean).join('+');
    return textResult(
      [
        `# press_key ✓ ${mods ? mods + '+' : ''}${key}`,
        '',
        `target: ${v.target as string}`,
        `tag: \`<${v.tag as string}>\``,
        '',
        '⚠ Synthetic KeyboardEvent — `isTrusted=false`, browser default actions (form submit, scroll) suppressed unless app JS handlers invoke them.',
      ].join('\n'),
    );
  },
};

function guessCode(key: string): string {
  if (key.length === 1) {
    if (/[a-zA-Z]/.test(key)) return 'Key' + key.toUpperCase();
    if (/[0-9]/.test(key)) return 'Digit' + key;
  }
  return key;
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
