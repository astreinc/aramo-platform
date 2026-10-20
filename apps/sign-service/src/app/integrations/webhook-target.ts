import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// Sign Unified Product S-5 — SSRF guard for tenant-configured webhook targets.
// A target configured in the workspace must be public HTTPS on the default
// port, carry no credentials, and resolve ONLY to public addresses — checked when
// it is saved AND again at every delivery (DNS can change). Operator-created
// first-party targets (`internal`) are exempt: they live on the private network.

export type TargetRefusal = 'not_https' | 'credentials_in_url' | 'port_not_allowed' | 'private_address' | 'unresolvable' | 'invalid_url';

function privateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateV4(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('ff');
}

export function checkTargetShape(target: string): TargetRefusal | null {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return 'invalid_url';
  }
  if (u.protocol !== 'https:') return 'not_https';
  if (u.username !== '' || u.password !== '') return 'credentials_in_url';
  if (u.port !== '' && u.port !== '443') return 'port_not_allowed';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return 'private_address';
  if (isIP(host) !== 0 && isPrivateAddress(host)) return 'private_address';
  return null;
}

export async function checkTargetResolves(target: string, resolver: (h: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true })): Promise<TargetRefusal | null> {
  const shape = checkTargetShape(target);
  if (shape !== null) return shape;
  const host = new URL(target).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return null;
  let addrs: { address: string }[];
  try {
    addrs = await resolver(host);
  } catch {
    return 'unresolvable';
  }
  if (addrs.length === 0) return 'unresolvable';
  return addrs.some((a) => isPrivateAddress(a.address)) ? 'private_address' : null;
}
