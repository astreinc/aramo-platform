import { AramoError } from '@aramo/common';

import type { CreateRequisitionRequestDto } from './dto/create-requisition-request.dto.js';
import type { UpdateRequisitionRequestDto } from './dto/update-requisition-request.dto.js';

// D-AUTHZ-COMP-WRITE-1 — the compensation write-side scope gate.
//
// THE FINDING (the carry from R4): the D5 compensation invariant was
// enforced ONLY at the READ layer (the field-masking interceptor) — a
// caller with requisition:edit + NO compensation:view:pay could
// POST/PATCH pay fields the BE persists (then masks from the writer on
// read; a higher-scoped user reads them later). The SAME CLASS as the
// P1 defect (a security invariant at the read/caller layer, not the
// write boundary).
//
// THE FIX: enforce IN-SERVICE at the REPOSITORY write boundary
// (safe-by-construction, every caller covered — no service tier exists;
// the repository is the deepest layer all 3 write paths traverse:
// create + update + createForImport). For each compensation field-group
// PRESENT in the input payload, require the matching compensation:edit:*
// scope; reject 403 INSUFFICIENT_PERMISSIONS BEFORE persist + BEFORE
// audit.
//
// THE TWO WRITE-FIELD GROUPS (mirror libs/field-masking SCOPE_TO_FIELDS;
// the minimum-coherent write set):
//   - edit:pay  → pay_rate_amount, pay_rate_currency, pay_rate_period,
//                 salary_amount, salary_currency
//   - edit:bill → bill_rate_amount, bill_rate_currency, bill_rate_period,
//                 placement_fee_percent, placement_fee_amount
// The 4 other view-side scopes (revenue / spread:amount / spread:percent
// / margin:percent) gate read-only DERIVED fields (computed in
// projectView from the two stored facts; no Prisma column, no DTO
// surface). No writeable surface → no edit scope.
//
// SCOPE-KEY DUPLICATION (load-bearing): the strings below MUST match
// libs/field-masking COMPENSATION_EDIT_PAY/BILL constants verbatim.
// libs/requisition does NOT import @aramo/field-masking — field-masking
// is the TERMINAL lib, the dependency direction is apps/api →
// field-masking only (per libs/field-masking/src/index.ts). The
// scope-key duplication mirrors the existing pattern in
// libs/identity/src/lib/dto/scope.dto.ts (SEED_SCOPE_KEYS lists
// 'compensation:view:pay' as a literal that duplicates
// libs/field-masking COMPENSATION_VIEW_PAY).
const COMPENSATION_EDIT_PAY = 'compensation:edit:pay' as const;
const COMPENSATION_EDIT_BILL = 'compensation:edit:bill' as const;

// The 5 stored-persisted pay write-fields (mirrors view:pay's grant set).
export const COMPENSATION_PAY_WRITE_KEYS = [
  'pay_rate_amount',
  'pay_rate_currency',
  'pay_rate_period',
  'salary_amount',
  'salary_currency',
] as const;

// The 5 stored-persisted bill write-fields (mirrors view:bill's grant set).
export const COMPENSATION_BILL_WRITE_KEYS = [
  'bill_rate_amount',
  'bill_rate_currency',
  'bill_rate_period',
  'placement_fee_percent',
  'placement_fee_amount',
] as const;

// The gate's input is the union of CREATE + UPDATE — UPDATE additionally
// permits `null` for clearing (ruling 4: null-as-clear requires the
// edit scope). Each comp field is `string | RatePeriod | null |
// undefined`; presence-in-input is `!== undefined`, so a null clear is
// gated identically to a set.
type CompensationWritableInput =
  | CreateRequisitionRequestDto
  | UpdateRequisitionRequestDto;

// Ruling 4: null-as-clear requires the edit scope — a clear IS a
// mutation. Ruling 5: compensation_model (a CONTRACT/PERMANENT label)
// is NOT gated — it's a discriminator, not a $ value.
//
// PRESENCE-IN-INPUT keying (load-bearing): the gate keys on what the
// CALLER supplied (`input.K !== undefined`), NOT on what
// buildCompensationCreateData writes (which null-defaults every comp
// column — would over-block every CREATE for callers without both
// edit scopes; reading the helper's output instead of the input was
// the §1(c) trap the directive flagged).
function presentWriteFields(
  input: CompensationWritableInput,
  keys: readonly string[],
): string[] {
  // Both DTOs declare every comp field as a typed optional; reading them
  // by string key returns the value or `undefined`. Treat the input
  // structurally — the only thing that matters is whether the caller
  // supplied the key (set or null).
  const record = input as unknown as Record<string, unknown>;
  return keys.filter((k) => record[k] !== undefined);
}

// THE GATE — the load-bearing 403-before-persist. Called from
// RequisitionRepository.create / update / createForImport BEFORE the
// Prisma write. Throws INSUFFICIENT_PERMISSIONS (HTTP 403; ruling 6 —
// reuse, not a new code) with structured details so the recruiter UI
// can render an actionable rejection.
//
// No-ops when the input carries zero compensation write-fields (the
// title-only / non-compensation PATCH stays a happy 200 — the gate is
// field-group-specific, NOT a blanket compensation block).
//
// Order: AFTER validateCompensationInput (structural 400 stays first),
// BEFORE prisma.requisition.{create,update}.
export function assertCompensationEditScopes(args: {
  input: CompensationWritableInput;
  scopes: readonly string[];
  requestId: string;
}): void {
  const writingPay = presentWriteFields(args.input, COMPENSATION_PAY_WRITE_KEYS);
  const writingBill = presentWriteFields(args.input, COMPENSATION_BILL_WRITE_KEYS);
  if (writingPay.length === 0 && writingBill.length === 0) return;

  const scopeSet = new Set(args.scopes);
  const missingScopes: string[] = [];
  const attemptedFields: string[] = [];

  if (writingPay.length > 0 && !scopeSet.has(COMPENSATION_EDIT_PAY)) {
    missingScopes.push(COMPENSATION_EDIT_PAY);
    attemptedFields.push(...writingPay);
  }
  if (writingBill.length > 0 && !scopeSet.has(COMPENSATION_EDIT_BILL)) {
    missingScopes.push(COMPENSATION_EDIT_BILL);
    attemptedFields.push(...writingBill);
  }

  if (missingScopes.length === 0) return;

  throw new AramoError(
    'INSUFFICIENT_PERMISSIONS',
    'Required compensation:edit scope(s) not granted',
    403,
    {
      requestId: args.requestId,
      details: {
        reason: 'compensation_edit_scope_missing',
        missing_scopes: missingScopes,
        attempted_fields: attemptedFields,
      },
    },
  );
}
