// Settings S5c-2 — operator-legible mapping for the teams + members
// surface.
//
// PL-94 §2 ruling 6 — DUPLICATE-NAME on create-team is REJECTED (not
// idempotent — names collide; the BE supplies `details: {name,
// existing_team_id}`). DUPLICATE member-add is SILENT SUCCESS (BE is
// idempotent — never reaches this mapper).
//
// 404 templates mirror the S5b / S5c-1 per-tenant isolation message.

import { ApiError } from '../api/client';

export interface ErrorMessage {
  readonly title: string;
  readonly detail?: string;
}

function detailsName(details: Record<string, unknown> | undefined): string | null {
  if (details === undefined) return null;
  return typeof details['name'] === 'string' ? (details['name'] as string) : null;
}

export function messageForCreateTeamError(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }

  // PL-94 §2 ruling 6 — duplicate-name. The BE returns 400
  // VALIDATION_ERROR with details = {name, existing_team_id}. The FE
  // renders the offending name explicitly.
  const dupName = detailsName(err.details);
  if (err.status === 400 && dupName !== null) {
    return {
      title: `A team named "${dupName}" already exists.`,
      detail: 'Pick a different name.',
    };
  }

  if (err.status === 400) {
    return { title: err.message };
  }

  return { title: err.message };
}

export function messageForAddMemberError(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  // 404 — the team is not in this tenant (per-tenant isolation).
  if (err.status === 404) {
    return { title: 'This team isn’t in your tenant.' };
  }
  return { title: err.message };
}

export function messageForRemoveMemberError(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  // 404 here is idempotent-success at the caller — this mapper is for
  // the rare other error.
  return { title: err.message };
}

export function messageForFetchTeamMembersError(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  if (err.status === 404) {
    return { title: 'This team isn’t in your tenant.' };
  }
  return { title: err.message };
}
