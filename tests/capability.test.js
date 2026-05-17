/**
 * Tests for src/capability.ts (compiled to build/src/capability.js).
 *
 * Run via:  npm test
 * Implements: WipError + classifyWipError + assertDomainAvailable + probeCapabilities (with mock session).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  WipError,
  classifyWipError,
  probeCapabilities,
  assertDomainAvailable,
} from '../build/src/capability.js';

describe('WipError', () => {
  test('preserves code and metadata', () => {
    const err = new WipError('DOMAIN_UNAVAILABLE', 'CSS not found', { domain: 'CSS', rawCode: -32601 });
    assert.equal(err.code, 'DOMAIN_UNAVAILABLE');
    assert.equal(err.domain, 'CSS');
    assert.equal(err.rawCode, -32601);
    assert.match(err.message, /CSS not found/);
    assert.equal(err.name, 'WipError');
    assert.ok(err instanceof Error);
  });

  test('toStructured emits machine-readable shape', () => {
    const err = new WipError('TIMEOUT', 'timed out', { domain: 'Page' });
    const out = err.toStructured();
    assert.equal(out.code, 'TIMEOUT');
    assert.equal(out.message, 'timed out');
    assert.equal(out.domain, 'Page');
    assert.ok(!('rawCode' in out), 'rawCode omitted when undefined');
  });
});

describe('classifyWipError', () => {
  test('identifies TIMEOUT from WipSession timeout message', () => {
    const e = classifyWipError(new Error('Timeout (5000ms) waiting for X (innerId=8)'), 'Page.reload');
    assert.equal(e.code, 'TIMEOUT');
    assert.equal(e.domain, 'Page');
  });

  test('identifies DOMAIN_UNAVAILABLE from "<Domain> domain was not found"', () => {
    const e = classifyWipError(new Error("Schema.getDomains failed: 'Schema' domain was not found"), 'Schema.getDomains');
    assert.equal(e.code, 'DOMAIN_UNAVAILABLE');
    assert.equal(e.domain, 'Schema');
    assert.equal(e.rawCode, -32601);
  });

  test('identifies METHOD_NOT_FOUND from generic "X was not found"', () => {
    const e = classifyWipError(new Error("Network.foo failed: 'Network.foo' was not found"), 'Network.foo');
    assert.equal(e.code, 'METHOD_NOT_FOUND');
    assert.equal(e.rawCode, -32601);
  });

  test('identifies INVALID_PARAMS', () => {
    const e = classifyWipError(new Error('IndexedDB.requestData failed: Invalid params: securityOrigin'), 'IndexedDB.requestData');
    assert.equal(e.code, 'INVALID_PARAMS');
    assert.equal(e.rawCode, -32602);
  });

  test('identifies TRANSPORT_ERROR from connection-state messages', () => {
    const e1 = classifyWipError(new Error('WipSession not connected (method=Runtime.evaluate)'), 'Runtime.evaluate');
    assert.equal(e1.code, 'TRANSPORT_ERROR');

    const e2 = classifyWipError(new Error('WipSession closed by peer'), 'Page.reload');
    assert.equal(e2.code, 'TRANSPORT_ERROR');
  });

  test('falls back to INTERNAL when no signal pattern matches', () => {
    const e = classifyWipError(new Error('something exotic'), 'Page.reload');
    assert.equal(e.code, 'INTERNAL');
  });

  test('domain extraction works for dotted method names', () => {
    const e = classifyWipError(new Error('whatever'), 'DOMDebugger.setEventBreakpoint');
    assert.equal(e.domain, 'DOMDebugger');
  });

  test('domain undefined when method has no dot', () => {
    const e = classifyWipError(new Error('whatever'), 'undottedmethod');
    assert.equal(e.domain, undefined);
  });
});

describe('assertDomainAvailable', () => {
  test('no-op when snapshot is undefined (probe not yet completed)', () => {
    assert.doesNotThrow(() => assertDomainAvailable(undefined, 'CSS'));
  });

  test('no-op when supportedDomains is undefined (Schema probe failed → optimistic)', () => {
    const snap = { probedAt: 'x', probeDurationMs: 0, schemaProbeSucceeded: false, sentinels: {}, notes: [] };
    assert.doesNotThrow(() => assertDomainAvailable(snap, 'CSS'));
  });

  test('no-op when supportedDomains has the domain', () => {
    const snap = { probedAt: 'x', probeDurationMs: 0, schemaProbeSucceeded: true, sentinels: {}, notes: [], supportedDomains: new Set(['Page', 'CSS']) };
    assert.doesNotThrow(() => assertDomainAvailable(snap, 'CSS'));
  });

  test('throws WipError DOMAIN_UNAVAILABLE when domain absent from supportedDomains', () => {
    const snap = { probedAt: 'x', probeDurationMs: 0, schemaProbeSucceeded: true, sentinels: {}, notes: [], supportedDomains: new Set(['Page']) };
    try {
      assertDomainAvailable(snap, 'CSS');
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof WipError, `expected WipError, got ${e.constructor.name}`);
      assert.equal(e.code, 'DOMAIN_UNAVAILABLE');
      assert.equal(e.domain, 'CSS');
    }
  });
});

describe('probeCapabilities', () => {
  test('returns snapshot with supportedDomains when Schema.getDomains succeeds', async () => {
    const session = mockSession({
      'Schema.getDomains': () => ({ domains: [{ domain: 'Page' }, { domain: 'Runtime' }, { domain: 'CSS' }] }),
    });
    const snap = await probeCapabilities(session);
    assert.equal(snap.schemaProbeSucceeded, true);
    assert.ok(snap.supportedDomains?.has('Page'));
    assert.ok(snap.supportedDomains?.has('CSS'));
    assert.equal(snap.supportedDomains?.size, 3);
    assert.match(snap.notes.join(' '), /3 domains/);
  });

  test('falls back gracefully when Schema.getDomains is unavailable', async () => {
    const session = mockSession({
      'Schema.getDomains': () => { throw new Error("Schema.getDomains failed: 'Schema' domain was not found"); },
    });
    const snap = await probeCapabilities(session);
    assert.equal(snap.schemaProbeSucceeded, false);
    assert.equal(snap.supportedDomains, undefined);
    assert.match(snap.notes.join(' '), /DOMAIN_UNAVAILABLE/);
  });

  test('records probeDurationMs', async () => {
    const session = mockSession({ 'Schema.getDomains': () => ({ domains: [] }) });
    const snap = await probeCapabilities(session);
    assert.ok(typeof snap.probeDurationMs === 'number');
    assert.ok(snap.probeDurationMs >= 0);
    assert.ok(snap.probeDurationMs < 5_000, `probeDurationMs=${snap.probeDurationMs} unexpectedly large`);
  });

  test('returns ISO timestamp in probedAt', async () => {
    const session = mockSession({ 'Schema.getDomains': () => ({ domains: [] }) });
    const snap = await probeCapabilities(session);
    assert.match(snap.probedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

/** Minimal WipSession-shaped mock — only `send` is exercised by probeCapabilities. */
function mockSession(handlers) {
  return {
    async send(method) {
      const h = handlers[method];
      if (!h) throw new Error(`mockSession: no handler for ${method}`);
      return h();
    },
    on() { return () => {}; },
    close() {},
    sendToTarget() { throw new Error('not implemented in mock'); },
  };
}
