import { describe, expect, it } from 'vitest';

import { hasScope } from './scopes';
import type { Session } from './session';

function makeSession(scopes: string[]): Session {
  return {
    sub: '00000000-0000-0000-0000-000000000001',
    consumer_type: 'recruiter',
    tenant_id: '00000000-0000-0000-0000-000000000002',
    scopes,
    iat: 0,
    exp: 0,
  };
}

describe('hasScope', () => {
  it('returns true when the scope is granted', () => {
    expect(
      hasScope(makeSession(['tenant:admin:settings']), 'tenant:admin:settings'),
    ).toBe(true);
  });

  it('returns false when the scope is not granted', () => {
    expect(
      hasScope(makeSession(['session:read']), 'tenant:admin:settings'),
    ).toBe(false);
  });

  it('returns false on an empty scope list', () => {
    expect(hasScope(makeSession([]), 'tenant:admin:settings')).toBe(false);
  });
});
