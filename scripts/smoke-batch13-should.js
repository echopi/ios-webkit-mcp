#!/usr/bin/env node
/* batch-13 Should (4 tools) E2E smoke */
import { PageSession } from '../build/src/page-session.js';
import { highlightNodeTool, hideHighlightTool } from '../build/src/tools/highlight_node.js';
import { setResourceCachingDisabledTool, setRequestInterceptionTool } from '../build/src/tools/network_runtime.js';

async function run(label, fn) {
  console.log(`\n=== ${label} ===`);
  try { const r = await fn(); console.log(r.isError ? '❌ ' + r.content[0].text : '✅\n' + r.content[0].text.slice(0, 600)); }
  catch (e) { console.log('💥', e.message); }
}

async function main() {
  await PageSession.get();
  await run('highlight_node(body)', () => highlightNodeTool.handler({selector:'body'}));
  await run('highlight_node(div, showInfo:false)', () => highlightNodeTool.handler({selector:'div', showInfo:false}));
  await run('hide_highlight()', () => hideHighlightTool.handler({}));
  await run('set_resource_caching_disabled(true)', () => setResourceCachingDisabledTool.handler({disabled:true}));
  await run('set_resource_caching_disabled(false)', () => setResourceCachingDisabledTool.handler({disabled:false}));
  // intercept enable then immediate disable to avoid hanging the page.
  await run('set_request_interception(true)', () => setRequestInterceptionTool.handler({enabled:true}));
  await run('set_request_interception(false) [release]', () => setRequestInterceptionTool.handler({enabled:false}));
  process.exit(0);
}
main().catch(e=>{console.error('FATAL',e);process.exit(1)});
