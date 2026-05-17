/**
 * Tests for src/server.ts — env var parsing and basic factory smoke.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, _parseDisabledTools } from '../build/src/server.js';

describe('_parseDisabledTools (WDM_DISABLE_TOOLS env)', () => {
  test('empty / undefined env → empty set', () => {
    assert.equal(_parseDisabledTools(undefined).size, 0);
    assert.equal(_parseDisabledTools('').size, 0);
  });

  test('single tool', () => {
    const s = _parseDisabledTools('record_timeline');
    assert.equal(s.size, 1);
    assert.ok(s.has('record_timeline'));
  });

  test('comma-separated list', () => {
    const s = _parseDisabledTools('set_init_script,record_timeline,record_cpu_profile');
    assert.equal(s.size, 3);
    assert.ok(s.has('set_init_script'));
    assert.ok(s.has('record_timeline'));
    assert.ok(s.has('record_cpu_profile'));
  });

  test('trims whitespace', () => {
    const s = _parseDisabledTools(' a , b ,  c  ');
    assert.equal(s.size, 3);
    assert.ok(s.has('a'));
    assert.ok(s.has('b'));
    assert.ok(s.has('c'));
  });

  test('drops empty segments', () => {
    const s = _parseDisabledTools('a,,b,');
    assert.equal(s.size, 2);
    assert.ok(s.has('a'));
    assert.ok(s.has('b'));
  });
});

describe('createServer smoke', () => {
  test('returns an MCP server object without throwing', () => {
    const s = createServer();
    assert.ok(s, 'server should be truthy');
    assert.equal(typeof s, 'object');
  });

  test('honours WDM_DISABLE_TOOLS by skipping registration (smoke — no crash)', () => {
    const prev = process.env['WDM_DISABLE_TOOLS'];
    process.env['WDM_DISABLE_TOOLS'] = 'set_init_script,record_timeline';
    try {
      // Should not throw. We don't introspect server.tool() registrations here;
      // the goal is regression-detect a typo in disabled-tool filtering.
      const s = createServer();
      assert.ok(s);
    } finally {
      if (prev === undefined) delete process.env['WDM_DISABLE_TOOLS'];
      else process.env['WDM_DISABLE_TOOLS'] = prev;
    }
  });
});
