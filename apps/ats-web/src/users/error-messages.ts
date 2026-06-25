// Settings S5b — operator-legible mapping from backend rejection details
// to user copy. The S5a ApiError {code, details} surface makes this
// possible (a generic 400 used to be all we had).
//
// Ruling 3 (Gate-5) — THE D5 REJECTION UX:
//   The backend details for an invertible role-union are:
//     { reason: 'invertible_role_union', role_keys: [<full distinct set>], cause: '<scope-key string>' }
//
//   We render the bundle-naming template keyed on role_keys (with the
//   role-catalog labels), e.g.:
//     "Roles Recruiter + Finance form a combination that would expose
//      pay rates. Choose roles that don't overlap on compensation
//      visibility."
//
//   We NEVER render `cause` raw — it names internal scope keys
//   (compensation:view:pay, etc.) and would leak the masking math.
//   The §6/R10 line is hard: scope-key math is forbidden in user copy.
//
// Ruling 4 — THE S4 GATE rejection (financials_audit_not_enabled): a
// separate operator message that points the admin at the Settings
// toggle, mirroring the FinancialsToggle vocabulary.

import { ApiError } from '@aramo/fe-foundation';

// Settings Rebuild D5 — role labels come from the catalog (passed in by the
// caller, which holds the fetched roles), not a hand-mirror. `labelOf` falls
// back to the raw key when the catalog is not loaded / lacks the role.
export type RoleLabelResolver = (key: string) => string;
const identityLabel: RoleLabelResolver = (k) => k;

function labelsForRoleKeys(
  role_keys: readonly string[],
  labelOf: RoleLabelResolver,
): string {
  return role_keys.map((k) => labelOf(k)).join(' + ');
}

export interface ErrorMessage {
  readonly title: string;
  readonly detail?: string;
}

export function messageForRoleAssignError(
  err: unknown,
  labelOf: RoleLabelResolver = identityLabel,
): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }

  const details = err.details ?? {};
  const reason =
    typeof details['reason'] === 'string'
      ? (details['reason'] as string)
      : null;

  // D5 — the load-bearing bundle-naming template.
  if (reason === 'invertible_role_union') {
    const role_keys = Array.isArray(details['role_keys'])
      ? (details['role_keys'] as unknown[]).filter(
          (k): k is string => typeof k === 'string',
        )
      : [];
    const labels = labelsForRoleKeys(role_keys, labelOf);
    return {
      title: 'These roles can’t be combined.',
      detail:
        labels.length > 0
          ? `Roles ${labels} form a combination that would expose pay rates. Choose roles that don’t overlap on compensation visibility.`
          : 'The selected roles form a combination that would expose pay rates. Choose roles that don’t overlap on compensation visibility.',
    };
    // NOTE: details.cause is intentionally NEVER read or rendered.
  }

  // S4 — the financials gate (the role-set includes auditor_with_financials
  // but the tenant's audit.financials_enabled is off).
  if (reason === 'financials_audit_not_enabled') {
    return {
      title: 'Financial-auditor grant is disabled.',
      detail:
        'Enable "Financial-auditor grant" in Settings before assigning the Auditor with Financials role.',
    };
  }

  if (reason === 'empty_role_keys') {
    return { title: 'Select at least one role.' };
  }

  if (reason === 'invalid_role_key_item') {
    return { title: 'One of the selected roles is invalid.' };
  }

  // 404 (per-tenant isolation) and other surfaces — keep generic.
  if (err.status === 404) {
    return { title: 'This user is not part of your tenant.' };
  }

  return { title: err.message };
}

export function messageForInviteError(
  err: unknown,
  labelOf: RoleLabelResolver = identityLabel,
): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  const details = err.details ?? {};
  const reason =
    typeof details['reason'] === 'string'
      ? (details['reason'] as string)
      : null;

  if (reason === 'invalid_email') {
    return { title: 'Please enter a valid email address.' };
  }
  if (reason === 'missing_body') {
    return { title: 'Please complete the form.' };
  }
  if (reason === 'empty_role_keys') {
    return { title: 'Select at least one role to assign on invite.' };
  }
  if (reason === 'invalid_role_key_item') {
    return { title: 'One of the selected roles is invalid.' };
  }
  // The D5 + S4 rejections share their templates with the assign path —
  // an invite can hit them too (the validator + gate run at invite).
  if (
    reason === 'invertible_role_union' ||
    reason === 'financials_audit_not_enabled'
  ) {
    return messageForRoleAssignError(err, labelOf);
  }
  if (err.code === 'COGNITO_PROVISION_FAILED') {
    return {
      title: 'Could not provision the user with the identity provider.',
      detail:
        'The invite was rolled back. Please try again; contact support if this persists.',
    };
  }
  return { title: err.message };
}

export function messageForDisableError(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  if (err.status === 404) {
    return { title: 'This user is not part of your tenant.' };
  }
  if (err.code === 'COGNITO_PROVISION_FAILED') {
    return {
      title: 'Could not disable the user with the identity provider.',
      detail:
        'The membership was re-enabled and is unchanged. Please try again; contact support if this persists.',
    };
  }
  return { title: err.message };
}

// Invite-S3 — the shared mapper for the state-dependent lifecycle actions
// (enable / revoke / resend / edit-email). The backend surfaces a per-reason
// taxonomy on VALIDATION_ERROR.details.reason; we render an operator message.
export function messageForLifecycleActionError(err: unknown): ErrorMessage {
  if (!(err instanceof ApiError)) {
    return { title: 'Unexpected error. Please try again.' };
  }
  const details = err.details ?? {};
  const reason =
    typeof details['reason'] === 'string'
      ? (details['reason'] as string)
      : null;

  if (reason === 'no_pending_invite') {
    return {
      title: 'There’s no pending invitation for this user.',
      detail: 'The list may be out of date — refresh and try again.',
    };
  }
  if (reason === 'email_locked') {
    return {
      title: 'This user’s email can’t be changed.',
      detail:
        'The email is only editable while an invitation has failed to deliver.',
    };
  }
  if (reason === 'email_in_use') {
    return { title: 'That email is already in use by another user.' };
  }
  if (reason === 'invalid_email') {
    return { title: 'Please enter a valid email address.' };
  }
  if (err.status === 404) {
    return { title: 'This user is not part of your tenant.' };
  }
  return { title: err.message };
}
