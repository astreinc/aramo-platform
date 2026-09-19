import { describe, expect, it } from 'vitest';

import {
  CLEARED_LABEL,
  REVIEW_REQUIRED_LABEL,
  formatHydrationValue,
  toHydrationDisplay,
  type ProfileHydrationItem,
} from './profile-hydration';

// TALENT-INTEL-1 TI-1E-B1 — the FE hydration DISPLAY adapter. The browser
// RENDERS server-owned hydration state; it never reconstructs it. The server's
// value_state drives empty/cleared; source_type drives the provenance chip
// (null ⇒ no chip, never FE-inferred); resolution drives the attention
// affordance. These tests pin those invariants.

function item(over: Partial<ProfileHydrationItem> & { field_key: string }): ProfileHydrationItem {
  return {
    current_value: null,
    value_state: 'UNKNOWN',
    source_type: null,
    projection_policy: 'AUTO',
    provenance: null,
    resolution_status: 'NONE',
    resolution_reason: null,
    proposed_value: null,
    ...over,
  };
}

describe('toHydrationDisplay — server-owned rendering (TI-1E-B1)', () => {
  it('SET → the typed value, no cleared/review affordance', () => {
    const d = toHydrationDisplay(item({ field_key: 'city', value_state: 'SET', current_value: 'London' }));
    expect(d.state).toBe('SET');
    expect(d.valueText).toBe('London');
    expect(d.clearedLabel).toBeNull();
    expect(d.needsReview).toBe(false);
  });

  it('UNKNOWN → em-dash, NOT the word "Unknown"', () => {
    const d = toHydrationDisplay(item({ field_key: 'notes', value_state: 'UNKNOWN' }));
    expect(d.valueText).toBe('—');
    expect(d.clearedLabel).toBeNull();
    expect(d.valueText.toLowerCase()).not.toContain('unknown');
  });

  it('EXPLICITLY_CLEARED → em-dash + "Cleared" affordance, distinct from UNKNOWN', () => {
    const d = toHydrationDisplay(item({ field_key: 'work_authorization', value_state: 'EXPLICITLY_CLEARED' }));
    expect(d.valueText).toBe('—');
    expect(d.clearedLabel).toBe(CLEARED_LABEL);
    expect(CLEARED_LABEL).toBe('Cleared');
  });

  it('boolean SET is typed (Yes/No), never the string "true"/"false"', () => {
    const yes = toHydrationDisplay(item({ field_key: 'can_relocate', value_state: 'SET', current_value: true }));
    const no = toHydrationDisplay(item({ field_key: 'is_hot', value_state: 'SET', current_value: false }));
    expect(yes.valueText).toBe('Yes');
    expect(no.valueText).toBe('No');
    expect(yes.valueText).not.toBe('true');
    expect(no.valueText).not.toBe('false');
  });

  it('numeric SET renders the number', () => {
    const d = toHydrationDisplay(item({ field_key: 'x', value_state: 'SET', current_value: 42 }));
    expect(d.valueText).toBe('42');
  });

  // ── HALT: provenance comes from the server source_type, never inferred ──
  it('source_type null → NO provenance chip (operational value, not fabricated)', () => {
    const d = toHydrationDisplay(item({ field_key: 'desired_pay', value_state: 'SET', current_value: '$85/hr', source_type: null }));
    expect(d.provenance).toBeNull();
  });

  it('source_type drives the provenance chip verbatim (RECONCILED)', () => {
    const d = toHydrationDisplay(item({ field_key: 'city', value_state: 'SET', current_value: 'London', source_type: 'RECONCILED', provenance: { evidence_id: 'ev1' } }));
    expect(d.provenance).toBe('RECONCILED');
  });

  it('PENDING_REVIEW → "Review required" affordance surfacing the proposed value', () => {
    const d = toHydrationDisplay(item({
      field_key: 'work_authorization',
      value_state: 'EXPLICITLY_CLEARED',
      resolution_status: 'PENDING_REVIEW',
      resolution_reason: 'EVIDENCE_CONFLICT',
      proposed_value: 'US_CITIZEN',
    }));
    expect(d.needsReview).toBe(true);
    expect(d.reviewLabel).toBe(REVIEW_REQUIRED_LABEL);
    expect(REVIEW_REQUIRED_LABEL).toBe('Review required');
    expect(d.proposedText).toBe('US_CITIZEN');
  });

  it('RESOLVED / NONE → no review affordance', () => {
    expect(toHydrationDisplay(item({ field_key: 'a', resolution_status: 'RESOLVED' })).needsReview).toBe(false);
    expect(toHydrationDisplay(item({ field_key: 'b', resolution_status: 'NONE' })).needsReview).toBe(false);
  });
});

describe('formatHydrationValue — typed formatting', () => {
  it('null → em-dash; boolean → Yes/No; array → comma-joined; number/string verbatim', () => {
    expect(formatHydrationValue(null)).toBe('—');
    expect(formatHydrationValue(true)).toBe('Yes');
    expect(formatHydrationValue(false)).toBe('No');
    expect(formatHydrationValue(['a', 'b'])).toBe('a, b');
    expect(formatHydrationValue(7)).toBe('7');
    expect(formatHydrationValue('hi')).toBe('hi');
  });
});
