/**
 * Singleton-ish persistent WIP page session shared by stream-based tools
 * (list_console_messages / list_network_requests / take_snapshot).
 *
 * Lifecycle:
 *   - Lazy: created on first PageSession.get() call.
 *   - Picks the first WKWebView page (filters out JSCore workers).
 *   - Enables Console + Network + Runtime + DOM domains (each `enable` is
 *     try-best-effort; failures are logged but don't abort).
 *   - Subscribes Console.messageAdded / Runtime.exceptionThrown /
 *     Network.requestWillBeSent / responseReceived / loadingFailed and
 *     fills rolling buffers (default cap 200 each).
 *   - On ws close / target destroyed, marks itself stale; next get() rebuilds.
 *
 * Each tool calls `await PageSession.get()` then queries buffers or calls
 * the underlying `session.send(...)` for one-shot RPCs.
 */
import { fetchProxyDevices, fetchDevicePages, type DevicePage } from './wip-client/iwdp-http.js';
import { WipSession } from './wip-client/ws-session.js';
import { probeCapabilities, type CapabilitySnapshot } from './capability.js';

const DEFAULT_PROXY_BASE = 'http://127.0.0.1:9221';
const DEFAULT_BUFFER_CAP = 200;

export interface ConsoleEntry {
  source: 'Console.messageAdded' | 'Runtime.exceptionThrown';
  level: string; // log/warning/error/debug/info; for exceptions: 'error'
  text: string;
  url?: string;
  line?: number;
  column?: number;
  timestamp?: number;
  args?: unknown[];
  stackTrace?: unknown;
  raw: unknown;
}

export interface NetworkEntry {
  requestId: string;
  url: string;
  method?: string;
  status?: number;
  statusText?: string;
  mimeType?: string;
  type?: string; // CDP `type`: XHR, Fetch, Document, Script, ...
  initiatorType?: string;
  startedAt?: number;
  endedAt?: number;
  encodedDataLength?: number;
  errorText?: string;
  state: 'pending' | 'response-received' | 'finished' | 'failed';
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  postData?: string;
}

/**
 * batch-14 frozen contract for `Network.requestIntercepted` (cross-review v2.0.1):
 *  - 30s auto-continue if not consumed
 *  - 16 max concurrent pending; oldest auto-continued when overflow
 *  - explicit `abort=true` for block; default = continue
 */
export interface InterceptedRequest {
  requestId: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  postData?: string;
  stage?: string;
  arrivedAt: number;
  autoContinueTimer?: ReturnType<typeof setTimeout>;
}
export const INTERCEPT_AUTO_CONTINUE_MS = 30_000;
export const INTERCEPT_MAX_PENDING = 16;

export interface AttachInfo {
  deviceId: string;
  deviceOSVersion?: string;
  pageId: string;
  pageTitle: string;
  pageUrl: string;
  webSocketDebuggerUrl: string;
  targetId?: string;
  attachedAt: number;
}

export class PageSession {
  private static cached: PageSession | undefined;

  static async get(opts?: { proxyDeviceListUrl?: string; bufferCap?: number; pageId?: string }): Promise<PageSession> {
    if (PageSession.cached && PageSession.cached.alive) {
      if (opts?.pageId && PageSession.cached.attachInfo?.pageId !== opts.pageId) {
        PageSession.cached.close();
        PageSession.cached = undefined;
      } else {
        return PageSession.cached;
      }
    }
    if (PageSession.cached) {
      PageSession.cached.close();
    }
    const ps = new PageSession(opts?.bufferCap ?? DEFAULT_BUFFER_CAP);
    await ps.init(opts?.proxyDeviceListUrl ?? DEFAULT_PROXY_BASE, opts?.pageId);
    PageSession.cached = ps;
    return ps;
  }

  static reset(): void {
    if (PageSession.cached) {
      PageSession.cached.close();
      PageSession.cached = undefined;
    }
  }

  readonly session = new WipSession();
  readonly consoleBuffer: ConsoleEntry[] = [];
  readonly networkBuffer: NetworkEntry[] = [];
  readonly networkById = new Map<string, NetworkEntry>();
  readonly intercepted = new Map<string, InterceptedRequest>();
  attachInfo: AttachInfo | undefined;
  enableErrors: Array<{ method: string; error: string }> = [];
  private alive = false;
  private readonly cap: number;
  private capabilityPromise: Promise<CapabilitySnapshot> | undefined;
  private capabilitySnapshot: CapabilitySnapshot | undefined;

  private constructor(bufferCap: number) {
    this.cap = bufferCap;
  }

  isAlive(): boolean {
    return this.alive;
  }

  close(): void {
    this.alive = false;
    this.session.close();
  }

  private async init(proxyBase: string, pageId?: string): Promise<void> {
    // 1. Pick the requested pageId, else first non-worker WKWebView page across devices.
    const devices = await fetchProxyDevices(proxyBase);
    if (devices.length === 0) {
      throw new Error('No iOS devices found via ios_webkit_debug_proxy. Connect iPhone, enable Web Inspector, ensure proxy is running.');
    }
    let chosenDev;
    let chosenPage: DevicePage | undefined;
    for (const dev of devices) {
      const pages = await fetchDevicePages(dev.url);
      let page;
      if (pageId) {
        page = pages.find(p => p.id === pageId);
      } else {
        page = pages.find(p => p.url && !p.title.startsWith('jsi_'));
      }
      if (page) {
        chosenDev = dev;
        chosenPage = page;
        break;
      }
    }
    if (!chosenDev || !chosenPage) {
      throw new Error(pageId
        ? `pageId ${JSON.stringify(pageId)} not found on any device. Run \`list_pages\` to enumerate.`
        : 'No inspectable WKWebView page found. Open a WebView page in the target app first (see `list_pages`).');
    }

    // 2. Connect + wait for page target.
    await this.session.connect(chosenPage.webSocketDebuggerUrl);
    const target = await this.session.waitForPageTarget();

    // 3. Wire event subscribers BEFORE enabling, so the first event isn't lost.
    this.session.on('Console.messageAdded', params => this.recordConsoleMessageAdded(params));
    this.session.on('Runtime.exceptionThrown', params => this.recordRuntimeException(params));
    this.session.on('Network.requestWillBeSent', params => this.recordNetworkRequestWillBeSent(params));
    this.session.on('Network.responseReceived', params => this.recordNetworkResponseReceived(params));
    this.session.on('Network.loadingFinished', params => this.recordNetworkLoadingFinished(params));
    this.session.on('Network.loadingFailed', params => this.recordNetworkLoadingFailed(params));
    this.session.on('Network.requestIntercepted', params => this.recordRequestIntercepted(params));

    // 4. Enable domains best-effort. WIP support varies — collect failures, don't abort.
    for (const m of ['Console.enable', 'Network.enable', 'Runtime.enable', 'DOM.enable']) {
      try {
        await this.session.send(m, undefined, 5_000);
      } catch (e) {
        this.enableErrors.push({ method: m, error: e instanceof Error ? e.message : String(e) });
      }
    }

    this.attachInfo = {
      deviceId: chosenDev.deviceId,
      deviceOSVersion: chosenDev.deviceOSVersion,
      pageId: chosenPage.id,
      pageTitle: chosenPage.title,
      pageUrl: chosenPage.url,
      webSocketDebuggerUrl: chosenPage.webSocketDebuggerUrl,
      targetId: target.targetId,
      attachedAt: Date.now(),
    };
    this.alive = true;

    // 5. Async fire-and-forget capability probe. Tools may consult `capability()`
    //    to fail-fast with DOMAIN_UNAVAILABLE before issuing doomed RPCs.
    //    NOTE: Sentinels that *hang* (e.g. CSS.* on iOS 26.5) are NOT included
    //    in probeCapabilities — Apple WIP serializes per-target responses, so a
    //    hanging probe blocks every concurrent tool call on the shared ws.
    //    Instead, we rely on Schema.getDomains where available + tool-level
    //    timeout fallback for unknown WebKit builds.
    this.capabilityPromise = probeCapabilities(this.session)
      .then(snap => {
        this.capabilitySnapshot = snap;
        return snap;
      })
      .catch(e => {
        // Probe itself failed (rare). Synthesize an "unknown" snapshot so
        // capability() resolves rather than hanging future awaiters.
        const fallback: CapabilitySnapshot = {
          probedAt: new Date().toISOString(),
          probeDurationMs: 0,
          supportedDomains: undefined,
          schemaProbeSucceeded: false,
          sentinels: {},
          notes: [`probe rejected: ${e instanceof Error ? e.message : String(e)}`],
        };
        this.capabilitySnapshot = fallback;
        return fallback;
      });
  }

  /**
   * Returns the capability snapshot synchronously if the background probe has
   * completed, else `undefined`. Tools that want to fail fast should call
   * `await pageSession.capability()` instead.
   */
  capabilitySync(): CapabilitySnapshot | undefined {
    return this.capabilitySnapshot;
  }

  /** Awaits capability probe completion. Resolves immediately if already done. */
  async capability(): Promise<CapabilitySnapshot> {
    if (this.capabilitySnapshot) return this.capabilitySnapshot;
    if (this.capabilityPromise) return this.capabilityPromise;
    throw new Error('PageSession.capability() called before init() — should be unreachable');
  }

  private push<T>(buf: T[], entry: T): void {
    buf.push(entry);
    if (buf.length > this.cap) {
      buf.splice(0, buf.length - this.cap);
    }
  }

  private recordConsoleMessageAdded(p: unknown): void {
    const params = (p as { message?: Record<string, unknown> })?.message;
    if (!params || typeof params !== 'object') return;
    const msg = params as Record<string, unknown>;
    this.push(this.consoleBuffer, {
      source: 'Console.messageAdded',
      level: String(msg.level ?? 'log'),
      text: String(msg.text ?? ''),
      url: typeof msg.url === 'string' ? msg.url : undefined,
      line: typeof msg.line === 'number' ? msg.line : undefined,
      column: typeof msg.column === 'number' ? msg.column : undefined,
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
      args: Array.isArray(msg.parameters) ? msg.parameters : undefined,
      stackTrace: msg.stackTrace,
      raw: msg,
    });
  }

  private recordRuntimeException(p: unknown): void {
    const params = p as Record<string, unknown> | undefined;
    if (!params) return;
    const details = params.exceptionDetails as Record<string, unknown> | undefined;
    this.push(this.consoleBuffer, {
      source: 'Runtime.exceptionThrown',
      level: 'error',
      text: String(details?.text ?? details?.exception ?? 'Uncaught exception'),
      url: typeof details?.url === 'string' ? details.url : undefined,
      line: typeof details?.lineNumber === 'number' ? details.lineNumber : undefined,
      column: typeof details?.columnNumber === 'number' ? details.columnNumber : undefined,
      timestamp: typeof params.timestamp === 'number' ? params.timestamp : undefined,
      stackTrace: details?.stackTrace,
      raw: params,
    });
  }

  private upsertNetwork(requestId: string, mutator: (e: NetworkEntry) => void): void {
    let entry = this.networkById.get(requestId);
    if (!entry) {
      entry = { requestId, url: '', state: 'pending' };
      this.networkById.set(requestId, entry);
      this.push(this.networkBuffer, entry);
    }
    mutator(entry);
  }

  private recordNetworkRequestWillBeSent(p: unknown): void {
    const params = p as Record<string, unknown> | undefined;
    if (!params || typeof params.requestId !== 'string') return;
    const req = params.request as Record<string, unknown> | undefined;
    this.upsertNetwork(params.requestId, e => {
      e.url = typeof req?.url === 'string' ? req.url : e.url;
      e.method = typeof req?.method === 'string' ? req.method : e.method;
      e.type = typeof params.type === 'string' ? params.type : e.type;
      const initiator = params.initiator as Record<string, unknown> | undefined;
      e.initiatorType = typeof initiator?.type === 'string' ? initiator.type : e.initiatorType;
      e.startedAt = typeof params.timestamp === 'number' ? params.timestamp : e.startedAt;
      const headers = req?.headers;
      if (headers && typeof headers === 'object') {
        e.requestHeaders = headers as Record<string, string>;
      }
      const postData = req?.postData;
      if (typeof postData === 'string') e.postData = postData;
    });
  }

  private recordNetworkResponseReceived(p: unknown): void {
    const params = p as Record<string, unknown> | undefined;
    if (!params || typeof params.requestId !== 'string') return;
    const res = params.response as Record<string, unknown> | undefined;
    this.upsertNetwork(params.requestId, e => {
      e.state = 'response-received';
      e.status = typeof res?.status === 'number' ? res.status : e.status;
      e.statusText = typeof res?.statusText === 'string' ? res.statusText : e.statusText;
      e.mimeType = typeof res?.mimeType === 'string' ? res.mimeType : e.mimeType;
      e.type = typeof params.type === 'string' ? params.type : e.type;
      const headers = res?.headers;
      if (headers && typeof headers === 'object') {
        e.responseHeaders = headers as Record<string, string>;
      }
    });
  }

  private recordNetworkLoadingFinished(p: unknown): void {
    const params = p as Record<string, unknown> | undefined;
    if (!params || typeof params.requestId !== 'string') return;
    this.upsertNetwork(params.requestId, e => {
      e.state = 'finished';
      e.endedAt = typeof params.timestamp === 'number' ? params.timestamp : e.endedAt;
      e.encodedDataLength = typeof params.encodedDataLength === 'number' ? params.encodedDataLength : e.encodedDataLength;
    });
  }

  private recordNetworkLoadingFailed(p: unknown): void {
    const params = p as Record<string, unknown> | undefined;
    if (!params || typeof params.requestId !== 'string') return;
    this.upsertNetwork(params.requestId, e => {
      e.state = 'failed';
      e.errorText = typeof params.errorText === 'string' ? params.errorText : e.errorText;
      e.endedAt = typeof params.timestamp === 'number' ? params.timestamp : e.endedAt;
    });
  }

  private recordRequestIntercepted(p: unknown): void {
    const params = p as Record<string, unknown> | undefined;
    if (!params || typeof params.requestId !== 'string') return;
    const requestId = params.requestId;
    const req = params.request as Record<string, unknown> | undefined;
    const entry: InterceptedRequest = {
      requestId,
      url: typeof req?.url === 'string' ? req.url : '',
      method: typeof req?.method === 'string' ? req.method : undefined,
      headers: req?.headers && typeof req.headers === 'object' ? (req.headers as Record<string, string>) : undefined,
      postData: typeof req?.postData === 'string' ? req.postData : undefined,
      stage: typeof params.stage === 'string' ? params.stage : undefined,
      arrivedAt: Date.now(),
    };
    // Enforce 16-pending cap: oldest is auto-continued and dropped.
    if (this.intercepted.size >= INTERCEPT_MAX_PENDING) {
      const oldest = this.intercepted.entries().next().value;
      if (oldest) {
        const [oldestId, oldestEntry] = oldest as [string, InterceptedRequest];
        if (oldestEntry.autoContinueTimer) clearTimeout(oldestEntry.autoContinueTimer);
        this.intercepted.delete(oldestId);
        // Best-effort auto-continue.
        this.session.send('Network.interceptContinue', { requestId: oldestId }, 5_000).catch(() => { /* ignore */ });
      }
    }
    // 30s auto-continue if not consumed by tool.
    entry.autoContinueTimer = setTimeout(() => {
      if (this.intercepted.has(requestId)) {
        this.intercepted.delete(requestId);
        this.session.send('Network.interceptContinue', { requestId }, 5_000).catch(() => { /* ignore */ });
      }
    }, INTERCEPT_AUTO_CONTINUE_MS);
    this.intercepted.set(requestId, entry);
  }

  /** Drain an intercepted request's bookkeeping. Called when a tool consumes
   *  the request via continue/respond — clears auto-continue timer and removes
   *  from the pending map. Returns the entry if it existed. */
  consumeIntercepted(requestId: string): InterceptedRequest | undefined {
    const entry = this.intercepted.get(requestId);
    if (!entry) return undefined;
    if (entry.autoContinueTimer) clearTimeout(entry.autoContinueTimer);
    this.intercepted.delete(requestId);
    return entry;
  }
}
