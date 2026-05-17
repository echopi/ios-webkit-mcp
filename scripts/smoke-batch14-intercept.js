#!/usr/bin/env node
/* batch-14 intercept full state machine E2E smoke
 * Test plan: enable interception → trigger fetch → list → respond mock → verify */
import { PageSession } from '../build/src/page-session.js';
import { evaluateScriptTool } from '../build/src/tools/evaluate_script.js';
import { setRequestInterceptionTool } from '../build/src/tools/network_runtime.js';
import { listInterceptedRequestsTool, interceptContinueTool, interceptRespondTool } from '../build/src/tools/intercept.js';

async function run(label, fn) {
  console.log(`\n=== ${label} ===`);
  try { const r = await fn(); console.log(r.isError ? '❌ ' + r.content[0].text : '✅\n' + r.content[0].text.slice(0, 600)); return r; }
  catch (e) { console.log('💥', e.message); return null; }
}

await PageSession.get();

// 1. enable
await run('enable interception', () => setRequestInterceptionTool.handler({enabled: true}));

// 2. trigger a fetch in background (don't await — it'll suspend)
console.log('\n=== triggering background fetch ===');
evaluateScriptTool.handler({
  expression: 'fetch("https://httpbin.org/uuid").then(r => r.text()).then(t => globalThis.__intercept_result = t).catch(e => globalThis.__intercept_err = e.message)',
}).then(()=>{}).catch(()=>{});

// 3. wait for intercept to populate
await new Promise(r => setTimeout(r, 1500));

// 4. list pending
const listed = await run('list_intercepted_requests', () => listInterceptedRequestsTool.handler({}));

// 5. extract reqId from listed output (regex)
const m = listed?.content[0].text.match(/`([a-zA-Z0-9.\-]+)`\s+\|/);
const reqId = m?.[1];
console.log('\nextracted reqId:', reqId);

if (reqId) {
  // 6. respond mock
  await run('intercept_respond mock', () => interceptRespondTool.handler({
    requestId: reqId,
    statusCode: 200,
    body: '{"mocked":true}',
    headers: {'Content-Type': 'application/json'},
  }));

  // 7. wait for fetch to complete
  await new Promise(r => setTimeout(r, 1000));
  await run('verify __intercept_result', () => evaluateScriptTool.handler({
    expression: 'globalThis.__intercept_result || globalThis.__intercept_err || "still pending"',
  }));
}

// 8. cleanup
await run('disable interception', () => setRequestInterceptionTool.handler({enabled: false}));
process.exit(0);
