#!/usr/bin/env node
/* batch-13 Must (5 tools) E2E smoke on real iOS device */
import { PageSession } from '../build/src/page-session.js';
import { setPauseOnExceptionsTool, setEventBreakpointTool, setUrlBreakpointTool } from '../build/src/tools/breakpoints.js';
import { getEventListenersTool } from '../build/src/tools/get_event_listeners.js';
import { recordCpuProfileTool } from '../build/src/tools/record_cpu_profile.js';

async function run(label, fn) {
  console.log(`\n=== ${label} ===`);
  try { const r = await fn(); console.log(r.isError ? '❌ ' + r.content[0].text : '✅\n' + r.content[0].text.slice(0, 800)); }
  catch (e) { console.log('💥', e.message); }
}

async function main() {
  await PageSession.get();

  await run('set_pause_on_exceptions(none)', () => setPauseOnExceptionsTool.handler({state:'none'}));
  await run('set_pause_on_exceptions(uncaught)', () => setPauseOnExceptionsTool.handler({state:'uncaught'}));
  await run('set_event_breakpoint(click,listener)', () => setEventBreakpointTool.handler({eventName:'click', breakpointType:'listener'}));
  await run('set_url_breakpoint(/api/, regex)', () => setUrlBreakpointTool.handler({url:'api', isRegex:false}));
  await run('get_event_listeners(body)', () => getEventListenersTool.handler({selector:'body'}));
  await run('record_cpu_profile(2000ms)', () => recordCpuProfileTool.handler({durationMs:2000, topN:10}));

  // Cleanup
  console.log('\n=== cleanup ===');
  await run('set_pause_on_exceptions(none)', () => setPauseOnExceptionsTool.handler({state:'none'}));

  process.exit(0);
}
main().catch(e=>{console.error('FATAL',e);process.exit(1)});
