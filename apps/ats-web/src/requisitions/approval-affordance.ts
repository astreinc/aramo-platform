import type { RecruitingStatus } from './types';

// Requisition Lifecycle UX (L1-E) — the named lifecycle-ACTION affordance table.
//
// Governing invariant: status is DISPLAYED as state; a user changes the
// lifecycle only through named business ACTIONS that mirror the authoritative
// transition matrix — never by editing a status enum. This module computes the
// ordered named actions the detail header renders, purely from
// (current status × actor scopes × submitter-context).
//
// It MIRRORS the BE authority and is COSMETIC — the backend policy engine
// (apps/api/src/policy/requisition-lifecycle.package.ts TRANSITION_MATRIX) plus
// the in-service SoD gate (approval-authorization-gate.ts) are authoritative: a
// scope-less action, an illegal-from-status transition, or a self-approval is
// refused by the BE regardless of what the UI shows. This table exists to guide
// the user to the legitimate next transition, not to authorize it. A drift spec
// (lifecycle-action-drift.spec.ts) fs-reads the BE matrix + ACTION_TARGET_STATUS
// and fails on any divergence.

export type LifecycleActionId =
  | 'SUBMIT_FOR_APPROVAL'
  | 'APPROVE'
  | 'REJECT'
  | 'CLOSE'
  | 'REOPEN'
  | 'PUT_ON_HOLD'
  | 'CANCEL'
  | 'CLOSE_SUBMITTALS';

export interface LifecycleAction {
  readonly action: LifecycleActionId;
  readonly label: string;
  readonly toStatus: RecruitingStatus;
}

// Submitter-context for the SoD suppression. `submitterId` is the actor who last
// moved this requisition into pending_approval (the RequisitionView SoD field);
// `actorId` is the current session subject. When they match, the actor's own
// Approve is suppressed (segregation of duties) — Reject stays available.
export interface LifecycleActionContext {
  readonly submitterId: string | null;
  readonly actorId: string | null;
}

const REQUISITION_EDIT = 'requisition:edit';
const REQUISITION_EDIT_STATUS = 'requisition:edit:status';
const REQUISITION_APPROVE = 'requisition:approve';

// Which scope authorises each action. `canEditStatus` is the disjunction
// requisition:edit OR requisition:edit:status (mirrors the STATUS bucket in
// field-affordance.ts); `canApprove` is requisition:approve (APPROVE/REJECT).
type ActionScope = 'canEditStatus' | 'canApprove';

interface ActionMeta {
  readonly label: string;
  readonly toStatus: RecruitingStatus;
  readonly scope: ActionScope;
}

// Label + target-status + authorising scope per action. Targets mirror
// ACTION_TARGET_STATUS (libs/requisition/.../requisition-transitions.ts);
// CLOSE_SUBMITTALS is the NON-governed open-only edit (target submittals_closed).
// Labels are the locked L1-E copy — Tier-2-clean, never reworded.
const ACTION_META: Readonly<Record<LifecycleActionId, ActionMeta>> = {
  SUBMIT_FOR_APPROVAL: { label: 'Submit for approval', toStatus: 'pending_approval', scope: 'canEditStatus' },
  APPROVE: { label: 'Approve', toStatus: 'open', scope: 'canApprove' },
  REJECT: { label: 'Reject', toStatus: 'draft', scope: 'canApprove' },
  CLOSE: { label: 'Close', toStatus: 'closed', scope: 'canEditStatus' },
  REOPEN: { label: 'Reopen', toStatus: 'open', scope: 'canEditStatus' },
  PUT_ON_HOLD: { label: 'Put on hold', toStatus: 'on_hold', scope: 'canEditStatus' },
  CANCEL: { label: 'Cancel', toStatus: 'canceled', scope: 'canEditStatus' },
  CLOSE_SUBMITTALS: { label: 'Close submittals', toStatus: 'submittals_closed', scope: 'canEditStatus' },
};

// Per declared status → the ordered legal named actions. The GOVERNED actions
// mirror the TRANSITION_MATRIX ALLOW cells EXACTLY (draft: SUBMIT_FOR_APPROVAL;
// pending_approval: APPROVE/REJECT; CLOSE from lead/open/on_hold/submittals_closed;
// REOPEN from lead/on_hold/submittals_closed/closed; PUT_ON_HOLD from
// lead/open/submittals_closed; CANCEL from lead/open/on_hold/submittals_closed).
// CLOSE_SUBMITTALS is the non-governed edit and appears on `open` ONLY. Terminal
// `canceled` and gated `archived` expose nothing. The drift spec proves the
// governed set equals the matrix.
const STATUS_ACTIONS: Readonly<Record<RecruitingStatus, readonly LifecycleActionId[]>> = {
  lead: ['REOPEN', 'PUT_ON_HOLD', 'CLOSE', 'CANCEL'],
  draft: ['SUBMIT_FOR_APPROVAL'],
  pending_approval: ['APPROVE', 'REJECT'],
  open: ['CLOSE_SUBMITTALS', 'PUT_ON_HOLD', 'CLOSE', 'CANCEL'],
  on_hold: ['REOPEN', 'CLOSE', 'CANCEL'],
  submittals_closed: ['REOPEN', 'PUT_ON_HOLD', 'CLOSE', 'CANCEL'],
  closed: ['REOPEN'],
  canceled: [],
  archived: [],
};

// The helper copy for CLOSE_SUBMITTALS (locked L1-E copy). Surfaced by the host
// as the action's title so the recruiter understands the non-destructive scope.
export const CLOSE_SUBMITTALS_HELPER =
  'No additional Talent can be submitted to the client. Existing Talent already in process are not removed.';

// The SoD line the host renders when the current actor IS the submitter of a
// pending_approval requisition and holds requisition:approve (their own Approve
// is suppressed above). Locked L1-E copy.
export const SELF_APPROVAL_SOD_LINE =
  'You submitted this requisition for approval. Another approver is required.';

// The ordered named lifecycle actions for (status × scopes × submitter-context).
// Pure + cosmetic. SoD: the submitter's own APPROVE is suppressed (Reject stays).
export function lifecycleActionsFor(
  status: RecruitingStatus,
  scopes: readonly string[],
  ctx: LifecycleActionContext,
): LifecycleAction[] {
  const canEditStatus =
    scopes.includes(REQUISITION_EDIT) || scopes.includes(REQUISITION_EDIT_STATUS);
  const canApprove = scopes.includes(REQUISITION_APPROVE);
  const grants = (scope: ActionScope): boolean =>
    scope === 'canApprove' ? canApprove : canEditStatus;
  const isSelfSubmitter =
    ctx.submitterId !== null && ctx.submitterId === ctx.actorId;

  return (STATUS_ACTIONS[status] ?? []).flatMap((id) => {
    const meta = ACTION_META[id];
    if (!grants(meta.scope)) return [];
    // Segregation of duties — never render the submitter their own actionable
    // Approve. REJECT is deliberately NOT self-guarded (returning your own
    // requisition to draft is harmless), mirroring the BE gate.
    if (id === 'APPROVE' && isSelfSubmitter) return [];
    return [{ action: id, label: meta.label, toStatus: meta.toStatus }];
  });
}
