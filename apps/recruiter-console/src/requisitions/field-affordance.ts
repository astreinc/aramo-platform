// PR-A2 P2 — the per-field AFFORDANCE map. The cockpit + the inline-edit
// primitive switch on this to decide editable / read-only / omitted per
// field. It REUSES the existing scope predicates (it does not reinvent
// them): the recon's PR-A1 bucket matrix mapped to the seeded edit-scopes.
//
// THE TWO-AXIS MODEL:
//   - VISIBILITY (read) is enforced at the BACKEND by field-masking — a
//     field the actor can't read is ABSENT from the RequisitionView payload
//     (the interceptor DELETEs it). The cockpit renders only what's present
//     (R8 — masking respected by absence). So this map governs EDITABILITY
//     only; the present/absent decision is the payload's, not this map's.
//   - EDITABILITY (write) is what `canEditBucket` answers: does the actor
//     hold the edit-scope for this field's bucket? The affordance is
//     cosmetic — the backend PATCH /:id per-field gate is the real check
//     (R6); a forced out-of-scope save 403s regardless.
//
// SYSTEM (id/timestamps/tenant) + DERIVED (margin/markup computed-on-read)
// are NEVER editable — no bucket grants them.

export type FieldBucket =
  | 'OPEN' // requisition:edit
  | 'STATUS' // requisition:edit OR requisition:edit:status
  | 'COMP_PAY' // compensation:edit:pay
  | 'COMP_BILL' // compensation:edit:bill
  | 'FINANCIAL' // requisition:edit:financials
  | 'PROFILE' // requisition:profile:edit
  | 'SYSTEM' // never editable
  | 'DERIVED'; // never editable (computed-on-read)

// Each bucket → the edit-scope(s) that grant write. A bucket with MULTIPLE
// scopes is satisfied by ANY one (the STATUS disjunction: requisition:edit
// is the full editor, requisition:edit:status is the narrow tier — either
// can write status). SYSTEM/DERIVED map to the empty set → never editable.
const BUCKET_EDIT_SCOPES: Readonly<Record<FieldBucket, readonly string[]>> = {
  OPEN: ['requisition:edit'],
  STATUS: ['requisition:edit', 'requisition:edit:status'],
  COMP_PAY: ['compensation:edit:pay'],
  COMP_BILL: ['compensation:edit:bill'],
  FINANCIAL: ['requisition:edit:financials'],
  PROFILE: ['requisition:profile:edit'],
  SYSTEM: [],
  DERIVED: [],
};

// True iff the actor's scopes grant edit on the bucket. ANY-of semantics
// for multi-scope buckets (STATUS). The single source of truth the cockpit
// + the affordance test both call (no two-place drift).
export function canEditBucket(
  scopes: readonly string[],
  bucket: FieldBucket,
): boolean {
  const required = BUCKET_EDIT_SCOPES[bucket];
  if (required.length === 0) return false;
  return required.some((s) => scopes.includes(s));
}

// The cockpit field descriptor table. Drives both rendering and the
// affordance proof. `kind` selects the inline editor; comp/financial fields
// render ONLY when present in the (masked) payload.
export type FieldKind = 'text' | 'number' | 'date' | 'select' | 'switch';

export interface CockpitFieldDescriptor {
  readonly key: string;
  readonly label: string;
  readonly bucket: FieldBucket;
  readonly kind: FieldKind;
  // Section grouping for the dense layout.
  readonly section: CockpitSection;
}

export type CockpitSection =
  | 'identity'
  | 'classification'
  | 'work_arrangement'
  | 'duration'
  | 'source'
  | 'compensation'
  | 'financial'
  | 'system';

// The authoritative field → (bucket, section, editor) table. Compensation
// + financial fields are listed but render conditionally on payload presence
// (masking by absence). The 3 DERIVED comp views are read-only by bucket.
export const COCKPIT_FIELDS: readonly CockpitFieldDescriptor[] = [
  // --- Identity / core (OPEN) ---
  { key: 'title', label: 'Title', bucket: 'OPEN', kind: 'text', section: 'identity' },
  { key: 'status', label: 'Status', bucket: 'STATUS', kind: 'select', section: 'identity' },
  { key: 'is_hot', label: 'Hot', bucket: 'OPEN', kind: 'switch', section: 'identity' },
  { key: 'openings', label: 'Openings', bucket: 'OPEN', kind: 'number', section: 'identity' },
  { key: 'start_date', label: 'Start date', bucket: 'OPEN', kind: 'date', section: 'identity' },
  { key: 'city', label: 'City', bucket: 'OPEN', kind: 'text', section: 'identity' },
  { key: 'state', label: 'State', bucket: 'OPEN', kind: 'text', section: 'identity' },
  { key: 'description', label: 'Description', bucket: 'OPEN', kind: 'text', section: 'identity' },
  { key: 'notes', label: 'Notes', bucket: 'OPEN', kind: 'text', section: 'identity' },

  // --- Classification (OPEN, enterprise) ---
  { key: 'job_type', label: 'Job type', bucket: 'OPEN', kind: 'select', section: 'classification' },
  { key: 'labor_category', label: 'Labor category', bucket: 'OPEN', kind: 'text', section: 'classification' },
  { key: 'role_family', label: 'Role family', bucket: 'OPEN', kind: 'select', section: 'classification' },
  { key: 'seniority_level', label: 'Seniority level', bucket: 'OPEN', kind: 'select', section: 'classification' },
  { key: 'headcount_reason', label: 'Headcount reason', bucket: 'OPEN', kind: 'select', section: 'classification' },

  // --- Work arrangement (OPEN, enterprise) ---
  { key: 'work_arrangement', label: 'Work arrangement', bucket: 'OPEN', kind: 'select', section: 'work_arrangement' },
  { key: 'travel_percent', label: 'Travel %', bucket: 'OPEN', kind: 'number', section: 'work_arrangement' },
  { key: 'relocation_offered', label: 'Relocation offered', bucket: 'OPEN', kind: 'switch', section: 'work_arrangement' },
  { key: 'work_authorization', label: 'Work authorization', bucket: 'OPEN', kind: 'select', section: 'work_arrangement' },

  // --- Duration & schedule (OPEN, enterprise) ---
  { key: 'end_date', label: 'End date', bucket: 'OPEN', kind: 'date', section: 'duration' },
  { key: 'duration_value', label: 'Duration value', bucket: 'OPEN', kind: 'number', section: 'duration' },
  { key: 'duration_unit', label: 'Duration unit', bucket: 'OPEN', kind: 'select', section: 'duration' },
  { key: 'extension_possible', label: 'Extension possible', bucket: 'OPEN', kind: 'switch', section: 'duration' },
  { key: 'hours_per_week', label: 'Hours / week', bucket: 'OPEN', kind: 'number', section: 'duration' },

  // --- Source / VMS (OPEN, enterprise) ---
  { key: 'source_system', label: 'Source system', bucket: 'OPEN', kind: 'select', section: 'source' },
  { key: 'external_req_id', label: 'External req ID', bucket: 'OPEN', kind: 'text', section: 'source' },

  // --- Compensation — pay side (COMP_PAY; render iff present in payload) ---
  { key: 'pay_rate_amount', label: 'Pay rate', bucket: 'COMP_PAY', kind: 'text', section: 'compensation' },
  { key: 'pay_rate_currency', label: 'Pay currency', bucket: 'COMP_PAY', kind: 'text', section: 'compensation' },
  { key: 'pay_rate_period', label: 'Pay period', bucket: 'COMP_PAY', kind: 'select', section: 'compensation' },
  { key: 'salary_amount', label: 'Salary', bucket: 'COMP_PAY', kind: 'text', section: 'compensation' },
  { key: 'salary_currency', label: 'Salary currency', bucket: 'COMP_PAY', kind: 'text', section: 'compensation' },
  // --- Compensation — bill side (COMP_BILL) ---
  { key: 'bill_rate_amount', label: 'Bill rate', bucket: 'COMP_BILL', kind: 'text', section: 'compensation' },
  { key: 'bill_rate_currency', label: 'Bill currency', bucket: 'COMP_BILL', kind: 'text', section: 'compensation' },
  { key: 'bill_rate_period', label: 'Bill period', bucket: 'COMP_BILL', kind: 'select', section: 'compensation' },
  { key: 'placement_fee_percent', label: 'Placement fee %', bucket: 'COMP_BILL', kind: 'text', section: 'compensation' },
  { key: 'placement_fee_amount', label: 'Placement fee', bucket: 'COMP_BILL', kind: 'text', section: 'compensation' },
  // --- Compensation — derived views (DERIVED; never editable) ---
  { key: 'margin_amount', label: 'Margin', bucket: 'DERIVED', kind: 'text', section: 'compensation' },
  { key: 'markup_percent', label: 'Markup %', bucket: 'DERIVED', kind: 'text', section: 'compensation' },
  { key: 'margin_percent', label: 'Margin %', bucket: 'DERIVED', kind: 'text', section: 'compensation' },

  // --- Financial planning (FINANCIAL; render iff present in payload) ---
  { key: 'target_margin_percent', label: 'Target margin %', bucket: 'FINANCIAL', kind: 'text', section: 'financial' },
  { key: 'markup_percent_target', label: 'Markup % target', bucket: 'FINANCIAL', kind: 'text', section: 'financial' },
  { key: 'rate_card_id', label: 'Rate card ID', bucket: 'FINANCIAL', kind: 'text', section: 'financial' },
  { key: 'min_bill_rate', label: 'Min bill rate', bucket: 'FINANCIAL', kind: 'text', section: 'financial' },
  { key: 'max_bill_rate', label: 'Max bill rate', bucket: 'FINANCIAL', kind: 'text', section: 'financial' },
  { key: 'min_pay_rate', label: 'Min pay rate', bucket: 'FINANCIAL', kind: 'text', section: 'financial' },
  { key: 'max_pay_rate', label: 'Max pay rate', bucket: 'FINANCIAL', kind: 'text', section: 'financial' },
];
