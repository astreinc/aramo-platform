import { describe, expect, it } from 'vitest';

import {
  computeContinuityDerivations,
  floorClass,
  HISTORY_SPAN_MIN_MONTHS,
  LONGITUDINAL_MIN_SPAN_DAYS,
  type ContactObservation,
  type ExistingDerived,
} from '../lib/continuity-derivers.js';
import { SOURCE_CLASSES, type SourceClass } from '../lib/vocab.js';

const DAY = 24 * 60 * 60 * 1000;
const at = (isoDay: string): Date => new Date(`${isoDay}T00:00:00.000Z`);

function obs(over: Partial<ContactObservation> = {}): ContactObservation {
  return {
    evidence_id: over.evidence_id ?? 'ev',
    anchor_kind: over.anchor_kind ?? 'EMAIL',
    value: over.value ?? 'ada@x.com',
    source_class: over.source_class ?? 'THIRD_PARTY_UNVERIFIED',
    collected_at: over.collected_at ?? at('2026-01-01'),
    current_status: over.current_status ?? 'VALID',
  };
}

function run(args: {
  contactObservations?: ContactObservation[];
  employmentClaims?: Array<{ evidence_id: string; source_class: SourceClass; start_date: string | null; end_date: string | null; current_status: 'VALID' | 'CONTRADICTED' }>;
  openGaps?: Array<{ current_status: 'VALID' | 'SUPERSEDED' }>;
  existingLongitudinal?: ExistingDerived | null;
  existingHistorySpan?: ExistingDerived | null;
}) {
  return computeContinuityDerivations({
    contactObservations: args.contactObservations ?? [],
    employmentClaims: args.employmentClaims ?? [],
    openGaps: args.openGaps ?? [],
    existingLongitudinal: args.existingLongitudinal ?? null,
    existingHistorySpan: args.existingHistorySpan ?? null,
  });
}

describe('floorClass — an inference never outranks its inputs (§3.1)', () => {
  it('returns the weakest class among the inputs, order-independently', () => {
    expect(floorClass(['THIRD_PARTY_VERIFIED', 'SELF', 'PLATFORM_VERIFIED'])).toBe('SELF');
    expect(floorClass(['AUTHORITATIVE_ISSUER', 'THIRD_PARTY_UNVERIFIED'])).toBe('THIRD_PARTY_UNVERIFIED');
    // property: the floor is exactly the minimum ladder index present
    for (const a of SOURCE_CLASSES) {
      for (const b of SOURCE_CLASSES) {
        const f = floorClass([a, b]);
        expect(SOURCE_CLASSES.indexOf(f)).toBe(Math.min(SOURCE_CLASSES.indexOf(a), SOURCE_CLASSES.indexOf(b)));
      }
    }
  });
});

describe('LONGITUDINAL_PRESENCE (§3.1)', () => {
  it('fires on ≥2 distinct arrivals of the same (kind, value) ≥30d apart; class = floor of inputs', () => {
    const plan = run({
      contactObservations: [
        obs({ evidence_id: 'a', collected_at: at('2026-01-01'), source_class: 'THIRD_PARTY_UNVERIFIED' }),
        obs({ evidence_id: 'b', collected_at: at('2026-03-01'), source_class: 'THIRD_PARTY_VERIFIED' }),
      ],
    });
    expect(plan.longitudinal.kind).toBe('write');
    if (plan.longitudinal.kind !== 'write') throw new Error('unreachable');
    expect(plan.longitudinal.source_class).toBe('THIRD_PARTY_UNVERIFIED'); // FLOOR, not the higher input
    expect(plan.longitudinal.payload).toMatchObject({
      anchor_kind: 'EMAIL',
      first_seen: '2026-01-01',
      last_seen: '2026-03-01',
      observation_count: 2,
      basis_evidence_ids: ['a', 'b'],
    });
  });

  it('is SILENT on a single arrival', () => {
    expect(run({ contactObservations: [obs({ evidence_id: 'a' })] }).longitudinal.kind).toBe('noop');
  });

  it('is SILENT when two observations are < 30d apart (seen, but not over time)', () => {
    const plan = run({
      contactObservations: [
        obs({ evidence_id: 'a', collected_at: at('2026-01-01') }),
        obs({ evidence_id: 'b', collected_at: new Date(at('2026-01-01').getTime() + (LONGITUDINAL_MIN_SPAN_DAYS - 1) * DAY) }),
      ],
    });
    expect(plan.longitudinal.kind).toBe('noop');
  });

  it('does not fire across DIFFERENT values (two distinct identifiers are not persistence)', () => {
    const plan = run({
      contactObservations: [
        obs({ evidence_id: 'a', value: 'ada@x.com', collected_at: at('2026-01-01') }),
        obs({ evidence_id: 'b', value: 'ada@y.com', collected_at: at('2026-03-01') }),
      ],
    });
    expect(plan.longitudinal.kind).toBe('noop');
  });

  it('ignores non-VALID observations and non-contact anchor kinds', () => {
    const plan = run({
      contactObservations: [
        obs({ evidence_id: 'a', collected_at: at('2026-01-01'), current_status: 'SUPERSEDED' }),
        obs({ evidence_id: 'b', collected_at: at('2026-03-01') }),
        obs({ evidence_id: 'c', anchor_kind: 'FULL_NAME', collected_at: at('2026-05-01') }),
      ],
    });
    expect(plan.longitudinal.kind).toBe('noop'); // only one VALID contact obs of the value
  });

  it('supersede-replace: a grown basis REPLACES; an identical basis is a NO-OP', () => {
    const observations = [
      obs({ evidence_id: 'a', collected_at: at('2026-01-01') }),
      obs({ evidence_id: 'b', collected_at: at('2026-03-01') }),
    ];
    const existing: ExistingDerived = {
      evidence_id: 'old',
      payload: { anchor_kind: 'EMAIL', first_seen: '2026-01-01', last_seen: '2026-03-01', observation_count: 2, basis_evidence_ids: ['a', 'b'] },
    };
    // identical basis → no-op
    expect(run({ contactObservations: observations, existingLongitudinal: existing }).longitudinal.kind).toBe('noop');
    // a third arrival extends the window → replace (supersede the old)
    const grown = run({
      contactObservations: [...observations, obs({ evidence_id: 'c', collected_at: at('2026-06-01') })],
      existingLongitudinal: existing,
    });
    expect(grown.longitudinal.kind).toBe('replace');
    if (grown.longitudinal.kind !== 'replace') throw new Error('unreachable');
    expect(grown.longitudinal.supersede_id).toBe('old');
    expect(grown.longitudinal.payload.observation_count).toBe(3);
  });

  it('supersede WITHOUT replacement: the basis vanishes → retire the standing row (clears the flag)', () => {
    const existing: ExistingDerived = { evidence_id: 'old', payload: { anchor_kind: 'EMAIL', first_seen: '2026-01-01', last_seen: '2026-03-01', observation_count: 2, basis_evidence_ids: ['a', 'b'] } };
    const plan = run({ contactObservations: [obs({ evidence_id: 'a' })], existingLongitudinal: existing });
    expect(plan.longitudinal.kind).toBe('retire');
    if (plan.longitudinal.kind !== 'retire') throw new Error('unreachable');
    expect(plan.longitudinal.supersede_id).toBe('old');
  });
});

describe('HISTORY_SPAN (§3.2)', () => {
  const emp = (evidence_id: string, start: string | null, end: string | null, source_class: SourceClass = 'THIRD_PARTY_UNVERIFIED') => ({
    evidence_id,
    source_class,
    start_date: start,
    end_date: end,
    current_status: 'VALID' as const,
  });

  it('fires on fully-dated employment spanning ≥24mo with zero open gaps; class = floor', () => {
    const plan = run({
      employmentClaims: [emp('j1', '2020-01-01', '2021-06-30', 'THIRD_PARTY_VERIFIED'), emp('j2', '2021-07-01', '2022-06-30', 'SELF')],
      openGaps: [{ current_status: 'SUPERSEDED' }], // a healed gap is not open
    });
    expect(plan.historySpan.kind).toBe('write');
    if (plan.historySpan.kind !== 'write') throw new Error('unreachable');
    expect(plan.historySpan.source_class).toBe('SELF'); // FLOOR
    expect(plan.historySpan.payload).toMatchObject({ earliest: '2020-01-01', latest: '2022-06-30', open_gap_count: 0 });
    expect(plan.historySpan.payload.span_months).toBeGreaterThanOrEqual(HISTORY_SPAN_MIN_MONTHS);
  });

  it('is SILENT on a sub-24-month span', () => {
    expect(run({ employmentClaims: [emp('j1', '2021-01-01', '2022-06-30')] }).historySpan.kind).toBe('noop');
  });

  it('is SILENT when ANY VALID claim is undated', () => {
    const plan = run({ employmentClaims: [emp('j1', '2018-01-01', '2022-06-30'), emp('j2', null, '2023-01-01')] });
    expect(plan.historySpan.kind).toBe('noop');
  });

  it('is SILENT when an open gap exists', () => {
    const plan = run({
      employmentClaims: [emp('j1', '2018-01-01', '2020-06-30'), emp('j2', '2021-01-01', '2023-06-30')],
      openGaps: [{ current_status: 'VALID' }],
    });
    expect(plan.historySpan.kind).toBe('noop');
  });

  it('a newly-opened gap SUPERSEDES a prior span (the healed gap mirror)', () => {
    const existing: ExistingDerived = { evidence_id: 'span-old', payload: { span_months: 30, earliest: '2018-01-01', latest: '2020-07-01', open_gap_count: 0 } };
    const plan = run({
      employmentClaims: [emp('j1', '2018-01-01', '2020-06-30'), emp('j2', '2021-01-01', '2023-06-30')],
      openGaps: [{ current_status: 'VALID' }], // a gap opened under it
      existingHistorySpan: existing,
    });
    expect(plan.historySpan.kind).toBe('retire');
    if (plan.historySpan.kind !== 'retire') throw new Error('unreachable');
    expect(plan.historySpan.supersede_id).toBe('span-old');
  });
});
