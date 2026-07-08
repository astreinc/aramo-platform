import { describe, expect, it } from 'vitest';

import {
  computeConsistencyPlan,
  REASON_EMPLOYER_CONFLICT_SAME_WINDOW,
  REASON_IMPOSSIBLE_RANGE,
  type EmploymentClaim,
  type ExistingGap,
} from '../lib/consistency-detectors.js';
import { sameUltimateSource } from '../lib/band-derivation.js';

// TR-4 B3 (§5a/§5b) — the pure detectors, proven BOTH WAYS: fires on a true
// positive AND stays silent on the null-date / missing-norm / non-independent /
// non-interior / agree variants. Silence is the property.

let seq = 0;
// Respect EXPLICIT null (a key present with a null value) vs "not provided" — a
// `??` default would silently coerce an intentional null back to the default and
// hide the very silence property under test.
function pick<K extends keyof EmploymentClaim>(
  over: Partial<EmploymentClaim>,
  key: K,
  dflt: EmploymentClaim[K],
): EmploymentClaim[K] {
  return key in over ? (over[key] as EmploymentClaim[K]) : dflt;
}
function claim(over: Partial<EmploymentClaim>): EmploymentClaim {
  seq += 1;
  return {
    evidence_id: pick(over, 'evidence_id', `e${seq}`),
    source_class: pick(over, 'source_class', 'THIRD_PARTY_UNVERIFIED'),
    source_ref: pick(over, 'source_ref', { talent_evidence_id: `t${seq}` }),
    employer_norm: pick(over, 'employer_norm', 'acme'),
    start_date: pick(over, 'start_date', '2020-01-01'),
    end_date: pick(over, 'end_date', '2020-12-31'),
    collected_at: pick(over, 'collected_at', new Date('2021-01-01')),
    current_status: pick(over, 'current_status', 'VALID'),
  };
}
const plan = (claims: EmploymentClaim[], gaps: ExistingGap[] = []) =>
  computeConsistencyPlan(claims, gaps);

describe('Detector 1 — impossible range (end < start)', () => {
  it('FIRES on end < start (both non-null)', () => {
    const c = claim({ start_date: '2020-06-01', end_date: '2020-01-01' });
    expect(plan([c]).impossibleRangeIds).toEqual([c.evidence_id]);
  });
  it('SILENT on a valid range', () => {
    expect(plan([claim({ start_date: '2020-01-01', end_date: '2020-06-01' })]).impossibleRangeIds).toEqual([]);
  });
  it('SILENT on null dates', () => {
    expect(plan([claim({ start_date: null, end_date: '2020-01-01' })]).impossibleRangeIds).toEqual([]);
    expect(plan([claim({ start_date: '2020-06-01', end_date: null })]).impossibleRangeIds).toEqual([]);
  });
  it('SILENT on an already-CONTRADICTED record (no re-raise)', () => {
    const c = claim({ start_date: '2020-06-01', end_date: '2020-01-01', current_status: 'CONTRADICTED' });
    expect(plan([c]).impossibleRangeIds).toEqual([]);
  });
});

describe('Detector 2 — same-window employer disagreement', () => {
  const a = { start_date: '2020-01-01', end_date: '2020-12-31', employer_norm: 'acme', source_ref: { talent_evidence_id: 'A' } };
  const b = { start_date: '2020-03-01', end_date: '2021-02-28', employer_norm: 'globex', source_ref: { talent_evidence_id: 'B' } };

  it('FIRES on independent sources, overlap ≥ 30d, unequal employer_norm', () => {
    const r = plan([claim(a), claim(b)]).employerConflicts;
    expect(r).toHaveLength(1);
  });
  it('SILENT when employers agree', () => {
    expect(plan([claim({ ...a }), claim({ ...b, employer_norm: 'acme' })]).employerConflicts).toEqual([]);
  });
  it('SILENT when NOT independent (both SELF collapse)', () => {
    expect(
      plan([
        claim({ ...a, source_class: 'SELF', source_ref: null }),
        claim({ ...b, source_class: 'SELF', source_ref: null }),
      ]).employerConflicts,
    ).toEqual([]);
  });
  it('SILENT when the same non-SELF source_ref (correlated)', () => {
    const ref = { talent_evidence_id: 'SAME' };
    expect(plan([claim({ ...a, source_ref: ref }), claim({ ...b, source_ref: ref })]).employerConflicts).toEqual([]);
  });
  it('SILENT when overlap < 30 days', () => {
    expect(
      plan([
        claim({ ...a, start_date: '2020-01-01', end_date: '2020-01-20' }),
        claim({ ...b, start_date: '2020-01-01', end_date: '2020-01-15' }),
      ]).employerConflicts,
    ).toEqual([]); // 15-day overlap < 30
  });
  it('SILENT when a date is null or employer_norm missing', () => {
    expect(plan([claim({ ...a, end_date: null }), claim(b)]).employerConflicts).toEqual([]);
    expect(plan([claim({ ...a, employer_norm: null }), claim(b)]).employerConflicts).toEqual([]);
  });
});

describe('Detector 3 — interior timeline gaps (> 180d)', () => {
  it('FIRES on an interior hole > 180 days between two jobs', () => {
    const j1 = claim({ evidence_id: 'j1', start_date: '2018-01-01', end_date: '2018-12-31' });
    const j2 = claim({ evidence_id: 'j2', start_date: '2020-06-01', end_date: '2021-06-01' });
    const r = plan([j1, j2]).gapsToOpen;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ before_evidence_id: 'j1', after_evidence_id: 'j2', gap_start: '2018-12-31', gap_end: '2020-06-01' });
  });
  it('SILENT on a hole ≤ 180 days', () => {
    const j1 = claim({ start_date: '2018-01-01', end_date: '2019-12-31' });
    const j2 = claim({ start_date: '2020-03-01', end_date: '2021-06-01' }); // ~60d hole
    expect(plan([j1, j2]).gapsToOpen).toEqual([]);
  });
  it('SILENT on the leading/trailing edge (only INTERIOR gaps count)', () => {
    // One job → no interior gap possible (nothing before/after to bound it).
    expect(plan([claim({ start_date: '2020-01-01', end_date: '2020-12-31' })]).gapsToOpen).toEqual([]);
  });
  it('SILENT when overlapping/nested jobs cover the span (no false gap)', () => {
    const j1 = claim({ start_date: '2018-01-01', end_date: '2021-01-01' }); // long job
    const j2 = claim({ start_date: '2019-01-01', end_date: '2019-06-01' }); // nested inside j1
    const j3 = claim({ start_date: '2021-02-01', end_date: '2022-01-01' }); // ~30d after j1 ends
    expect(plan([j1, j2, j3]).gapsToOpen).toEqual([]);
  });
  it('SILENT when a fully-dated bound is missing (null date)', () => {
    const j1 = claim({ start_date: '2018-01-01', end_date: null });
    const j2 = claim({ start_date: '2020-06-01', end_date: '2021-06-01' });
    expect(plan([j1, j2]).gapsToOpen).toEqual([]);
  });
});

describe('Healed gaps — SUPERSEDE when filled', () => {
  it('marks a recorded gap healed when a filler now covers it', () => {
    const j1 = claim({ evidence_id: 'j1', start_date: '2018-01-01', end_date: '2018-12-31' });
    const j2 = claim({ evidence_id: 'j2', start_date: '2020-06-01', end_date: '2021-06-01' });
    // A filler employment spanning the old gap interval.
    const filler = claim({ evidence_id: 'fill', start_date: '2019-01-01', end_date: '2020-05-01', collected_at: new Date('2022-01-01') });
    const existing: ExistingGap[] = [
      { evidence_id: 'gapE', before_evidence_id: 'j1', after_evidence_id: 'j2', gap_start: '2018-12-31', gap_end: '2020-06-01', current_status: 'VALID' },
    ];
    const r = plan([j1, j2, filler], existing);
    expect(r.gapsToHeal).toEqual([{ gap_evidence_id: 'gapE', filler_evidence_id: 'fill' }]);
    // The old (j1,j2) gap is no longer re-opened (covered now).
    expect(r.gapsToOpen).toEqual([]);
  });
  it('does not re-open an already-recorded gap (idempotent)', () => {
    const j1 = claim({ evidence_id: 'j1', start_date: '2018-01-01', end_date: '2018-12-31' });
    const j2 = claim({ evidence_id: 'j2', start_date: '2020-06-01', end_date: '2021-06-01' });
    const existing: ExistingGap[] = [
      { evidence_id: 'gapE', before_evidence_id: 'j1', after_evidence_id: 'j2', gap_start: '2018-12-31', gap_end: '2020-06-01', current_status: 'VALID' },
    ];
    const r = plan([j1, j2], existing);
    expect(r.gapsToOpen).toEqual([]);
    expect(r.gapsToHeal).toEqual([]); // still open, not healed
  });
});

describe('independence rule (sameUltimateSource) — mirrors band derivation §6.2', () => {
  it('two SELF collapse; SELF vs non-SELF distinct; equal source_ref collapse; distinct source_ref independent', () => {
    const self = (): { source_class: 'SELF'; source_ref: null } => ({ source_class: 'SELF', source_ref: null });
    expect(sameUltimateSource(self(), self())).toBe(true);
    expect(sameUltimateSource(self(), { source_class: 'THIRD_PARTY_UNVERIFIED', source_ref: { x: 1 } })).toBe(false);
    expect(
      sameUltimateSource(
        { source_class: 'THIRD_PARTY_UNVERIFIED', source_ref: { id: 'A' } },
        { source_class: 'AUTHORITATIVE_ISSUER', source_ref: { id: 'A' } },
      ),
    ).toBe(true);
    expect(
      sameUltimateSource(
        { source_class: 'THIRD_PARTY_UNVERIFIED', source_ref: { id: 'A' } },
        { source_class: 'THIRD_PARTY_UNVERIFIED', source_ref: { id: 'B' } },
      ),
    ).toBe(false);
    // null non-SELF source_ref → its own independent signal.
    expect(
      sameUltimateSource(
        { source_class: 'THIRD_PARTY_UNVERIFIED', source_ref: null },
        { source_class: 'THIRD_PARTY_UNVERIFIED', source_ref: null },
      ),
    ).toBe(false);
  });
});

describe('reason vocabulary — distinct from promotion-reconcile', () => {
  it('exposes IMPOSSIBLE_RANGE + EMPLOYER_CONFLICT_SAME_WINDOW (no field-occupancy language)', () => {
    expect(REASON_IMPOSSIBLE_RANGE).toBe('IMPOSSIBLE_RANGE');
    expect(REASON_EMPLOYER_CONFLICT_SAME_WINDOW).toBe('EMPLOYER_CONFLICT_SAME_WINDOW');
  });
});
