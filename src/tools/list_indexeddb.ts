import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface DbList { databaseNames: string[] }

export const listIndexeddbTool = {
  name: 'list_indexeddb',
  description: [
    'List IndexedDB database names for a given origin via WIP `IndexedDB.requestDatabaseNames` (Apple-specific, probe-confirmed 2026-05-16).',
    'Origin defaults to the currently-attached page\'s origin. Pass `securityOrigin` explicitly to inspect a different origin scope.',
    'NOTE: WIP\'s `Storage.*` domain is NOT available (probe ❌), so deep IndexedDB inspection (table contents) requires `IndexedDB.requestData` with a schema we haven\'t fully reverse-engineered yet.',
  ].join(' '),

  inputSchema: {
    securityOrigin: z.string().optional().describe('Origin URL, e.g. `https://example.com`. Defaults to the current page\'s origin.'),
  },

  handler: async ({ securityOrigin }: { securityOrigin?: string }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }

    let origin = securityOrigin;
    if (!origin) {
      try {
        const r = await ps.session.send<{ result: { value: string } }>('Runtime.evaluate', {
          expression: 'location.origin', returnByValue: true,
        }, 5_000);
        origin = r?.result?.value;
      } catch {}
    }
    if (!origin) return errorResult('Cannot determine origin — pass `securityOrigin` explicitly.');

    let r: DbList;
    try { r = await ps.session.send<DbList>('IndexedDB.requestDatabaseNames', { securityOrigin: origin }, 10_000); }
    catch (e) { return errorResult(`IndexedDB.requestDatabaseNames failed: ${describe(e)}`); }

    const names = r.databaseNames ?? [];
    const lines = [`# list_indexeddb — ${names.length} database(s) for \`${origin}\``, ''];
    if (names.length === 0) {
      lines.push('(no databases — page may not use IndexedDB or origin mismatch)');
    } else {
      for (const n of names) lines.push(`- ${n}`);
    }
    return textResult(lines.join('\n'));
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
