// RecruitingStatus — Track 1 T1-d supersession of the former RequisitionStatus.
// The DECLARED lifecycle only: a stored status label, NOT the pipeline state
// machine. Recruiter-editable via the standard requisition:edit scope; no
// transition rules and no event-log trigger live in this enum (governed
// transitions are T1-e). CapacityStatus is DERIVED and lands in Track 4.
//
// Value crosswalk (PO ruling): former `active` -> `open`; former `full` ->
// `submittals_closed`; `lead` retained as the functional intake state;
// on_hold/closed/canceled unchanged.
//
// Subsystem-gated: `archived` exists in the value space but its transition-in is
// registered DISABLED until the retention subsystem lands (see
// SELECTABLE_RECRUITING_STATUS_VALUES for the set a recruiter may actually choose
// today). `draft` + `pending_approval` were un-gated by the Approval sub-workflow
// (they are now reachable via the governed SUBMIT_FOR_APPROVAL / APPROVE / REJECT
// edges + ordinary entry into `draft`).
export const RECRUITING_STATUS_VALUES = [
  'lead',
  'draft',
  'pending_approval',
  'open',
  'on_hold',
  'submittals_closed',
  'canceled',
  'closed',
  'archived',
] as const;
export type RecruitingStatus = (typeof RECRUITING_STATUS_VALUES)[number];

// Subsystem-gated values whose behaviour does not exist yet — a recruiter
// cannot transition a requisition INTO these (directive §2, PO correction 1).
// They remain valid enum members so the type is complete and a future
// subsystem can light them up without a schema change. The Approval sub-workflow
// (Amendment B) un-gated `draft` + `pending_approval`; `archived` stays gated
// until the retention subsystem ships.
export const GATED_RECRUITING_STATUS_VALUES = [
  'archived',
] as const satisfies readonly RecruitingStatus[];

// The values a recruiter may actually select / transition into today.
export const SELECTABLE_RECRUITING_STATUS_VALUES: readonly RecruitingStatus[] =
  RECRUITING_STATUS_VALUES.filter(
    (v) => !(GATED_RECRUITING_STATUS_VALUES as readonly string[]).includes(v),
  );

export function isRecruitingStatus(value: unknown): value is RecruitingStatus {
  return (
    typeof value === 'string' &&
    (RECRUITING_STATUS_VALUES as readonly string[]).includes(value)
  );
}

// Track 1 T1-e (§2.3 / R9) — is this status one a recruiter may NOT transition
// INTO today? The write path uses this to refuse a gated target server-side
// (REQUISITION_STATUS_GATED), independent of the transition-policy engine —
// the gated set is unreachable BY CONSTRUCTION, not by a policy rule.
export function isGatedRecruitingStatus(value: RecruitingStatus): boolean {
  return (GATED_RECRUITING_STATUS_VALUES as readonly string[]).includes(value);
}
