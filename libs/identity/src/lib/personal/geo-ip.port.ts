import { existsSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import { open, validate, type AsnResponse, type CountryResponse, type Reader } from 'maxmind';

import type { NetworkKind } from './personal-risk-rating.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §6.6 / §6.2 — the
// network-country and network-kind signals, from OFFLINE MaxMind GeoLite2
// databases (no request leaves the box). Operational controls, not proof of
// residence. Fail closed: no database / no answer ⇒ countryOf → null, which every
// caller treats as NOT eligible; networkKind → 'unknown'.

export const GEO_IP_PORT = Symbol('GEO_IP_PORT');

export interface GeoIpPort {
  /** ISO 3166-1 alpha-2 country of the IP, or null when unknown. */
  countryOf(ip: string): Promise<string | null>;
  networkKind(ip: string): Promise<NetworkKind>;
}

// Hosting / data-centre networks, matched against the GeoLite2-ASN organization
// name (lower-cased substring). Small and explainable on purpose.
export const HOSTING_ASN_KEYWORDS: readonly string[] = [
  'amazon',
  'aws',
  'google cloud',
  'google llc',
  'microsoft',
  'azure',
  'digitalocean',
  'linode',
  'akamai',
  'vultr',
  'choopa',
  'ovh',
  'hetzner',
  'contabo',
  'scaleway',
  'leaseweb',
  'oracle',
  'alibaba',
  'tencent',
  'm247',
  'datacamp',
  'cdn77',
  'hostinger',
  'hostwinds',
  'ionos',
  'colocrossing',
  'psychz',
  'quadranet',
  'hosting',
  'datacenter',
  'data center',
  'vpn',
];

function stripIpv6Mapped(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export class MaxmindGeoIpAdapter implements GeoIpPort {
  private readonly logger = new Logger('MaxmindGeoIpAdapter');
  private country?: Promise<Reader<CountryResponse> | null>;
  private asn?: Promise<Reader<AsnResponse> | null>;

  constructor(
    private readonly countryDbPath: string | undefined = process.env['SIGN_GEOIP_DB_PATH'],
    private readonly asnDbPath: string | undefined = process.env['SIGN_GEOIP_ASN_DB_PATH'],
  ) {}

  private load<T extends CountryResponse | AsnResponse>(path: string | undefined, label: string): Promise<Reader<T> | null> {
    if (path === undefined || path.trim() === '' || !existsSync(path)) {
      if (path !== undefined && path.trim() !== '') this.logger.warn(`${label} database not found (fail closed)`);
      return Promise.resolve(null);
    }
    return open<T>(path).catch((err: unknown) => {
      this.logger.warn(`${label} database unreadable (fail closed): ${(err as Error).message}`);
      return null;
    });
  }

  async countryOf(ip: string): Promise<string | null> {
    const addr = stripIpv6Mapped(ip);
    if (!validate(addr)) return null;
    this.country ??= this.load<CountryResponse>(this.countryDbPath, 'GeoLite2-Country');
    const reader = await this.country;
    if (reader === null) return null;
    try {
      const r = reader.get(addr);
      return r?.country?.iso_code ?? r?.registered_country?.iso_code ?? null;
    } catch {
      return null;
    }
  }

  async networkKind(ip: string): Promise<NetworkKind> {
    const addr = stripIpv6Mapped(ip);
    if (!validate(addr)) return 'unknown';
    this.asn ??= this.load<AsnResponse>(this.asnDbPath, 'GeoLite2-ASN');
    const reader = await this.asn;
    if (reader === null) return 'unknown';
    try {
      const org = reader.get(addr)?.autonomous_system_organization?.toLowerCase();
      if (org === undefined) return 'unknown';
      return HOSTING_ASN_KEYWORDS.some((k) => org.includes(k)) ? 'hosting' : 'residential';
    } catch {
      return 'unknown';
    }
  }
}
