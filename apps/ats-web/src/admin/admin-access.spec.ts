import { type Session } from '@aramo/fe-foundation';
import { describe, expect, it } from 'vitest';

import { hasAdminScope } from './admin-access';

function makeSession(scopes: readonly string[]): Session {
  return {
    sub: 'user-1',
    consumer_type: 'recruiter',
    tenant_id: 'tenant-abc',
    scopes: [...scopes],
    iat: 0,
    exp: 0,
  };
}

describe('hasAdminScope', () => {
  it('is true when the session carries any tenant:admin:* scope', () => {
    expect(hasAdminScope(makeSession(['talent:read', 'tenant:admin:settings']))).toBe(true);
    expect(hasAdminScope(makeSession(['tenant:admin:user-manage']))).toBe(true);
  });

  it('is false for a recruiter-only principal (no tenant:admin:* scope)', () => {
    expect(
      hasAdminScope(
        makeSession(['requisition:read', 'talent:read', 'company:read', 'task:read']),
      ),
    ).toBe(false);
  });

  it('does not match adjacent scope families (e.g. org:manage, team:manage)', () => {
    // The Phase-1 section gate is the tenant:admin:* family specifically; the
    // per-module routes that arrive in Phase 2+ carry their own scopes.
    expect(hasAdminScope(makeSession(['org:manage', 'team:manage']))).toBe(false);
  });

  it('is false for an empty scope set', () => {
    expect(hasAdminScope(makeSession([]))).toBe(false);
  });
});
