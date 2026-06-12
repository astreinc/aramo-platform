import { AramoError } from '@aramo/common';

// Job-Module (LB-4) — the PROMOTED write-side field-group edit-gate.
//
// THE RULE-OF-THREE: compensation-edit-gate (D-AUTHZ-COMP-WRITE-1) was the
// 1st write-gate; the company commercial write-strip is a 2nd (in the
// company repo); this Job-Module PR adds a 3rd (requisition financials).
// Instead of hand-copying the presence-keyed 403-before-persist logic a
// third time, the shared primitive is extracted here and consumed by BOTH
// the compensation gate (refactored to delegate) AND the new financial
// gate below.
//
// PRESENCE-IN-INPUT keying (load-bearing, inherited from the comp gate):
// the gate keys on what the CALLER supplied (`input[k] !== undefined`),
// NOT on what the repository's build*Data helpers write (which null-default
// every column and would over-block). A null-clear counts as a write
// (ruling 4: null-as-clear requires the edit scope).
//
// The gate is field-group-specific: a write touching ZERO gated fields is
// a no-op (a title-only PATCH stays a happy 200). For each group whose
// fields are present without the matching scope, the gate collects the
// missing scope + attempted fields and throws ONE 403 INSUFFICIENT_
// PERMISSIONS (reuse, not a new code) BEFORE persist + BEFORE audit.

export interface ScopedFieldGroup {
  scope: string;
  fields: readonly string[];
}

export function assertScopedFieldGroupsPresent(args: {
  input: Record<string, unknown>;
  scopes: readonly string[];
  requestId: string;
  groups: readonly ScopedFieldGroup[];
  message: string;
  reason: string;
}): void {
  const record = args.input;
  const scopeSet = new Set(args.scopes);
  const missingScopes: string[] = [];
  const attemptedFields: string[] = [];

  for (const group of args.groups) {
    const present = group.fields.filter((k) => record[k] !== undefined);
    if (present.length > 0 && !scopeSet.has(group.scope)) {
      missingScopes.push(group.scope);
      attemptedFields.push(...present);
    }
  }

  if (missingScopes.length === 0) return;

  throw new AramoError('INSUFFICIENT_PERMISSIONS', args.message, 403, {
    requestId: args.requestId,
    details: {
      reason: args.reason,
      missing_scopes: missingScopes,
      attempted_fields: attemptedFields,
    },
  });
}

// Job-Module (LB-4) — the requisition financial-planning write-gate.
//
// The 7 financial-planning write-fields are an all-or-nothing group gated
// by ONE scope (requisition:edit:financials). DISTINCT from the comp
// edit:pay/edit:bill groups (own scope; not in the D5 non-invertibility
// family). The scope-key string below MUST match
// libs/field-masking REQUISITION_VIEW_FINANCIALS's edit counterpart and
// libs/identity SEED_SCOPE_KEYS verbatim (libs/requisition does NOT import
// @aramo/field-masking — field-masking is the terminal read-side lib; the
// duplication mirrors the existing comp-edit-gate scope-key duplication).
const REQUISITION_EDIT_FINANCIALS = 'requisition:edit:financials' as const;

export const REQUISITION_FINANCIAL_WRITE_KEYS = [
  'target_margin_percent',
  'markup_percent_target',
  'rate_card_id',
  'min_bill_rate',
  'max_bill_rate',
  'min_pay_rate',
  'max_pay_rate',
] as const;

// Fire from RequisitionRepository.create / update / createForImport BEFORE
// the Prisma write. No-ops when the input carries zero financial fields.
export function assertFinancialEditScopes(args: {
  input: Record<string, unknown>;
  scopes: readonly string[];
  requestId: string;
}): void {
  assertScopedFieldGroupsPresent({
    input: args.input,
    scopes: args.scopes,
    requestId: args.requestId,
    groups: [
      { scope: REQUISITION_EDIT_FINANCIALS, fields: REQUISITION_FINANCIAL_WRITE_KEYS },
    ],
    message: 'Required requisition:edit:financials scope not granted',
    reason: 'financial_edit_scope_missing',
  });
}
