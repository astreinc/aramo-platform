import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_SCOPE_PATTERNS,
  MICROSOFT_DELEGATED_SCOPES,
  MicrosoftScopeViolationError,
  assertLeastPrivilegeScopes,
  microsoftScopeParam,
} from '../lib/domain/graph-scopes.js';

// COMM-C2B R8 — the least-privilege delegated scope set is the load-bearing
// Microsoft-permission security boundary. These proofs pin the EXACT authorized
// set and prove the guard fails closed on every broader scope the directive
// forbids (mailbox read, impersonation, calendar-wide, directory-wide,
// application/tenant-wide).

describe('COMM-C2B Microsoft Graph least-privilege scopes (R8)', () => {
  it('authorizes EXACTLY the six least-privilege delegated scopes, in request order', () => {
    expect([...MICROSOFT_DELEGATED_SCOPES]).toEqual([
      'openid',
      'profile',
      'offline_access',
      'User.Read',
      'Mail.Send',
      'OnlineMeetings.ReadWrite',
    ]);
  });

  it('the authorized set contains NO forbidden scope', () => {
    for (const scope of MICROSOFT_DELEGATED_SCOPES) {
      for (const pattern of FORBIDDEN_SCOPE_PATTERNS) {
        expect(pattern.test(scope), `${scope} matched ${String(pattern)}`).toBe(false);
      }
    }
  });

  it('passes the authorized set through the fail-closed guard', () => {
    expect(() => assertLeastPrivilegeScopes([...MICROSOFT_DELEGATED_SCOPES])).not.toThrow();
  });

  it.each([
    'Mail.Read',
    'Mail.ReadWrite',
    'Mail.Send.Shared',
    'Calendars.ReadWrite',
    'Directory.Read.All',
    'User.Read.All',
    'Sites.ReadWrite.All',
    'Files.ReadWrite.All',
  ])('fails closed on the broader scope %s (R8 HALT boundary)', (scope) => {
    expect(() => assertLeastPrivilegeScopes([scope])).toThrow(MicrosoftScopeViolationError);
  });

  it('rejects the authorized set plus one smuggled broader scope', () => {
    expect(() =>
      assertLeastPrivilegeScopes([...MICROSOFT_DELEGATED_SCOPES, 'Mail.Read']),
    ).toThrow(MicrosoftScopeViolationError);
  });

  it('microsoftScopeParam is the space-delimited authorized set', () => {
    expect(microsoftScopeParam()).toBe(
      'openid profile offline_access User.Read Mail.Send OnlineMeetings.ReadWrite',
    );
  });
});
