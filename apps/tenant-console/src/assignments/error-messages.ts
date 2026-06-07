// Settings S5c-3 — operator-legible error mapping for the three
// assignment editors. The mapper is uniform (PL-94 §2 ruling 1) — each
// editor names its parent ("company" / "team" / "requisition") in the
// 404 copy; the rest of the contract is shared.
//
// PL-94 §2 ruling 1 idempotency: a DUPLICATE POST is SILENT SUCCESS
// (BE returns existing row, never reaches this mapper); a DELETE 404
// is handled as SUCCESS at the consumer (the mapper is for non-404
// errors only).

import { ApiError } from '../api/client';

export interface ErrorMessage {
  readonly title: string;
  readonly detail?: string;
}

type ParentKind = 'company' | 'team' | 'requisition';

function notFoundCopy(parent: ParentKind): ErrorMessage {
  switch (parent) {
    case 'company':
      return { title: 'This company isn’t in your tenant.' };
    case 'team':
      return { title: 'This team isn’t in your tenant.' };
    case 'requisition':
      return { title: 'This requisition isn’t in your tenant.' };
  }
}

function genericMessage(err: ApiError): ErrorMessage {
  return { title: err.message };
}

// ─── D — Company-assignments ─────────────────────────────────────────

export function messageForAssignUser(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  if (err.status === 404) return notFoundCopy('company');
  return genericMessage(err);
}

export function messageForUnassignUser(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  // 404 here is handled at the caller as idempotent success — this
  // mapper is for the rare other error.
  return genericMessage(err);
}

export function messageForFetchCompanyAssignments(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  if (err.status === 404) return notFoundCopy('company');
  return genericMessage(err);
}

// ─── E — Team-clients ────────────────────────────────────────────────

export function messageForAddTeamClient(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  // Company-not-found (cross-tenant or unknown company_id) bubbles up
  // from the cross-schema parent check in addClientOwnership.
  if (err.status === 404) {
    return { title: 'That company isn’t in your tenant.' };
  }
  return genericMessage(err);
}

export function messageForRemoveTeamClient(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  return genericMessage(err);
}

export function messageForFetchTeamClients(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  // Note: a cross-tenant teamId returns an empty list at the BE (no
  // 404) per the §7.3 cross-schema rule. A 404 here would be unusual;
  // surface it generically.
  return genericMessage(err);
}

// ─── F — Requisition-assign ──────────────────────────────────────────

export function messageForAssignRequisition(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  if (err.status === 404) return notFoundCopy('requisition');
  return genericMessage(err);
}

export function messageForUnassignRequisition(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  return genericMessage(err);
}

export function messageForFetchRequisitionAssignments(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  if (err.status === 404) return notFoundCopy('requisition');
  return genericMessage(err);
}
