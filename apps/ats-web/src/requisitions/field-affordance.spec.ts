import { describe, expect, it } from 'vitest';

import { canEditBucket, COCKPIT_FIELDS } from './field-affordance';

// PR-A2 §4 P2 — the PER-FIELD AFFORDANCE proof (unit tier). Drives the cockpit
// edit affordances off the SAME canEditBucket predicate the cockpit renders
// with, so this table IS the contract. The roles below mirror the live PR-A1
// matrix; each asserts the editable/read-only decision per bucket. The
// backend-is-truth proof (a forced out-of-scope save 403s) is covered in
// RequisitionDetailView.cockpit.spec.tsx.

// Role → scope-set fixtures (the edit-scope axis from the A1 catalog).
const RECRUITER = ['requisition:read']; // read-only on requisitions
const STATUS_TIER = ['requisition:read', 'requisition:edit:status'];
const FULL_EDITOR = ['requisition:read', 'requisition:edit'];
const PAY_EDITOR = ['requisition:read', 'compensation:edit:pay'];
const BILL_EDITOR = ['requisition:read', 'compensation:edit:bill'];
const FIN_EDITOR = ['requisition:read', 'requisition:edit:financials'];
const PROFILE_EDITOR = ['requisition:read', 'requisition:profile:edit'];

describe('PR-A2 field affordance — canEditBucket', () => {
  it('recruiter (read-only) edits NOTHING — no bucket is editable', () => {
    for (const bucket of [
      'OPEN',
      'STATUS',
      'COMP_PAY',
      'COMP_BILL',
      'FINANCIAL',
      'PROFILE',
      'SYSTEM',
      'DERIVED',
    ] as const) {
      expect(canEditBucket(RECRUITER, bucket)).toBe(false);
    }
  });

  it('status-only tier edits STATUS only (the disjunction), nothing else', () => {
    expect(canEditBucket(STATUS_TIER, 'STATUS')).toBe(true);
    expect(canEditBucket(STATUS_TIER, 'OPEN')).toBe(false);
    expect(canEditBucket(STATUS_TIER, 'COMP_PAY')).toBe(false);
    expect(canEditBucket(STATUS_TIER, 'FINANCIAL')).toBe(false);
    expect(canEditBucket(STATUS_TIER, 'PROFILE')).toBe(false);
  });

  it('full editor edits OPEN + STATUS, but NOT comp/financial/profile (separate scopes)', () => {
    expect(canEditBucket(FULL_EDITOR, 'OPEN')).toBe(true);
    expect(canEditBucket(FULL_EDITOR, 'STATUS')).toBe(true);
    expect(canEditBucket(FULL_EDITOR, 'COMP_PAY')).toBe(false);
    expect(canEditBucket(FULL_EDITOR, 'COMP_BILL')).toBe(false);
    expect(canEditBucket(FULL_EDITOR, 'FINANCIAL')).toBe(false);
    expect(canEditBucket(FULL_EDITOR, 'PROFILE')).toBe(false);
  });

  it('pay editor edits COMP_PAY only; bill editor edits COMP_BILL only (the pay≠bill boundary)', () => {
    expect(canEditBucket(PAY_EDITOR, 'COMP_PAY')).toBe(true);
    expect(canEditBucket(PAY_EDITOR, 'COMP_BILL')).toBe(false);
    expect(canEditBucket(BILL_EDITOR, 'COMP_BILL')).toBe(true);
    expect(canEditBucket(BILL_EDITOR, 'COMP_PAY')).toBe(false);
  });

  it('financial editor edits FINANCIAL only; profile editor edits PROFILE only', () => {
    expect(canEditBucket(FIN_EDITOR, 'FINANCIAL')).toBe(true);
    expect(canEditBucket(FIN_EDITOR, 'OPEN')).toBe(false);
    expect(canEditBucket(PROFILE_EDITOR, 'PROFILE')).toBe(true);
    expect(canEditBucket(PROFILE_EDITOR, 'OPEN')).toBe(false);
  });

  it('SYSTEM + DERIVED are NEVER editable — even for a hold-everything actor', () => {
    const ALL = [
      'requisition:edit',
      'requisition:edit:status',
      'compensation:edit:pay',
      'compensation:edit:bill',
      'requisition:edit:financials',
      'requisition:profile:edit',
    ];
    expect(canEditBucket(ALL, 'SYSTEM')).toBe(false);
    expect(canEditBucket(ALL, 'DERIVED')).toBe(false);
  });

  it('the 3 derived comp views are mapped DERIVED (never editable)', () => {
    const derived = COCKPIT_FIELDS.filter((f) => f.bucket === 'DERIVED').map(
      (f) => f.key,
    );
    expect(derived).toEqual(['margin_amount', 'markup_percent', 'margin_percent']);
  });

  it('every cockpit field carries a known bucket + a section (table is well-formed)', () => {
    for (const f of COCKPIT_FIELDS) {
      expect(f.bucket).toBeDefined();
      expect(f.section).toBeDefined();
      expect(f.label.length).toBeGreaterThan(0);
    }
  });
});
