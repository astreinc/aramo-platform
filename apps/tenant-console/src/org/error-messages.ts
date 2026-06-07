// Settings S5c-1 — operator-legible mapping from D4a edge rejections.
//
// PL-94 §2 ruling 4 — DUPLICATE = SILENT SUCCESS. The BE is idempotent
// on duplicate (manager, report) pairs (libs/identity/.../management-
// edge.service.ts: findByPair returns existing row, no audit event).
// The FE NEVER surfaces a duplicate as an error.
//
// PL-94 §2 ruling 4 — real rejections: self_loop + cycle only. The BE
// shape is MANAGEMENT_CYCLE_REJECTED (HTTP 409) with
// `details.reason='self_loop' | 'cycle'`. The R10 line: render
// operator-legible copy; no internal leak.

import { ApiError } from '../api/client';

export interface ErrorMessage {
  readonly title: string;
  readonly detail?: string;
}

export function messageForAddEdgeError(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }

  const details = err.details ?? {};
  const reason =
    typeof details['reason'] === 'string'
      ? (details['reason'] as string)
      : null;

  if (reason === 'self_loop') {
    return {
      title: 'A user can’t manage themselves.',
      detail:
        'Pick two different people for the manager and report.',
    };
  }

  if (reason === 'cycle') {
    return {
      title: 'This would create a reporting cycle.',
      detail:
        'The proposed report is already a manager up this reporting chain. Choose a different report.',
    };
  }

  // 400 from the controller's body validation (missing fields, etc.).
  if (err.status === 400) {
    return { title: err.message };
  }

  // 404 — one of the user IDs does not exist in the tenant (the
  // 403-fallback raw-UUID path can hit this if a bad UUID is typed).
  if (err.status === 404) {
    return {
      title: 'One of those users doesn’t exist in your tenant.',
    };
  }

  return { title: err.message };
}

export function messageForRemoveEdgeError(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  // A 404 on DELETE is idempotent — the edge is already gone. The
  // caller treats this as success; this mapper is for the rare other
  // error.
  return { title: err.message };
}
