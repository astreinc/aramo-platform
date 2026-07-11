import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { TenantRepository } from '@aramo/identity';

import { TenantWriteFreezeInterceptor } from '../tenant-write-freeze/tenant-write-freeze.interceptor.js';
import { ALLOW_WHEN_SUSPENDED_KEY } from '../tenant-write-freeze/allow-when-suspended.decorator.js';

// Inc-3 PR-3.7 — the decision-ladder unit matrix. The interceptor is the only
// unit under test; TenantRepository + Reflector are mocked so each rung is
// isolated.

const TENANT_ID = '01900000-0000-7000-8000-0000000000a1';

function authCtx(over: Partial<AuthContextType> = {}): AuthContextType {
  return {
    sub: 'u1',
    consumer_type: 'recruiter',
    actor_kind: 'user',
    tenant_id: TENANT_ID,
    scopes: [],
    iat: 0,
    exp: 0,
    ...over,
  } as AuthContextType;
}

function makeCtx(args: {
  method?: string;
  authContext?: AuthContextType | undefined;
}): ExecutionContext {
  const req = {
    method: args.method ?? 'POST',
    authContext: args.authContext,
    requestId: 'req-1',
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}) as never,
    getClass: () => ({}) as never,
  } as unknown as ExecutionContext;
}

function makeHandler(): CallHandler {
  return { handle: vi.fn().mockReturnValue(of('ok')) };
}

function build(opts: {
  status?: string | null; // findLifecycleById result status; null → row absent
  allowDecorator?: boolean;
}): {
  interceptor: TenantWriteFreezeInterceptor;
  findLifecycleById: ReturnType<typeof vi.fn>;
} {
  const findLifecycleById = vi.fn(async () =>
    opts.status === null || opts.status === undefined
      ? opts.status === null
        ? null
        : { id: TENANT_ID, status: 'ACTIVE', is_active: true }
      : { id: TENANT_ID, status: opts.status, is_active: opts.status !== 'CLOSED' },
  );
  const tenantRepo = { findLifecycleById } as unknown as TenantRepository;
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(opts.allowDecorator ?? undefined),
  } as unknown as Reflector;
  return {
    interceptor: new TenantWriteFreezeInterceptor(tenantRepo, reflector),
    findLifecycleById,
  };
}

describe('TenantWriteFreezeInterceptor — decision ladder', () => {
  it('rung 1 — no authContext → skip (no DB read)', async () => {
    const { interceptor, findLifecycleById } = build({});
    const next = makeHandler();
    await interceptor.intercept(makeCtx({ authContext: undefined }), next);
    expect(next.handle).toHaveBeenCalledOnce();
    expect(findLifecycleById).not.toHaveBeenCalled();
  });

  it('rung 2 — platform consumer → skip (operator acts on suspended tenants)', async () => {
    const { interceptor, findLifecycleById } = build({ status: 'SUSPENDED' });
    const next = makeHandler();
    await interceptor.intercept(
      makeCtx({ method: 'POST', authContext: authCtx({ consumer_type: 'platform' }) }),
      next,
    );
    expect(next.handle).toHaveBeenCalledOnce();
    expect(findLifecycleById).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'rung 3 — read method %s → skip (write freeze only; no DB read)',
    async (method) => {
      const { interceptor, findLifecycleById } = build({ status: 'SUSPENDED' });
      const next = makeHandler();
      await interceptor.intercept(makeCtx({ method, authContext: authCtx() }), next);
      expect(next.handle).toHaveBeenCalledOnce();
      expect(findLifecycleById).not.toHaveBeenCalled();
    },
  );

  it('rung 4 — @AllowWhenSuspended → skip even for SUSPENDED (no DB read)', async () => {
    const { interceptor, findLifecycleById } = build({
      status: 'SUSPENDED',
      allowDecorator: true,
    });
    const next = makeHandler();
    await interceptor.intercept(makeCtx({ method: 'POST', authContext: authCtx() }), next);
    expect(next.handle).toHaveBeenCalledOnce();
    // Rung 4 short-circuits before the rung-5 read.
    expect(findLifecycleById).not.toHaveBeenCalled();
  });

  it('rung 4 — Reflector queried with handler + class (getAllAndOverride)', async () => {
    const { interceptor } = build({ status: 'ACTIVE' });
    const reflectorSpy = vi.fn().mockReturnValue(undefined);
    // Rebuild with an observable reflector to assert the key + targets.
    const tenantRepo = {
      findLifecycleById: vi.fn(async () => ({ id: TENANT_ID, status: 'ACTIVE', is_active: true })),
    } as unknown as TenantRepository;
    const i2 = new TenantWriteFreezeInterceptor(tenantRepo, {
      getAllAndOverride: reflectorSpy,
    } as unknown as Reflector);
    void interceptor;
    await i2.intercept(makeCtx({ method: 'POST', authContext: authCtx() }), makeHandler());
    expect(reflectorSpy).toHaveBeenCalledWith(ALLOW_WHEN_SUSPENDED_KEY, [
      expect.anything(),
      expect.anything(),
    ]);
  });

  it.each(['ACTIVE', 'PROVISIONED', 'OFFBOARDING'])(
    'rung 5 — %s writes normally (pass)',
    async (status) => {
      const { interceptor, findLifecycleById } = build({ status });
      const next = makeHandler();
      await interceptor.intercept(makeCtx({ method: 'POST', authContext: authCtx() }), next);
      expect(findLifecycleById).toHaveBeenCalledWith(TENANT_ID);
      expect(next.handle).toHaveBeenCalledOnce();
    },
  );

  it('rung 5 — SUSPENDED → 403 TENANT_SUSPENDED (write denied, handler not reached)', async () => {
    const { interceptor } = build({ status: 'SUSPENDED' });
    const next = makeHandler();
    await expect(
      interceptor.intercept(makeCtx({ method: 'POST', authContext: authCtx() }), next),
    ).rejects.toMatchObject({ code: 'TENANT_SUSPENDED', statusCode: 403 });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('rung 5 — CLOSED → 403 TENANT_CLOSED', async () => {
    const { interceptor } = build({ status: 'CLOSED' });
    const next = makeHandler();
    await expect(
      interceptor.intercept(makeCtx({ method: 'DELETE', authContext: authCtx() }), next),
    ).rejects.toMatchObject({ code: 'TENANT_CLOSED', statusCode: 403 });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('edge — null tenant row under a valid JWT → FAIL CLOSED (403 TENANT_CLOSED)', async () => {
    const { interceptor } = build({ status: null });
    const next = makeHandler();
    const err = await interceptor
      .intercept(makeCtx({ method: 'POST', authContext: authCtx() }), next)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AramoError);
    expect(err).toMatchObject({
      code: 'TENANT_CLOSED',
      statusCode: 403,
      context: { details: { reason: 'tenant_row_absent' } },
    });
    expect(next.handle).not.toHaveBeenCalled();
  });
});

// Inc-3 PR-3.7 §4/§5.3 — registration order. Nest runs APP_INTERCEPTORs in
// provider-declaration order; the write-freeze MUST be first so a denied write
// short-circuits before any enrichment work is spent. A cheap source assertion:
// the TenantWriteFreezeInterceptor APP_INTERCEPTOR entry precedes the
// VisibilityInterceptor entry in app.module.ts.
describe('TenantWriteFreezeInterceptor — registration order', () => {
  it('is the FIRST APP_INTERCEPTOR (before VisibilityInterceptor)', () => {
    const source = readFileSync(
      resolve(__dirname, '../app.module.ts'),
      'utf8',
    );
    const freeze = source.indexOf('useClass: TenantWriteFreezeInterceptor');
    const visibility = source.indexOf('useClass: VisibilityInterceptor');
    expect(freeze).toBeGreaterThan(-1);
    expect(visibility).toBeGreaterThan(-1);
    expect(freeze).toBeLessThan(visibility);
  });
});
