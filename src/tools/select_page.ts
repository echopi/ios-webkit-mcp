import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const selectPageTool = {
  name: 'select_page',
  description: [
    'Switch the shared PageSession to a specific page id returned by `list_pages`.',
    'Default attach picks the first non-worker WKWebView page on the first device. Use this when multiple pages exist (host app keeps several WKWebView instances) or to target a JSCore worker explicitly.',
    'Side effects: closes the current ws, drops console/network buffers, re-runs Console.enable / Network.enable / Runtime.enable on the new target. Existing PageSession state is NOT preserved.',
  ].join(' '),

  inputSchema: {
    pageId: z.string().min(1).describe('Target page id from `list_pages` (e.g. "7").'),
    proxyDeviceListUrl: z
      .string()
      .url()
      .optional()
      .describe('Override `ios_webkit_debug_proxy` device-list URL (default http://127.0.0.1:9221).'),
  },

  handler: async ({
    pageId,
    proxyDeviceListUrl,
  }: {
    pageId: string;
    proxyDeviceListUrl?: string;
  }) => {
    PageSession.reset();
    let ps: PageSession;
    try {
      ps = await PageSession.get({ pageId, proxyDeviceListUrl });
    } catch (e) {
      return errorResult(`Failed to attach to pageId ${JSON.stringify(pageId)}: ${describe(e)}`);
    }

    const info = ps.attachInfo!;
    const lines = [
      `# select_page ✓ pageId=${info.pageId}`,
      '',
      `Title: ${info.pageTitle || '(no title)'}`,
      `URL: ${info.pageUrl || '(no url)'}`,
      `Device: ${info.deviceId.slice(0, 12)}… · iOS ${info.deviceOSVersion ?? '?'}`,
      `Attached at: ${new Date(info.attachedAt).toISOString()}`,
    ];
    if (ps.enableErrors.length > 0) {
      lines.push('');
      lines.push(
        `⚠ enable errors on new target: ${ps.enableErrors.map(e => `${e.method}(${e.error})`).join(', ')}`,
      );
    }
    lines.push('');
    lines.push('Console / Network buffers reset. Trigger page activity then re-read.');
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
