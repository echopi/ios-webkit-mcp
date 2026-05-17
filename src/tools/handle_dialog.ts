import { z } from 'zod';
import { PageSession } from '../page-session.js';

/**
 * WIP has neither `Page.javascriptDialogOpening` events nor
 * `Page.handleJavaScriptDialog` method — verified `-32601` for both. The iOS
 * WebView surfaces `window.alert/confirm/prompt` as native UI handled by the
 * host app's WKUIDelegate, completely outside WIP's reach.
 *
 * This tool overrides `window.alert/confirm/prompt` from JS land:
 *   - `install` mode: monkey-patches the three globals to record each call in
 *     `window.__wdm_dialogs` and short-circuit return preset responses
 *   - `list` mode: returns the captured queue
 *   - `set_response` mode: updates the preset response for subsequent confirm/prompt
 *   - `uninstall` mode: restores the natives
 *
 * Because the override returns synchronously, no native iOS dialog UI appears.
 * Pages that depend on the actual dialog blocking (e.g. "wait for user to dismiss
 * the alert") may behave differently than in a real user session.
 */
export const handleDialogTool = {
  name: 'handle_dialog',
  description: [
    'Manage `window.alert` / `confirm` / `prompt` interception on the inspected iOS WebView page.',
    'NOTE: WIP has no `Page.javascriptDialogOpening` event or `Page.handleJavaScriptDialog` method (verified `-32601`). This tool monkey-patches the three globals from JS — synthetic, no real iOS dialog UI fires after install. Use this to capture dialog text the page would have shown and to pre-set the return value for `confirm` / `prompt`.',
    'Modes: `install` (overrides + start recording), `list` (read captured queue), `set_response` (update default return), `uninstall` (restore natives).',
  ].join(' '),

  inputSchema: {
    mode: z
      .enum(['install', 'list', 'set_response', 'uninstall'])
      .describe('install | list | set_response | uninstall.'),
    confirmResponse: z
      .boolean()
      .optional()
      .describe('install / set_response: value returned to `confirm()`. Default true.'),
    promptResponse: z
      .string()
      .optional()
      .describe('install / set_response: value returned to `prompt()`. Default "".'),
    clearQueue: z
      .boolean()
      .optional()
      .describe('list: also clear the queue after reading. Default false.'),
  },

  handler: async ({
    mode,
    confirmResponse,
    promptResponse,
    clearQueue = false,
  }: {
    mode: 'install' | 'list' | 'set_response' | 'uninstall';
    confirmResponse?: boolean;
    promptResponse?: string;
    clearQueue?: boolean;
  }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    let expression: string;
    if (mode === 'install') {
      const cr = confirmResponse === undefined ? 'true' : String(confirmResponse);
      const pr = JSON.stringify(promptResponse ?? '');
      expression = `
        (() => {
          const state = window.__wdm_dialog_state = window.__wdm_dialog_state || {
            installed: false, alert: null, confirm: null, prompt: null,
            response: { confirm: true, prompt: '' },
          };
          state.response.confirm = ${cr};
          state.response.prompt = ${pr};
          if (state.installed) return { ok: true, alreadyInstalled: true, response: state.response };
          state.alert = window.alert; state.confirm = window.confirm; state.prompt = window.prompt;
          window.__wdm_dialogs = window.__wdm_dialogs || [];
          window.alert = function (msg) {
            window.__wdm_dialogs.push({ type: 'alert', text: String(msg ?? ''), ts: Date.now() });
          };
          window.confirm = function (msg) {
            window.__wdm_dialogs.push({ type: 'confirm', text: String(msg ?? ''), ts: Date.now() });
            return state.response.confirm;
          };
          window.prompt = function (msg, defaultValue) {
            window.__wdm_dialogs.push({ type: 'prompt', text: String(msg ?? ''), defaultValue: defaultValue == null ? null : String(defaultValue), ts: Date.now() });
            return state.response.prompt;
          };
          state.installed = true;
          return { ok: true, installed: true, response: state.response };
        })()
      `;
    } else if (mode === 'list') {
      expression = `
        (() => {
          const queue = (window.__wdm_dialogs || []).slice();
          if (${clearQueue}) window.__wdm_dialogs = [];
          return { ok: true, queue, installed: (window.__wdm_dialog_state || {}).installed === true };
        })()
      `;
    } else if (mode === 'set_response') {
      const cr = confirmResponse === undefined ? 'undefined' : String(confirmResponse);
      const pr = promptResponse === undefined ? 'undefined' : JSON.stringify(promptResponse);
      expression = `
        (() => {
          const state = window.__wdm_dialog_state;
          if (!state || !state.installed) return { ok: false, reason: 'not_installed' };
          if (${cr} !== undefined) state.response.confirm = ${cr};
          if (${pr} !== undefined) state.response.prompt = ${pr};
          return { ok: true, response: state.response };
        })()
      `;
    } else {
      expression = `
        (() => {
          const state = window.__wdm_dialog_state;
          if (!state || !state.installed) return { ok: true, alreadyUninstalled: true };
          if (state.alert) window.alert = state.alert;
          if (state.confirm) window.confirm = state.confirm;
          if (state.prompt) window.prompt = state.prompt;
          state.installed = false;
          return { ok: true, uninstalled: true };
        })()
      `;
    }

    let result;
    try {
      result = await ps.session.send<{ result: { value: unknown } }>(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: false },
        10_000,
      );
    } catch (e) {
      return errorResult(`Runtime.evaluate (handle_dialog ${mode}) failed: ${describe(e)}`);
    }

    const v = result?.result?.value as Record<string, unknown> | undefined;
    if (!v || v.ok !== true) {
      return errorResult(`# handle_dialog (${mode}): failed\n\n${JSON.stringify(v)}`);
    }

    if (mode === 'list') {
      const queue = (v.queue as Array<Record<string, unknown>>) ?? [];
      const lines = [
        `# handle_dialog list — ${queue.length} captured · installed: ${v.installed as boolean}`,
        '',
      ];
      if (queue.length === 0) {
        lines.push('(No dialogs intercepted. Either install first or page hasn\'t triggered one.)');
      } else {
        queue.forEach((d, i) => {
          const ts = typeof d.ts === 'number' ? new Date(d.ts as number).toISOString() : '';
          lines.push(`## [${i + 1}] ${d.type as string}${ts ? ` · ${ts}` : ''}`);
          lines.push(`text: ${JSON.stringify(d.text)}`);
          if (d.defaultValue != null) lines.push(`defaultValue: ${JSON.stringify(d.defaultValue)}`);
          lines.push('');
        });
      }
      return textResult(lines.join('\n'));
    }

    if (mode === 'install') {
      const resp = v.response as { confirm: boolean; prompt: string };
      return textResult(
        [
          `# handle_dialog install ✓${v.alreadyInstalled ? ' (already installed — response updated)' : ''}`,
          '',
          `confirm() default response: ${resp.confirm}`,
          `prompt() default response: ${JSON.stringify(resp.prompt)}`,
          '',
          '⚠ Synthetic: alert/confirm/prompt return immediately, no native UI fires. Pages depending on real dialog blocking semantics may diverge.',
        ].join('\n'),
      );
    }

    if (mode === 'set_response') {
      const resp = v.response as { confirm: boolean; prompt: string };
      return textResult(
        [
          `# handle_dialog set_response ✓`,
          '',
          `confirm() response: ${resp.confirm}`,
          `prompt() response: ${JSON.stringify(resp.prompt)}`,
        ].join('\n'),
      );
    }

    return textResult(
      [`# handle_dialog uninstall ✓${v.alreadyUninstalled ? ' (was already uninstalled)' : ''}`].join(
        '\n',
      ),
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
