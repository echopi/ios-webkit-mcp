#!/usr/bin/env node
/**
 * Smoke test: invoke the list_pages tool handler directly (no MCP transport),
 * print the result. Useful for local verification without wiring an LLM client.
 *
 * Usage:
 *   npm run build && node scripts/smoke-list-pages.js
 *   PROXY=http://127.0.0.1:9221 node scripts/smoke-list-pages.js
 */
import { listPagesTool } from '../build/src/tools/list_pages.js';

const proxyDeviceListUrl = process.env['PROXY'];
const args = proxyDeviceListUrl ? { proxyDeviceListUrl } : {};

const result = await listPagesTool.handler(args);
for (const c of result.content) {
  process.stdout.write(c.text + '\n');
}
if (result.isError) {
  process.exit(2);
}
