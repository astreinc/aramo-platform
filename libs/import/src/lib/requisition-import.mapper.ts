import {
  isRatePeriod,
  RECRUITING_STATUS_VALUES,
  resolveExternalIdentity,
  type CreateRequisitionRequestDto,
  type RecruitingStatus,
} from '@aramo/requisition';

import {
  CANONICAL_REQUISITION_IMPORT_KEYS,
  type CanonicalRequisitionImportRecord,
} from './dto/canonical-requisition-import.dto.js';

// T8-P2 — provider-neutral canonical requisition mapper (VMS Integration
// Directive v1.0 §5-§9). Pure: validates + maps a CanonicalRequisitionImportRecord
// into a CreateRequisitionRequestDto (the input to the governed createForImport
// path). Every rejection is a bounded, STABLE token — recorded as an
// ImportFailure.failure_reason (which is explicitly "NOT an ErrorCode"), so this
// adds NO error-code to the parity surface.
//
// The mapper enforces the T8-P2 semantics the governed create path does NOT:
//   - gated-status refusal at import (createForImport does not gate status)
//   - unknown-field rejection (no silent discard, no JSONB escape hatch, §6)
//   - the T5 boundary (person/assignment-specific terms are unknown keys → reject)
//   - openings maps ONLY to the stored total (§8)
// Identity canonicalization + the duplicate-identity conflict are reused from
// T8-P1 (resolveExternalIdentity here; the partial-unique index at persist).

// The bounded failure tokens (stable vocabulary; ImportFailure.failure_reason).
export type RequisitionImportFailureToken =
  | 'INVALID_EXTERNAL_IDENTITY'
  | 'MISSING_REQUIRED_FIELD'
  | 'INVALID_OPENINGS'
  | 'UNSUPPORTED_LIFECYCLE_STATUS'
  | 'GATED_STATUS_NOT_IMPORTABLE'
  | 'UNSUPPORTED_FIELD'
  | 'INVALID_COMMERCIAL_VALUE'
  | 'INVALID_DATE';

export class RequisitionImportMappingError extends Error {
  constructor(
    readonly token: RequisitionImportFailureToken,
    message: string,
    readonly offending_fields: string[] = [],
  ) {
    super(message);
    this.name = 'RequisitionImportMappingError';
  }
}

function fail(
  token: RequisitionImportFailureToken,
  message: string,
  fields: string[] = [],
): never {
  throw new RequisitionImportMappingError(token, message, fields);
}

// Non-negative decimal with up to 12 integer + 4 fractional digits — mirrors the
// requisition compensation-validation guard (Decimal(12,2)/(12,4) column widths).
const DECIMAL_RE = /^\d{1,12}(?:\.\d{1,4})?$/;

const RECRUITING_STATUS_SET: ReadonlySet<string> = new Set(RECRUITING_STATUS_VALUES);

function isIsoDate(value: string): boolean {
  const t = Date.parse(value);
  return !Number.isNaN(t);
}

// Aramo-INTERNAL lifecycle states an external import must NEVER set directly.
// draft / pending_approval are the internal approval-chain states — reachable
// ONLY through the governed SUBMIT_FOR_APPROVAL / APPROVE / REJECT transitions,
// never via bulk import — and archived is the retention state (subsystem not
// shipped). Deliberately DECOUPLED from isGatedRecruitingStatus: the Approval
// sub-workflow un-gated draft/pending_approval for the IN-APP workflow, but they
// stay non-importable — an external system's status maps only to the operational
// lifecycle (lead/open/on_hold/submittals_closed/closed/canceled). Behaviour of
// the import wall is unchanged (T8-P2 §9); the refusal is now its own concern.
const NON_IMPORTABLE_STATUSES: ReadonlySet<RecruitingStatus> = new Set([
  'draft',
  'pending_approval',
  'archived',
]);

// Resolve the adapter-supplied NORMALIZED status token into an internal
// RecruitingStatus (case-insensitive). The connector owns provider→internal
// normalization; the framework validates the token and enforces the import wall
// the create path does not (§9). Absent → undefined (repository defaults 'open').
function resolveStatus(
  record: CanonicalRequisitionImportRecord,
): RecruitingStatus | undefined {
  const raw = record.external_status;
  if (raw === undefined || raw === null || raw === '') return undefined; // → default 'open'
  const token = raw.trim().toLowerCase();
  if (!RECRUITING_STATUS_SET.has(token)) {
    fail('UNSUPPORTED_LIFECYCLE_STATUS', `external_status '${raw}' is not a normalized RecruitingStatus token`, ['external_status']);
  }
  if (NON_IMPORTABLE_STATUSES.has(token as RecruitingStatus)) {
    // draft | pending_approval | archived — internal lifecycle states; an import
    // must not set them (createForImport does not refuse status).
    fail('GATED_STATUS_NOT_IMPORTABLE', `status '${token}' is an internal lifecycle state and cannot be imported`, ['external_status']);
  }
  return token as RecruitingStatus;
}

// Map a canonical record → CreateRequisitionRequestDto, or throw a
// RequisitionImportMappingError with a bounded token.
export function mapCanonicalRequisition(
  record: CanonicalRequisitionImportRecord,
  requestId: string,
): CreateRequisitionRequestDto {
  // 1. Unknown-field rejection (§6/§7). Any key outside the canonical set —
  //    custom fields, provider extension blocks, person/assignment-specific
  //    commercial terms (T5-owned) — is rejected, never silently dropped.
  const unknown = Object.keys(record).filter(
    (k) => !CANONICAL_REQUISITION_IMPORT_KEYS.includes(k),
  );
  if (unknown.length > 0) {
    fail('UNSUPPORTED_FIELD', `unsupported field(s): ${unknown.join(', ')}`, unknown);
  }

  // 2. External identity (T8-P1). Canonicalizes source_system + validates
  //    external_req_id + co-presence. AramoError from the resolver → bounded token.
  let source_system: string | null;
  let external_req_id: string | null;
  try {
    const identity = resolveExternalIdentity(
      { source_system: record.source_system, external_req_id: record.external_req_id },
      requestId,
    );
    source_system = identity.source_system;
    external_req_id = identity.external_req_id;
  } catch {
    fail('INVALID_EXTERNAL_IDENTITY', 'source_system/external_req_id failed canonical validation', [
      'source_system',
      'external_req_id',
    ]);
  }
  if (source_system === null || external_req_id === null) {
    fail('INVALID_EXTERNAL_IDENTITY', 'source_system and external_req_id are both required', [
      'source_system',
      'external_req_id',
    ]);
  }

  // 3. Required fields.
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (title.length === 0) fail('MISSING_REQUIRED_FIELD', 'title is required', ['title']);
  const company_id = typeof record.company_id === 'string' ? record.company_id.trim() : '';
  if (company_id.length === 0) fail('MISSING_REQUIRED_FIELD', 'company_id is required', ['company_id']);

  // 4. Openings — maps ONLY to the stored total (§8). Non-negative integer;
  //    over-capacity (fewer openings than active assignments) stays representable,
  //    never rejected on derived availability.
  const openings = record.openings;
  if (typeof openings !== 'number' || !Number.isInteger(openings) || openings < 0) {
    fail('INVALID_OPENINGS', 'openings must be a non-negative integer', ['openings']);
  }

  // 5. Lifecycle → internal RecruitingStatus (gated refused above).
  const status = resolveStatus(record);

  // 6. Requisition-level commercial (§7) — decimal-string validation; write is
  //    gated by compensation:* at createForImport.
  if (record.bill_rate_amount !== undefined && !DECIMAL_RE.test(record.bill_rate_amount)) {
    fail('INVALID_COMMERCIAL_VALUE', 'bill_rate_amount must be a non-negative decimal string', ['bill_rate_amount']);
  }
  if (record.bill_rate_period !== undefined && !isRatePeriod(record.bill_rate_period)) {
    // A bounded failure rather than an opaque Prisma enum error at persist.
    fail('INVALID_COMMERCIAL_VALUE', 'bill_rate_period must be a valid RatePeriod (HOURLY|DAILY|WEEKLY|MONTHLY|ANNUAL)', ['bill_rate_period']);
  }

  // 7. Dates.
  for (const [field, value] of [
    ['start_date', record.start_date],
    ['end_date', record.end_date],
    ['imported_at', record.imported_at],
  ] as const) {
    if (value !== undefined && !isIsoDate(value)) {
      fail('INVALID_DATE', `${field} must be an ISO 8601 date`, [field]);
    }
  }

  const dto: CreateRequisitionRequestDto = {
    title,
    company_id,
    openings,
    source_system,
    external_req_id,
    ...(status !== undefined ? { status } : {}),
    ...(record.description !== undefined ? { description: record.description } : {}),
    ...(record.city !== undefined ? { city: record.city } : {}),
    ...(record.state !== undefined ? { state: record.state } : {}),
    ...(record.work_arrangement !== undefined ? { work_arrangement: record.work_arrangement } : {}),
    ...(record.job_type !== undefined ? { job_type: record.job_type } : {}),
    ...(record.contact_id !== undefined ? { contact_id: record.contact_id } : {}),
    ...(record.start_date !== undefined ? { start_date: record.start_date } : {}),
    ...(record.end_date !== undefined ? { end_date: record.end_date } : {}),
    ...(record.imported_at !== undefined ? { imported_at: record.imported_at } : {}),
    ...(record.bill_rate_amount !== undefined ? { bill_rate_amount: record.bill_rate_amount } : {}),
    ...(record.bill_rate_currency !== undefined ? { bill_rate_currency: record.bill_rate_currency } : {}),
    ...(record.bill_rate_period !== undefined
      ? { bill_rate_period: record.bill_rate_period as CreateRequisitionRequestDto['bill_rate_period'] }
      : {}),
  };
  return dto;
}
