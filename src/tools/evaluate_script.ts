import { z } from 'zod';
import { fetchProxyDevices, fetchDevicePages } from '../wip-client/iwdp-http.js';
import { WipSession } from '../wip-client/ws-session.js';
import { PageSession } from '../page-session.js';

const DEFAULT_PROXY_BASE = 'http://127.0.0.1:9221';

interface WipRemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
}

interface RuntimeEvaluateResult {
  result: WipRemoteObject;
  wasThrown?: boolean;
}

export const evaluateScriptTool = {
  name: 'evaluate_script',
  description: [
    'Evaluate a JavaScript expression in the inspected iOS WebView page.',
    'Wraps WIP `Runtime.evaluate`. Returns the value (when returnByValue=true) or a description string.',
    'If pageId is omitted the first inspectable page on the first device is used.',
    'Requires `ios_webkit_debug_proxy` running + iPhone connected + isInspectable=true.',
  ].join(' '),

  inputSchema: {
    expression: z
      .string()
      .min(1)
      .describe('JavaScript expression to evaluate (e.g. `1+1`, `document.title`, `JSON.stringify(window.location)`)'),
    pageId: z
      .string()
      .optional()
      .describe('Page id from list_pages output. If omitted, uses the first available page.'),
    awaitPromise: z
      .boolean()
      .optional()
      .describe('If the expression returns a Promise, wait for it to settle (default true).'),
    returnByValue: z
      .boolean()
      .optional()
      .describe('Serialize the result by value (default true). Set false to keep an objectId reference.'),
    proxyDeviceListUrl: z
      .string()
      .url()
      .optional()
      .describe(`Base URL of ios_webkit_debug_proxy's device-list endpoint (default ${DEFAULT_PROXY_BASE})`),
  },

  handler: async ({
    expression,
    pageId,
    awaitPromise = true,
    returnByValue = true,
    proxyDeviceListUrl,
  }: {
    expression: string;
    pageId?: string;
    awaitPromise?: boolean;
    returnByValue?: boolean;
    proxyDeviceListUrl?: string;
  }) => {
    // Default mode (pageId omitted): use the shared PageSession so that
    // Network / Console events fired by this expression flow into the same
    // ws that list_console_messages / list_network_requests subscribe to.
    // WIP per-ws Network.enable state is isolated, so a transient session
    // would receive events that the persistent session never sees.
    //
    // Explicit pageId mode: open a transient session — useful for poking
    // a non-default target (worker, secondary page) without disturbing
    // the persistent attach.
    let chosenPageMeta: { device: string; id: string; title: string; url: string };
    let evalResult: RuntimeEvaluateResult;
    let usingShared = false;

    if (pageId == null && proxyDeviceListUrl == null) {
      try {
        const ps = await PageSession.get();
        const info = ps.attachInfo!;
        chosenPageMeta = { device: info.deviceId, id: info.pageId, title: info.pageTitle, url: info.pageUrl };
        evalResult = await ps.session.send<RuntimeEvaluateResult>('Runtime.evaluate', {
          expression,
          returnByValue,
          awaitPromise,
          generatePreview: true,
        });
        usingShared = true;
      } catch (e) {
        return errorResult(`Runtime.evaluate (shared session) failed: ${describeError(e)}`);
      }
    } else {
      // Transient session path.
      const base = proxyDeviceListUrl ?? DEFAULT_PROXY_BASE;
      let devices;
      try {
        devices = await fetchProxyDevices(base);
      } catch (e) {
        return errorResult(`Failed to reach ios_webkit_debug_proxy at ${base}: ${describeError(e)}`);
      }
      if (devices.length === 0) {
        return errorResult('No iOS devices found. Connect an iPhone via USB, trust this Mac, and ensure Settings > Safari > Advanced > Web Inspector = ON.');
      }

      let chosenPageUrl: string | undefined;
      let chosenMeta: typeof chosenPageMeta | undefined;
      for (const dev of devices) {
        let pages;
        try {
          pages = await fetchDevicePages(dev.url);
        } catch {
          continue;
        }
        let match;
        if (pageId != null) {
          match = pages.find(p => p.id === pageId);
        } else {
          match = pages.find(p => p.url && !p.title.startsWith('jsi_')) ?? pages[0];
        }
        if (match) {
          chosenPageUrl = match.webSocketDebuggerUrl;
          chosenMeta = { device: dev.deviceId, id: match.id, title: match.title, url: match.url };
          break;
        }
      }
      if (!chosenPageUrl || !chosenMeta) {
        return errorResult(
          pageId == null
            ? 'No inspectable pages available. Open a WebView page in the target app first (run `list_pages` to verify).'
            : `Page id "${pageId}" not found. Run \`list_pages\` to see available ids.`,
        );
      }
      chosenPageMeta = chosenMeta;
      const session = new WipSession();
      try {
        await session.connect(chosenPageUrl);
        await session.waitForPageTarget();
        evalResult = await session.send<RuntimeEvaluateResult>('Runtime.evaluate', {
          expression,
          returnByValue,
          awaitPromise,
          generatePreview: true,
        });
      } catch (e) {
        session.close();
        return errorResult(`Runtime.evaluate (transient) failed: ${describeError(e)}`);
      } finally {
        session.close();
      }
    }

    const lines: string[] = [];
    lines.push(`# Runtime.evaluate result`);
    lines.push('');
    lines.push(`Target: device \`${chosenPageMeta.device.slice(0, 12)}…\` · page id \`${chosenPageMeta.id}\` · ${chosenPageMeta.title || chosenPageMeta.url}${usingShared ? ' (shared session)' : ' (transient session)'}`);
    lines.push('');
    lines.push('```js');
    lines.push(expression.length > 200 ? expression.slice(0, 200) + '…' : expression);
    lines.push('```');
    lines.push('');

    const ro = evalResult.result;
    if (evalResult.wasThrown) {
      lines.push(`**Threw**: ${ro.description ?? ro.value ?? '(no description)'}`);
    } else if (returnByValue && 'value' in ro) {
      lines.push(`**Value** (${ro.type}${ro.subtype ? '/' + ro.subtype : ''}):`);
      lines.push('```json');
      try {
        lines.push(JSON.stringify(ro.value, null, 2));
      } catch {
        lines.push(String(ro.value));
      }
      lines.push('```');
    } else {
      lines.push(`**Result** (${ro.type}${ro.subtype ? '/' + ro.subtype : ''}): ${ro.description ?? ro.className ?? '(no description)'}`);
      if (ro.objectId) {
        lines.push(`objectId: \`${ro.objectId}\``);
      }
    }

    return textResult(lines.join('\n'));
  },
};

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
