import type { FactState, ProfileFactType } from '@aramo/intelligence-contracts';
import { PROFILE_FACT_TYPES } from '@aramo/intelligence-contracts';

import { canonicalJson, namesConflict, normalizeNames, sha256Hex, type NameSnapshot } from '../normalize.js';
import type { JsonObject, TrustStateRow } from '../repositories/types.js';
import { PROJECTED_ASSERTION_STATUSES, type AssertionStatus } from '../vocabulary.js';

import { deriveTrust, independenceKey } from './trust-derivation.js';

// ATI-SEP-1 T5 — the PURE projection: assertions (+ identifiers) of one VIEW of
// a subject → resolved facts, the status each assertion has in that view,
// contradiction pairs, time-based staleness and the trust state. No I/O; the
// ProjectionService persists what this returns (full Golden view), and the read
// API computes a TENANT_SCOPED view on the fly from a filtered set.
//
// Tie-breakers (deterministic, in order) between incompatible claimed values
// of one fact:
//   0. WORK_AUTHORIZATION only: TI-authoritative values first (TI-1G)
//   1. verification_status   VERIFIED > DOCUMENT_SUPPORTED > DECLARED
//   2. source independence    more distinct independent sources (tenants) first —
//                             repeated claims of one source count once
//   3. recency               latest observed_at first
//   4. assertion id          (stable final order)
// AVAILABILITY is temporal: verification, then recency (corroboration of an old
// value never beats a fresher one).
//
// Contradictions: the same fact (fact_key) with incompatible values from
// DIFFERENT source references → a pair (losing member, winning representative);
// both are CONTRADICTED in this view. A stored CONTRADICTED assertion with no
// contradicting partner left in the view is REVALIDATED. Nothing is deleted.

export interface ProjectionAssertion {
  id: string;
  assertion_type: string;
  payload: Record<string, unknown>;
  source_reference_id: string | null;
  source_system_id: string;
  source_tenant_id: string | null;
  source_kind: string;
  verification_status: string;
  observed_at: Date;
  valid_from: Date | null;
  valid_to: Date | null;
  current_status: string;
  ai_derived: boolean;
}

export interface ProjectionIdentifier {
  id: string;
  identifier_type: string;
  normalized_value: string;
  verification_status: string;
  is_primary: boolean;
  status: string;
  source_reference_id: string | null;
}

export interface ProjectionOptions {
  now: Date;
  /** AVAILABILITY older than this is STALE (TI_AVAILABILITY_FRESHNESS_DAYS, default 90). */
  availabilityFreshnessDays: number;
  /** Assertion ids backed by an acquired artifact (AUTHORITATIVE band). */
  artifactSupported?: ReadonlySet<string>;
}

export interface ProjectedFact {
  fact_type: ProfileFactType;
  fact_key: string;
  value: JsonObject;
  state: FactState;
  verification_status: 'DECLARED' | 'DOCUMENT_SUPPORTED' | 'VERIFIED';
  corroborating_sources: number;
  supporting_assertion_ids: string[];
}

export interface ProjectionResult {
  facts: ProjectedFact[];
  /** Status of every projected (non-retired) assertion in this view. */
  effective_status: Map<string, AssertionStatus>;
  /** [losing member, winning representative] — distinct source references. */
  contradictions: Array<[string, string]>;
  trust: TrustStateRow;
}

export const DEFAULT_AVAILABILITY_FRESHNESS_DAYS = 90;
const MS_PER_DAY = 86_400_000;

const VERIFICATION_ORDER: Record<string, number> = { VERIFIED: 3, DOCUMENT_SUPPORTED: 2, DECLARED: 1 };
const verificationOrder = (v: string): number => VERIFICATION_ORDER[v] ?? 0;
const FACT_TYPE_ORDER = new Map<string, number>(PROFILE_FACT_TYPES.map((t, i) => [t, i]));

const SINGLE_VALUED = new Set(['NAME', 'CURRENT_EMPLOYER', 'TITLE', 'LOCATION', 'AVAILABILITY', 'WORK_AUTHORIZATION']);
const MULTI_VALUED = new Set(['WORK_HISTORY', 'SKILL', 'EDUCATION', 'CERTIFICATION', 'PROJECT', 'PUBLIC_PROFILE_URL']);

function text(v: unknown): string {
  return typeof v === 'string'
    ? v
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9+#]+/g, ' ')
        .trim()
    : '';
}
const month = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 7) : '');
const year = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 4) : '');
/** Both present and different. */
const differ = (a: string, b: string): boolean => a !== '' && b !== '' && a !== b;

function factKey(type: string, p: Record<string, unknown>): string {
  switch (type) {
    case 'WORK_HISTORY':
      return `${text(p['employer'])}|${month(p['start_date'])}`;
    case 'EDUCATION':
      return `${text(p['institution'])}|${text(p['degree'])}`;
    case 'CERTIFICATION':
      return `${text(p['name'])}|${text(p['issuer'])}`;
    case 'SKILL':
    case 'PROJECT':
      return text(p['name']);
    case 'PUBLIC_PROFILE_URL':
      return typeof p['url'] === 'string' ? p['url'].trim().toLowerCase().replace(/\/+$/, '') : '';
    default:
      return '';
  }
}

/** Are two payloads of the same fact (same fact_key) compatible values? */
export function compatible(type: string, a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  switch (type) {
    case 'NAME':
      return !namesConflict(normalizeNames(a as NameSnapshot), normalizeNames(b as NameSnapshot));
    case 'CURRENT_EMPLOYER':
      return text(a['name']) === text(b['name']);
    case 'TITLE':
      return text(a['value']) === text(b['value']);
    case 'LOCATION':
      return !(['country', 'region', 'city'] as const).some((k) => differ(text(a[k]), text(b[k])));
    case 'WORK_AUTHORIZATION':
      return a['status'] === b['status'] || differ(text(a['jurisdiction']), text(b['jurisdiction']));
    case 'WORK_HISTORY':
      return !differ(text(a['title']), text(b['title'])) && !differ(month(a['end_date']), month(b['end_date']));
    case 'EDUCATION':
      return !differ(year(a['end_date']), year(b['end_date']));
    case 'CERTIFICATION':
      return !differ(text(a['credential_id']), text(b['credential_id']));
    default:
      // AVAILABILITY is temporal; SKILL / PROJECT / URL values never contradict.
      return true;
  }
}

function parseLooseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !/^\d{4}(-\d{2}(-\d{2})?)?/.test(v)) return null;
  const [y, m, d] = v.slice(0, 10).split('-');
  // A partial date means "through the end of that period".
  if (d) return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 23, 59, 59));
  if (m) return new Date(Date.UTC(Number(y), Number(m), 0, 23, 59, 59));
  return new Date(Date.UTC(Number(y), 11, 31, 23, 59, 59));
}

/** Time-based staleness (validity window, certification expiry, availability freshness). */
export function isTimeStale(a: ProjectionAssertion, opts: ProjectionOptions): boolean {
  const now = opts.now.getTime();
  if (a.valid_to !== null && a.valid_to.getTime() < now) return true;
  if (a.assertion_type === 'CERTIFICATION') {
    const exp = parseLooseDate(a.payload['expires_on']);
    if (exp !== null && exp.getTime() < now) return true;
  }
  if (a.assertion_type === 'AVAILABILITY') {
    return now - a.observed_at.getTime() > opts.availabilityFreshnessDays * MS_PER_DAY;
  }
  return false;
}

interface Cluster {
  members: ProjectionAssertion[];
  rep: ProjectionAssertion;
}

const byStrength = (a: ProjectionAssertion, b: ProjectionAssertion): number =>
  verificationOrder(b.verification_status) - verificationOrder(a.verification_status) ||
  b.observed_at.getTime() - a.observed_at.getTime() ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function cluster(type: string, claims: ProjectionAssertion[]): Cluster[] {
  const out: Cluster[] = [];
  for (const a of [...claims].sort(byStrength)) {
    const home = out.find((c) => compatible(type, c.rep.payload, a.payload));
    if (home) home.members.push(a);
    else out.push({ members: [a], rep: a });
  }
  return out;
}

const sourcesOf = (c: Cluster): number => new Set(c.members.filter((m) => !m.ai_derived).map(independenceKey)).size || 1;
const bestVerification = (c: Cluster): number => Math.max(...c.members.map((m) => verificationOrder(m.verification_status)));
const latest = (c: Cluster): number => Math.max(...c.members.map((m) => m.observed_at.getTime()));
const authoritative = (c: Cluster): number => (c.members.some((m) => m.payload['authoritative'] === true) ? 1 : 0);

function clusterOrder(type: string): (a: Cluster, b: Cluster) => number {
  return (a, b) =>
    (type === 'WORK_AUTHORIZATION' ? authoritative(b) - authoritative(a) : 0) ||
    bestVerification(b) - bestVerification(a) ||
    (type === 'AVAILABILITY' ? 0 : sourcesOf(b) - sourcesOf(a)) ||
    latest(b) - latest(a) ||
    (a.rep.id < b.rep.id ? -1 : a.rep.id > b.rep.id ? 1 : 0);
}

const VERIFICATION_NAMES = ['DECLARED', 'DOCUMENT_SUPPORTED', 'VERIFIED'] as const;
const verificationName = (n: number): ProjectedFact['verification_status'] => VERIFICATION_NAMES[Math.max(0, n - 1)] ?? 'DECLARED';

function factValue(type: string, winner: Cluster, stale: boolean): JsonObject {
  const p = winner.rep.payload as JsonObject;
  if (type === 'SKILL') {
    const years = winner.members.map((m) => m.payload['years']).filter((y): y is number => typeof y === 'number');
    const lastUsed = winner.members
      .map((m) => m.payload['last_used'])
      .filter((v): v is string => typeof v === 'string')
      .sort();
    return {
      ...p,
      ...(years.length > 0 ? { years: Math.max(...years) } : {}),
      ...(lastUsed.length > 0 ? { last_used: lastUsed[lastUsed.length - 1] as string } : {}),
    };
  }
  if (type === 'AVAILABILITY') {
    return { ...p, freshness: stale ? 'STALE' : 'CURRENT', observed_at: winner.rep.observed_at.toISOString() };
  }
  if (type === 'CERTIFICATION') return { ...p, expired: stale };
  return { ...p };
}

/** sha256 of `TYPE:normalized_value` — how a VERIFICATION_OUTCOME names its identifier without carrying it. */
export function identifierDigest(type: string, normalizedValue: string): string {
  return sha256Hex(`${type}:${normalizedValue}`);
}

function contactFacts(identifiers: ProjectionIdentifier[], verificationAssertions: ProjectionAssertion[]): ProjectedFact[] {
  const byKey = new Map<string, ProjectionIdentifier[]>();
  for (const i of identifiers) {
    if (i.status !== 'ACTIVE' || (i.identifier_type !== 'EMAIL' && i.identifier_type !== 'PHONE')) continue;
    const k = `${i.identifier_type}|${i.normalized_value}`;
    byKey.set(k, [...(byKey.get(k) ?? []), i]);
  }
  const facts: ProjectedFact[] = [];
  for (const rows of byKey.values()) {
    const first = rows[0] as ProjectionIdentifier;
    const verified = rows.some((r) => r.verification_status === 'VERIFIED');
    const digest = identifierDigest(first.identifier_type, first.normalized_value);
    facts.push({
      fact_type: first.identifier_type as ProfileFactType,
      fact_key: first.normalized_value,
      value: { value: first.normalized_value, verified, primary: rows.some((r) => r.is_primary) },
      state: 'RESOLVED',
      verification_status: verified ? 'VERIFIED' : 'DECLARED',
      corroborating_sources: new Set(rows.map((r) => r.source_reference_id ?? 'ti')).size,
      supporting_assertion_ids: verificationAssertions
        .filter((a) => a.payload['identifier_digest'] === digest)
        .map((a) => a.id)
        .sort(),
    });
  }
  return facts;
}

/** Deterministic presentation order: fact type, then (contacts) verified → primary, then key. */
export function orderFacts<T extends { fact_type: string; fact_key: string; value: Record<string, unknown> }>(facts: T[]): T[] {
  const flag = (f: T, k: string) => (f.value[k] === true ? 1 : 0);
  return [...facts].sort(
    (a, b) =>
      (FACT_TYPE_ORDER.get(a.fact_type) ?? 99) - (FACT_TYPE_ORDER.get(b.fact_type) ?? 99) ||
      flag(b, 'verified') - flag(a, 'verified') ||
      flag(b, 'primary') - flag(a, 'primary') ||
      (a.fact_key < b.fact_key ? -1 : a.fact_key > b.fact_key ? 1 : 0),
  );
}

export function computeProjection(
  assertions: ProjectionAssertion[],
  identifiers: ProjectionIdentifier[],
  opts: ProjectionOptions,
): ProjectionResult {
  const projected = assertions.filter((a) => (PROJECTED_ASSERTION_STATUSES as readonly string[]).includes(a.current_status));
  const stale = new Set(projected.filter((a) => isTimeStale(a, opts)).map((a) => a.id));

  const groups = new Map<string, ProjectionAssertion[]>();
  for (const a of projected) {
    if (!SINGLE_VALUED.has(a.assertion_type) && !MULTI_VALUED.has(a.assertion_type)) continue;
    const key = `${a.assertion_type}\u0000${SINGLE_VALUED.has(a.assertion_type) ? '' : factKey(a.assertion_type, a.payload)}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }

  const facts: ProjectedFact[] = [];
  const contradictions: Array<[string, string]> = [];
  const contradicted = new Set<string>();
  for (const [key, claims] of groups) {
    const [type, fact_key] = key.split('\u0000') as [string, string];
    const clusters = cluster(type, claims).sort(clusterOrder(type));
    const winner = clusters[0] as Cluster;
    let factContradicted = false;
    for (const loser of clusters.slice(1)) {
      for (const m of loser.members) {
        const partner = winner.members.find(
          (w) => w.source_reference_id !== m.source_reference_id || (w.source_reference_id === null && w.id !== m.id),
        );
        if (partner === undefined) continue;
        contradictions.push([m.id, partner.id]);
        contradicted.add(m.id).add(partner.id);
        factContradicted = true;
      }
    }
    const winnerStale = winner.members.every((m) => stale.has(m.id));
    facts.push({
      fact_type: type as ProfileFactType,
      fact_key,
      value: factValue(type, winner, winnerStale),
      state: factContradicted ? 'CONTRADICTED' : winnerStale ? 'STALE' : 'RESOLVED',
      verification_status: verificationName(bestVerification(winner)),
      corroborating_sources: sourcesOf(winner),
      supporting_assertion_ids: winner.members.map((m) => m.id).sort(),
    });
  }

  const verificationAssertions = projected.filter((a) => a.assertion_type === 'VERIFICATION_OUTCOME' && a.source_kind === 'VERIFICATION');
  facts.push(...contactFacts(identifiers, verificationAssertions));

  const effective_status = new Map<string, AssertionStatus>();
  for (const a of projected) {
    const stored = a.current_status as AssertionStatus;
    let status: AssertionStatus = stored;
    if (stored !== 'DISPUTED') {
      if (contradicted.has(a.id)) status = 'CONTRADICTED';
      else status = stale.has(a.id) ? 'STALE' : 'VALID';
    }
    effective_status.set(a.id, status);
  }

  const trust = deriveTrust(
    projected.map((a) => ({ ...a, status: effective_status.get(a.id) as AssertionStatus })),
    identifiers.filter((i) => i.status === 'ACTIVE'),
    opts.artifactSupported ?? new Set(),
    opts.now,
  );

  return { facts: orderFacts(facts), effective_status, contradictions, trust };
}

/** The stored ResolvedProfileFact.value of a projected fact (type/key/supporting live in their own columns). */
export function storedFactValue(f: ProjectedFact): JsonObject {
  return { value: f.value, state: f.state, verification_status: f.verification_status, corroborating_sources: f.corroborating_sources };
}

/** Change detection key of a projected fact. */
export function factSignature(value: unknown, supporting: string[]): string {
  return canonicalJson({ value, supporting: [...supporting].sort() });
}
