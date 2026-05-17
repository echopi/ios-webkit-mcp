#!/usr/bin/env node
/**
 * Smoke test: invoke the evaluate_script tool handler directly.
 *
 * Usage:
 *   npm run build && node scripts/smoke-evaluate.js
 *   EXPR='document.title' node scripts/smoke-evaluate.js
 *   EXPR='navigator.userAgent' PAGE_ID=0 node scripts/smoke-evaluate.js
 */
import { evaluateScriptTool } from '../build/src/tools/evaluate_script.js';

const expression = process.env['EXPR'] ?? '1+1';
const pageId = process.env['PAGE_ID'];

const result = await evaluateScriptTool.handler({
  expression,
  ...(pageId ? { pageId } : {}),
});
for (const c of result.content) {
  process.stdout.write(c.text + '\n');
}
if (result.isError) {
  process.exit(2);
}
