import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface SnapshotRectResult {
  dataURL: string;
}

interface Viewport {
  innerWidth: number;
  innerHeight: number;
  scrollX: number;
  scrollY: number;
  dpr: number;
}

export const takeScreenshotTool = {
  name: 'take_screenshot',
  description: [
    'Capture a screenshot of the inspected iOS WebView page using WIP `Page.snapshotRect` (Apple-specific; the CDP-style `Page.captureScreenshot` is NOT implemented on iOS — verified `-32601 not found`).',
    'Returns a base64 PNG image. By default captures the current viewport at the device DPR; pass an explicit `rect` for a sub-region.',
    'Note: WIP only captures the rect you specify — there is no built-in "full page" mode like Chrome\'s. To screenshot a region you can see, leave rect empty and accept the current viewport.',
  ].join(' '),

  inputSchema: {
    rect: z
      .object({
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        width: z.number().int().min(1),
        height: z.number().int().min(1),
      })
      .optional()
      .describe('Optional viewport rect (CSS pixels). Defaults to (0,0, viewportW, viewportH).'),
    coordinateSystem: z
      .enum(['Viewport', 'Page'])
      .optional()
      .describe('WIP coordinate system. `Viewport` (default) treats rect as CSS-pixel offsets within the visible viewport; `Page` is full-page coords.'),
  },

  handler: async ({
    rect,
    coordinateSystem = 'Viewport',
  }: {
    rect?: { x: number; y: number; width: number; height: number };
    coordinateSystem?: 'Viewport' | 'Page';
  }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    // If no rect supplied, query viewport dimensions via Runtime.evaluate.
    let useRect = rect;
    let viewport: Viewport | undefined;
    if (!useRect) {
      try {
        const r = await ps.session.send<{ result: { value: Viewport } }>('Runtime.evaluate', {
          expression: 'JSON.stringify({innerWidth: window.innerWidth, innerHeight: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, dpr: window.devicePixelRatio})',
          returnByValue: false,
        });
        // The string value comes back as JSON-of-JSON; with returnByValue:false we get description; flip approach
      } catch {
        // ignore
      }

      try {
        const r2 = await ps.session.send<{ result: { value: string } }>('Runtime.evaluate', {
          expression: 'JSON.stringify({innerWidth: window.innerWidth, innerHeight: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, dpr: window.devicePixelRatio})',
          returnByValue: true,
        });
        if (r2?.result?.value) {
          viewport = JSON.parse(r2.result.value) as Viewport;
          useRect = { x: viewport.scrollX, y: viewport.scrollY, width: viewport.innerWidth, height: viewport.innerHeight };
        }
      } catch {
        // fallback
      }

      if (!useRect) {
        useRect = { x: 0, y: 0, width: 390, height: 844 }; // iPhone 14/15-ish default
      }
    }

    let result: SnapshotRectResult;
    try {
      result = await ps.session.send<SnapshotRectResult>('Page.snapshotRect', {
        x: useRect.x,
        y: useRect.y,
        width: useRect.width,
        height: useRect.height,
        coordinateSystem,
      }, 30_000);
    } catch (e) {
      return errorResult(`Page.snapshotRect failed: ${describe(e)}`);
    }

    if (!result.dataURL || !result.dataURL.startsWith('data:image/')) {
      return errorResult(`Page.snapshotRect returned no valid dataURL (got: ${String(result.dataURL).slice(0, 80)})`);
    }

    const m = result.dataURL.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!m) {
      return errorResult('Unrecognized dataURL format from Page.snapshotRect.');
    }
    const mimeType = m[1]!;
    const base64 = m[2]!;
    const sizeKb = Math.round((base64.length * 3) / 4 / 1024);

    return {
      content: [
        {
          type: 'image' as const,
          data: base64,
          mimeType,
        },
        {
          type: 'text' as const,
          text: `# take_screenshot · ${mimeType} (~${sizeKb} KB)\n\nRect: ${useRect.x},${useRect.y} ${useRect.width}×${useRect.height} (${coordinateSystem})${viewport ? ` · viewport ${viewport.innerWidth}×${viewport.innerHeight} dpr ${viewport.dpr}` : ''}`,
        },
      ],
    };
  },
};

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}
function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
