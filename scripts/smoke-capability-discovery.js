#!/usr/bin/env node
/**
 * Smoke: PageSession + Capability discovery probe end-to-end.
 *
 *   PROXY=http://127.0.0.1:9221 node scripts/smoke-capability-discovery.js
 *   PAGE_TITLE_INCLUDES=example node scripts/smoke-capability-discovery.js
 */
import { PageSession } from '../build/src/page-session.js';

process.env.WDM_WS_DEBUG = process.env.WDM_WS_DEBUG || '0';

async function main() {
  // Pick page by title if requested.
  if (process.env.PAGE_TITLE_INCLUDES) {
    const proxyBase = process.env.PROXY || 'http://127.0.0.1:9221';
    const r = await fetch(proxyBase + '/json');
    const devs = await r.json();
    let pickedId;
    for (const d of devs) {
      const base = d.url.startsWith('http') ? d.url : `http://${d.url}`;
      const r2 = await fetch(base + '/json');
      const pages = await r2.json();
      const pg = pages.find(p => p.url && (p.title || '').includes(process.env.PAGE_TITLE_INCLUDES));
      if (pg) { pickedId = pg.id; break; }
    }
    if (pickedId) console.error(`[smoke] picked pageId=${pickedId}`);
    var ps = await PageSession.get({ pageId: pickedId });
  } else {
    var ps = await PageSession.get();
  }

  console.error(`[smoke] attached: ${ps.attachInfo?.pageTitle} (${ps.attachInfo?.pageUrl?.slice(0, 60)})`);
  console.error(`[smoke] awaiting capability probe…`);

  const t0 = Date.now();
  const cap = await ps.capability();
  const dt = Date.now() - t0;

  console.log(JSON.stringify({
    probedAt: cap.probedAt,
    probeDurationMs: cap.probeDurationMs,
    awaitMs: dt,
    schemaProbeSucceeded: cap.schemaProbeSucceeded,
    supportedDomainCount: cap.supportedDomains?.size,
    supportedDomains: cap.supportedDomains ? [...cap.supportedDomains].sort() : null,
    sentinels: cap.sentinels,
    notes: cap.notes,
  }, null, 2));

  ps.close();
  process.exit(0);
}

main().catch(e => { console.error('smoke FAILED:', e); process.exit(1); });
