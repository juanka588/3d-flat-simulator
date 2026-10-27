import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Expands an IPv6 literal to 8 16-bit groups; `undefined` if malformed. Handles `::` and a trailing dotted IPv4. */
function ipv6Groups(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1]!.split('.').map(Number);
    if (o.some((n) => n > 255)) return undefined;
    s = s.slice(0, -v4[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
}

function privateV4(o: readonly number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** True for any address a pasted URL must never reach: loopback, private, link-local, CGNAT, multicast, reserved, unspecified; also IPv4 hidden in IPv6 (mapped, NAT64, 6to4). Unparsable = refused. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, ''));
  const addr = ip.replace(/^\[|\]$/g, '');
  if (kind === 4) return privateV4(addr.split('.').map(Number));
  if (kind !== 6) return true;
  const g = ipv6Groups(addr);
  if (!g) return true;
  const embedded = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return privateV4(embedded(g[6]!, g[7]!)); // ::ffff:a.b.c.d, ::a.b.c.d (also :: and ::1)
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateV4(embedded(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return privateV4(embedded(g[1]!, g[2]!)); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home', '.corp', '.intranet'];

/** Default DNS: every address of the host. */
export async function dnsAll(hostname: string): Promise<string[]> {
  const r = await lookup(hostname, { all: true, verbatim: true });
  return r.map((x) => x.address);
}

export type HostVerdict = { ok: true; addresses: string[] } | { ok: false; reason: string };

/**
 * SSRF guard for one host name: not a local name, not a private IP literal, and EVERY address its DNS
 * answers is public (one private answer refuses the host: a rebinding record can mix them).
 */
export async function checkPublicHost(hostname: string, resolve: (h: string) => Promise<string[]> = dnsAll): Promise<HostVerdict> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (host === '' || host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { ok: false, reason: `${hostname} is a local name` };
  if (isIP(host)) return isPrivateAddress(host) ? { ok: false, reason: `${hostname} is a private or loopback address` } : { ok: true, addresses: [host] };
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return { ok: false, reason: `${hostname} does not resolve` };
  }
  if (addresses.length === 0) return { ok: false, reason: `${hostname} does not resolve` };
  const bad = addresses.find(isPrivateAddress);
  if (bad !== undefined) return { ok: false, reason: `${hostname} resolves to a private address (${bad})` };
  return { ok: true, addresses };
}
