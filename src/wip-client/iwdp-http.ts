/**
 * Minimal HTTP client for ios_webkit_debug_proxy's HTTP endpoints.
 *
 * Endpoint shapes (verified against v1.9.2 default config `null:9221,:9222-9322`):
 *
 *   GET http://127.0.0.1:9221/json            → array of devices with `url` pointing to per-device port
 *   GET http://127.0.0.1:<devicePort>/json/list → array of inspectable pages on that device
 *
 * The returned `webSocketDebuggerUrl` looks like CDP but frames are Apple WIP (proxy is transport, not translator).
 */
import { request as httpRequest } from 'node:http';

export interface ProxyDevice {
  deviceId: string;
  deviceName: string;
  deviceOSVersion?: string;
  url: string;
}

export interface DevicePage {
  id: string;
  title: string;
  url: string;
  type?: string;
  webSocketDebuggerUrl: string;
  webkitVersion?: string;
  description?: string;
}

export async function fetchProxyDevices(deviceListBaseUrl: string): Promise<ProxyDevice[]> {
  const json = await httpGetJson(stripTrailingSlash(deviceListBaseUrl) + '/json');
  if (!Array.isArray(json)) return [];
  return json
    .map((entry): ProxyDevice | null => {
      const url = (entry as Record<string, unknown>).url;
      if (typeof url !== 'string' || url.length === 0) return null;
      const r = entry as Record<string, unknown>;
      return {
        deviceId: String(r.deviceId ?? 'unknown'),
        deviceName: String(r.deviceName ?? ''),
        deviceOSVersion: typeof r.deviceOSVersion === 'string' ? r.deviceOSVersion : undefined,
        url,
      };
    })
    .filter((d): d is ProxyDevice => d !== null);
}

export async function fetchDevicePages(deviceUrl: string): Promise<DevicePage[]> {
  const baseUrl = normalizeToHttp(deviceUrl);
  const json = await httpGetJson(baseUrl + '/json/list');
  if (!Array.isArray(json)) return [];
  return json.map((p): DevicePage => {
    const o = p as Record<string, unknown>;
    const wsUrl = typeof o.webSocketDebuggerUrl === 'string' ? o.webSocketDebuggerUrl : '';
    // /json/list response on ios_webkit_debug_proxy v1.9.2 omits `id`;
    // the page id is the trailing segment of `webSocketDebuggerUrl` (e.g. ".../devtools/page/7" → "7").
    const idFromField = typeof o.id === 'string' || typeof o.id === 'number' ? String(o.id) : '';
    const idFromUrl = wsUrl.match(/\/devtools\/page\/([^/?]+)$/)?.[1] ?? '';
    return {
      id: idFromField || idFromUrl,
      title: typeof o.title === 'string' ? o.title : '',
      url: typeof o.url === 'string' ? o.url : '',
      type: typeof o.type === 'string' ? o.type : undefined,
      webSocketDebuggerUrl: wsUrl,
      webkitVersion: typeof o.webkitVersion === 'string' ? o.webkitVersion : undefined,
      description: typeof o.description === 'string' ? o.description : undefined,
    };
  });
}

function normalizeToHttp(input: string): string {
  let s = stripTrailingSlash(input);
  if (s.startsWith('ws://')) s = 'http://' + s.slice('ws://'.length);
  else if (s.startsWith('wss://')) s = 'https://' + s.slice('wss://'.length);
  else if (!/^https?:\/\//.test(s)) s = 'http://' + s;
  return s;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function httpGetJson(urlStr: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: timeoutMs,
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode} from ${urlStr}: ${body.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`Non-JSON response from ${urlStr}: ${body.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Timeout (${timeoutMs}ms) fetching ${urlStr}`)));
    req.end();
  });
}
