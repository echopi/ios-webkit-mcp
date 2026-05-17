/**
 * JSON-RPC client for Apple WIP frames via ios_webkit_debug_proxy.
 *
 * **Wire format (verified 2026-05-16 on iOS 26.5.0 + iwdp v1.9.2)**:
 *
 * The top-level ws connection at `ws://<host>:<port>/devtools/page/N` only
 * exposes Apple's `Target.*` envelope domain. Real protocol domains
 * (Runtime / Network / DOM / Console / Debugger / Page) are NOT directly
 * callable on this connection — sending `Runtime.evaluate` at the top level
 * returns `-32601 'Runtime' domain was not found`.
 *
 * Apple's WIP uses a multi-target dispatch model:
 *
 *   ─── outbound (client → device) ─────────────────────────────────────────
 *     { id: <outerId>, method: "Target.sendMessageToTarget",
 *       params: { targetId, message: "<stringified inner JSON-RPC>" } }
 *
 *   ─── inbound  (device → client) ─────────────────────────────────────────
 *     { method: "Target.dispatchMessageFromTarget",
 *       params: { targetId, message: "<stringified inner JSON-RPC>" } }
 *
 *   ─── target lifecycle (passive notifications) ──────────────────────────
 *     { method: "Target.targetCreated", params: { targetInfo: {targetId, type} } }
 *     { method: "Target.targetDestroyed", params: { targetId } }
 *
 * Outer and inner JSON-RPC `id` sequences are independent. This class hides
 * all of that — callers just `send('Runtime.evaluate', {...})` and get back
 * the inner result.
 *
 * Spec source (planned): WebKit `Source/WebInspectorUI/Protocol/*.json`.
 */
import WebSocket from 'ws';

export interface WipTargetInfo {
  targetId: string;
  type: string;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

type EventHandler = (params: unknown) => void;

const DEBUG = process.env['WDM_WS_DEBUG'] === '1';

export class WipSession {
  private ws: WebSocket | undefined;
  private nextOuterId = 1;
  private nextInnerId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events = new Map<string, Set<EventHandler>>();
  private readonly targets = new Map<string, WipTargetInfo>();
  private pageTargetId: string | undefined;
  private pageTargetWaiters: Array<(t: WipTargetInfo) => void> = [];
  private closed = false;

  async connect(url: string, timeoutMs = 10_000): Promise<void> {
    if (this.ws) throw new Error('WipSession already connected');
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`Timeout (${timeoutMs}ms) connecting to ${url}`));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.once('error', err => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      ws.on('message', d => this.handleOuter(d));
      ws.on('close', () => this.handleClose());
    });
  }

  /**
   * Wait until a `Target.targetCreated` event with type=page arrives.
   * Resolves immediately if a page target has already been seen.
   */
  async waitForPageTarget(timeoutMs = 5_000): Promise<WipTargetInfo> {
    if (this.pageTargetId) return this.targets.get(this.pageTargetId)!;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pageTargetWaiters.indexOf(once);
        if (idx >= 0) this.pageTargetWaiters.splice(idx, 1);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for page target. Seen targets: ${[...this.targets.values()].map(t => `${t.targetId}(${t.type})`).join(', ') || '(none)'}`));
      }, timeoutMs);
      const once = (t: WipTargetInfo) => {
        clearTimeout(timer);
        resolve(t);
      };
      this.pageTargetWaiters.push(once);
    });
  }

  /**
   * Send an inner JSON-RPC request to the page target, wrapped in
   * Target.sendMessageToTarget. Resolves with the inner result.
   */
  send<R = unknown>(method: string, params?: unknown, timeoutMs = 15_000): Promise<R> {
    if (!this.ws || this.closed) {
      return Promise.reject(new Error(`WipSession not connected (method=${method})`));
    }
    if (!this.pageTargetId) {
      return Promise.reject(new Error(`No page target attached (call waitForPageTarget first). method=${method}`));
    }
    return this.sendToTarget<R>(this.pageTargetId, method, params, timeoutMs);
  }

  sendToTarget<R = unknown>(
    targetId: string,
    method: string,
    params?: unknown,
    timeoutMs = 15_000,
  ): Promise<R> {
    if (!this.ws || this.closed) {
      return Promise.reject(new Error(`WipSession not connected (method=${method})`));
    }
    const innerId = this.nextInnerId++;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(innerId);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${method} response (innerId=${innerId})`));
      }, timeoutMs);
      this.pending.set(innerId, {
        method,
        resolve: result => {
          clearTimeout(timer);
          resolve(result as R);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      });
      const inner = JSON.stringify({ id: innerId, method, params });
      const outer = JSON.stringify({
        id: this.nextOuterId++,
        method: 'Target.sendMessageToTarget',
        params: { targetId, message: inner },
      });
      if (DEBUG) process.stderr.write(`[wip-ws → ${targetId}] ${inner}\n`);
      this.ws!.send(outer, err => {
        if (err) {
          const p = this.pending.get(innerId);
          this.pending.delete(innerId);
          clearTimeout(timer);
          p?.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  /**
   * Subscribe to a domain event (e.g. `Console.messageAdded`,
   * `Network.requestWillBeSent`). Handlers receive the inner `params`.
   */
  on(event: string, handler: EventHandler): () => void {
    let set = this.events.get(event);
    if (!set) {
      set = new Set();
      this.events.set(event, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = undefined;
    }
  }

  getTargets(): WipTargetInfo[] {
    return [...this.targets.values()];
  }

  private handleOuter(data: WebSocket.RawData): void {
    let msg: unknown;
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const o = msg as Record<string, unknown>;

    // Outer-level event: Target.targetCreated / Target.targetDestroyed / Target.dispatchMessageFromTarget
    if (typeof o.method === 'string') {
      switch (o.method) {
        case 'Target.targetCreated': {
          const t = (o.params as Record<string, unknown> | undefined)?.['targetInfo'] as WipTargetInfo | undefined;
          if (t && typeof t.targetId === 'string') {
            this.targets.set(t.targetId, t);
            if (DEBUG) process.stderr.write(`[wip-ws target+] ${t.targetId} (${t.type})\n`);
            if (t.type === 'page' && !this.pageTargetId) {
              this.pageTargetId = t.targetId;
              const waiters = this.pageTargetWaiters.splice(0);
              for (const w of waiters) w(t);
            }
          }
          return;
        }
        case 'Target.targetDestroyed': {
          const tid = (o.params as Record<string, unknown> | undefined)?.['targetId'];
          if (typeof tid === 'string') {
            this.targets.delete(tid);
            if (this.pageTargetId === tid) this.pageTargetId = undefined;
            if (DEBUG) process.stderr.write(`[wip-ws target-] ${tid}\n`);
          }
          return;
        }
        case 'Target.dispatchMessageFromTarget': {
          const params = o.params as Record<string, unknown> | undefined;
          const inner = params?.['message'];
          if (typeof inner === 'string') {
            this.handleInner(inner);
          }
          return;
        }
        default:
          // Unknown outer event — pass through to subscribers for the event
          this.dispatchEvent(o.method, o.params);
          return;
      }
    }

    // Outer-level RPC response. Apple WIP ALWAYS sends `{result: {}, id: outerId}`
    // as a sendMessageToTarget ack — content is empty, the real inner response
    // (with method-specific result or error) arrives wrapped in
    // `Target.dispatchMessageFromTarget`. We log for debug but never resolve
    // pending from here.
    if (DEBUG && typeof o.id === 'number') {
      process.stderr.write(`[wip-ws outer ack] id=${o.id} ${JSON.stringify(o).slice(0, 200)}\n`);
    }
  }

  private handleInner(rawInner: string): void {
    if (DEBUG) process.stderr.write(`[wip-ws ←] ${rawInner.slice(0, 300)}\n`);
    let msg: unknown;
    try {
      msg = JSON.parse(rawInner);
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    const o = msg as Record<string, unknown>;

    if (typeof o.id === 'number') {
      const p = this.pending.get(o.id);
      if (!p) return;
      this.pending.delete(o.id);
      if (o.error) {
        const err = o.error as { code?: number; message?: string };
        p.reject(new Error(`${p.method} failed: ${err.message ?? JSON.stringify(o.error)}`));
      } else {
        p.resolve(o.result);
      }
      return;
    }

    if (typeof o.method === 'string') {
      this.dispatchEvent(o.method, o.params);
    }
  }

  private dispatchEvent(method: string, params: unknown): void {
    const handlers = this.events.get(method);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(params);
      } catch {
        // ignore handler error
      }
    }
  }

  private handleClose(): void {
    this.closed = true;
    const err = new Error('WipSession closed by peer');
    for (const p of this.pending.values()) {
      p.reject(err);
    }
    this.pending.clear();
    for (const w of this.pageTargetWaiters.splice(0)) {
      // Re-trigger waiters with a synthetic rejection through their promise chain — but we have no reject here.
      // Drop them: they'll time out via their own timer instead.
      void w;
    }
  }
}
