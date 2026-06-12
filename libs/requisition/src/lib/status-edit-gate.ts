import { AramoError } from '@aramo/common';

// PR-A1 Requisition-Gating Rework — the status-only edit gate.
//
// THE INVERTED GATE (restrict-to-subset). The compensation / financial
// edit-gates GATE-A-SUBSET: a write touching a gated field-group requires
// the matching scope. This gate does the OPPOSITE — it RESTRICTS a holder
// of the narrow requisition:edit:status scope to ONLY the status field:
//
//   - A holder of requisition:edit (the full editor) is UNAFFECTED — they
//     edit status + every other field exactly as before. The gate returns
//     immediately.
//   - A holder of requisition:edit:status WITHOUT requisition:edit (the
//     status-only tier — delivery_manager) may PATCH ONLY the `status`
//     field. ANY other field present in the request body → 403.
//   - A caller holding NEITHER scope has no edit capability → 403. (The
//     PATCH route no longer carries a route-level @RequireScopes guard —
//     it cannot express the "edit OR edit:status" disjunction since
//     RolesGuard is all-or-nothing AND — so the in-service gate is the
//     authoritative PATCH authorization point, mirroring the
//     comp/financial edit-gate's safe-by-construction repository-boundary
//     enforcement.)
//
// Enforced IN-SERVICE at RequisitionRepository.update BEFORE the comp /
// financial edit-gates and BEFORE the tenant-existence read, so a 403 does
// not leak existence-in-tenant via a 404-vs-403 timing difference (same
// ordering rationale as the comp gate).
//
// PRESENCE keying: "any other field" is keyed on the RAW request body keys
// (Object.keys(input) where input[k] !== undefined), NOT the typed DTO
// surface — so a status-only actor sending a status PLUS any unknown/extra
// key is still rejected. An empty body (no fields) is a no-op happy path.

const REQUISITION_EDIT = 'requisition:edit' as const;
const REQUISITION_EDIT_STATUS = 'requisition:edit:status' as const;

// The single field a status-only editor may write.
export const STATUS_ONLY_ALLOWED_FIELDS = ['status'] as const;

export function assertStatusOnlyEditScope(args: {
  input: Record<string, unknown>;
  scopes: readonly string[];
  requestId: string;
}): void {
  const scopeSet = new Set(args.scopes);

  // Full editor — unaffected.
  if (scopeSet.has(REQUISITION_EDIT)) return;

  const allowed = new Set<string>(STATUS_ONLY_ALLOWED_FIELDS);

  // Status-only editor — restrict to the status field.
  if (scopeSet.has(REQUISITION_EDIT_STATUS)) {
    const attempted = Object.keys(args.input).filter(
      (k) => args.input[k] !== undefined && !allowed.has(k),
    );
    if (attempted.length > 0) {
      throw new AramoError(
        'INSUFFICIENT_PERMISSIONS',
        'requisition:edit:status permits editing only the status field',
        403,
        {
          requestId: args.requestId,
          details: {
            reason: 'status_only_edit_field_violation',
            allowed_fields: [...STATUS_ONLY_ALLOWED_FIELDS],
            attempted_fields: attempted,
          },
        },
      );
    }
    return;
  }

  // Neither scope — no edit capability at all.
  throw new AramoError(
    'INSUFFICIENT_PERMISSIONS',
    'Requisition edit requires requisition:edit (or requisition:edit:status for the status-only tier)',
    403,
    {
      requestId: args.requestId,
      details: {
        reason: 'requisition_edit_scope_missing',
        required_scopes: [REQUISITION_EDIT, REQUISITION_EDIT_STATUS],
      },
    },
  );
}
