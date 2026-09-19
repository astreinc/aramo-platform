import { describe, expect, it } from 'vitest';

import {
  PROFILE_HYDRATION_FIELDS,
  composeProfileHydration,
  type ProfileHydrationInputRecord,
} from '../lib/profile-hydration.js';
import type { TalentProfileFieldStateReadRow } from '../lib/talent-record-reconcile.repository.js';

// TALENT-INTEL-1 TI-1E-A — the aggregate profile-hydration projection is a
// DERIVED READ. It composes the operational TalentRecord value with the
// TI-1D-A/B field-state control/resolution/provenance metadata, encoding the
// governed precedence ONCE, server-side. It NEVER runs extraction, NEVER
// reconciles, NEVER writes. These tests pin the precedence + typing + the
// hard-HALT invariants the architecture ruling fixed.

// A minimal record carrying the columns the hydration set reads. All 29
// governed editable fields default to null / false; each test overrides.
function record(over: Partial<ProfileHydrationInputRecord> = {}): ProfileHydrationInputRecord {
  const base: ProfileHydrationInputRecord = {
    first_name: null,
    last_name: null,
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
    country: 'US',
    source: null,
    key_skills: null,
    current_employer: null,
    current_pay: null,
    desired_pay: null,
    date_available: null,
    can_relocate: false,
    is_hot: false,
    notes: null,
    web_site: null,
    best_time_to_call: null,
    title: null,
    availability_status: null,
    engagement_type: null,
    work_authorization: null,
    owner_id: null,
  };
  return { ...base, ...over };
}

function row(over: Partial<TalentProfileFieldStateReadRow> & { field_key: string }): TalentProfileFieldStateReadRow {
  return {
    value_state: 'UNKNOWN',
    source_type: 'RECONCILED',
    projection_policy: 'AUTO',
    resolution_status: 'NONE',
    resolution_reason: null,
    proposed_value: null,
    provenance: null,
    ...over,
  };
}

const TALENT_ID = '00000000-0000-7000-8000-e0000000e001';

function fieldsByKey(rows: TalentProfileFieldStateReadRow[] = []) {
  const res = composeProfileHydration(TALENT_ID, record(), rows);
  return new Map(res.fields.map((f) => [f.field_key, f]));
}

describe('composeProfileHydration — governed precedence + typing (TI-1E-A)', () => {
  it('covers the full governed editable field set exactly once, sorted', () => {
    const res = composeProfileHydration(TALENT_ID, record(), []);
    expect(res.talent_record_id).toBe(TALENT_ID);
    expect(res.fields).toHaveLength(PROFILE_HYDRATION_FIELDS.length);
    const keys = res.fields.map((f) => f.field_key);
    expect(new Set(keys).size).toBe(keys.length); // unique
    expect(keys).toEqual([...keys].sort()); // stable sorted
    // every governed field present
    for (const f of PROFILE_HYDRATION_FIELDS) {
      expect(keys).toContain(f.field_key);
    }
  });

  // ── HALT: EXPLICITLY_CLEARED wins, and is never refilled/mislabelled ──
  it('EXPLICITLY_CLEARED control wins → value_state=EXPLICITLY_CLEARED, current_value null, governed metadata faithful', () => {
    const res = composeProfileHydration(
      TALENT_ID,
      record({ work_authorization: null }),
      [row({ field_key: 'work_authorization', value_state: 'EXPLICITLY_CLEARED', source_type: 'MANUAL', projection_policy: 'HOLD' })],
    );
    const wa = res.fields.find((f) => f.field_key === 'work_authorization')!;
    expect(wa.value_state).toBe('EXPLICITLY_CLEARED');
    expect(wa.current_value).toBeNull();
    expect(wa.source_type).toBe('MANUAL');
    expect(wa.projection_policy).toBe('HOLD');
  });

  // ── HALT: UNKNOWN stays UNKNOWN (genuinely absent, no governance) ──
  it('empty field with no field-state row → UNKNOWN with null governed source (no fabrication)', () => {
    const f = fieldsByKey().get('notes')!;
    expect(f.current_value).toBeNull();
    expect(f.value_state).toBe('UNKNOWN');
    expect(f.source_type).toBeNull();
    expect(f.provenance).toBeNull();
    expect(f.resolution_status).toBe('NONE');
  });

  // ── HALT: operational fields NEVER receive fabricated provenance ──
  it('operational-only field WITH a value → SET but source_type null + provenance null (not fabricated MANUAL/RESUME/RECONCILED)', () => {
    const res = composeProfileHydration(TALENT_ID, record({ desired_pay: '$85/hr' }), []);
    const f = res.fields.find((x) => x.field_key === 'desired_pay')!;
    expect(f.current_value).toBe('$85/hr');
    expect(f.value_state).toBe('SET');
    expect(f.source_type).toBeNull();
    expect(f.provenance).toBeNull();
  });

  it('reconciled field (provenance row, no control) → SET + source_type RECONCILED + evidence linkage', () => {
    const res = composeProfileHydration(
      TALENT_ID,
      record({ city: 'Austin' }),
      [row({ field_key: 'city', value_state: 'UNKNOWN', source_type: 'RECONCILED', provenance: { evidence_id: 'ev-1' } })],
    );
    const f = res.fields.find((x) => x.field_key === 'city')!;
    expect(f.current_value).toBe('Austin');
    expect(f.value_state).toBe('SET'); // a present reconciled value displays as SET, not UNKNOWN
    expect(f.source_type).toBe('RECONCILED');
    expect(f.provenance).toEqual({ evidence_id: 'ev-1' });
  });

  it('explicit governed SET control is honored', () => {
    const res = composeProfileHydration(
      TALENT_ID,
      record({ email1: 'a@b.co' }),
      [row({ field_key: 'email1', value_state: 'SET', source_type: 'MANUAL' })],
    );
    const f = res.fields.find((x) => x.field_key === 'email1')!;
    expect(f.value_state).toBe('SET');
    expect(f.source_type).toBe('MANUAL');
    expect(f.current_value).toBe('a@b.co');
  });

  // ── typed values: booleans are booleans, never stringified ──
  it('boolean columns are returned as booleans (SET), not stringified', () => {
    const res = composeProfileHydration(TALENT_ID, record({ can_relocate: true, is_hot: false }), []);
    const cr = res.fields.find((f) => f.field_key === 'can_relocate')!;
    const ih = res.fields.find((f) => f.field_key === 'is_hot')!;
    expect(cr.current_value).toBe(true);
    expect(typeof cr.current_value).toBe('boolean');
    expect(cr.value_state).toBe('SET');
    expect(ih.current_value).toBe(false);
    expect(typeof ih.current_value).toBe('boolean');
    expect(ih.value_state).toBe('SET');
  });

  // ── resolution summary surfaces while PENDING_REVIEW ──
  it('PENDING_REVIEW surfaces resolution_status + reason + proposed_value', () => {
    const res = composeProfileHydration(
      TALENT_ID,
      record({ work_authorization: 'US_CITIZEN' }),
      [row({ field_key: 'work_authorization', value_state: 'SET', source_type: 'RECONCILED', resolution_status: 'PENDING_REVIEW', resolution_reason: 'EVIDENCE_CONFLICT', proposed_value: 'GREEN_CARD' })],
    );
    const f = res.fields.find((x) => x.field_key === 'work_authorization')!;
    expect(f.resolution_status).toBe('PENDING_REVIEW');
    expect(f.resolution_reason).toBe('EVIDENCE_CONFLICT');
    expect(f.proposed_value).toBe('GREEN_CARD');
  });

  it('non-null country default → SET with null governed source (operational)', () => {
    const f = fieldsByKey().get('country')!;
    expect(f.current_value).toBe('US');
    expect(f.value_state).toBe('SET');
    expect(f.source_type).toBeNull();
  });
});
