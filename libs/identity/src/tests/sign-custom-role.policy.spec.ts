import { describe, expect, it } from 'vitest';

import { ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE } from '../lib/dto/esign-permissions.js';
import {
  SIGN_CUSTOM_ROLE_COMPOSABLE_SCOPES,
  checkCustomRoleScopes,
  composableScopesOf,
  isComposableSignScope,
  normalizeCustomRoleText,
  scopesActorLacks,
} from '../lib/sign-custom-role/sign-custom-role.policy.js';

// Aramo Sign Feature-Parity §1.21 — the pure custom-role policy (composable set,
// anti-escalation guard, read-time filter, name/description rules).

const S = ESIGN_SCOPE;

describe('Sign custom role policy', () => {
  it('composable set = every sign:* scope except sign:billing:manage; never another namespace', () => {
    const all = Object.values(ESIGN_SCOPE);
    expect([...SIGN_CUSTOM_ROLE_COMPOSABLE_SCOPES].sort()).toEqual(all.filter((k) => k !== S.BILLING_MANAGE).sort());
    expect(SIGN_CUSTOM_ROLE_COMPOSABLE_SCOPES.every((k) => k.startsWith('sign:'))).toBe(true);
    expect(isComposableSignScope(S.BILLING_MANAGE)).toBe(false);
    for (const k of ['platform:tenant:read', 'talent:read', 'tenant:user:manage', 'document_template:read', 'sign:*', 'sign:envelope', 'SIGN:ENVELOPE:READ', '']) {
      expect(isComposableSignScope(k), k).toBe(false);
    }
    // Every built-in Sign role's scopes are composable (a custom role can reproduce them).
    for (const scopes of Object.values(ESIGN_ROLE_PERMISSIONS)) expect(scopes.every(isComposableSignScope)).toBe(true);
  });

  it('the guard normalizes a valid request (dedupe, sort)', () => {
    expect(checkCustomRoleScopes([S.ENVELOPE_SEND, S.ENVELOPE_READ, S.ENVELOPE_SEND], ESIGN_ROLE_PERMISSIONS.sign_sender)).toEqual({ ok: true, scopes: [S.ENVELOPE_READ, S.ENVELOPE_SEND] });
  });

  it('the guard refuses empty, non-string, non-composable and over-privileged requests', () => {
    const admin = ESIGN_ROLE_PERMISSIONS.sign_admin;
    expect(checkCustomRoleScopes([], admin)).toEqual({ ok: false, reason: 'scope_keys_required' });
    expect(checkCustomRoleScopes([42], admin)).toMatchObject({ ok: false, reason: 'scope_not_composable' });
    expect(checkCustomRoleScopes([S.ENVELOPE_READ, null], admin)).toMatchObject({ ok: false, reason: 'scope_not_composable' });
    // Billing is refused even for a holder of billing (tenant_owner).
    expect(checkCustomRoleScopes([S.BILLING_MANAGE], [...admin, S.BILLING_MANAGE])).toEqual({ ok: false, reason: 'scope_not_composable', scopes: [S.BILLING_MANAGE] });
    expect(checkCustomRoleScopes(['platform:tenant:read', S.ENVELOPE_READ], ['platform:tenant:read', ...admin])).toEqual({ ok: false, reason: 'scope_not_composable', scopes: ['platform:tenant:read'] });
    // Non-composable is reported before over-privilege.
    expect(checkCustomRoleScopes(['talent:read', S.ENVELOPE_MANAGE_ALL], [])).toMatchObject({ reason: 'scope_not_composable' });
    // A sender cannot compose admin scopes.
    expect(checkCustomRoleScopes([S.ENVELOPE_READ, S.MEMBER_MANAGE, S.ENVELOPE_READ_ALL], ESIGN_ROLE_PERMISSIONS.sign_sender)).toEqual({
      ok: false,
      reason: 'scope_exceeds_actor',
      scopes: [S.ENVELOPE_READ_ALL, S.MEMBER_MANAGE].sort(),
    });
    // An actor with no scopes can grant nothing.
    expect(checkCustomRoleScopes([S.ENVELOPE_READ], [])).toMatchObject({ ok: false, reason: 'scope_exceeds_actor' });
  });

  it('scopesActorLacks and the read-time filter', () => {
    expect(scopesActorLacks([S.ENVELOPE_READ, S.REPORT_READ], [S.ENVELOPE_READ])).toEqual([S.REPORT_READ]);
    expect(scopesActorLacks([S.ENVELOPE_READ], [S.ENVELOPE_READ, S.REPORT_READ])).toEqual([]);
    expect(composableScopesOf([S.REPORT_READ, 'platform:tenant:read', S.BILLING_MANAGE, S.ENVELOPE_READ, S.REPORT_READ])).toEqual([S.ENVELOPE_READ, S.REPORT_READ]);
  });

  it('name and description rules', () => {
    expect(normalizeCustomRoleText('  Contract   reviewers ', '  ')).toEqual({ ok: true, name: 'Contract reviewers', description: null });
    expect(normalizeCustomRoleText('A', 'Reads all')).toEqual({ ok: true, name: 'A', description: 'Reads all' });
    for (const bad of ['', '   ', 'x'.repeat(61), 'bell\u0007name', 7, null, undefined]) {
      expect(normalizeCustomRoleText(bad, null), String(bad)).toEqual({ ok: false, reason: 'name_invalid' });
    }
    expect(normalizeCustomRoleText('ok', 'd'.repeat(501))).toEqual({ ok: false, reason: 'description_invalid' });
    expect(normalizeCustomRoleText('ok', 5)).toEqual({ ok: false, reason: 'description_invalid' });
  });
});
