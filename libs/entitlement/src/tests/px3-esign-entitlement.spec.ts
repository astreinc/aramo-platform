import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthContext } from '@aramo/auth';

import type { Capability } from '../lib/capability.js';
import { EntitlementGuard } from '../lib/entitlement.guard.js';
import { REQUIRED_CAPABILITIES_KEY } from '../lib/entitlement.metadata.js';
import type { EntitlementRepository } from '../lib/entitlement.repository.js';

// PX-V1 PX-3 — the `esign` capability is now LOAD-BEARING for the authenticated
// E-Sign sender surface. At baseline 130bfb65 `esign` was in CAPABILITY_VALUES but
// enforced NOWHERE (0 @RequireCapability('esign') usages). These prove the
// EntitlementGuard denies fail-closed without the capability and permits with it,
// and that {ATS=NO, E-Sign=YES} is expressible at tenant grain.

function makeContext(authContext: AuthContext, requestId = 'req-px3'): ExecutionContext {
  const request = { authContext, requestId };
  return {
    getHandler: () => () => undefined,
    getClass: () => class TestClass {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => ({}) }),
  } as unknown as ExecutionContext;
}

function makeReflector(required?: Capability[]): Reflector {
  const r = new Reflector();
  vi.spyOn(r, 'getAllAndOverride').mockImplementation((key: string) =>
    key === REQUIRED_CAPABILITIES_KEY ? required : undefined,
  );
  return r;
}

function makeRepository(entitled: Capability[]): EntitlementRepository {
  return { getCapabilities: async () => new Set(entitled) } as unknown as EntitlementRepository;
}

const senderAuth: AuthContext = {
  sub: '01900000-0000-7000-8000-0000000000c1',
  consumer_type: 'esign',
  actor_kind: 'user',
  tenant_id: '01900000-0000-7000-8000-0000000000c0',
  scopes: ['esign:envelope:create'],
  iat: 0,
  exp: 0,
};

describe('PX-V1 PX-3 — esign capability is load-bearing for the sender surface', () => {
  it('DENIES fail-closed when the tenant is NOT entitled to esign', async () => {
    const guard = new EntitlementGuard(makeReflector(['esign']), makeRepository(['core', 'ats', 'portal']));
    await expect(guard.canActivate(makeContext(senderAuth))).rejects.toMatchObject({
      code: 'TENANT_CAPABILITY_NOT_ENTITLED',
      statusCode: 403,
    });
  });

  it('PERMITS when the tenant is entitled to esign', async () => {
    const guard = new EntitlementGuard(makeReflector(['esign']), makeRepository(['esign']));
    await expect(guard.canActivate(makeContext(senderAuth))).resolves.toBe(true);
  });

  it('an [esign]-only tenant (ATS=NO, E-Sign=YES) passes the esign gate but fails an ats gate', async () => {
    const esignOnly: Capability[] = ['core', 'esign']; // deliberately NO ats
    await expect(
      new EntitlementGuard(makeReflector(['esign']), makeRepository(esignOnly)).canActivate(makeContext(senderAuth)),
    ).resolves.toBe(true);
    await expect(
      new EntitlementGuard(makeReflector(['ats']), makeRepository(esignOnly)).canActivate(makeContext(senderAuth)),
    ).rejects.toMatchObject({ code: 'TENANT_CAPABILITY_NOT_ENTITLED' });
  });
});
