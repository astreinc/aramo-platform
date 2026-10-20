// Talent Lifecycle R1–R5 Implementation Directive v1.2 LOCKED §5.1 — A1 AM-1 §2.2 as a PURE
// code-level rule: requisition status → which Pipeline activity is permitted. It is NOT
// policy data: `evaluate()` throws for a resource a tenant's package lacks, and only the
// sentinel + Astre are re-seeded on deploy, so a new policy column would fail progression
// closed for every other tenant (precedent: isRequisitionSubmittable, open-only submit).
//
// A1 AM-1 §2.2 (Lead ruling D-2 for `lead` is PROVISIONAL):
//   | Pipeline activity                         | open  | on_hold | lead  | closed / canceled |
//   | ADD (Add Talent)                          | Allow | Allow   | Allow | Deny              |
//   | CONTACT_SEND (req-scoped email/voice/RTR) | Allow | Allow   | Allow | Deny              |
//   | CONTACT_EVIDENCE (→ contacted)            | Allow | Allow   | Allow | Historical only   |
//   | RESPONSE (→ talent_responded)             | Allow | Allow   | Deny  | Deny              |
//   | QUALIFY_DECISION (→ qualifying/qualified) | Allow | Allow   | Deny  | Deny              |
// New client submittal stays governed by isRequisitionSubmittable (open only).
// `submittals_closed`, `draft`, `pending_approval` and `archived` are UNCHANGED by A1 (D-8):
// this rule does not restrict them (the existing ADD policy matrix still governs ADD there).

export type RequisitionPipelineActivity =
  | 'ADD'
  | 'CONTACT_SEND'
  | 'CONTACT_EVIDENCE'
  | 'RESPONSE'
  | 'QUALIFY_DECISION';

const TERMINAL_REQUISITION_STATUSES: ReadonlySet<string> = new Set(['closed', 'canceled']);

/** A1 AM-2 — `closed` and `canceled` are terminal for the ordinary lifecycle. */
export function isTerminalRequisitionStatus(status: string): boolean {
  return TERMINAL_REQUISITION_STATUSES.has(status);
}

/** True iff the requisition status permits the Pipeline activity (A1 AM-1 §2.2). */
export function requisitionPermits(status: string, activity: RequisitionPipelineActivity): boolean {
  if (TERMINAL_REQUISITION_STATUSES.has(status)) return false;
  if (status === 'lead') {
    // D-2 provisional (A1 §1): Add, stop at Contacted, no client submittal.
    return activity === 'ADD' || activity === 'CONTACT_SEND' || activity === 'CONTACT_EVIDENCE';
  }
  return true;
}

// v1.2 §5.2 (Lead ruling L-3, APPROVED WITH LIMITS) — the requisition gate for one Pipeline
// status change, evaluated INSIDE the transition transaction against the requisition status
// read FOR SHARE (§5.3):
//   - forward progression into contacted / talent_responded / qualifying / qualified →
//     requisitionPermits(status, CONTACT_EVIDENCE | RESPONSE | QUALIFY_DECISION);
//   - an ordinary BACKWARD stage correction → denied on closed / canceled;
//   - not_in_consideration on closed / canceled → allowed ONLY as a governed final
//     disposition carrying its reason (the /actions DISPOSITION path);
//   - system downstream commands (COMPLETE, downstream DISPOSITION) → ungated: the
//     placement / client-decision domains keep authority (A1 §2.2);
//   - a requisition that does not resolve in the tenant → refused (fail-closed, §2.6).
// (VOID — ADDED_BY_MISTAKE from no_contact — runs its own command, not this gate; LR-F C-2.)
export type RequisitionGateRefusal =
  | RequisitionPipelineActivity
  | 'BACKWARD_CORRECTION'
  | 'FINAL_DISPOSITION_WITHOUT_REASON'
  | 'REQUISITION_UNRESOLVED';

const ACTIVE_ORDER: readonly string[] = ['no_contact', 'contacted', 'talent_responded', 'qualifying', 'qualified'];
const FORWARD_ACTIVITY: Readonly<Record<string, RequisitionPipelineActivity>> = {
  contacted: 'CONTACT_EVIDENCE',
  talent_responded: 'RESPONSE',
  qualifying: 'QUALIFY_DECISION',
  qualified: 'QUALIFY_DECISION',
};

export function requisitionGateForTransition(args: {
  from_status: string;
  to_status: string;
  requisition_status: string | null;
  has_disposition: boolean;
  system_downstream: boolean;
}): RequisitionGateRefusal | null {
  if (args.system_downstream || args.to_status === 'completed') return null;
  if (args.requisition_status === null) return 'REQUISITION_UNRESOLVED';
  const status = args.requisition_status;
  if (args.to_status === 'not_in_consideration') {
    return isTerminalRequisitionStatus(status) && !args.has_disposition ? 'FINAL_DISPOSITION_WITHOUT_REASON' : null;
  }
  const from = ACTIVE_ORDER.indexOf(args.from_status);
  const to = ACTIVE_ORDER.indexOf(args.to_status);
  if (from === -1 || to === -1) return null;
  if (to < from) return isTerminalRequisitionStatus(status) ? 'BACKWARD_CORRECTION' : null;
  const activity = FORWARD_ACTIVITY[args.to_status];
  if (activity === undefined) return null;
  return requisitionPermits(status, activity) ? null : activity;
}
