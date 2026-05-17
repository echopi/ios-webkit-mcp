/**
 * Tests for src/tools/summarize_console_errors.ts helpers (compiled output).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVEL_RANK,
  _normalizeLevel,
  _groupKey,
  _extractFrames,
  _truncate,
} from '../build/src/tools/summarize_console_errors.js';

describe('_normalizeLevel', () => {
  test('maps exact known values', () => {
    assert.equal(_normalizeLevel('error'), 'error');
    assert.equal(_normalizeLevel('warning'), 'warning');
    assert.equal(_normalizeLevel('info'), 'info');
    assert.equal(_normalizeLevel('log'), 'log');
  });

  test('"warn" alias → "warning"', () => {
    assert.equal(_normalizeLevel('warn'), 'warning');
  });

  test('unknown levels fall through to "log"', () => {
    assert.equal(_normalizeLevel('verbose'), 'log');
    assert.equal(_normalizeLevel(''), 'log');
    assert.equal(_normalizeLevel('debug'), 'log');
  });
});

describe('LEVEL_RANK', () => {
  test('strict ordering log < info < warning < error', () => {
    assert.ok(LEVEL_RANK.log < LEVEL_RANK.info);
    assert.ok(LEVEL_RANK.info < LEVEL_RANK.warning);
    assert.ok(LEVEL_RANK.warning < LEVEL_RANK.error);
  });
});

describe('_groupKey', () => {
  test('text + url:line forms stable key', () => {
    const k1 = _groupKey({ source: 'Console.messageAdded', level: 'error', text: 'foo', url: 'a.js', line: 5, raw: {} });
    const k2 = _groupKey({ source: 'Console.messageAdded', level: 'error', text: 'foo', url: 'a.js', line: 5, raw: {} });
    assert.equal(k1, k2);
  });

  test('different url → different key', () => {
    const k1 = _groupKey({ source: 'Console.messageAdded', level: 'error', text: 'foo', url: 'a.js', line: 5, raw: {} });
    const k2 = _groupKey({ source: 'Console.messageAdded', level: 'error', text: 'foo', url: 'b.js', line: 5, raw: {} });
    assert.notEqual(k1, k2);
  });

  test('different line → different key', () => {
    const k1 = _groupKey({ source: 'Console.messageAdded', level: 'error', text: 'foo', url: 'a.js', line: 5, raw: {} });
    const k2 = _groupKey({ source: 'Console.messageAdded', level: 'error', text: 'foo', url: 'a.js', line: 6, raw: {} });
    assert.notEqual(k1, k2);
  });

  test('truncates text past 80 chars for grouping', () => {
    const longA = 'x'.repeat(80) + 'AAA';
    const longB = 'x'.repeat(80) + 'BBB';
    const k1 = _groupKey({ source: 'Console.messageAdded', level: 'log', text: longA, url: 'a.js', line: 1, raw: {} });
    const k2 = _groupKey({ source: 'Console.messageAdded', level: 'log', text: longB, url: 'a.js', line: 1, raw: {} });
    assert.equal(k1, k2, 'group key should collapse same-prefix-80 messages into one bucket');
  });

  test('collapses internal whitespace', () => {
    const k1 = _groupKey({ source: 'Console.messageAdded', level: 'log', text: 'foo\nbar', url: 'a.js', line: 1, raw: {} });
    const k2 = _groupKey({ source: 'Console.messageAdded', level: 'log', text: 'foo bar', url: 'a.js', line: 1, raw: {} });
    assert.equal(k1, k2);
  });

  test('missing url → (no-loc) sentinel', () => {
    const k = _groupKey({ source: 'Console.messageAdded', level: 'log', text: 'x', raw: {} });
    assert.match(k, /\(no-loc\)$/);
  });
});

describe('_extractFrames', () => {
  test('formats callFrames into "  at fn (url:line:col)" lines', () => {
    const st = {
      callFrames: [
        { functionName: 'doFoo', url: 'a.js', lineNumber: 10, columnNumber: 4 },
        { functionName: '', url: 'b.js', lineNumber: 20, columnNumber: 0 },
      ],
    };
    const out = _extractFrames(st);
    assert.equal(out.length, 2);
    assert.equal(out[0], '  at doFoo (a.js:10:4)');
    assert.equal(out[1], '  at <anon> (b.js:20:0)');
  });

  test('returns empty for null / non-object / missing callFrames', () => {
    assert.deepEqual(_extractFrames(null), []);
    assert.deepEqual(_extractFrames(undefined), []);
    assert.deepEqual(_extractFrames('not an obj'), []);
    assert.deepEqual(_extractFrames({}), []);
    assert.deepEqual(_extractFrames({ callFrames: 'not array' }), []);
  });

  test('handles missing fields gracefully', () => {
    const out = _extractFrames({ callFrames: [{}] });
    assert.equal(out.length, 1);
    assert.equal(out[0], '  at <anon> (?:?:?)');
  });
});

describe('_truncate', () => {
  test('returns input unchanged when <= n', () => {
    assert.equal(_truncate('hello', 10), 'hello');
    assert.equal(_truncate('hello', 5), 'hello');
  });

  test('truncates with ellipsis when > n', () => {
    assert.equal(_truncate('helloworld', 6), 'hello…');
  });

  test('empty / undefined input → empty', () => {
    assert.equal(_truncate('', 5), '');
    assert.equal(_truncate(undefined, 5), '');
  });
});
