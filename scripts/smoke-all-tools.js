#!/usr/bin/env node
/**
 * Smoke test: invoke all stream-based tools via PageSession singleton.
 * Capture events for WATCH_MS (default 6000), then dump.
 */
import { listConsoleMessagesTool } from '../build/src/tools/list_console_messages.js';
import { listNetworkRequestsTool } from '../build/src/tools/list_network_requests.js';
import { takeSnapshotTool } from '../build/src/tools/take_snapshot.js';
import { PageSession } from '../build/src/page-session.js';

const watchMs = Number(process.env['WATCH_MS'] ?? 6000);

console.log('[smoke] attaching to first WKWebView page...');
const ps = await PageSession.get();
console.log(`[smoke] attached → page id ${ps.attachInfo.pageId} (${ps.attachInfo.pageTitle})`);
console.log(`[smoke] enable errors: ${ps.enableErrors.map(e => e.method).join(', ') || '(none)'}`);

// Default: fire some activity so the buffers aren't empty on idle pages. Set NO_TRIGGER=1 to skip.
if (process.env['NO_TRIGGER'] !== '1') {
  console.log('[smoke] firing test console + fetch (NO_TRIGGER=1 to skip)...');
  await ps.session.send('Runtime.evaluate', {
    expression: `console.log("[wdm-smoke] ping at " + new Date().toISOString()); console.warn("[wdm-smoke] warn sample"); fetch("/__wdm_smoke__" + Date.now()).catch(()=>{}); "ok"`,
    returnByValue: true,
  });
}
console.log(`[smoke] watching for ${watchMs}ms (interact with the page to trigger more events)...`);
await new Promise(r => setTimeout(r, watchMs));

console.log(`\n[smoke] buffered: console=${ps.consoleBuffer.length}, network=${ps.networkBuffer.length}\n`);

console.log('======================= list_console_messages =======================');
const consoleResult = await listConsoleMessagesTool.handler({ limit: 20 });
process.stdout.write(consoleResult.content[0].text + '\n');

console.log('\n======================= list_network_requests =======================');
const netResult = await listNetworkRequestsTool.handler({ limit: 30 });
process.stdout.write(netResult.content[0].text + '\n');

console.log('\n======================= take_snapshot (outline) =======================');
const snapResult = await takeSnapshotTool.handler({ depth: 5, pierce: false, maxNodes: 60 });
process.stdout.write(snapResult.content[0].text + '\n');

PageSession.reset();
process.exit(0);
