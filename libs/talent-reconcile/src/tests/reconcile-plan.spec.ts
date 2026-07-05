import { describe, expect, it } from 'vitest';
import type { TalentRecordView } from '@aramo/talent-record';
import type { EvidenceRecordRow } from '@aramo/talent-trust';

import { computeReconcilePlan } from '../lib/reconcile-plan.js';

// Unit coverage for the pure reconcile engine — fill-null / align / contradict /
// address block / identity-stable / key_skills append / newest-by-type / VALID
// filter. No IO.

let seq = 0;
function ev(
  assertion_type: string,
  assertion_payload: unknown,
  opts: { status?: string; collected?: string; id?: string } = {},
): EvidenceRecordRow {
  seq += 1;
  return {
    id: opts.id ?? `ev-${seq}`,
    assertion_type,
    assertion_payload,
    current_status: opts.status ?? 'VALID',
    collected_at: new Date(opts.collected ?? '2026-07-04T00:00:00.000Z'),
    created_at: new Date(opts.collected ?? '2026-07-04T00:00:00.000Z'),
  } as EvidenceRecordRow;
}

function rec(over: Partial<Record<string, string | null>> = {}): TalentRecordView {
  return {
    first_name: 'Alan',
    last_name: 'Turing',
    email1: null,
    email2: null,
    phone_home: null,
    phone_cell: null,
    phone_work: null,
    address: null,
    address2: null,
    city: null,
    state: null,
    zip: null,
    web_site: null,
    key_skills: null,
    current_employer: null,
    ...over,
  } as unknown as TalentRecordView;
}

describe('computeReconcilePlan — fill-null contact', () => {
  it('fills null email1/phone_cell/web_site from newest declared evidence + records provenance', () => {
    const plan = computeReconcilePlan(rec(), [
      ev('EMAIL', { normalized_value: 'alan@x.com' }, { id: 'e1' }),
      ev('PHONE', { value: '+15550001' }, { id: 'p1' }),
      ev('PROFILE_URL', { value: 'https://x.com/alan' }, { id: 'u1' }),
    ]);
    expect(plan.patch).toEqual({
      email1: 'alan@x.com',
      phone_cell: '+15550001',
      web_site: 'https://x.com/alan',
    });
    expect(plan.provenance).toEqual(
      expect.arrayContaining([
        { field_name: 'email1', evidence_id: 'e1' },
        { field_name: 'phone_cell', evidence_id: 'p1' },
        { field_name: 'web_site', evidence_id: 'u1' },
      ]),
    );
    expect(plan.contradictions).toEqual([]);
  });

  it('fills the ADDRESS block sub-fields from one evidence, sharing its provenance', () => {
    const plan = computeReconcilePlan(rec(), [
      ev('ADDRESS', { address: '1 Bletchley', city: 'MK', state: 'BK', zip: 'MK3' }, { id: 'a1' }),
    ]);
    expect(plan.patch).toEqual({ address: '1 Bletchley', city: 'MK', state: 'BK', zip: 'MK3' });
    expect(plan.provenance.filter((p) => p.evidence_id === 'a1').map((p) => p.field_name).sort()).toEqual(
      ['address', 'city', 'state', 'zip'],
    );
  });

  it('occupied-same → no patch, provenance aligned (idempotent back-fill)', () => {
    const plan = computeReconcilePlan(rec({ email1: 'alan@x.com' }), [
      ev('EMAIL', { normalized_value: 'alan@x.com' }, { id: 'e1' }),
    ]);
    expect(plan.patch).toEqual({});
    expect(plan.provenance).toEqual([{ field_name: 'email1', evidence_id: 'e1' }]);
    expect(plan.contradictions).toEqual([]);
  });

  it('occupied + newer-differing → NOT overwritten, recorded as a pending contradiction', () => {
    const plan = computeReconcilePlan(rec({ email1: 'old@x.com' }), [
      ev('EMAIL', { normalized_value: 'new@x.com' }, { id: 'e2' }),
    ]);
    expect(plan.patch).toEqual({});
    expect(plan.contradictions).toEqual([{ field_name: 'email1', new_evidence_id: 'e2' }]);
    expect(plan.provenance).toEqual([]);
  });
});

describe('computeReconcilePlan — identity-stable + newest + VALID filter', () => {
  it('FULL_NAME differing from the record → pending contradiction, never patched', () => {
    const plan = computeReconcilePlan(rec({ first_name: 'Alan', last_name: 'Turing' }), [
      ev('FULL_NAME', { first_name: 'Alan', last_name: 'Lovelace' }, { id: 'n1' }),
    ]);
    // first_name matches (align), last_name differs (pending contradiction); never a patch.
    expect(plan.patch.first_name).toBeUndefined();
    expect(plan.patch.last_name).toBeUndefined();
    expect(plan.contradictions).toEqual([{ field_name: 'last_name', new_evidence_id: 'n1' }]);
    expect(plan.provenance).toEqual([{ field_name: 'first_name', evidence_id: 'n1' }]);
  });

  it('newest VALID evidence per type wins (later collected_at)', () => {
    const plan = computeReconcilePlan(rec(), [
      ev('EMAIL', { value: 'older@x.com' }, { id: 'old', collected: '2026-07-01T00:00:00.000Z' }),
      ev('EMAIL', { value: 'newer@x.com' }, { id: 'new', collected: '2026-07-04T00:00:00.000Z' }),
    ]);
    expect(plan.patch.email1).toBe('newer@x.com');
    expect(plan.provenance).toEqual([{ field_name: 'email1', evidence_id: 'new' }]);
  });

  it('non-VALID evidence (SUPERSEDED) is ignored', () => {
    const plan = computeReconcilePlan(rec(), [
      ev('EMAIL', { value: 'dead@x.com' }, { id: 'x', status: 'SUPERSEDED' }),
    ]);
    expect(plan.patch).toEqual({});
    expect(plan.provenance).toEqual([]);
  });

  it('never touches talent-stated / recruiter-owned fields (no evidence maps to them)', () => {
    const plan = computeReconcilePlan(rec(), [
      ev('EMAIL', { value: 'a@x.com' }),
      ev('FULL_NAME', { first_name: 'Alan', last_name: 'Turing' }),
    ]);
    expect(Object.keys(plan.patch)).toEqual(['email1']);
    // no availability_status/engagement_type/work_authorization/notes/is_hot keys
    expect(plan.patch).not.toHaveProperty('availability_status');
    expect(plan.patch).not.toHaveProperty('notes');
  });
});

describe('computeReconcilePlan — key_skills append (union)', () => {
  it('unions declared SKILL values into null key_skills', () => {
    const plan = computeReconcilePlan(rec(), [
      ev('SKILL', { value: 'Go' }, { id: 's1' }),
      ev('SKILL', { value: 'Rust' }, { id: 's2', collected: '2026-07-05T00:00:00.000Z' }),
    ]);
    expect(plan.patch.key_skills).toBe('Go, Rust');
    expect(plan.provenance).toEqual([{ field_name: 'key_skills', evidence_id: 's2' }]);
  });

  it('appends only NEW skills to an occupied key_skills (case-insensitive), no duplicate', () => {
    const plan = computeReconcilePlan(rec({ key_skills: 'Go, Python' }), [
      ev('SKILL', { value: 'go' }, { id: 's1' }),
      ev('SKILL', { value: 'Rust' }, { id: 's2', collected: '2026-07-05T00:00:00.000Z' }),
    ]);
    expect(plan.patch.key_skills).toBe('Go, Python, Rust');
  });

  it('no change when all declared skills already present → no patch', () => {
    const plan = computeReconcilePlan(rec({ key_skills: 'Go, Rust' }), [
      ev('SKILL', { value: 'Go' }),
      ev('SKILL', { value: 'rust' }),
    ]);
    expect(plan.patch.key_skills).toBeUndefined();
  });
});
