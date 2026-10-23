import { describe, expect, it } from 'vitest';

import { computeProjection, deriveTrust, type ProjectionAssertion, type ProjectionIdentifier } from '../index.js';

import { snapshot } from './support/fixtures.js';
import { ATS, services } from './support/services.js';

// ATI-SEP-1 T5 — the pure projection (tie-breakers, contradictions, staleness,
// work-authorization authority, contacts) and trust derivation, then the
// persisted ProjectionService (statuses + events + links, revalidation,
// outbox changed_fact_types, scheduled re-assessment).

const NOW = new Date('2026-10-23T00:00:00.000Z');
const OPTS = { now: NOW, availabilityFreshnessDays: 90 };
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

let seq = 0;
function a(over: Partial<ProjectionAssertion> & { assertion_type: string; payload: Record<string, unknown> }): ProjectionAssertion {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    source_reference_id: `ref-${over.source_tenant_id ?? 'a'}`,
    source_system_id: 'ARAMO_ATS',
    source_tenant_id: 'a',
    source_kind: 'RECRUITER',
    verification_status: 'DECLARED',
    observed_at: days(10),
    valid_from: null,
    valid_to: null,
    current_status: 'VALID',
    ai_derived: false,
    ...over,
  };
}
const title = (value: string, over: Partial<ProjectionAssertion> = {}) => a({ assertion_type: 'TITLE', payload: { value }, ...over });
const fact = (r: ReturnType<typeof computeProjection>, type: string, key = '') => r.facts.find((f) => f.fact_type === type && f.fact_key === key);

describe('computeProjection — deterministic tie-breakers', () => {
  it('1. verification wins over corroboration and recency', () => {
    const verified = title('Staff Engineer', { source_kind: 'TI_ACQUIRED', source_tenant_id: null, source_reference_id: null, verification_status: 'VERIFIED', observed_at: days(300) });
    const r = computeProjection([title('Engineer', { source_tenant_id: 'a' }), title('Engineer', { source_tenant_id: 'b' }), verified], [], OPTS);
    expect(fact(r, 'TITLE')).toMatchObject({ value: { value: 'Staff Engineer' }, verification_status: 'VERIFIED', state: 'CONTRADICTED', supporting_assertion_ids: [verified.id] });
  });

  it('2. independent sources (distinct tenants) win over recency', () => {
    const r = computeProjection(
      [title('Engineer', { source_tenant_id: 'a', observed_at: days(50) }), title('engineer', { source_tenant_id: 'b', observed_at: days(40) }), title('Manager', { source_tenant_id: 'c', observed_at: days(1) })],
      [],
      OPTS,
    );
    expect(fact(r, 'TITLE')).toMatchObject({ value: { value: 'engineer' }, corroborating_sources: 2 });
  });

  it('3. repeated claims of ONE source are not corroboration (same tenant twice, talent-self thrice)', () => {
    const r = computeProjection(
      [
        title('Manager', { source_tenant_id: 'c', source_reference_id: 'ref-c1', observed_at: days(60) }),
        title('Manager', { source_tenant_id: 'c', source_reference_id: 'ref-c2', observed_at: days(60) }),
        title('Engineer', { source_tenant_id: 'a', observed_at: days(5) }),
      ],
      [],
      OPTS,
    );
    expect(fact(r, 'TITLE')).toMatchObject({ value: { value: 'Engineer' }, corroborating_sources: 1 });
    const self = computeProjection(
      [1, 2, 3].map(() => title('CTO', { source_kind: 'TALENT_SELF', observed_at: days(90) })).concat([title('Engineer', { source_tenant_id: 'b', source_reference_id: 'ref-b', observed_at: days(1) })]),
      [],
      OPTS,
    );
    expect(fact(self, 'TITLE')?.value).toEqual({ value: 'Engineer' });
  });

  it('4. recency breaks a tie of verification and independence', () => {
    const r = computeProjection([title('Engineer', { source_tenant_id: 'a', observed_at: days(30) }), title('Manager', { source_tenant_id: 'b', observed_at: days(2) })], [], OPTS);
    expect(fact(r, 'TITLE')?.value).toEqual({ value: 'Manager' });
    expect(r.contradictions).toHaveLength(1);
  });

  it('no contradiction inside one source reference; compatible values corroborate', () => {
    const r = computeProjection([title('Engineer', { source_reference_id: 'ref-x' }), title('Manager', { source_reference_id: 'ref-x' })], [], OPTS);
    expect(r.contradictions).toEqual([]);
    expect([...r.effective_status.values()]).toEqual(['VALID', 'VALID']);
    const loc = computeProjection(
      [a({ assertion_type: 'LOCATION', payload: { city: 'Austin', country: 'US' } }), a({ assertion_type: 'LOCATION', payload: { country: 'us' }, source_tenant_id: 'b' })],
      [],
      OPTS,
    );
    expect(fact(loc, 'LOCATION')).toMatchObject({ state: 'RESOLVED', corroborating_sources: 2 });
  });

  it('a contradiction marks both sides CONTRADICTED in the view and the fact CONTRADICTED', () => {
    const x = title('Engineer', { source_tenant_id: 'a', observed_at: days(30) });
    const y = title('Manager', { source_tenant_id: 'b', observed_at: days(2) });
    const r = computeProjection([x, y], [], OPTS);
    expect(r.contradictions).toEqual([[x.id, y.id]]);
    expect(r.effective_status.get(x.id)).toBe('CONTRADICTED');
    expect(r.effective_status.get(y.id)).toBe('CONTRADICTED');
    expect(fact(r, 'TITLE')?.state).toBe('CONTRADICTED');
    // a stored CONTRADICTED with no partner left in the view is VALID again
    const alone = computeProjection([{ ...x, current_status: 'CONTRADICTED' }], [], OPTS);
    expect(alone.effective_status.get(x.id)).toBe('VALID');
  });
});

describe('computeProjection — staleness, authority, multi-valued facts, contacts', () => {
  it('AVAILABILITY older than the window is STALE; a fresher value beats a corroborated stale one', () => {
    const old1 = a({ assertion_type: 'AVAILABILITY', payload: { status: 'AVAILABLE' }, observed_at: days(120) });
    const old2 = a({ assertion_type: 'AVAILABILITY', payload: { status: 'AVAILABLE' }, observed_at: days(120), source_tenant_id: 'b' });
    expect(fact(computeProjection([old1, old2], [], OPTS), 'AVAILABILITY')).toMatchObject({ state: 'STALE', value: { status: 'AVAILABLE', freshness: 'STALE' } });
    const fresh = a({ assertion_type: 'AVAILABILITY', payload: { status: 'NOT_AVAILABLE' }, observed_at: days(3), source_tenant_id: 'c' });
    const r = computeProjection([old1, old2, fresh], [], OPTS);
    expect(fact(r, 'AVAILABILITY')).toMatchObject({ state: 'RESOLVED', value: { status: 'NOT_AVAILABLE', freshness: 'CURRENT' } });
    expect(r.contradictions).toEqual([]);
    expect(r.effective_status.get(old1.id)).toBe('STALE');
    expect(fact(computeProjection([old1], [], { ...OPTS, availabilityFreshnessDays: 365 }), 'AVAILABILITY')?.state).toBe('RESOLVED');
  });

  it('an expired certification (or a past valid_to) is STALE', () => {
    const cert = a({ assertion_type: 'CERTIFICATION', payload: { name: 'CKA', issuer: 'CNCF', expires_on: '2026-09' } });
    const r = computeProjection([cert], [], OPTS);
    expect(fact(r, 'CERTIFICATION', 'cka|cncf')).toMatchObject({ state: 'STALE', value: { expired: true } });
    expect(r.effective_status.get(cert.id)).toBe('STALE');
    const bounded = title('Lead', { valid_to: days(1) });
    expect(computeProjection([bounded], [], OPTS).effective_status.get(bounded.id)).toBe('STALE');
  });

  it('work authorization: a TI-authoritative value wins over a non-authoritative résumé value', () => {
    const recruiter = a({ assertion_type: 'WORK_AUTHORIZATION', payload: { status: 'REQUIRES_SPONSORSHIP', authoritative: true }, observed_at: days(100) });
    const resume = a({ assertion_type: 'WORK_AUTHORIZATION', payload: { status: 'CITIZEN', authoritative: false }, source_kind: 'RESUME_DERIVED', source_tenant_id: 'b', observed_at: days(1) });
    const r = computeProjection([resume, recruiter], [], OPTS);
    expect(fact(r, 'WORK_AUTHORIZATION')?.value).toMatchObject({ status: 'REQUIRES_SPONSORSHIP', authoritative: true });
    expect(computeProjection([resume], [], OPTS).trust.eligibility_band).toBe('SELF_ASSERTED');
  });

  it('skills are keyed per name with the longest years and the latest last_used', () => {
    const r = computeProjection(
      [
        a({ assertion_type: 'SKILL', payload: { name: 'TypeScript', years: 3, last_used: '2024' } }),
        a({ assertion_type: 'SKILL', payload: { name: 'typescript', years: 6, last_used: '2026-09' }, source_tenant_id: 'b' }),
        a({ assertion_type: 'SKILL', payload: { name: 'Go' } }),
      ],
      [],
      OPTS,
    );
    expect(r.facts.filter((f) => f.fact_type === 'SKILL').map((f) => f.fact_key)).toEqual(['go', 'typescript']);
    expect(fact(r, 'SKILL', 'typescript')).toMatchObject({ value: { years: 6, last_used: '2026-09' }, corroborating_sources: 2 });
  });

  it('contacts: verified first, then primary', () => {
    const ids: ProjectionIdentifier[] = [
      { id: '1', identifier_type: 'EMAIL', normalized_value: 'b@x.io', verification_status: 'UNVERIFIED', is_primary: true, status: 'ACTIVE', source_reference_id: 'r' },
      { id: '2', identifier_type: 'EMAIL', normalized_value: 'a@x.io', verification_status: 'UNVERIFIED', is_primary: false, status: 'ACTIVE', source_reference_id: 'r' },
      { id: '3', identifier_type: 'EMAIL', normalized_value: 'z@x.io', verification_status: 'VERIFIED', is_primary: false, status: 'ACTIVE', source_reference_id: null },
      { id: '4', identifier_type: 'EMAIL', normalized_value: 'old@x.io', verification_status: 'UNVERIFIED', is_primary: false, status: 'SUPERSEDED', source_reference_id: 'r' },
    ];
    const r = computeProjection([], ids, OPTS);
    expect(r.facts.map((f) => f.fact_key)).toEqual(['z@x.io', 'b@x.io', 'a@x.io']);
    expect(r.facts[0]).toMatchObject({ verification_status: 'VERIFIED', value: { value: 'z@x.io', verified: true } });
  });
});

describe('deriveTrust — bands', () => {
  const t = (over: Partial<ProjectionAssertion> & { assertion_type: string; payload: Record<string, unknown> }) => ({ ...a(over), status: 'VALID' as const });
  it('one tenant → SELF_ASSERTED; two tenants → CORROBORATED; talent-self never verifies; TI verification → INDEPENDENTLY_VERIFIED', () => {
    expect(deriveTrust([t({ assertion_type: 'SKILL', payload: { name: 'Go' } })], [], new Set(), NOW).claims_band).toBe('SELF_ASSERTED');
    expect(
      deriveTrust([t({ assertion_type: 'SKILL', payload: { name: 'Go' } }), t({ assertion_type: 'SKILL', payload: { name: 'Go' }, source_tenant_id: 'b' })], [], new Set(), NOW).claims_band,
    ).toBe('CORROBORATED');
    expect(deriveTrust([1, 2, 3].map(() => t({ assertion_type: 'SKILL', payload: { name: 'Go' }, source_kind: 'TALENT_SELF' })), [], new Set(), NOW).claims_band).toBe('SELF_ASSERTED');
    const v = t({ assertion_type: 'VERIFICATION_OUTCOME', payload: { target: 'EMAIL' }, source_kind: 'VERIFICATION', verification_status: 'VERIFIED', source_tenant_id: null });
    expect(deriveTrust([v], [], new Set(), NOW)).toMatchObject({ identity_band: 'INDEPENDENTLY_VERIFIED', claims_band: 'NOT_ESTABLISHED' });
    const acquired = t({ assertion_type: 'CERTIFICATION', payload: { name: 'CKA' }, source_kind: 'TI_ACQUIRED', verification_status: 'VERIFIED', source_tenant_id: null });
    expect(deriveTrust([acquired], [], new Set([acquired.id]), NOW).claims_band).toBe('AUTHORITATIVE');
  });

  it('an open contradiction caps the dimension at CORROBORATED; flags are statements of fact', () => {
    const acquired = { ...t({ assertion_type: 'TITLE', payload: { value: 'X' }, source_kind: 'TI_ACQUIRED', verification_status: 'VERIFIED', source_tenant_id: null }) };
    const contradicted = { ...t({ assertion_type: 'TITLE', payload: { value: 'Y' } }), status: 'CONTRADICTED' as const };
    const s = deriveTrust([acquired, contradicted], [], new Set([acquired.id]), NOW);
    expect(s).toMatchObject({ claims_band: 'CORROBORATED', open_contradiction_count: 1, single_source_only: true });
    const oldV = t({ assertion_type: 'VERIFICATION_OUTCOME', payload: { target: 'EMAIL' }, source_kind: 'VERIFICATION', verification_status: 'VERIFIED', observed_at: days(400) });
    expect(deriveTrust([oldV], [], new Set(), NOW).verification_stale).toBe(true);
  });
});

describe('ProjectionService — persisted Golden projection', () => {
  const titled = (tenant: string, value: string, observed: string) =>
    snapshot({
      tenant,
      talent: `${tenant}-1`,
      identity: { names: { first: 'Priya', last: 'Raman' }, emails: [{ value: 'priya@x.io', is_primary: true, verification: { status: 'VERIFIED', method: 'EMAIL_OTP', source: 'ARAMO_PORTAL', verified_at: '2026-10-01T00:00:00.000Z' } }] },
      assertions: [{ assertion_type: 'TITLE', payload: { value }, source_kind: 'RECRUITER', observed_at: observed }],
    });

  it('contradiction → statuses CONTRADICTED with events + one CONTRADICTS link; a later agreement REVALIDATES (links never deleted)', async () => {
    const s = services();
    const first = await s.ingest.ingest(titled('a', 'Engineer', '2026-10-01T00:00:00.000Z'), ATS);
    await s.ingest.ingest(titled('b', 'Manager', '2026-10-10T00:00:00.000Z'), ATS);
    const subject = first.intelligence_subject_id;
    const titles = () => [...s.mem.state.assertions.values()].filter((x) => x.assertion_type === 'TITLE' && x.current_status !== 'SUPERSEDED');
    expect(titles().map((x) => x.current_status)).toEqual(['CONTRADICTED', 'CONTRADICTED']);
    expect(s.mem.state.links.filter((l) => l.link_type === 'CONTRADICTS')).toHaveLength(1);
    expect(s.mem.state.events.filter((e) => e.event_type === 'CONTRADICTED')).toHaveLength(2);
    const stored = [...s.mem.state.facts.values()].find((f) => f.subject_id === subject && f.fact_type === 'TITLE');
    expect(stored?.value).toMatchObject({ value: { value: 'Manager' }, state: 'CONTRADICTED' });
    const last = s.mem.state.outbox.at(-1);
    expect(last).toMatchObject({ event_type: 'golden_talent.profile_updated', subject_id: subject });
    expect((last?.payload as { changed_fact_types: string[] }).changed_fact_types).toContain('TITLE');

    await s.ingest.ingest(titled('b', 'Engineer', '2026-10-12T00:00:00.000Z'), ATS);
    expect(titles().map((x) => x.current_status)).toEqual(['VALID', 'VALID']);
    expect(s.mem.state.events.filter((e) => e.event_type === 'REVALIDATED')).toHaveLength(1);
    expect(s.mem.state.links.filter((l) => l.link_type === 'CONTRADICTS')).toHaveLength(1);
    expect(s.mem.state.trust.get(subject)?.claims_band).toBe('CORROBORATED');
  });

  it('an unchanged rebuild writes no outbox event; the re-assessment job marks availability STALE later', async () => {
    const s = services();
    const res = await s.ingest.ingest(
      snapshot({ assertions: [{ assertion_type: 'AVAILABILITY', payload: { status: 'AVAILABLE' }, source_kind: 'RECRUITER', observed_at: '2026-10-20T00:00:00.000Z' }] }),
      ATS,
    );
    const outboxBefore = s.mem.state.outbox.length;
    expect(await s.projection.rebuild(res.intelligence_subject_id, new Date('2026-10-23T00:00:00.000Z'))).toMatchObject({ changed_fact_types: [] });
    expect(s.mem.state.outbox).toHaveLength(outboxBefore);

    const n = await s.projection.reassess(new Date('2027-02-01T00:00:00.000Z'));
    expect(n).toBe(1);
    const avail = [...s.mem.state.assertions.values()].find((x) => x.assertion_type === 'AVAILABILITY');
    expect(avail?.current_status).toBe('STALE');
    expect(s.mem.state.events.some((e) => e.assertion_id === avail?.id && e.event_type === 'STALE')).toBe(true);
    expect((s.mem.state.outbox.at(-1)?.payload as { changed_fact_types: string[] }).changed_fact_types).toEqual(['AVAILABILITY', 'TRUST']);
    // assessed now → not selected again within the interval
    expect(await s.projection.reassess(new Date('2027-02-01T00:10:00.000Z'))).toBe(0);
  });

  it('a merge rebuilds the survivor and empties the merged-away projection', async () => {
    const s = services();
    const x = await s.ingest.ingest(snapshot({ tenant: 'm-a', identity: { emails: [{ value: 'x@x.io', is_primary: true }] } }), ATS);
    const y = await s.ingest.ingest(snapshot({ tenant: 'm-b', identity: { emails: [{ value: 'y@x.io', is_primary: true }] } }), ATS);
    await s.mergeSplit.merge(y.intelligence_subject_id, x.intelligence_subject_id, 'op', 'test');
    const factsOf = (id: string) => [...s.mem.state.facts.values()].filter((f) => f.subject_id === id);
    expect(factsOf(y.intelligence_subject_id)).toEqual([]);
    expect(factsOf(x.intelligence_subject_id).filter((f) => f.fact_type === 'EMAIL').map((f) => f.fact_key).sort()).toEqual(['x@x.io', 'y@x.io']);
  });
});
