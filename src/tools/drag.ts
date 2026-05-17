import { z } from 'zod';
import { PageSession } from '../page-session.js';

/**
 * WIP gotcha: `Runtime.evaluate` with `awaitPromise:true` does NOT correctly
 * serialize the resolved value of a returned Promise (even `Promise.resolve(42)`
 * comes back as `{}`). So this tool keeps the inner expression synchronous.
 * Per-step delay is implemented by issuing one Runtime.evaluate per pointermove
 * step from TS land when `stepDelayMs > 0`. When `stepDelayMs === 0`, the entire
 * sequence runs in a single sync IIFE.
 */
export const dragTool = {
  name: 'drag',
  description: [
    'Drag from a source element to a target element (or by pixel offset) on the inspected iOS WebView page.',
    'NOTE: WIP has no `Input.dispatchTouch/MouseEvent`. Synthetic pointer sequence (`pointerdown` → N × `pointermove` → `pointerup`, mirrored for mouse) via `Runtime.evaluate`. iOS gesture recognizers (UIPanGestureRecognizer / native scroll) will NOT fire because no real touch reaches the WebView host. Useful for JS-implemented drag handlers; useless for native scroll triggers.',
    'Provide exactly one destination: `toSelector` (element-to-element) OR `dx`/`dy` (offset from source center).',
  ].join(' '),

  inputSchema: {
    fromSelector: z.string().min(1).describe('CSS selector for the source element.'),
    fromNth: z.number().int().min(0).optional().describe('Source nth match. Default 0.'),
    toSelector: z.string().min(1).optional().describe('CSS selector for the destination element. Mutually exclusive with dx/dy.'),
    toNth: z.number().int().min(0).optional().describe('Destination nth match. Default 0.'),
    dx: z.number().optional().describe('X offset (CSS px) from source center. Mutually exclusive with toSelector.'),
    dy: z.number().optional().describe('Y offset (CSS px) from source center. Mutually exclusive with toSelector.'),
    steps: z.number().int().min(2).max(120).optional().describe('Number of pointermove steps between start and end. Default 12.'),
    stepDelayMs: z.number().int().min(0).max(200).optional().describe('Delay between move steps. Default 12.'),
    waitAfterMs: z.number().int().min(0).max(10_000).optional().describe('Block after release for this long (default 200).'),
  },

  handler: async ({
    fromSelector,
    fromNth = 0,
    toSelector,
    toNth = 0,
    dx,
    dy,
    steps = 12,
    stepDelayMs = 12,
    waitAfterMs = 200,
  }: {
    fromSelector: string;
    fromNth?: number;
    toSelector?: string;
    toNth?: number;
    dx?: number;
    dy?: number;
    steps?: number;
    stepDelayMs?: number;
    waitAfterMs?: number;
  }) => {
    const offsetMode = dx !== undefined || dy !== undefined;
    if (offsetMode && toSelector !== undefined) {
      return errorResult('Provide either `toSelector` OR `dx`/`dy`, not both.');
    }
    if (!offsetMode && toSelector === undefined) {
      return errorResult('Provide one of: `toSelector` or `dx`/`dy`.');
    }

    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    const fromJson = JSON.stringify(fromSelector);
    const toJson = toSelector !== undefined ? JSON.stringify(toSelector) : 'null';
    const prelude = `
      (() => {
        const fromMatches = document.querySelectorAll(${fromJson});
        if (fromMatches.length === 0) return { ok: false, reason: 'from_no_match', selector: ${fromJson} };
        if (${fromNth} >= fromMatches.length) return { ok: false, reason: 'from_nth_out_of_range', found: fromMatches.length };
        const src = fromMatches[${fromNth}];
        const srcRect = src.getBoundingClientRect();
        const sx = srcRect.x + srcRect.width / 2;
        const sy = srcRect.y + srcRect.height / 2;
        let ex, ey, dstTag = null;
        if (${toJson} !== null) {
          const toMatches = document.querySelectorAll(${toJson});
          if (toMatches.length === 0) return { ok: false, reason: 'to_no_match', selector: ${toJson} };
          if (${toNth} >= toMatches.length) return { ok: false, reason: 'to_nth_out_of_range', found: toMatches.length };
          const dst = toMatches[${toNth}];
          const r = dst.getBoundingClientRect();
          ex = r.x + r.width / 2;
          ey = r.y + r.height / 2;
          dstTag = dst.tagName.toLowerCase();
        } else {
          ex = sx + ${dx ?? 0};
          ey = sy + ${dy ?? 0};
        }
        window.__wdm_drag = { src, sx, sy, ex, ey };
        return { ok: true, fromTag: src.tagName.toLowerCase(), dstTag, sx, sy, ex, ey };
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
      return errorResult(`Runtime.evaluate (drag prelude) failed: ${describe(e)}`);
    }
    const preVal = pre?.result?.value as Record<string, unknown> | undefined;
    if (!preVal || preVal.ok !== true) {
      return errorResult(`# drag: failed at prelude\n\n${JSON.stringify(preVal)}`);
    }

    const fireSnippet = `(() => {
      const d = window.__wdm_drag;
      const src = d.src;
      const fire = (type, x, y, evCtor, buttons) => {
        src.dispatchEvent(new evCtor(type, {
          bubbles: true, cancelable: true,
          clientX: x, clientY: y,
          pointerType: 'mouse', pointerId: 1, isPrimary: true,
          button: 0, buttons: buttons != null ? buttons : 1,
        }));
      };
      return fire;
    })()`;

    const downSync = `
      (() => {
        const d = window.__wdm_drag;
        const src = d.src;
        const init = { bubbles: true, cancelable: true, clientX: d.sx, clientY: d.sy, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 1 };
        src.dispatchEvent(new PointerEvent('pointerdown', init));
        src.dispatchEvent(new MouseEvent('mousedown', init));
        return { ok: true };
      })()
    `;

    const moveSync = (t: number) => `
      (() => {
        const d = window.__wdm_drag;
        const src = d.src;
        const t = ${t};
        const mx = d.sx + (d.ex - d.sx) * t;
        const my = d.sy + (d.ey - d.sy) * t;
        const init = { bubbles: true, cancelable: true, clientX: mx, clientY: my, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 1 };
        src.dispatchEvent(new PointerEvent('pointermove', init));
        src.dispatchEvent(new MouseEvent('mousemove', init));
        return { ok: true };
      })()
    `;

    const upSync = `
      (() => {
        const d = window.__wdm_drag;
        const src = d.src;
        const init = { bubbles: true, cancelable: true, clientX: d.ex, clientY: d.ey, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 0 };
        src.dispatchEvent(new PointerEvent('pointerup', init));
        src.dispatchEvent(new MouseEvent('mouseup', init));
        return { ok: true };
      })()
    `;

    const allInOne = `
      (() => {
        const d = window.__wdm_drag;
        const src = d.src;
        const steps = ${steps};
        const fire = (type, x, y, evCtor, buttons) => {
          src.dispatchEvent(new evCtor(type, {
            bubbles: true, cancelable: true,
            clientX: x, clientY: y,
            pointerType: 'mouse', pointerId: 1, isPrimary: true,
            button: 0, buttons: buttons != null ? buttons : 1,
          }));
        };
        fire('pointerdown', d.sx, d.sy, PointerEvent);
        fire('mousedown', d.sx, d.sy, MouseEvent);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const mx = d.sx + (d.ex - d.sx) * t;
          const my = d.sy + (d.ey - d.sy) * t;
          fire('pointermove', mx, my, PointerEvent);
          fire('mousemove', mx, my, MouseEvent);
        }
        fire('pointerup', d.ex, d.ey, PointerEvent, 0);
        fire('mouseup', d.ex, d.ey, MouseEvent, 0);
        return { ok: true, steps };
      })()
    `;

    try {
      if (stepDelayMs === 0) {
        const r = await ps.session.send<{ result: { value: unknown } }>(
          'Runtime.evaluate',
          { expression: allInOne, returnByValue: true, awaitPromise: false },
          15_000,
        );
        const v = r?.result?.value as Record<string, unknown> | undefined;
        if (!v || v.ok !== true) {
          return errorResult(`# drag: failed at all-in-one\n\n${JSON.stringify(v)}`);
        }
      } else {
        await ps.session.send('Runtime.evaluate', { expression: downSync, returnByValue: true, awaitPromise: false }, 10_000);
        for (let i = 1; i <= steps; i++) {
          await ps.session.send('Runtime.evaluate', { expression: moveSync(i / steps), returnByValue: true, awaitPromise: false }, 10_000);
          if (i < steps) await new Promise(r => setTimeout(r, stepDelayMs));
        }
        await ps.session.send('Runtime.evaluate', { expression: upSync, returnByValue: true, awaitPromise: false }, 10_000);
      }
    } catch (e) {
      return errorResult(`Runtime.evaluate (drag loop) failed: ${describe(e)}`);
    }

    if (waitAfterMs > 0) {
      await new Promise(r => setTimeout(r, waitAfterMs));
    }

    void fireSnippet; // referenced for documentation; not executed
    return textResult(
      [
        `# drag ✓`,
        '',
        `from: \`<${preVal.fromTag as string}>\` @ (${(preVal.sx as number).toFixed(1)}, ${(preVal.sy as number).toFixed(1)})`,
        `to: ${preVal.dstTag ? `\`<${preVal.dstTag as string}>\` @ ` : ''}(${(preVal.ex as number).toFixed(1)}, ${(preVal.ey as number).toFixed(1)})`,
        `steps: ${steps}${stepDelayMs > 0 ? ` (per-step, ${stepDelayMs}ms between)` : ' (single sync round-trip)'}`,
        '',
        '⚠ Synthetic Pointer/Mouse drag. No native iOS gesture recognizers fire — useful only for handlers attached in JS (e.g. `pointerdown` listeners, `react-dnd`, sortable libs). Native scroll / pinch / pan will NOT respond.',
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
