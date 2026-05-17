import { z } from 'zod';
import { PageSession } from '../page-session.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 250;

export const waitForTool = {
  name: 'wait_for',
  description: [
    'Wait for a condition on the inspected iOS WebView page. Polls via `Runtime.evaluate` until the condition is met or timeout.',
    'Modes (exactly one required):',
    '  • `selector`: wait for `document.querySelector(selector)` to return non-null',
    '  • `text`: wait for `document.body.textContent.includes(text)` to be true',
    '  • `expression`: wait for the given JS expression to evaluate truthy',
  ].join(' '),

  inputSchema: {
    selector: z.string().min(1).optional().describe('CSS selector to wait for.'),
    text: z.string().min(1).optional().describe('Text substring to appear in document.body.textContent.'),
    expression: z.string().min(1).optional().describe('JS expression — succeeds when truthy.'),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(60_000)
      .optional()
      .describe(`Max time to wait (default ${DEFAULT_TIMEOUT_MS}).`),
    pollMs: z
      .number()
      .int()
      .min(50)
      .max(5_000)
      .optional()
      .describe(`Polling interval (default ${DEFAULT_POLL_MS}).`),
  },

  handler: async ({
    selector,
    text,
    expression,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = DEFAULT_POLL_MS,
  }: {
    selector?: string;
    text?: string;
    expression?: string;
    timeoutMs?: number;
    pollMs?: number;
  }) => {
    const modes = [selector, text, expression].filter(x => x !== undefined).length;
    if (modes !== 1) {
      return errorResult(`Provide exactly one of: selector / text / expression (got ${modes}).`);
    }

    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    let probe: string;
    let label: string;
    if (selector !== undefined) {
      probe = `(document.querySelector(${JSON.stringify(selector)}) !== null)`;
      label = `selector \`${selector}\``;
    } else if (text !== undefined) {
      probe = `(typeof document.body !== 'undefined' && (document.body.textContent || '').includes(${JSON.stringify(text)}))`;
      label = `text \`${text}\``;
    } else {
      probe = `Boolean(${expression!})`;
      label = `expression \`${expression!.length > 60 ? expression!.slice(0, 60) + '…' : expression}\``;
    }

    const deadline = Date.now() + timeoutMs;
    let polls = 0;
    while (Date.now() < deadline) {
      polls++;
      try {
        const r = await ps.session.send<{ result: { value?: boolean } }>('Runtime.evaluate', {
          expression: probe,
          returnByValue: true,
        }, Math.max(2_000, pollMs));
        if (r?.result?.value === true) {
          return textResult(
            [
              `# wait_for ✓ ${label}`,
              '',
              `Matched after ${polls} poll(s) / ${Date.now() - (deadline - timeoutMs)}ms (timeout was ${timeoutMs}ms, poll ${pollMs}ms).`,
            ].join('\n'),
          );
        }
      } catch (e) {
        return errorResult(`Runtime.evaluate during wait_for failed: ${describe(e)}`);
      }
      await new Promise(r => setTimeout(r, pollMs));
    }

    return errorResult(
      `# wait_for ✗ ${label} — timed out after ${timeoutMs}ms (${polls} polls)`,
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
