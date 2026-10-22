import { statSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import { open, validate, type AsnResponse, type CountryResponse, type Reader } from 'maxmind';

import type { NetworkKind } from './personal-risk-rating.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §6.6 / §6.2 — the
// network-country and network-kind signals, from OFFLINE MaxMind GeoLite2
// databases (no request leaves the box).
//
// Architect ruling 2026-10-21: GeoLite2 is a RISK SIGNAL only — never proof of
// residence or identity, never a hard country block on its own. A missing,
// unreadable or silent database is UNKNOWN (country null), never evidence that
// the person is in (or outside) any country. Every lookup carries its evidence:
// the country (null = UNKNOWN), the lookup time and the database version (the
// mmdb metadata database type + build time), so each risk decision can record
// exactly what it saw. The databases are refreshed in place by MaxMind's
// geoipupdate; this adapter re-reads a replaced file without a restart.

export const GEO_IP_PORT = Symbol('GEO_IP_PORT');

/** One GeoIP lookup with its evidence. `country` null means UNKNOWN. */
export interface GeoIpLookup {
  /** ISO 3166-1 alpha-2 country of the IP, or null when unknown. */
  country: string | null;
  network_kind: NetworkKind;
  /** ISO time of the lookup. */
  looked_up_at: string;
  /** `<database type> <build time ISO>` of the country database, or null when none was readable. */
  db_version: string | null;
}

/** The geo evidence a risk decision records (Architect ruling 2026-10-21). */
export interface GeoEvidence {
  /** ISO alpha-2, or null = UNKNOWN (no database, no answer or a lookup error). */
  country: string | null;
  looked_up_at: string;
  db_version: string | null;
}

export function geoEvidenceOf(l: Pick<GeoIpLookup, 'country' | 'looked_up_at' | 'db_version'>): GeoEvidence {
  return { country: l.country, looked_up_at: l.looked_up_at, db_version: l.db_version };
}

/** The evidence for "nothing could be looked up" (no IP, or the port failed). */
export function unknownGeoEvidence(now: Date = new Date()): GeoEvidence {
  return { country: null, looked_up_at: now.toISOString(), db_version: null };
}

export interface GeoIpPort {
  /** ISO 3166-1 alpha-2 country of the IP, or null when unknown. */
  countryOf(ip: string): Promise<string | null>;
  networkKind(ip: string): Promise<NetworkKind>;
  /** Country + network kind + evidence in one call. Never throws: failure = UNKNOWN. */
  lookup(ip: string, now?: Date): Promise<GeoIpLookup>;
}

/** Look up through any port, turning a throwing port into UNKNOWN (callers never see an error). */
export async function safeGeoLookup(port: GeoIpPort, ip: string | null, now: Date = new Date()): Promise<GeoIpLookup> {
  if (ip === null || ip === 'unknown') return { ...unknownGeoEvidence(now), network_kind: 'unknown' };
  try {
    const r = await port.lookup(ip, now);
    return { ...r, country: r.country === null ? null : r.country.toUpperCase() };
  } catch {
    return { ...unknownGeoEvidence(now), network_kind: 'unknown' };
  }
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

/** How often (ms) the adapter checks whether a database file was replaced. */
export const GEOIP_RECHECK_MS = 60_000;

interface LoadedDb<T extends CountryResponse | AsnResponse> {
  reader: Reader<T> | null;
  // The file identity the reader was loaded from (null when nothing was loaded).
  stamp: string | null;
  checked_at: number;
}

export function mmdbVersion(reader: Pick<Reader<CountryResponse>, 'metadata'> | null): string | null {
  if (reader === null) return null;
  try {
    const at = reader.metadata.buildEpoch;
    const iso = at instanceof Date && !Number.isNaN(at.getTime()) ? at.toISOString() : 'unknown-build';
    return `${reader.metadata.databaseType ?? 'unknown'} ${iso}`;
  } catch {
    return null;
  }
}

export class MaxmindGeoIpAdapter implements GeoIpPort {
  private readonly logger = new Logger('MaxmindGeoIpAdapter');
  private readonly dbs = new Map<string, LoadedDb<CountryResponse | AsnResponse>>();
  private readonly loading = new Map<string, Promise<void>>();

  constructor(
    private readonly countryDbPath: string | undefined = process.env['SIGN_GEOIP_DB_PATH'],
    private readonly asnDbPath: string | undefined = process.env['SIGN_GEOIP_ASN_DB_PATH'],
    private readonly recheckMs: number = GEOIP_RECHECK_MS,
  ) {}

  /** The file's identity: a replaced file (the updater writes a new file and renames it) changes it. */
  private static stampOf(path: string): string | null {
    try {
      const st = statSync(path);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /**
   * The current reader for `path`, re-opened when the file was replaced since the
   * last check (checked at most every `recheckMs`). A database that cannot be read
   * keeps the last good reader; with none, null (UNKNOWN). Never throws.
   */
  private async reader<T extends CountryResponse | AsnResponse>(path: string | undefined, label: string): Promise<Reader<T> | null> {
    if (path === undefined || path.trim() === '') return null;
    const now = Date.now();
    const cur = this.dbs.get(path);
    if (cur !== undefined && now - cur.checked_at < this.recheckMs) return cur.reader as Reader<T> | null;
    const inflight = this.loading.get(path);
    if (inflight !== undefined) {
      await inflight;
      return (this.dbs.get(path)?.reader ?? null) as Reader<T> | null;
    }
    const p = this.refresh<T>(path, label, cur as LoadedDb<T> | undefined, now).finally(() => this.loading.delete(path));
    this.loading.set(path, p);
    await p;
    return (this.dbs.get(path)?.reader ?? null) as Reader<T> | null;
  }

  private async refresh<T extends CountryResponse | AsnResponse>(path: string, label: string, cur: LoadedDb<T> | undefined, now: number): Promise<void> {
    const stamp = MaxmindGeoIpAdapter.stampOf(path);
    if (stamp === null) {
      if (cur?.reader == null) this.logger.warn(`${label} database not found (lookups are UNKNOWN)`);
      // Keep a reader already loaded: the updater may be mid-replace.
      this.dbs.set(path, { reader: cur?.reader ?? null, stamp: cur?.stamp ?? null, checked_at: now });
      return;
    }
    if (cur !== undefined && cur.stamp === stamp) {
      this.dbs.set(path, { ...cur, checked_at: now });
      return;
    }
    try {
      const reader = await open<T>(path);
      this.dbs.set(path, { reader, stamp, checked_at: now });
      if (cur?.reader != null) this.logger.log(`${label} database reloaded (${mmdbVersion(reader as unknown as Reader<CountryResponse>) ?? 'unknown version'})`);
    } catch (err) {
      this.logger.warn(`${label} database unreadable (lookups are UNKNOWN unless an earlier copy is loaded): ${(err as Error).message}`);
      this.dbs.set(path, { reader: cur?.reader ?? null, stamp: cur?.stamp ?? null, checked_at: now });
    }
  }

  async countryOf(ip: string): Promise<string | null> {
    return (await this.lookupCountry(ip)).country;
  }

  private async lookupCountry(ip: string): Promise<{ country: string | null; db_version: string | null }> {
    try {
      const reader = await this.reader<CountryResponse>(this.countryDbPath, 'GeoLite2-Country');
      const db_version = mmdbVersion(reader);
      const addr = stripIpv6Mapped(ip);
      if (reader === null || !validate(addr)) return { country: null, db_version };
      const r = reader.get(addr);
      const iso = r?.country?.iso_code ?? r?.registered_country?.iso_code ?? null;
      return { country: typeof iso === 'string' && /^[A-Za-z]{2}$/.test(iso) ? iso.toUpperCase() : null, db_version };
    } catch {
      return { country: null, db_version: null };
    }
  }

  async networkKind(ip: string): Promise<NetworkKind> {
    try {
      const addr = stripIpv6Mapped(ip);
      if (!validate(addr)) return 'unknown';
      const reader = await this.reader<AsnResponse>(this.asnDbPath, 'GeoLite2-ASN');
      if (reader === null) return 'unknown';
      const org = reader.get(addr)?.autonomous_system_organization?.toLowerCase();
      if (org === undefined) return 'unknown';
      return HOSTING_ASN_KEYWORDS.some((k) => org.includes(k)) ? 'hosting' : 'residential';
    } catch {
      return 'unknown';
    }
  }

  async lookup(ip: string, now: Date = new Date()): Promise<GeoIpLookup> {
    const [c, network_kind] = await Promise.all([this.lookupCountry(ip), this.networkKind(ip)]);
    return { country: c.country, network_kind, looked_up_at: now.toISOString(), db_version: c.db_version };
  }
}
