import { z } from 'zod';
import { fetchProxyDevices, fetchDevicePages } from '../wip-client/iwdp-http.js';

const DEFAULT_PROXY_BASE = 'http://127.0.0.1:9221';

export const listPagesTool = {
  name: 'list_pages',
  description: [
    'List iOS WebView pages currently inspectable via ios_webkit_debug_proxy.',
    'Requires the proxy to be running with an iPhone connected and Web Inspector enabled.',
    'Returns one row per page (id, type, title, url) plus the raw WIP webSocketDebuggerUrl.',
    'NOTE: webSocketDebuggerUrl path looks chromium-style but frame content is Apple WIP, not CDP.',
  ].join(' '),

  inputSchema: {
    proxyDeviceListUrl: z
      .string()
      .url()
      .optional()
      .describe(
        `Base URL of ios_webkit_debug_proxy's device-list endpoint (default ${DEFAULT_PROXY_BASE})`,
      ),
  },

  handler: async ({
    proxyDeviceListUrl,
  }: {
    proxyDeviceListUrl?: string;
  }): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> => {
    const base = proxyDeviceListUrl ?? DEFAULT_PROXY_BASE;

    let devices;
    try {
      devices = await fetchProxyDevices(base);
    } catch (e) {
      return errorResult(`Failed to reach ios_webkit_debug_proxy at ${base}: ${describeError(e)}\n\nIs the proxy running? Try: pgrep -fl ios_webkit_debug_proxy`);
    }

    if (devices.length === 0) {
      return textResult(
        [
          '# No iOS devices found',
          '',
          'Possible causes:',
          '- iPhone not connected via USB',
          '- iPhone has not trusted this Mac (check `idevice_id -l`)',
          '- Settings > Safari > Advanced > Web Inspector is OFF',
          '- ios_webkit_debug_proxy is not running',
        ].join('\n'),
      );
    }

    const allPages: Array<{
      deviceId: string;
      idx: number;
      id: string;
      title: string;
      url: string;
      type: string;
      webSocketDebuggerUrl: string;
    }> = [];

    const deviceErrors: Array<{ deviceId: string; error: string }> = [];

    for (const dev of devices) {
      try {
        const pages = await fetchDevicePages(dev.url);
        pages.forEach((p, idx) => {
          allPages.push({
            deviceId: dev.deviceId,
            idx,
            id: p.id,
            title: p.title,
            url: p.url,
            type: p.type ?? 'page',
            webSocketDebuggerUrl: p.webSocketDebuggerUrl,
          });
        });
      } catch (e) {
        deviceErrors.push({ deviceId: dev.deviceId, error: describeError(e) });
      }
    }

    if (allPages.length === 0) {
      const lines = [
        `# No inspectable pages on ${devices.length} device(s)`,
        '',
        `Devices found: ${devices.map(d => d.deviceId).join(', ')}`,
        '',
        'Make sure the target app has a WebView/Safari page open AND the WKWebView has `isInspectable = true` (iOS 16.4+ requirement).',
      ];
      if (deviceErrors.length > 0) {
        lines.push('', '## Errors fetching device pages');
        for (const e of deviceErrors) {
          lines.push(`- ${e.deviceId}: ${e.error}`);
        }
      }
      return textResult(lines.join('\n'));
    }

    const pageCount = allPages.filter(p => p.url && !p.title.startsWith('jsi_')).length;
    const workerCount = allPages.length - pageCount;

    const md: string[] = [
      `# ${allPages.length} inspectable target(s) on ${devices.length} device(s) — ${pageCount} WKWebView page(s), ${workerCount} JSCore worker(s)`,
      '',
      '| # | kind | device | id | title | url |',
      '|---|------|--------|----|-------|-----|',
    ];
    allPages.forEach((p, i) => {
      const kind = p.url && !p.title.startsWith('jsi_') ? 'page' : 'worker';
      md.push(
        `| ${i} | ${kind} | \`${p.deviceId.slice(0, 12)}${p.deviceId.length > 12 ? '…' : ''}\` | ${p.id} | ${escapeCell(p.title)} | ${escapeCell(p.url)} |`,
      );
    });
    md.push('', '## webSocketDebuggerUrl (raw WIP frames, not CDP)', '');
    allPages.forEach((p, i) => md.push(`- [${i}] \`${p.webSocketDebuggerUrl}\``));

    if (deviceErrors.length > 0) {
      md.push('', '## Devices with errors', '');
      for (const e of deviceErrors) {
        md.push(`- ${e.deviceId}: ${e.error}`);
      }
    }

    return textResult(md.join('\n'));
  },
};

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
