import { z } from 'zod';
import { PageSession } from '../page-session.js';

interface CookieJar { cookies: Array<Record<string, unknown>> }

export const getCookiesTool = {
  name: 'get_cookies',
  description: [
    'List cookies visible to the inspected iOS WebView page via WIP `Page.getCookies` (Apple-specific, probe-confirmed 2026-05-16).',
    'NOTE: WIP\'s `Network.*Cookies` methods are NOT exposed on iOS — only the `Page.getCookies` / `Page.deleteCookie` pair works. Filter by URL substring or domain locally.',
  ].join(' '),

  inputSchema: {
    urlSubstring: z.string().optional().describe('Case-insensitive substring filter on cookie URL/domain.'),
    nameSubstring: z.string().optional().describe('Case-insensitive substring filter on cookie name.'),
    limit: z.number().int().min(1).max(500).optional().describe('Max cookies returned (default 100).'),
  },

  handler: async ({
    urlSubstring,
    nameSubstring,
    limit = 100,
  }: { urlSubstring?: string; nameSubstring?: string; limit?: number }) => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }

    let r: CookieJar;
    try { r = await ps.session.send<CookieJar>('Page.getCookies', undefined, 10_000); }
    catch (e) { return errorResult(`Page.getCookies failed: ${describe(e)}`); }

    let cookies = r.cookies ?? [];
    if (urlSubstring) {
      const n = urlSubstring.toLowerCase();
      cookies = cookies.filter(c => (`${c.domain ?? ''}${c.path ?? ''}`).toLowerCase().includes(n));
    }
    if (nameSubstring) {
      const n = nameSubstring.toLowerCase();
      cookies = cookies.filter(c => String(c.name ?? '').toLowerCase().includes(n));
    }
    const total = cookies.length;
    cookies = cookies.slice(0, limit);

    const lines = [`# get_cookies — ${cookies.length} of ${total} total`, ''];
    if (cookies.length === 0) {
      lines.push('(no cookies match filters)');
      return textResult(lines.join('\n'));
    }
    lines.push('| name | value | domain | path | expires | secure | httpOnly | session |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const c of cookies) {
      const value = String(c.value ?? '');
      const v = value.length > 40 ? value.slice(0, 40) + '…' : value;
      const exp = typeof c.expires === 'number' && c.expires > 0 ? new Date((c.expires as number) * 1000).toISOString().slice(0, 19) : '-';
      lines.push(`| ${c.name as string} | ${v.replace(/\|/g, '\\|')} | ${c.domain ?? ''} | ${c.path ?? '/'} | ${exp} | ${c.secure ? '✓' : ''} | ${c.httpOnly ? '✓' : ''} | ${c.session ? '✓' : ''} |`);
    }
    return textResult(lines.join('\n'));
  },
};

function textResult(text: string) { return { content: [{ type: 'text' as const, text }] }; }
function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
