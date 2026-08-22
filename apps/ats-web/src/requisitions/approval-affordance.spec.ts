import { describe, expect, it } from 'vitest';

import { approvalAffordancesFor } from './approval-affordance';

// Requisition Approval sub-workflow — D7 UI affordance gate (pure).
// Mirrors the BE governed edges + RBAC (R-RBAC): the named affordances the
// cockpit renders are computed from (current status × actor scopes):
//   - draft + (requisition:edit OR requisition:edit:status) → Submit for approval
//   - pending_approval + requisition:approve → Approve, Reject
// The affordance is cosmetic (the BE gate is authoritative — a self-approval or
// a scope-less approve 403s regardless); it exists to guide, not to authorize.

const EDIT = ['requisition:read', 'requisition:edit'];
const EDIT_STATUS = ['requisition:read', 'requisition:edit:status'];
const APPROVE = ['requisition:read', 'requisition:edit', 'requisition:approve'];

describe('approvalAffordancesFor', () => {
  it('draft + edit scope → Submit for approval (→ pending_approval)', () => {
    const a = approvalAffordancesFor('draft', EDIT);
    expect(a).toEqual([{ action: 'SUBMIT_FOR_APPROVAL', label: 'Submit for approval', toStatus: 'pending_approval' }]);
  });

  it('draft + status-only edit scope → Submit for approval (edit:status suffices)', () => {
    expect(approvalAffordancesFor('draft', EDIT_STATUS).map((x) => x.action)).toEqual(['SUBMIT_FOR_APPROVAL']);
  });

  it('draft WITHOUT any edit scope → nothing', () => {
    expect(approvalAffordancesFor('draft', ['requisition:read'])).toEqual([]);
  });

  it('pending_approval + requisition:approve → Approve (→ open) and Reject (→ draft)', () => {
    const a = approvalAffordancesFor('pending_approval', APPROVE);
    expect(a).toEqual([
      { action: 'APPROVE', label: 'Approve', toStatus: 'open' },
      { action: 'REJECT', label: 'Reject', toStatus: 'draft' },
    ]);
  });

  it('pending_approval WITHOUT requisition:approve → nothing (even a full editor cannot approve)', () => {
    expect(approvalAffordancesFor('pending_approval', EDIT)).toEqual([]);
  });

  it('no approval affordances outside the approval chain (open / on_hold / closed)', () => {
    for (const s of ['open', 'on_hold', 'submittals_closed', 'closed', 'canceled', 'lead'] as const) {
      expect(approvalAffordancesFor(s, APPROVE)).toEqual([]);
    }
  });
});
