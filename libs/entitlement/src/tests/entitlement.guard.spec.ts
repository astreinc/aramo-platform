import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthContext } from '@aramo/auth';

import type { Capability } from '../lib/capability.js';
import { EntitlementGuard } from '../lib/entitlement.guard.js';
import { REQUIRED_CAPABILITIES_KEY } from '../lib/entitlement.metadata.js';
import type { EntitlementRepository } from '../lib/entitlement.repository.js';

// PR-A1b §4 — EntitlementGuard unit tests.
//
// Distinct-axis assertion (Ruling 1): the guard rejects on tenant-level
// entitlement and is independent of @RequireScopes / RolesGuard. These
// unit tests cover the guard in isolation; the end-to-end "scoped user
// in unentitled tenant is still rejected" proof lives in apps/api
// portal-refusal.negative-shape.spec.ts (alongside the rest of the
// portal route enforcement integration).

function makeContext(args: {
  authContext?: Partial<AuthContext>;
  requestId?: string;
}): ExecutionContext {
  const request = {
    authContext: args.authContext as AuthContext | undefined,
    requestId: args.requestId ?? 'req-test',
  };
  return {
    getHandler: () => () => undefined,
    getClass: () => class TestClass {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

function makeReflector(required?: Capability[]): Reflector {
  const r = new Reflector();
  vi.spyOn(r, 'getAllAndOverride').mockImplementation((key: string) => {
    if (key === REQUIRED_CAPABILITIES_KEY) return required;
    return undefined;
  });
  return r;
}

function makeRepository(entitled: Capability[]): EntitlementRepository {
  return {
    getCapabilities: async () => new Set(entitled),
  } as unknown as EntitlementRepository;
}

const baseAuth: AuthContext = {
  sub: '01900000-0000-7000-8000-000000000002',
  consumer_type: 'portal',
  actor_kind: 'user',
  tenant_id: '01900000-0000-7000-8000-000000000001',
  scopes: ['portal:profile:read'],
  iat: 0,
  exp: 0,
};

describe('EntitlementGuard', () => {
  it('passes through when no @RequireCapability metadata is set', async () => {
    const guard = new EntitlementGuard(
      makeReflector(undefined),
      makeRepository([]),
    );
    const ctx = makeContext({ authContext: baseAuth });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('passes through when @RequireCapability metadata is an empty array', async () => {
    const guard = new EntitlementGuard(
      makeReflector([]),
      makeRepository([]),
    );
    const ctx = makeContext({ authContext: baseAuth });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('passes when the tenant is entitled to the required capability', async () => {
    const guard = new EntitlementGuard(
      makeReflector(['portal']),
      makeRepository(['core', 'ats', 'portal']),
    );
    const ctx = makeContext({ authContext: baseAuth });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('passes when multiple required capabilities are all entitled (all-or-nothing)', async () => {
    const guard = new EntitlementGuard(
      makeReflector(['core', 'portal']),
      makeRepository(['core', 'ats', 'portal']),
    );
    const ctx = makeContext({ authContext: baseAuth });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects with TENANT_CAPABILITY_NOT_ENTITLED when the tenant lacks the required capability', async () => {
    const guard = new EntitlementGuard(
      makeReflector(['sourcing']),
      makeRepository(['core', 'ats', 'portal']),
    );
    const ctx = makeContext({
      authContext: baseAuth,
      requestId: 'req-deliberate-fail',
    });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'TENANT_CAPABILITY_NOT_ENTITLED',
      statusCode: 403,
      context: {
        requestId: 'req-deliberate-fail',
        details: {
          tenant_id: baseAuth.tenant_id,
          required_capabilities: ['sourcing'],
          missing_capabilities: ['sourcing'],
        },
      },
    });
  });

  it('rejects when the tenant has SOME but not ALL required capabilities (all-or-nothing)', async () => {
    const guard = new EntitlementGuard(
      makeReflector(['portal', 'sourcing']),
      makeRepository(['portal']),
    );
    const ctx = makeContext({ authContext: baseAuth });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'TENANT_CAPABILITY_NOT_ENTITLED',
      statusCode: 403,
      context: {
        details: {
          required_capabilities: ['portal', 'sourcing'],
          missing_capabilities: ['sourcing'],
        },
      },
    });
  });

  it('rejects when AuthContext is missing entirely (JwtAuthGuard skipped)', async () => {
    const guard = new EntitlementGuard(
      makeReflector(['portal']),
      makeRepository(['portal']),
    );
    const ctx = makeContext({ authContext: undefined });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'TENANT_CAPABILITY_NOT_ENTITLED',
      statusCode: 403,
      context: { details: { reason: 'auth_context_missing' } },
    });
  });
});
