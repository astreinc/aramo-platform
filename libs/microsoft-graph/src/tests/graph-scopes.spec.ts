import { describe, expect, it } from 'vitest';

import {
  FORBIDDEN_SCOPE_PATTERNS,
  MICROSOFT_DELEGATED_SCOPES,
  MICROSOFT_SCHEDULING_SCOPES,
  MicrosoftScopeViolationError,
  assertLeastPrivilegeScopes,
  microsoftSchedulingScopeParam,
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

// COMM-C2B Amendment A1 (R4/R8) — the Outlook calendar scheduling capability is a
// SEPARATELY authorized scope set that adds EXACTLY Calendars.ReadWrite on top of
// the baseline. The baseline posture is unchanged: Calendars.* stays fail-closed
// forbidden for every recruiter who has not enabled scheduling. The scheduling set
// narrowly admits only the Calendars.ReadWrite literal — never Calendars.Read, a
// shared-calendar variant, or any broader scope.
describe('COMM-C2B Amendment A1 Outlook scheduling scope set (R4/R8)', () => {
  it('authorizes EXACTLY the baseline set plus Calendars.ReadWrite, in request order', () => {
    expect([...MICROSOFT_SCHEDULING_SCOPES]).toEqual([
      ...MICROSOFT_DELEGATED_SCOPES,
      'Calendars.ReadWrite',
    ]);
  });

  it('passes the scheduling set through the guard under the scheduling capability', () => {
    expect(() =>
      assertLeastPrivilegeScopes([...MICROSOFT_SCHEDULING_SCOPES], 'scheduling'),
    ).not.toThrow();
  });

  it('admits Calendars.ReadWrite ONLY under the scheduling capability — baseline still fails closed', () => {
    expect(() => assertLeastPrivilegeScopes(['Calendars.ReadWrite'], 'scheduling')).not.toThrow();
    expect(() => assertLeastPrivilegeScopes(['Calendars.ReadWrite'], 'baseline')).toThrow(
      MicrosoftScopeViolationError,
    );
    // default capability is baseline — the pre-amendment call site stays fail-closed
    expect(() => assertLeastPrivilegeScopes(['Calendars.ReadWrite'])).toThrow(
      MicrosoftScopeViolationError,
    );
  });

  it.each(['Calendars.Read', 'Calendars.ReadWrite.Shared', 'Calendars.ReadBasic'])(
    'scheduling capability still fails closed on the broader calendar scope %s',
    (scope) => {
      expect(() => assertLeastPrivilegeScopes([scope], 'scheduling')).toThrow(
        MicrosoftScopeViolationError,
      );
    },
  );

  it.each(['Mail.Read', 'Directory.Read.All', 'Sites.ReadWrite.All'])(
    'scheduling capability does NOT widen any non-calendar authority (%s still forbidden)',
    (scope) => {
      expect(() => assertLeastPrivilegeScopes([scope], 'scheduling')).toThrow(
        MicrosoftScopeViolationError,
      );
    },
  );

  it('microsoftSchedulingScopeParam appends Calendars.ReadWrite to the baseline param', () => {
    expect(microsoftSchedulingScopeParam()).toBe(
      'openid profile offline_access User.Read Mail.Send OnlineMeetings.ReadWrite Calendars.ReadWrite',
    );
  });
});
