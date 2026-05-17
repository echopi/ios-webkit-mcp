/**
 * `set_user_agent` (batch-14, Apple WIP `Page.overrideUserAgent`).
 *
 * Probe-confirmed (2026-05-17) on iOS 26.5.0 + Apple system WKWebView:
 *   - Method exists; `Page.overrideUserAgent({value})` returns `{}` immediately.
 *   - **Override applies on next navigation only** — `navigator.userAgent` and
 *     outgoing request `User-Agent` header keep the OLD value until the page
 *     reloads. Setting + reloading: navigator.userAgent + first xhs fetch
 *     header both showed `wdm-probe/2.0` ✅.
 *
 * This tool eliminates the spec §"Future optimization §1" claim that UA
 * override required a host-side native bridge — Page.overrideUserAgent
 * is the official upstream answer (no condition / always available, see
 * `Source/JavaScriptCore/inspector/protocol/Page.json`).
 *
 * Semantics:
 *   - `value: <non-empty string>` → set override, default-reload to apply
 *   - `value: ""` or omitted → clear override (default-reload to restore)
 *   - `reload: false` → don't reload; user must reload manually for change
 *     to take effect (rare — useful when chaining several overrides before a
 *     single reload).
 */
import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const setUserAgentTool = {
  name: 'set_user_agent',
  description: [
    'Override the User-Agent header on the inspected iOS WebView page via WIP `Page.overrideUserAgent` (✅ probe 2026-05-17).',
    'Override applies on next navigation only — this tool reloads the page by default (`reload: true`) so the change takes effect immediately. After reload, both `navigator.userAgent` (JS) and outgoing `User-Agent` request header (network) reflect the new value.',
    'Pass `value: ""` (empty) to clear the override and restore the original WebKit UA. Pass `reload: false` if you plan to chain other overrides before reloading.',
  ].join(' '),
  inputSchema: {
    value: z.string().optional().describe('UA string to send. Empty / omitted = clear override.'),
    reload: z
      .boolean()
      .optional()
      .describe('Reload the page after setting (default true). Set false if chaining multiple overrides for a single reload.'),
  },
  handler: async ({ value = '', reload = true }: { value?: string; reload?: boolean }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    // Page.enable is idempotent; ensure it lazily.
    try { await ps.session.send('Page.enable', undefined, 5_000); } catch { /* ignore */ }
    try {
      await ps.session.send('Page.overrideUserAgent', { value }, 5_000);
    } catch (e) {
      return errorResult(`Page.overrideUserAgent failed: ${describe(e)}`);
    }

    let reloadResult = '';
    if (reload) {
      try {
        await ps.session.send('Page.reload', { ignoreCache: true }, 10_000);
        // Allow main document to start loading before tool returns.
        await new Promise(r => setTimeout(r, 800));
        reloadResult = '\nPage reloaded; UA now in effect on this navigation onward.';
      } catch (e) {
        reloadResult = `\n⚠ Page.reload failed: ${describe(e)} — UA override is queued; manually reload to apply.`;
      }
    } else {
      reloadResult = '\n⚠ `reload: false` — UA override queued; will take effect on the next navigation.';
    }

    if (!value) {
      return textResult(`# set_user_agent ✓ cleared\n\nUser-Agent override removed. WebKit will use its default UA on next navigation.${reloadResult}`);
    }
    return textResult(
      `# set_user_agent ✓ \`${value.length > 80 ? value.slice(0, 77) + '…' : value}\`\n\n` +
        `Override registered via \`Page.overrideUserAgent\`.${reloadResult}`,
    );
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
