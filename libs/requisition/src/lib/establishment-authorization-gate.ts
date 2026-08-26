import { AramoError } from '@aramo/common';

import type { RecruitingStatus } from './dto/requisition-status.js';

// Requisition Lane 1-A (Create-Governance) — the initial-state authority gate.
//
// Sibling to approval-authorization-gate.ts: a PURE
// (mode × requested_status × scopes) → throw boundary check, enforced
// IN-SERVICE at RequisitionRepository.create / createForImport BEFORE the
// data build and BEFORE any write, so a refusal costs no mutation and no
// lifecycle/audit emission. It CLOSES the generic-CSV establish hole — today
// the NON_IMPORTABLE_STATUSES wall lives only in the VMS mapper.
//
// Governing invariant (Directive §9): every Requisition state establishment
// passes through creation-mode × establishment-authority × allowed-initial-
// state. After L1-A there is NO `input.status ?? 'open' -> INSERT` on any
// path. `origin = integration` is a creation MODE, never a credential.
//
// Authority model (Directive v1.1, D-A1-GRANT — DECOUPLED):
//   - MANUAL           create() + actor_kind:'user'. Base authority
//                      requisition:create (route-gated). Allowed { draft }.
//   - MANUAL-ESTABLISH MANUAL + requisition:create:establish. Allowed
//                      { draft, open }. Granted to NO human tenant role in v1.
//   - INTEGRATION      the createForImport() path. Authority = the EXISTING
//                      requisition:import:write (route-gated on the canonical
//                      import surface; re-asserted here at the floor). Allowed
//                      { lead, open, on_hold, submittals_closed, closed,
//                      canceled } — draft/pending_approval/archived refused
//                      (the net-new generic-CSV hole closure).
//   - SYSTEM           create() + actor_kind:'system'. Authority =
//                      requisition:create:establish (held programmatically by
//                      system/bootstrap identities + test helpers). Allowed
//                      { draft, open }.
//   - pending_approval NEVER; archived NEVER (in any mode).

export type CreationMode = 'MANUAL' | 'INTEGRATION' | 'SYSTEM';

// The functional create qualifier that unlocks the governed establishment
// mode (MANUAL-ESTABLISH + SYSTEM). CATALOG-ONLY in v1 — granted to no human
// tenant role; held programmatically by system/bootstrap + passed by test
// helpers. INTEGRATION does NOT use this scope (it reuses import:write).
export const REQUISITION_CREATE_ESTABLISH = 'requisition:create:establish' as const;

// The EXISTING scope that authorizes the import (INTEGRATION) establishment
// path. Reused verbatim — L1-A adds no scope for imports (Directive v1.1
// D-A1-GRANT (a)).
const REQUISITION_IMPORT_WRITE = 'requisition:import:write' as const;

// The BASE allowed initial states per creation mode, once the mode's
// authority is satisfied. Co-located beside GATED_RECRUITING_STATUS_VALUES
// (dto/requisition-status.ts) as the app-boundary establishment data. MANUAL
// is the ordinary-manual base; the establish scope extends it to
// MANUAL-ESTABLISH ({ draft, open }) in the gate below.
export const ESTABLISHMENT_MATRIX: Readonly<
  Record<CreationMode, readonly RecruitingStatus[]>
> = {
  MANUAL: ['draft'],
  INTEGRATION: ['lead', 'open', 'on_hold', 'submittals_closed', 'closed', 'canceled'],
  SYSTEM: ['draft', 'open'],
};

// The mode-derived default when the caller supplies no explicit status
// (Directive §3 — replacing the removed `input.status ?? 'open'`). SYSTEM is
// "explicit only" in the matrix; it falls back to the safe non-established
// floor (draft) rather than silently establishing open.
const CREATION_MODE_DEFAULT_STATUS: Readonly<Record<CreationMode, RecruitingStatus>> = {
  MANUAL: 'draft',
  INTEGRATION: 'open',
  SYSTEM: 'draft',
};

export type EstablishmentRefusalReason =
  | 'establishment_authority_required'
  | 'initial_state_not_allowed_for_mode';

function refuse(
  reason: EstablishmentRefusalReason,
  mode: CreationMode,
  status: RecruitingStatus,
  requestId: string,
): AramoError {
  return new AramoError(
    'REQUISITION_INITIAL_STATE_FORBIDDEN',
    reason === 'establishment_authority_required'
      ? `Establishing a requisition in '${status}' via ${mode} requires establishment authority`
      : `Initial state '${status}' is not allowed for the ${mode} creation mode`,
    403,
    { requestId, details: { reason, mode, status } },
  );
}

// Derive the create()-path creation mode from the actor kind. The
// createForImport() path is INTEGRATION intrinsically (Directive v1.1 item 3:
// INTEGRATION is the import code path, never derived from consumer_type — a
// human-triggered import still carries human context).
export function resolveCreateModeFromActorKind(
  actorKind: 'system' | 'service_account' | 'user',
): CreationMode {
  return actorKind === 'system' ? 'SYSTEM' : 'MANUAL';
}

// The PURE authority gate. Validates (mode × requested_status × scopes),
// resolves the mode default when no status is supplied, and RETURNS the
// resolved initial status the caller must persist. Throws
// REQUISITION_INITIAL_STATE_FORBIDDEN (403) on refusal.
export function assertEstablishmentAuthorization(args: {
  mode: CreationMode;
  /** The caller-supplied status, or undefined for the mode default. */
  requestedStatus?: RecruitingStatus;
  scopes: readonly string[];
  requestId: string;
}): RecruitingStatus {
  const { mode, scopes, requestId } = args;
  const status = args.requestedStatus ?? CREATION_MODE_DEFAULT_STATUS[mode];

  let allowed: readonly RecruitingStatus[];

  if (mode === 'MANUAL') {
    const hasEstablish = scopes.includes(REQUISITION_CREATE_ESTABLISH);
    // A non-draft MANUAL establishment REQUIRES create:establish. Ordinary
    // manual (no establish) may only enter `draft` (Directive R-DEFAULT).
    if (status !== 'draft' && !hasEstablish) {
      throw refuse('establishment_authority_required', mode, status, requestId);
    }
    allowed = hasEstablish ? ESTABLISHMENT_MATRIX.SYSTEM : ESTABLISHMENT_MATRIX.MANUAL;
  } else if (mode === 'SYSTEM') {
    if (!scopes.includes(REQUISITION_CREATE_ESTABLISH)) {
      throw refuse('establishment_authority_required', mode, status, requestId);
    }
    allowed = ESTABLISHMENT_MATRIX.SYSTEM;
  } else {
    // INTEGRATION — authority is the EXISTING requisition:import:write,
    // re-asserted at the floor (Directive proof 6a: route + floor).
    if (!scopes.includes(REQUISITION_IMPORT_WRITE)) {
      throw refuse('establishment_authority_required', mode, status, requestId);
    }
    allowed = ESTABLISHMENT_MATRIX.INTEGRATION;
  }

  // The requested/defaulted status must be permitted for the mode. This is
  // the wall that refuses pending_approval/archived in EVERY mode and draft
  // in INTEGRATION (the generic-CSV hole closure).
  if (!(allowed as readonly string[]).includes(status)) {
    throw refuse('initial_state_not_allowed_for_mode', mode, status, requestId);
  }

  return status;
}
