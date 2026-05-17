/**
 * Capability discovery — runtime detection of which WIP domains the
 * connected WebKit build actually supports.
 *
 * Motivated by iOS WKWebView (tested on iOS 26.5.0) hanging on `CSS.*`
 * (TIMEOUT, not -32601 NOT_FOUND). The WIP protocol declares CSS as always
 * available, but iOS WebKit runtime does not respond to CSS domain calls.
 * spec: docs/spec.md §"Capability discovery architecture".
 *
 * Strategy:
 *   1. Try `Schema.getDomains` first — canonical Apple WIP discovery method.
 *   2. If that fails (-32601), probe a curated CSS sentinel (CSS.enable with
 *      a short timeout) — TIMEOUT means the fork omitted the domain even if
 *      it would respond -32601 to other calls.
 *
 * The probe runs async after page attach so tool calls are not blocked. Tool
 * handlers may consult `PageSession.capability()` to fail-fast with a
 * structured `WipError` instead of waiting for a 15s timeout.
 */
import type { WipSession } from './wip-client/ws-session.js';

export type WipErrorCode =
  | 'DOMAIN_UNAVAILABLE'
  | 'METHOD_NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'TIMEOUT'
  | 'TRANSPORT_ERROR'
  | 'INTERNAL';

export class WipError extends Error {
  readonly code: WipErrorCode;
  readonly domain?: string;
  readonly rawCode?: number;
  readonly fallback?: string;

  constructor(code: WipErrorCode, message: string, opts?: { domain?: string; rawCode?: number; fallback?: string }) {
    super(message);
    this.name = 'WipError';
    this.code = code;
    this.domain = opts?.domain;
    this.rawCode = opts?.rawCode;
    this.fallback = opts?.fallback;
  }

  toStructured(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.domain !== undefined ? { domain: this.domain } : {}),
      ...(this.rawCode !== undefined ? { rawCode: this.rawCode } : {}),
      ...(this.fallback !== undefined ? { fallback: this.fallback } : {}),
    };
  }
}

/**
 * Map a raw WIP error response (or thrown Error) to a WipError with code.
 * `code === -32601` → METHOD_NOT_FOUND (or DOMAIN_UNAVAILABLE if message
 * contains "domain was not found"). `-32602` → INVALID_PARAMS. Plain timeout
 * messages from `WipSession.send` → TIMEOUT.
 */
export function classifyWipError(err: unknown, method: string): WipError {
  const msg = err instanceof Error ? err.message : String(err);
  // Match patterns from WipSession.handleInner reject + connect/send timeout
  // strings.
  if (/Timeout \(\d+ms\)/.test(msg)) {
    return new WipError('TIMEOUT', msg, { domain: domainOf(method) });
  }
  // WipSession threw the legacy "<method> failed: <wip-error.message>" format.
  // Check for known sentinel substrings in the WIP-side message.
  const domainMatch = msg.match(/'([A-Z][A-Za-z0-9]+)' domain was not found/);
  if (domainMatch) {
    return new WipError('DOMAIN_UNAVAILABLE', msg, { domain: domainMatch[1], rawCode: -32601 });
  }
  if (/'[^']+' was not found/.test(msg)) {
    return new WipError('METHOD_NOT_FOUND', msg, { domain: domainOf(method), rawCode: -32601 });
  }
  if (/Invalid params|expected/i.test(msg)) {
    return new WipError('INVALID_PARAMS', msg, { domain: domainOf(method), rawCode: -32602 });
  }
  if (/WipSession not connected|closed by peer/.test(msg)) {
    return new WipError('TRANSPORT_ERROR', msg, { domain: domainOf(method) });
  }
  return new WipError('INTERNAL', msg, { domain: domainOf(method) });
}

function domainOf(method: string): string | undefined {
  const idx = method.indexOf('.');
  return idx > 0 ? method.slice(0, idx) : undefined;
}

export interface CapabilitySnapshot {
  /** ISO timestamp of probe completion. */
  probedAt: string;
  /** ms it took to complete all probes. */
  probeDurationMs: number;
  /** Domains reported by Schema.getDomains, lowercased to set membership. undefined if Schema unavailable. */
  supportedDomains?: Set<string>;
  /** True iff Schema.getDomains succeeded. False if probe fell back to sentinels. */
  schemaProbeSucceeded: boolean;
  /** Curated sentinel results: domain → 'ok' | 'timeout' | 'not-found' | 'invalid-params'. */
  sentinels: Record<string, 'ok' | 'timeout' | 'not-found' | 'invalid-params' | 'error'>;
  /** Free-form notes (e.g. "CSS.enable hung after 3s — iOS WKWebView runtime no-op on CSS domain"). */
  notes: string[];
}

/**
 * Sentinels for Schema-fallback domain probing. **Important constraint**: any
 * method that *hangs* (no response within `timeoutMs`) blocks every concurrent
 * tool call on the same ws — Apple WIP serializes per-target message
 * processing. So sentinels MUST be methods that always reply quickly (success
 * or `-32601 NOT_FOUND`), never methods known to hang.
 *
 * CSS.* is intentionally NOT a sentinel: `CSS.enable` hangs on iOS 26.5 (real
 * receipt 2026-05-17). Detection of CSS unavailability happens via:
 *   ① Schema.getDomains absence of "CSS" entry, OR
 *   ② tool-level timeout when a CSS-dependent tool eventually ships.
 *
 * Currently empty — all batch-13 Must tools live in domains we already have
 * positive matrix coverage for.
 */
const SENTINEL_PROBES: Array<{ domain: string; method: string; params?: unknown; timeoutMs: number }> = [];

export async function probeCapabilities(session: WipSession): Promise<CapabilitySnapshot> {
  const startedAt = Date.now();
  const sentinels: Record<string, 'ok' | 'timeout' | 'not-found' | 'invalid-params' | 'error'> = {};
  const notes: string[] = [];
  let supportedDomains: Set<string> | undefined;
  let schemaProbeSucceeded = false;

  // Step 1: Schema.getDomains.
  try {
    const result = await session.send<{ domains?: Array<{ domain?: string }> }>(
      'Schema.getDomains',
      undefined,
      3_000,
    );
    if (Array.isArray(result?.domains)) {
      supportedDomains = new Set(
        result.domains
          .map(d => (typeof d?.domain === 'string' ? d.domain : ''))
          .filter(Boolean),
      );
      schemaProbeSucceeded = true;
      notes.push(`Schema.getDomains → ${supportedDomains.size} domains`);
    } else {
      notes.push(`Schema.getDomains returned no domains[] array`);
    }
  } catch (e) {
    const err = classifyWipError(e, 'Schema.getDomains');
    notes.push(`Schema.getDomains ${err.code}: ${err.message.slice(0, 80)}`);
  }

  // Step 2: Sentinel probes — currently CSS only.
  await Promise.all(
    SENTINEL_PROBES.map(async ({ domain, method, params, timeoutMs }) => {
      try {
        await session.send(method, params, timeoutMs);
        sentinels[domain] = 'ok';
      } catch (e) {
        const err = classifyWipError(e, method);
        if (err.code === 'TIMEOUT') sentinels[domain] = 'timeout';
        else if (err.code === 'DOMAIN_UNAVAILABLE' || err.code === 'METHOD_NOT_FOUND') sentinels[domain] = 'not-found';
        else if (err.code === 'INVALID_PARAMS') sentinels[domain] = 'invalid-params';
        else sentinels[domain] = 'error';
      }
    }),
  );

  // Step 3: Cross-check Schema vs sentinels — capture "claimed but hung" cases.
  for (const { domain } of SENTINEL_PROBES) {
    const sentinel = sentinels[domain];
    if (sentinel === 'timeout' && supportedDomains?.has(domain)) {
      notes.push(`⚠ ${domain} domain reported by Schema but ${domain}.* hung — likely WebKit fork omits implementation. Treating as unavailable.`);
      supportedDomains.delete(domain);
    }
  }

  return {
    probedAt: new Date(startedAt).toISOString(),
    probeDurationMs: Date.now() - startedAt,
    supportedDomains,
    schemaProbeSucceeded,
    sentinels,
    notes,
  };
}

/**
 * Convenience: throw a structured WipError if the snapshot tells us the
 * required domain is unavailable. No-op if `supportedDomains` is undefined
 * (Schema probe failed → assume optimistic).
 */
export function assertDomainAvailable(snap: CapabilitySnapshot | undefined, domain: string): void {
  if (!snap || !snap.supportedDomains) return; // optimistic when discovery failed
  if (!snap.supportedDomains.has(domain)) {
    throw new WipError(
      'DOMAIN_UNAVAILABLE',
      `${domain} domain is not supported on this WebKit build. ` +
        `Schema.getDomains did not list it (probedAt=${snap.probedAt}).`,
      { domain, fallback: undefined },
    );
  }
}
