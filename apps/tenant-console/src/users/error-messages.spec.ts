import { describe, expect, it } from 'vitest';
import { ApiError } from '@aramo/fe-foundation';

import {
  messageForDisableError,
  messageForInviteError,
  messageForRoleAssignError,
} from './error-messages';

// Settings S5b — operator-message tests. The load-bearing assertions:
//
//   (1) The D5 invertible_role_union message uses the BUNDLE-NAMING
//       template keyed on details.role_keys (ruling 3).
//   (2) The `cause` string from the backend is NEVER rendered — even
//       when present in the details. Internal scope-key math is
//       forbidden in user copy (the §6/R10 line).
//   (3) The S4 financials_audit_not_enabled message points the admin
//       at the Settings toggle (mirrors the FinancialsToggle vocab).
//
// These are the proofs the directive marked "load-bearing" — the
// security invariant becoming legible.

function d5Error(role_keys: string[]) {
  return new ApiError(
    400,
    'role bundle union violates D5 non-invertibility',
    'VALIDATION_ERROR',
    {
      reason: 'invertible_role_union',
      role_keys,
      // The cause string names internal scope keys — it must NEVER
      // surface to the user.
      cause:
        'role composite:finance+recruiter scope union [compensation:view:pay, compensation:view:spread] is invertible',
    },
  );
}

describe('messageForRoleAssignError — THE D5 REJECTION UX (ruling 3)', () => {
  it('renders the bundle-naming template with role LABELS, not raw keys', () => {
    const msg = messageForRoleAssignError(
      d5Error(['finance', 'recruiter']),
    );
    expect(msg.title).toBe('These roles can’t be combined.');
    // The detail names the catalog labels — "Finance + Recruiter", not
    // the raw keys.
    expect(msg.detail).toContain('Finance + Recruiter');
    expect(msg.detail).toContain('would expose pay rates');
  });

  it('the cause string is NEVER rendered (R10 — no scope-key math in user copy)', () => {
    const msg = messageForRoleAssignError(
      d5Error(['finance', 'recruiter']),
    );
    const combined = `${msg.title}\n${msg.detail ?? ''}`;
    // Scope-key colons MUST NOT appear in the operator copy.
    expect(combined).not.toMatch(/compensation:view:/);
    expect(combined).not.toMatch(/scope union/);
    expect(combined).not.toMatch(/invertible/i);
    expect(combined).not.toMatch(/composite:/);
  });

  it('falls back gracefully when role_keys is missing from details', () => {
    const err = new ApiError(400, 'bad', 'VALIDATION_ERROR', {
      reason: 'invertible_role_union',
    });
    const msg = messageForRoleAssignError(err);
    expect(msg.title).toBe('These roles can’t be combined.');
    // Still no leak.
    expect(msg.detail ?? '').not.toMatch(/:/);
  });

  it('maps the S4 financials_audit_not_enabled rejection to a Settings-pointing message', () => {
    const err = new ApiError(400, 'gate', 'VALIDATION_ERROR', {
      reason: 'financials_audit_not_enabled',
      role_key: 'auditor_with_financials',
    });
    const msg = messageForRoleAssignError(err);
    expect(msg.title).toMatch(/financial-auditor grant is disabled/i);
    expect(msg.detail).toMatch(/Settings/);
    expect(msg.detail).toMatch(/Auditor with Financials/);
  });

  it('maps empty_role_keys to a select-at-least-one prompt', () => {
    const err = new ApiError(400, 'empty', 'VALIDATION_ERROR', {
      reason: 'empty_role_keys',
    });
    expect(messageForRoleAssignError(err).title).toMatch(/select at least one/i);
  });

  it('maps a 404 to a per-tenant isolation message', () => {
    const err = new ApiError(404, 'nope', 'NOT_FOUND', {});
    expect(messageForRoleAssignError(err).title).toMatch(
      /not part of your tenant/i,
    );
  });
});

describe('messageForInviteError', () => {
  it('maps invalid_email', () => {
    const err = new ApiError(400, 'x', 'VALIDATION_ERROR', {
      reason: 'invalid_email',
    });
    expect(messageForInviteError(err).title).toMatch(/valid email/i);
  });

  it('delegates an invertible-union invite-time rejection to the D5 template', () => {
    const err = d5Error(['finance', 'recruiter']);
    const msg = messageForInviteError(err);
    expect(msg.title).toBe('These roles can’t be combined.');
    expect(msg.detail).toContain('Finance + Recruiter');
  });

  it('maps COGNITO_PROVISION_FAILED to a rolled-back message', () => {
    const err = new ApiError(502, 'x', 'COGNITO_PROVISION_FAILED', {});
    const msg = messageForInviteError(err);
    expect(msg.title).toMatch(/could not provision/i);
    expect(msg.detail).toMatch(/rolled back/i);
  });
});

describe('messageForDisableError', () => {
  it('maps a 404 to a per-tenant isolation message', () => {
    const err = new ApiError(404, 'nope', 'NOT_FOUND', {});
    expect(messageForDisableError(err).title).toMatch(
      /not part of your tenant/i,
    );
  });

  it('maps COGNITO_PROVISION_FAILED to a re-enabled message', () => {
    const err = new ApiError(502, 'x', 'COGNITO_PROVISION_FAILED', {});
    const msg = messageForDisableError(err);
    expect(msg.title).toMatch(/could not disable/i);
    expect(msg.detail).toMatch(/re-enabled/i);
  });
});
