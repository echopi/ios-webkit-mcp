import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const wipSendTool = {
  name: 'wip_send',
  description: [
    'Escape hatch — send an arbitrary WIP method through the shared PageSession with full envelope wrapping (`Target.sendMessageToTarget`).',
    'Use this to probe new methods, drive Apple-specific domains (`CSS`, `Animation`, `Heap`, `DOMDebugger`, …) not yet wrapped by dedicated tools, or experiment before promoting to a real tool.',
    'Returns the raw `result` payload on success, or a structured error with WIP error code/message.',
  ].join(' '),

  inputSchema: {
    method: z
      .string()
      .min(1)
      .describe('WIP method, e.g. `Page.getResourceTree`, `CSS.enable`, `Heap.gc`.'),
    params: z
      .record(z.unknown())
      .optional()
      .describe('Method params object. Omit for parameterless methods.'),
    timeoutMs: z
      .number()
      .int()
      .min(500)
      .max(120_000)
      .optional()
      .describe('Per-call timeout (default 15000).'),
    previewMaxLen: z
      .number()
      .int()
      .min(100)
      .max(500_000)
      .optional()
      .describe('Result JSON truncation cap (default 20000).'),
  },

  handler: async ({
    method,
    params,
    timeoutMs = 15_000,
    previewMaxLen = 20_000,
  }: {
    method: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
    previewMaxLen?: number;
  }) => {
    let ps: PageSession;
    try {
      ps = await PageSession.get();
    } catch (e) {
      return errorResult(`Unable to attach to a WKWebView page: ${describe(e)}`);
    }

    let result: unknown;
    try {
      result = await ps.session.send(method, params, timeoutMs);
    } catch (e) {
      const err = e as { code?: number; message?: string };
      const code = err.code;
      const tag = code === -32601 ? '❌ NOT_FOUND' : code === -32602 ? '⚠ INVALID_PARAMS' : `⚠ ${code ?? '?'}`;
      return errorResult(
        [
          `# wip_send ${tag} \`${method}\``,
          '',
          `params: ${JSON.stringify(params ?? {})}`,
          '',
          `error: ${err.message ?? describe(e)}`,
        ].join('\n'),
      );
    }

    const json = JSON.stringify(result, null, 2) ?? 'null';
    const body =
      json.length > previewMaxLen ? json.slice(0, previewMaxLen) + `\n… (truncated, full length ${json.length})` : json;
    return textResult(
      [
        `# wip_send ✓ \`${method}\``,
        '',
        `params: ${JSON.stringify(params ?? {})}`,
        '',
        '## result',
        '```json',
        body,
        '```',
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
