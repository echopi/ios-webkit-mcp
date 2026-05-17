import { z } from 'zod';
import { PageSession } from '../page-session.js';

export const deleteCookieTool = {
  name: 'delete_cookie',
  description: [
    'Delete a single cookie by name + URL via WIP `Page.deleteCookie` (Apple-specific, probe-confirmed 2026-05-16).',
    'NOTE: WIP\'s `Network.deleteCookies` is NOT exposed on iOS — only `Page.deleteCookie` works, and it takes `cookieName` + `url` (not domain/path).',
  ].join(' '),

  inputSchema: {
    cookieName: z.string().min(1).describe('Exact cookie name to delete.'),
    url: z.string().url().describe('Origin URL the cookie is scoped to (e.g. https://example.com).'),
  },

  handler: async ({ cookieName, url }: { cookieName: string; url: string }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    try { await ps.session.send('Page.deleteCookie', { cookieName, url }, 10_000); }
    catch (e) { return errorResult(`Page.deleteCookie failed: ${describe(e)}`); }
    return textResult(`# delete_cookie ✓\n\nname: \`${cookieName}\` · url: \`${url}\`\n\nRun \`get_cookies\` with \`nameSubstring=${cookieName}\` to verify removal.`);
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
