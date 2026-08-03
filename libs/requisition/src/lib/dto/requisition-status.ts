// RecruitingStatus (T1-d — supersedes RequisitionStatus; Track-1 §T1-d) — the
// declared-status closed list, in lifecycle order. Simple stored enum, NOT the
// pipeline state machine. Recruiter-editable via requisition:edit; no transition
// rules yet (T1-e adds the governed machine). Order + membership MUST match the
// Prisma enum `RecruitingStatus` and the FE mirror (drift-guarded).
//
//   • `lead` is retained + functional (a real pre-open staffing state).
//   • `draft` / `pending_approval` / `archived` are present-but-inert — no
//     transition path leads into them until their subsystems land (T1-e+).
//   • `active` → `open`, `full` → `submittals_closed`.
// (Constant name kept `REQUISITION_STATUS_VALUES`: it is the requisition's
//  status-value list; the enum type it produces is `RecruitingStatus`.)
export const REQUISITION_STATUS_VALUES = [
  'draft',
  'pending_approval',
  'lead',
  'open',
  'on_hold',
  'submittals_closed',
  'closed',
  'canceled',
  'archived',
] as const;
export type RecruitingStatus = (typeof REQUISITION_STATUS_VALUES)[number];

export function isRecruitingStatus(value: unknown): value is RecruitingStatus {
  return (
    typeof value === 'string' &&
    (REQUISITION_STATUS_VALUES as readonly string[]).includes(value)
  );
}
