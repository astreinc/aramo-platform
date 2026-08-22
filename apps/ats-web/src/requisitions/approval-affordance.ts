import type { RecruitingStatus } from './types';

// Requisition Approval sub-workflow (D7) — the named approval affordances the
// cockpit renders, computed purely from (current status × actor scopes). This
// mirrors the BE governed edges + RBAC (R-RBAC); it is COSMETIC — the BE
// in-service gate is authoritative (a scope-less approve, or a self-approval,
// 403s regardless of what the UI shows). It exists to guide the user to the
// legitimate next transition, not to authorize it.

export type ApprovalAction = 'SUBMIT_FOR_APPROVAL' | 'APPROVE' | 'REJECT';

export interface ApprovalAffordance {
  readonly action: ApprovalAction;
  readonly label: string;
  readonly toStatus: RecruitingStatus;
}

const REQUISITION_EDIT = 'requisition:edit';
const REQUISITION_EDIT_STATUS = 'requisition:edit:status';
const REQUISITION_APPROVE = 'requisition:approve';

export function approvalAffordancesFor(
  status: RecruitingStatus,
  scopes: readonly string[],
): ApprovalAffordance[] {
  const canEditStatus =
    scopes.includes(REQUISITION_EDIT) || scopes.includes(REQUISITION_EDIT_STATUS);
  const canApprove = scopes.includes(REQUISITION_APPROVE);

  // draft → pending_approval (SUBMIT_FOR_APPROVAL) — the ordinary edit scope.
  if (status === 'draft' && canEditStatus) {
    return [
      { action: 'SUBMIT_FOR_APPROVAL', label: 'Submit for approval', toStatus: 'pending_approval' },
    ];
  }

  // pending_approval → open (APPROVE) / → draft (REJECT) — requisition:approve.
  if (status === 'pending_approval' && canApprove) {
    return [
      { action: 'APPROVE', label: 'Approve', toStatus: 'open' },
      { action: 'REJECT', label: 'Reject', toStatus: 'draft' },
    ];
  }

  return [];
}
