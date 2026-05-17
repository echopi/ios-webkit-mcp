#!/usr/bin/env node
import { PageSession } from '../build/src/page-session.js';
import { getCapabilitySnapshotTool } from '../build/src/tools/get_capability_snapshot.js';
import { recordMemoryTrackingTool } from '../build/src/tools/record_memory_tracking.js';

async function run(label, fn) {
  console.log(`\n=== ${label} ===`);
  try { const r = await fn(); console.log(r.isError ? '❌ ' + r.content[0].text : '✅\n' + r.content[0].text.slice(0, 800)); }
  catch (e) { console.log('💥', e.message); }
}

await PageSession.get();
await run('get_capability_snapshot', () => getCapabilitySnapshotTool.handler({}));
await run('record_memory_tracking(2000ms)', () => recordMemoryTrackingTool.handler({durationMs: 2000}));
process.exit(0);
