import { describe, it, expect, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContext } from '@aramo/auth';

import { RolesGuard } from '../lib/roles.guard.js';
import {
  REQUIRED_SCOPES_KEY,
  REQUIRES_SITE_MATCH_KEY,
} from '../lib/authorization.metadata.js';

function makeContext(args: {
  authContext?: Partial<AuthContext>;
  params?: Record<string, string>;
  query?: Record<string, string>;
  requestId?: string;
}): ExecutionContext {
  const request = {
    authContext: args.authContext as AuthContext | undefined,
    requestId: args.requestId ?? 'req-test',
    params: args.params ?? {},
    query: args.query ?? {},
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

function makeReflector(
  metadata: Partial<{
    [REQUIRED_SCOPES_KEY]: string[];
    [REQUIRES_SITE_MATCH_KEY]: boolean;
  }>,
): Reflector {
  const r = new Reflector();
  vi.spyOn(r, 'getAllAndOverride').mockImplementation((key: string) => {
    return (metadata as Record<string, unknown>)[key];
  });
  return r;
}

const baseAuth: AuthContext = {
  sub: '01900000-0000-7000-8000-000000000002',
  consumer_type: 'recruiter',
  actor_kind: 'user',
  tenant_id: '01900000-0000-7000-8000-000000000001',
  scopes: ['submittal:create', 'submittal:read'],
  iat: 0,
  exp: 0,
};

describe('RolesGuard', () => {
  it('passes through when no @RequireScopes / @RequireSiteMatch metadata is set', () => {
    const guard = new RolesGuard(makeReflector({}));
    const ctx = makeContext({ authContext: baseAuth });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes when every required scope is present in AuthContext.scopes', () => {
    const guard = new RolesGuard(
      makeReflector({ [REQUIRED_SCOPES_KEY]: ['submittal:create'] }),
    );
    const ctx = makeContext({ authContext: baseAuth });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes when multiple required scopes are all present (all-or-nothing)', () => {
    const guard = new RolesGuard(
      makeReflector({
        [REQUIRED_SCOPES_KEY]: ['submittal:create', 'submittal:read'],
      }),
    );
    const ctx = makeContext({ authContext: baseAuth });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects with INSUFFICIENT_PERMISSIONS (403) when a required scope is missing', () => {
    const guard = new RolesGuard(
      makeReflector({
        [REQUIRED_SCOPES_KEY]: ['submittal:approve'],
      }),
    );
    const ctx = makeContext({ authContext: baseAuth });
    expect(() => guard.canActivate(ctx)).toThrow(AramoError);
    try {
      guard.canActivate(ctx);
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(e.statusCode).toBe(403);
      expect(e.context.details).toMatchObject({
        required_scopes: ['submittal:approve'],
        missing_scopes: ['submittal:approve'],
      });
    }
  });

  it('rejects when any one of several required scopes is missing (all-or-nothing semantics)', () => {
    const guard = new RolesGuard(
      makeReflector({
        [REQUIRED_SCOPES_KEY]: ['submittal:create', 'submittal:approve'],
      }),
    );
    const ctx = makeContext({ authContext: baseAuth });
    expect(() => guard.canActivate(ctx)).toThrow(AramoError);
  });

  it('rejects with INSUFFICIENT_PERMISSIONS when AuthContext is missing entirely (JwtAuthGuard skipped)', () => {
    const guard = new RolesGuard(
      makeReflector({ [REQUIRED_SCOPES_KEY]: ['submittal:create'] }),
    );
    const ctx = makeContext({});
    expect(() => guard.canActivate(ctx)).toThrow(AramoError);
    try {
      guard.canActivate(ctx);
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(e.context.details).toMatchObject({
        reason: 'auth_context_missing',
      });
    }
  });

  // A1a fix: an absent site_id claim denotes a TENANT-WIDE principal with
  // authority over every site — so a @RequireSiteMatch route admits it
  // (it does NOT reject as a missing claim). The issuer omits the claim
  // only for NULL-site memberships, so this cannot be forged.
  it('passes a @RequireSiteMatch route when the AuthContext lacks a site_id claim (tenant-wide principal, no requested site)', () => {
    const guard = new RolesGuard(
      makeReflector({ [REQUIRES_SITE_MATCH_KEY]: true }),
    );
    const ctx = makeContext({ authContext: baseAuth });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // A1a fix: a tenant-wide principal (no site_id claim) is admitted even
  // when the route names a specific requested site — all-site authority.
  it('passes a @RequireSiteMatch route when the AuthContext lacks a site_id claim and the route names a requested site (tenant-wide all-site authority)', () => {
    const guard = new RolesGuard(
      makeReflector({ [REQUIRES_SITE_MATCH_KEY]: true }),
    );
    const ctx = makeContext({
      authContext: baseAuth,
      params: { site_id: '01900000-0000-7000-8000-0000000000a2' },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a @RequireSiteMatch route when claim.site_id does not match the requested site_id (wrong-site)', () => {
    const guard = new RolesGuard(
      makeReflector({ [REQUIRES_SITE_MATCH_KEY]: true }),
    );
    const ctx = makeContext({
      authContext: {
        ...baseAuth,
        site_id: '01900000-0000-7000-8000-0000000000a1',
      },
      params: { site_id: '01900000-0000-7000-8000-0000000000a2' },
    });
    expect(() => guard.canActivate(ctx)).toThrow(AramoError);
    try {
      guard.canActivate(ctx);
    } catch (err) {
      const e = err as AramoError;
      expect(e.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(e.context.details).toMatchObject({
        claim_site_id: '01900000-0000-7000-8000-0000000000a1',
        requested_site_id: '01900000-0000-7000-8000-0000000000a2',
      });
    }
  });

  it('passes a @RequireSiteMatch route when claim.site_id matches the requested site_id', () => {
    const guard = new RolesGuard(
      makeReflector({ [REQUIRES_SITE_MATCH_KEY]: true }),
    );
    const ctx = makeContext({
      authContext: {
        ...baseAuth,
        site_id: '01900000-0000-7000-8000-0000000000a1',
      },
      params: { site_id: '01900000-0000-7000-8000-0000000000a1' },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes a @RequireSiteMatch route when claim.site_id is set and no request site is supplied (tenant-wide site claim ok)', () => {
    const guard = new RolesGuard(
      makeReflector({ [REQUIRES_SITE_MATCH_KEY]: true }),
    );
    const ctx = makeContext({
      authContext: {
        ...baseAuth,
        site_id: '01900000-0000-7000-8000-0000000000a1',
      },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('reads requested site from query string when no path param is set', () => {
    const guard = new RolesGuard(
      makeReflector({ [REQUIRES_SITE_MATCH_KEY]: true }),
    );
    const ctx = makeContext({
      authContext: {
        ...baseAuth,
        site_id: '01900000-0000-7000-8000-0000000000a1',
      },
      query: { site_id: '01900000-0000-7000-8000-0000000000a2' },
    });
    expect(() => guard.canActivate(ctx)).toThrow(AramoError);
  });

  it('enforces both scopes AND site simultaneously when both decorators are present', () => {
    const guard = new RolesGuard(
      makeReflector({
        [REQUIRED_SCOPES_KEY]: ['submittal:create'],
        [REQUIRES_SITE_MATCH_KEY]: true,
      }),
    );
    // scopes ok, site mismatch -> reject
    const ctx = makeContext({
      authContext: {
        ...baseAuth,
        site_id: '01900000-0000-7000-8000-0000000000a1',
      },
      params: { site_id: '01900000-0000-7000-8000-0000000000a2' },
    });
    expect(() => guard.canActivate(ctx)).toThrow(AramoError);
  });
});
