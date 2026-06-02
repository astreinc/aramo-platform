// RequisitionStatus — directive §4 closed list. Simple stored enum,
// NOT the pipeline state machine. Recruiter-editable via the standard
// requisition:edit scope; no transition rules, no event log, no
// openings_available decrement (those land at A5).
export const REQUISITION_STATUS_VALUES = [
  'active',
  'on_hold',
  'full',
  'closed',
  'canceled',
  'lead',
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUS_VALUES)[number];

export function isRequisitionStatus(value: unknown): value is RequisitionStatus {
  return (
    typeof value === 'string' &&
    (REQUISITION_STATUS_VALUES as readonly string[]).includes(value)
  );
}
