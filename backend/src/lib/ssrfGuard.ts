// SSRF guard for routes that fetch a caller-supplied URL (POST /api/extract).
//
// requireAuth maps a missing or invalid token to a shared default user, so "behind requireAuth" is not a
// barrier: anyone could make the backend request http://169.254.169.254/, http://localhost:PORT/, or any
// private-network address and read the response back through the extraction result.
//
// Defences, in order:
//   1. Only http/https, no embedded credentials.
//   2. The host is resolved and EVERY returned address must be public (IP literals are checked directly).
//   3. Redirects are followed by the caller one hop at a time, re-running this check per hop.
//   4. guardedLookup() is installed on the HTTP agents so the address actually connected to is validated
//      too (closes the DNS-rebinding gap between the check and the connect).
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKS: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const n = ipv4ToInt(address);
    return !V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (ipv4ToInt(base) & mask);
    });
  }
  if (family === 6) {
    const a = address.toLowerCase().split('%')[0] ?? '';
    if (a === '::' || a === '::1') return false;
    // IPv4-mapped / compatible (::ffff:a.b.c.d or ::ffff:aabb:ccdd): judge the embedded IPv4 address.
    const dotted = a.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPublicAddress(dotted[1] ?? '');
    const hex = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1] ?? '0', 16);
      const lo = parseInt(hex[2] ?? '0', 16);
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
    if (a.startsWith('64:ff9b:')) return false; // NAT64 can reach IPv4 private space
    return true;
  }
  return false;
}

/** Throws SsrfBlockedError unless the URL is http(s) and resolves only to public addresses. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfBlockedError('Only http and https URLs are allowed');
  if (url.username || url.password) throw new SsrfBlockedError('URLs with credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new SsrfBlockedError('Host is not allowed');
  }
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new SsrfBlockedError('Host is not allowed');
    return url;
  }
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new SsrfBlockedError('Host could not be resolved');
  }
  if (addrs.length === 0 || addrs.some((a) => !isPublicAddress(a.address))) throw new SsrfBlockedError('Host is not allowed');
  return url;
}

/** dns.lookup replacement that refuses non-public results; install on http(s) agents. */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addrs) => {
    if (err) return callback(err, '', 0);
    const list = (addrs as unknown as dns.LookupAddress[]) ?? [];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      const e: NodeJS.ErrnoException = new SsrfBlockedError('Host is not allowed');
      e.code = 'ESSRFBLOCKED';
      return callback(e, '', 0);
    }
    if (options.all) return callback(null, list);
    const first0 = list[0]!;
    return callback(null, first0.address, first0.family);
  });
}

export const guardedHttpAgent = new http.Agent({ lookup: guardedLookup as net.LookupFunction });
export const guardedHttpsAgent = new https.Agent({ lookup: guardedLookup as net.LookupFunction });
