import { AramoError } from '@aramo/common';
import { describe, expect, it } from 'vitest';

import { assertApprovalAuthorization } from '../lib/approval-authorization-gate.js';

// Requisition Approval sub-workflow — Boundary D5 (per-edge authorization).
// LOCKED: Aramo-Requisition-Approval-Subworkflow-Directive-v1_0 (R-RBAC).
//
// The pure authorization gate for the approval-DECISION edges (APPROVE / REJECT).
// It runs IN-SERVICE (RequisitionRepository.gateTransition), BEFORE the policy
// engine and BEFORE any write, mirroring status-edit-gate / financial-edit-gate:
//   - APPROVE / REJECT require the NEW requisition:approve scope (the ordinary
//     edit scope that reached the PATCH gate is NOT sufficient).
//   - APPROVE additionally enforces SEGREGATION OF DUTIES: the approver must
//     differ from the recruiter who submitted the requisition for approval.
//   - SUBMIT_FOR_APPROVAL and the four original transitions are NOT gated here
//     (they authorize via the ordinary edit scope upstream).

const REQ = 'req-approval-authz';
const APPROVER = '00000000-0000-0000-0000-0000000000a1';
const SUBMITTER = '00000000-0000-0000-0000-0000000000b2';
const WITH_APPROVE = ['requisition:read', 'requisition:edit', 'requisition:approve'];
const WITHOUT_APPROVE = ['requisition:read', 'requisition:edit'];

function run(overrides: Partial<Parameters<typeof assertApprovalAuthorization>[0]>) {
  return () =>
    assertApprovalAuthorization({
      action: 'APPROVE',
      scopes: WITH_APPROVE,
      actorId: APPROVER,
      submitterId: SUBMITTER,
      requestId: REQ,
      ...overrides,
    });
}

describe('assertApprovalAuthorization — approval-decision edge authz', () => {
  it('APPROVE with requisition:approve by a DIFFERENT actor than the submitter passes', () => {
    expect(run({})).not.toThrow();
  });

  it('REJECT with requisition:approve passes (not self-approval guarded)', () => {
    expect(run({ action: 'REJECT', actorId: SUBMITTER })).not.toThrow();
  });

  it('APPROVE WITHOUT requisition:approve → 403 (scope missing)', () => {
    let thrown: AramoError | undefined;
    try {
      run({ scopes: WITHOUT_APPROVE })();
    } catch (e) {
      thrown = e as AramoError;
    }
    expect(thrown).toBeInstanceOf(AramoError);
    expect(thrown?.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(thrown?.statusCode).toBe(403);
    expect(thrown?.context.details?.['reason']).toBe('requisition_approve_scope_missing');
  });

  it('REJECT WITHOUT requisition:approve → 403 (scope missing)', () => {
    expect(run({ action: 'REJECT', scopes: WITHOUT_APPROVE })).toThrow(AramoError);
  });

  it('APPROVE by the SUBMITTER themselves → 403 (segregation of duties)', () => {
    let thrown: AramoError | undefined;
    try {
      run({ actorId: SUBMITTER })();
    } catch (e) {
      thrown = e as AramoError;
    }
    expect(thrown).toBeInstanceOf(AramoError);
    expect(thrown?.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(thrown?.statusCode).toBe(403);
    expect(thrown?.context.details?.['reason']).toBe('requisition_self_approval_forbidden');
  });

  it('APPROVE when the submitter is unknown (null) → scope-checked only, no self-approval throw', () => {
    expect(run({ submitterId: null, actorId: APPROVER })).not.toThrow();
    // even if the approver happens to equal itself, a null submitter cannot match.
    expect(run({ submitterId: null, actorId: SUBMITTER })).not.toThrow();
  });

  it('SUBMIT_FOR_APPROVAL is NOT gated here (ordinary edit scope authorizes it upstream)', () => {
    expect(
      run({ action: 'SUBMIT_FOR_APPROVAL', scopes: WITHOUT_APPROVE, actorId: SUBMITTER, submitterId: SUBMITTER }),
    ).not.toThrow();
  });

  it('the four original transitions are NOT gated here', () => {
    for (const action of ['CLOSE', 'REOPEN', 'PUT_ON_HOLD', 'CANCEL'] as const) {
      expect(run({ action, scopes: WITHOUT_APPROVE })).not.toThrow();
    }
  });
});
