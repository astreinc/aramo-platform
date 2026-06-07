// Hand-mirrored from libs/requisition/src/lib/dto/requisition.view.ts and
// libs/requisition/src/lib/dto/requisition-status.ts. Source-annotated so
// a future BE shape change is caught by the failing build (the missing
// field) — not by silent drift at runtime. R1 hand-mirrors instead of
// importing @aramo/requisition (a forbidden domain edge from
// apps/recruiter-console).

export const REQUISITION_STATUS_VALUES = [
  'active',
  'on_hold',
  'full',
  'closed',
  'canceled',
  'lead',
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUS_VALUES)[number];

// Q2 ruling — the "my open reqs" framing. Closed = filled/closed/canceled.
// Active = everything else (active + lead + on_hold — work the recruiter
// can still touch).
export const CLOSED_REQUISITION_STATUSES: readonly RequisitionStatus[] = [
  'full',
  'closed',
  'canceled',
];

export function isClosedStatus(status: RequisitionStatus): boolean {
  return (CLOSED_REQUISITION_STATUSES as readonly string[]).includes(status);
}

// RequisitionView — mirrors the BE DTO. Compensation fields are present
// in the type (so a future expansion stays type-safe) but are masked at
// the BE for the recruiter (no compensation:view:* scope); R1 does NOT
// render them.
export interface RequisitionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly title: string;
  readonly company_id: string;
  readonly contact_id: string | null;
  readonly company_department_id: string | null;
  readonly status: RequisitionStatus;
  readonly type: string | null;
  readonly duration: string | null;
  readonly rate_max: string | null;
  readonly salary: string | null;
  readonly description: string | null;
  readonly notes: string | null;
  readonly is_hot: boolean;
  readonly openings: number;
  readonly openings_available: number;
  readonly start_date: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly recruiter_id: string | null;
  readonly owner_id: string | null;
  readonly entered_by_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  // Compensation surface (BE-masked for recruiter — present here so the
  // type system catches a future un-mask).
  readonly compensation_model: string | null;
  readonly pay_rate_amount: string | null;
  readonly pay_rate_currency: string | null;
  readonly pay_rate_period: string | null;
  readonly bill_rate_amount: string | null;
  readonly bill_rate_currency: string | null;
  readonly bill_rate_period: string | null;
  readonly placement_fee_percent: string | null;
  readonly placement_fee_amount: string | null;
  readonly salary_amount: string | null;
  readonly salary_currency: string | null;
  readonly margin_amount: string | null;
  readonly markup_percent: string | null;
  readonly margin_percent: string | null;
}

export interface RequisitionListResponse {
  readonly items: readonly RequisitionView[];
}
