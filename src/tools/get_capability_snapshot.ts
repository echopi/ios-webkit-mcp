/**
 * `get_capability_snapshot` — expose the WIP capability discovery snapshot to
 * LLM agents. Useful when the agent's earlier tool call hits a domain timeout
 * and it wants to know "is this method known to be unsupported on this device,
 * or is it just a transient timeout?".
 *
 * Surface mirrors `CapabilitySnapshot` from src/capability.ts — see spec
 * §"Capability discovery 架构 (v2.0.1)".
 */
import { PageSession } from '../page-session.js';

export const getCapabilitySnapshotTool = {
  name: 'get_capability_snapshot',
  description: [
    'Return the WIP capability discovery snapshot for the currently-attached page session.',
    'Tells you which Apple WIP domains the connected WebKit build supports (when `Schema.getDomains` is available; many iOS builds do NOT expose Schema, in which case `supportedDomains` is null and tool calls fall back to optimistic + tool-level timeout).',
    'Use to interpret prior `*_DOMAIN_UNAVAILABLE` errors or to plan whether to attempt CSS / Audit / Animation / Memory etc. methods.',
  ].join(' '),
  inputSchema: {},
  handler: async () => {
    let ps: PageSession;
    try { ps = await PageSession.get(); } catch (e) { return errorResult(`Unable to attach: ${describe(e)}`); }
    const snap = await ps.capability();
    const out = {
      probedAt: snap.probedAt,
      probeDurationMs: snap.probeDurationMs,
      schemaProbeSucceeded: snap.schemaProbeSucceeded,
      supportedDomains: snap.supportedDomains ? [...snap.supportedDomains].sort() : null,
      sentinels: snap.sentinels,
      notes: snap.notes,
      attachInfo: ps.attachInfo
        ? {
            deviceOSVersion: ps.attachInfo.deviceOSVersion,
            pageTitle: ps.attachInfo.pageTitle,
            pageUrl: ps.attachInfo.pageUrl,
            attachedAt: ps.attachInfo.attachedAt,
          }
        : null,
    };
    const text = '# get_capability_snapshot\n\n```json\n' + JSON.stringify(out, null, 2) + '\n```';
    return { content: [{ type: 'text' as const, text }] };
  },
};

function errorResult(text: string) { return { content: [{ type: 'text' as const, text }], isError: true }; }
function describe(e: unknown) { return e instanceof Error ? e.message : String(e); }
