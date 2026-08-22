import { AramoError } from '@aramo/common';

import type { TransitionAction } from './dto/requisition-transitions.js';

// Requisition Approval sub-workflow (Amendment B, R-RBAC) — the per-edge
// authorization gate for the approval-DECISION transitions.
//
// Mirrors status-edit-gate / financial-edit-gate: a PURE (input × scopes) → throw
// boundary check, enforced IN-SERVICE at RequisitionRepository.gateTransition
// BEFORE the policy engine runs and BEFORE any write, so a 403 costs no policy
// decision record and no mutation.
//
//   - APPROVE / REJECT require the NEW requisition:approve scope. The ordinary
//     edit scope (requisition:edit / :edit:status) that carried the PATCH past
//     the status-only edit gate does NOT authorize an approval decision.
//   - APPROVE additionally enforces SEGREGATION OF DUTIES: the approver must
//     differ from the recruiter who submitted the requisition for approval
//     (the actor of the most recent SUBMIT_FOR_APPROVAL, resolved by the caller).
//     REJECT is deliberately NOT self-guarded — returning your own requisition to
//     `draft` for edits is harmless. A null submitter (unknown) skips the SoD
//     check but the scope requirement still applies.
//   - SUBMIT_FOR_APPROVAL and the four original transitions are NOT gated here —
//     they authorize via the ordinary edit scope upstream.

const REQUISITION_APPROVE = 'requisition:approve' as const;

export function assertApprovalAuthorization(args: {
  action: TransitionAction;
  scopes: readonly string[];
  actorId: string;
  /** Actor of the most recent SUBMIT_FOR_APPROVAL for this requisition, or null. */
  submitterId: string | null;
  requestId: string;
}): void {
  if (args.action !== 'APPROVE' && args.action !== 'REJECT') return;

  if (!args.scopes.includes(REQUISITION_APPROVE)) {
    throw new AramoError(
      'INSUFFICIENT_PERMISSIONS',
      'Approving or rejecting a requisition requires requisition:approve',
      403,
      {
        requestId: args.requestId,
        details: {
          reason: 'requisition_approve_scope_missing',
          required_scopes: [REQUISITION_APPROVE],
        },
      },
    );
  }

  if (
    args.action === 'APPROVE' &&
    args.submitterId !== null &&
    args.submitterId === args.actorId
  ) {
    throw new AramoError(
      'INSUFFICIENT_PERMISSIONS',
      'The approver must differ from the recruiter who submitted the requisition for approval',
      403,
      {
        requestId: args.requestId,
        details: { reason: 'requisition_self_approval_forbidden' },
      },
    );
  }
}
