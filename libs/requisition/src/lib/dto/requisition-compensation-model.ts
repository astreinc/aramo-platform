// RequisitionCompensationModel — Compensation-Field Modeling v1.1 §2.3
// discriminator. CONTRACT uses bill_rate_* / pay_rate_* + the derived
// views (margin_amount, markup_percent, margin_percent computed in
// projectView). PERMANENT uses placement_fee_percent / _amount +
// structured salary_amount / salary_currency. The application doesn't
// enforce "CONTRACT requisitions must leave perm fields null" — the
// fields coexist on Requisition; the discriminator labels which set
// is meaningful for downstream consumers (display, reporting, D5's
// per-role view mask).
export const REQUISITION_COMPENSATION_MODEL_VALUES = [
  'CONTRACT',
  'PERMANENT',
] as const;
export type RequisitionCompensationModel =
  (typeof REQUISITION_COMPENSATION_MODEL_VALUES)[number];

export function isRequisitionCompensationModel(
  value: unknown,
): value is RequisitionCompensationModel {
  return (
    typeof value === 'string' &&
    (REQUISITION_COMPENSATION_MODEL_VALUES as readonly string[]).includes(value)
  );
}
