import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { IdentityAuditService } from '@aramo/identity';
import type { RefreshTokenDto, RefreshTokenService } from '@aramo/auth-storage';

import { AuthController } from '../app/auth/auth.controller.js';
import type { CookieVerifierService } from '../app/auth/cookie-verifier.service.js';
import type { HostBaseResolver } from '../app/auth/host-base-resolver.service.js';
import type { PkceService } from '../app/auth/pkce.service.js';
import type { RefreshOrchestratorService } from '../app/auth/refresh-orchestrator.service.js';
import type { SessionOrchestratorService } from '../app/auth/session-orchestrator.service.js';

const USER_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_ID = '01900000-0000-7000-8000-0000000000aa';

interface FakeResponse {
  cookie: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
}

function makeRes(): FakeResponse {
  const res = {
    cookie: vi.fn(),
    status: vi.fn(),
    end: vi.fn(),
    redirect: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as FakeResponse;
}

function makeController(
  overrides: Partial<{
    pkce: PkceService;
    sessionOrch: SessionOrchestratorService;
    refreshOrch: RefreshOrchestratorService;
    cookieVerifier: CookieVerifierService;
    refreshTokens: RefreshTokenService;
    audit: IdentityAuditService;
    hostBase: HostBaseResolver;
  }> = {},
): AuthController {
  // PR-3.1: default HostBaseResolver resolves to no derivation (env fallback),
  // so tests that don't exercise host-derivation behave exactly as before.
  const defaultHostBase = {
    resolve: vi.fn().mockResolvedValue({ derivedBase: null, identityProvider: null }),
  } as unknown as HostBaseResolver;
  return new AuthController(
    overrides.pkce ?? ({} as PkceService),
    overrides.sessionOrch ?? ({} as SessionOrchestratorService),
    overrides.refreshOrch ?? ({} as RefreshOrchestratorService),
    overrides.cookieVerifier ?? ({} as CookieVerifierService),
    overrides.refreshTokens ?? ({} as RefreshTokenService),
    overrides.audit ?? ({} as IdentityAuditService),
    overrides.hostBase ?? defaultHostBase,
  );
}

describe('AuthController.session', () => {
  // Test 36: /session verifies cookie, returns 6-field SessionResponse.
  it('returns the 6-field SessionResponseDto on successful verification', async () => {
    const cookieVerifier = {
      verify: vi.fn().mockResolvedValue({
        sub: USER_ID,
        consumer_type: 'recruiter',
        tenant_id: TENANT_ID,
        scopes: ['auth:session:read'],
        iat: 1_700_000_000,
        exp: 1_700_000_900,
      }),
    } as unknown as CookieVerifierService;
    const ctl = makeController({ cookieVerifier });
    const req = {
      cookies: { aramo_access_token: 'a.jwt' },
      requestId: 'req-1',
    } as never;
    const result = await ctl.session('recruiter', req);
    expect(Object.keys(result).sort()).toEqual([
      'consumer_type',
      'exp',
      'iat',
      'scopes',
      'sub',
      'tenant_id',
    ]);
    expect(result.sub).toBe(USER_ID);
    expect(result.consumer_type).toBe('recruiter');
  });

  // Test 37: consumer mismatch → INVALID_TOKEN.
  it('throws AramoError(INVALID_TOKEN, 401) on path/JWT consumer mismatch', async () => {
    const cookieVerifier = {
      verify: vi.fn().mockResolvedValue({
        sub: USER_ID,
        consumer_type: 'portal',
        tenant_id: TENANT_ID,
        scopes: [],
        iat: 1,
        exp: 2,
      }),
    } as unknown as CookieVerifierService;
    const ctl = makeController({ cookieVerifier });
    const req = {
      cookies: { aramo_access_token: 'jwt' },
      requestId: 'r',
    } as never;
    await expect(ctl.session('recruiter', req)).rejects.toBeInstanceOf(AramoError);
    await expect(ctl.session('recruiter', req)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
      statusCode: 401,
    });
  });

  it('throws AramoError(INVALID_TOKEN, 401) when access cookie is missing', async () => {
    const cookieVerifier = {
      verify: vi.fn(),
    } as unknown as CookieVerifierService;
    const ctl = makeController({ cookieVerifier });
    const req = { cookies: {}, requestId: 'r', get: () => undefined } as never;
    await expect(ctl.session('recruiter', req)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
      statusCode: 401,
    });
  });
});

describe('AuthController.logout (idempotent)', () => {
  // Test 38: logout returns 204 even with missing cookie.
  it('returns 204 and clears cookies even with missing refresh cookie', async () => {
    const refreshTokens = {
      findByHash: vi.fn(),
      revoke: vi.fn(),
    } as unknown as RefreshTokenService;
    const audit = {
      writeEvent: vi.fn(),
    } as unknown as IdentityAuditService;
    const ctl = makeController({ refreshTokens, audit });
    const res = makeRes();
    const req = { cookies: {}, requestId: 'r', get: () => undefined } as never;

    await ctl.logout('recruiter', req, res as never);

    expect(refreshTokens.findByHash).not.toHaveBeenCalled();
    expect(audit.writeEvent).not.toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalledTimes(2); // clear access + refresh
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('revokes the matching token and emits identity.session.revoked when cookie present', async () => {
    const found: RefreshTokenDto = {
      id: 'rt-1',
      user_id: USER_ID,
      tenant_id: TENANT_ID,
      consumer_type: 'recruiter',
      token_hash: 'h',
      created_at: '',
      updated_at: '',
      expires_at: '',
      revoked_at: null,
      replaced_by_id: null,
    };
    const refreshTokens = {
      findByHash: vi.fn().mockResolvedValue(found),
      revoke: vi.fn().mockResolvedValue(found),
    } as unknown as RefreshTokenService;
    const audit = {
      writeEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as IdentityAuditService;
    const ctl = makeController({ refreshTokens, audit });
    const res = makeRes();
    const req = {
      cookies: { aramo_refresh_token: 'plaintext' },
      requestId: 'r',
    } as never;

    await ctl.logout('recruiter', req, res as never);

    expect(refreshTokens.revoke).toHaveBeenCalledWith({ id: 'rt-1' });
    expect(audit.writeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'identity.session.revoked',
        actor_type: 'user',
        payload: { reason: 'logout' },
      }),
    );
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('skips revocation silently when refresh-token consumer does not match path consumer (LO.2.s)', async () => {
    const found: RefreshTokenDto = {
      id: 'rt-1',
      user_id: USER_ID,
      tenant_id: TENANT_ID,
      consumer_type: 'portal',
      token_hash: 'h',
      created_at: '',
      updated_at: '',
      expires_at: '',
      revoked_at: null,
      replaced_by_id: null,
    };
    const refreshTokens = {
      findByHash: vi.fn().mockResolvedValue(found),
      revoke: vi.fn(),
    } as unknown as RefreshTokenService;
    const audit = {
      writeEvent: vi.fn(),
    } as unknown as IdentityAuditService;
    const ctl = makeController({ refreshTokens, audit });
    const res = makeRes();
    const req = {
      cookies: { aramo_refresh_token: 'plaintext' },
      requestId: 'r',
    } as never;

    await ctl.logout('recruiter', req, res as never);

    expect(refreshTokens.revoke).not.toHaveBeenCalled();
    expect(audit.writeEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
  });
});

describe('AuthController.logoutRedirect (§5 D3 — Cognito SSO logout)', () => {
  const DOMAIN = 'aramo.auth.example.test';
  const CLIENT_ID = 'client-abc';
  const SIGNOUT = 'https://app.staging.example.test/login';

  function withEnv(
    env: Record<string, string | undefined>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const keys = Object.keys(env);
    const prev = keys.map((k) => [k, process.env[k]] as const);
    for (const k of keys) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    return fn().finally(() => {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  it('302-redirects to the Cognito hosted-UI /logout with client_id + the REGISTERED logout_uri', async () => {
    await withEnv(
      {
        AUTH_COGNITO_DOMAIN: DOMAIN,
        AUTH_COGNITO_CLIENT_ID: CLIENT_ID,
        AUTH_COGNITO_SIGNOUT_REDIRECT: SIGNOUT,
      },
      async () => {
        const ctl = makeController();
        const res = makeRes();
        const req = { cookies: {}, requestId: 'r', get: () => undefined } as never;

        await ctl.logoutRedirect('recruiter', req, res as never);

        expect(res.redirect).toHaveBeenCalledTimes(1);
        const [status, location] = res.redirect.mock.calls[0] as [
          number,
          string,
        ];
        expect(status).toBe(302);
        const url = new URL(location);
        expect(url.origin).toBe(`https://${DOMAIN}`);
        expect(url.pathname).toBe('/logout');
        expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
        // The return URL is the REGISTERED env value, NOT anything from the
        // request — the open-redirect guard.
        expect(url.searchParams.get('logout_uri')).toBe(SIGNOUT);
      },
    );
  });

  it('uses the configured logout_uri even if the request carries one (NOT user-controllable)', async () => {
    await withEnv(
      {
        AUTH_COGNITO_DOMAIN: DOMAIN,
        AUTH_COGNITO_CLIENT_ID: CLIENT_ID,
        AUTH_COGNITO_SIGNOUT_REDIRECT: SIGNOUT,
      },
      async () => {
        const ctl = makeController();
        const res = makeRes();
        // An attacker-supplied logout_uri in the query must be ignored.
        const req = {
          cookies: {},
          requestId: 'r',
          query: { logout_uri: 'https://evil.example.test/phish' },
          get: () => undefined,
        } as never;

        await ctl.logoutRedirect('recruiter', req, res as never);

        const location = (res.redirect.mock.calls[0] as [number, string])[1];
        expect(location).toContain(encodeURIComponent(SIGNOUT));
        expect(location).not.toContain('evil.example.test');
      },
    );
  });

  it('throws 500 (signout_redirect_missing) when AUTH_COGNITO_SIGNOUT_REDIRECT is unset — no fallback', async () => {
    await withEnv(
      {
        AUTH_COGNITO_DOMAIN: DOMAIN,
        AUTH_COGNITO_CLIENT_ID: CLIENT_ID,
        AUTH_COGNITO_SIGNOUT_REDIRECT: undefined,
      },
      async () => {
        const ctl = makeController();
        const res = makeRes();
        const req = { cookies: {}, requestId: 'r', get: () => undefined } as never;

        await expect(
          ctl.logoutRedirect('recruiter', req, res as never),
        ).rejects.toMatchObject({
          code: 'INTERNAL_ERROR',
          context: { details: { reason: 'signout_redirect_missing' } },
        });
        expect(res.redirect).not.toHaveBeenCalled();
      },
    );
  });

  it('throws 500 (cognito_env_missing) when domain/client are unset', async () => {
    await withEnv(
      {
        AUTH_COGNITO_DOMAIN: undefined,
        AUTH_COGNITO_CLIENT_ID: undefined,
        AUTH_COGNITO_SIGNOUT_REDIRECT: SIGNOUT,
      },
      async () => {
        const ctl = makeController();
        const res = makeRes();
        const req = { cookies: {}, requestId: 'r', get: () => undefined } as never;

        await expect(
          ctl.logoutRedirect('recruiter', req, res as never),
        ).rejects.toMatchObject({
          code: 'INTERNAL_ERROR',
          context: { details: { reason: 'cognito_env_missing' } },
        });
        expect(res.redirect).not.toHaveBeenCalled();
      },
    );
  });

  it('rejects an invalid consumer with VALIDATION_ERROR (400)', async () => {
    await withEnv(
      {
        AUTH_COGNITO_DOMAIN: DOMAIN,
        AUTH_COGNITO_CLIENT_ID: CLIENT_ID,
        AUTH_COGNITO_SIGNOUT_REDIRECT: SIGNOUT,
      },
      async () => {
        const ctl = makeController();
        const res = makeRes();
        const req = { cookies: {}, requestId: 'r', get: () => undefined } as never;

        await expect(
          ctl.logoutRedirect('not-a-consumer', req, res as never),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
      },
    );
  });

  it('is a cookie-less idempotent no-op (already-logged-out → still a clean 302)', async () => {
    await withEnv(
      {
        AUTH_COGNITO_DOMAIN: DOMAIN,
        AUTH_COGNITO_CLIENT_ID: CLIENT_ID,
        AUTH_COGNITO_SIGNOUT_REDIRECT: SIGNOUT,
      },
      async () => {
        const refreshTokens = {
          findByHash: vi.fn(),
          revoke: vi.fn(),
        } as unknown as RefreshTokenService;
        const ctl = makeController({ refreshTokens });
        const res = makeRes();
        // No cookies at all — an already-logged-out browser.
        const req = { cookies: {}, requestId: 'r', get: () => undefined } as never;

        await ctl.logoutRedirect('recruiter', req, res as never);

        // No token lookup / revocation: the redirect reveals nothing.
        expect(refreshTokens.findByHash).not.toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledTimes(1);
        expect(res.cookie).not.toHaveBeenCalled();
      },
    );
  });
});

describe('AuthController.callback (orchestrator-result mapping)', () => {
  it('on success: sets cookies, clears pkce_state, redirects 302 to the CONFIGURED target', async () => {
    // The redirect target is per-environment config (the frontend origin for
    // THIS env), NOT a hardcoded literal. Set it and assert the 302 uses the
    // exact configured value.
    const CONFIGURED = 'https://app.staging.example.test/';
    const prev = process.env['AUTH_POST_LOGIN_REDIRECT'];
    process.env['AUTH_POST_LOGIN_REDIRECT'] = CONFIGURED;
    try {
      const sessionOrch = {
        handleCallback: vi.fn().mockResolvedValue({
          kind: 'success',
          accessJwt: 'a.b.c',
          refreshTokenPlaintext: 'rt-plain',
        }),
      } as unknown as SessionOrchestratorService;
      const ctl = makeController({ sessionOrch });
      const res = makeRes();
      const req = {
        cookies: { aramo_pkce_state: 'cipher' },
        requestId: 'r',
        get: () => undefined,
      } as never;
      await ctl.callback(
        'recruiter',
        'code',
        'state',
        undefined,
        undefined,
        req,
        res as never,
      );
      // 3 cookie operations: access, refresh, clear pkce
      expect(res.cookie).toHaveBeenCalledTimes(3);
      // 302 to the CONFIGURED target — not a hardcoded localhost literal.
      expect(res.redirect).toHaveBeenCalledWith(302, CONFIGURED);
      expect(res.status).not.toHaveBeenCalledWith(204);
    } finally {
      if (prev === undefined) delete process.env['AUTH_POST_LOGIN_REDIRECT'];
      else process.env['AUTH_POST_LOGIN_REDIRECT'] = prev;
    }
  });

  it('on success WITHOUT AUTH_POST_LOGIN_REDIRECT configured: throws 500 (no hardcoded fallback)', async () => {
    const prev = process.env['AUTH_POST_LOGIN_REDIRECT'];
    delete process.env['AUTH_POST_LOGIN_REDIRECT'];
    try {
      const sessionOrch = {
        handleCallback: vi.fn().mockResolvedValue({
          kind: 'success',
          accessJwt: 'a.b.c',
          refreshTokenPlaintext: 'rt-plain',
        }),
      } as unknown as SessionOrchestratorService;
      const ctl = makeController({ sessionOrch });
      const res = makeRes();
      const req = {
        cookies: { aramo_pkce_state: 'cipher' },
        requestId: 'r',
        get: () => undefined,
      } as never;
      await expect(
        ctl.callback('recruiter', 'code', 'state', undefined, undefined, req, res as never),
      ).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        context: { details: { reason: 'post_login_redirect_missing' } },
      });
      // No silent localhost fallback redirect.
      expect(res.redirect).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env['AUTH_POST_LOGIN_REDIRECT'];
      else process.env['AUTH_POST_LOGIN_REDIRECT'] = prev;
    }
  });

  // Inc-3 PR-3.5 (Workstream A) — callback errors become NAVIGATIONS (302 →
  // ${base}/login?error=CODE) when a validated base resolves, and fall back to
  // JSON (throw) when none does. Response-shape only: the codes are byte-
  // identical to the pre-3.5 throws.
  describe('callback errors → 302 /login?error= (Workstream A)', () => {
    const BASE = 'https://acme.aramo.ai';
    function validatedHostBase(): HostBaseResolver {
      return {
        resolve: vi
          .fn()
          .mockResolvedValue({ derivedBase: BASE, identityProvider: null }),
      } as unknown as HostBaseResolver;
    }
    function nullHostBase(): HostBaseResolver {
      return {
        resolve: vi
          .fn()
          .mockResolvedValue({ derivedBase: null, identityProvider: null }),
      } as unknown as HostBaseResolver;
    }
    async function run(
      result: unknown,
      hostBase: HostBaseResolver,
      host = 'acme.aramo.ai',
    ): Promise<FakeResponse> {
      const sessionOrch = {
        handleCallback: vi.fn().mockResolvedValue(result),
      } as unknown as SessionOrchestratorService;
      const ctl = makeController({ sessionOrch, hostBase });
      const res = makeRes();
      const req = {
        cookies: { aramo_pkce_state: 'cipher' },
        requestId: 'r',
        get: () => host,
      } as never;
      await ctl.callback(
        'recruiter',
        'code',
        'state',
        undefined,
        undefined,
        req,
        res as never,
      );
      return res;
    }

    const CASES: ReadonlyArray<readonly [string, unknown, string]> = [
      [
        'tenant_selection_required',
        { kind: 'tenant_selection_required', tenants: [{ id: TENANT_ID, name: 'T1' }] },
        'TENANT_SELECTION_REQUIRED',
      ],
      ['tenant_suspended', { kind: 'auth_error', reason: 'tenant_suspended' }, 'TENANT_SUSPENDED'],
      ['tenant_closed', { kind: 'auth_error', reason: 'tenant_closed' }, 'TENANT_CLOSED'],
      ['email_not_verified', { kind: 'auth_error', reason: 'email_not_verified' }, 'INVALID_TOKEN'],
      ['no_active_tenant', { kind: 'auth_error', reason: 'no_active_tenant' }, 'TENANT_ACCESS_DENIED'],
      ['user_not_provisioned', { kind: 'auth_error', reason: 'user_not_provisioned' }, 'INSUFFICIENT_PERMISSIONS'],
      ['internal_error', { kind: 'internal_error', reason: 'boom' }, 'INTERNAL_ERROR'],
    ];

    it.each(CASES)(
      'validated base: %s → 302 /login?error=%s',
      async (_label, result, code) => {
        const res = await run(result, validatedHostBase());
        expect(res.redirect).toHaveBeenCalledWith(
          302,
          `${BASE}/login?error=${code}`,
        );
      },
    );

    it('VALIDATION_ERROR carries the reason subcode on the query', async () => {
      const res = await run(
        { kind: 'validation_error', reason: 'state_mismatch' },
        validatedHostBase(),
      );
      expect(res.redirect).toHaveBeenCalledWith(
        302,
        `${BASE}/login?error=VALIDATION_ERROR&reason=state_mismatch`,
      );
    });

    it('no base resolves → JSON fallback (throws, never a redirect)', async () => {
      const prevPub = process.env['AUTH_PUBLIC_BASE_URL'];
      const prevLegacy = process.env['AUTH_COGNITO_REDIRECT_URI'];
      delete process.env['AUTH_PUBLIC_BASE_URL'];
      delete process.env['AUTH_COGNITO_REDIRECT_URI'];
      try {
        const sessionOrch = {
          handleCallback: vi
            .fn()
            .mockResolvedValue({ kind: 'auth_error', reason: 'tenant_suspended' }),
        } as unknown as SessionOrchestratorService;
        const ctl = makeController({ sessionOrch, hostBase: nullHostBase() });
        const res = makeRes();
        const req = {
          cookies: { aramo_pkce_state: 'c' },
          requestId: 'r',
          get: () => undefined,
        } as never;
        await expect(
          ctl.callback('recruiter', 'code', 'state', undefined, undefined, req, res as never),
        ).rejects.toMatchObject({ code: 'TENANT_SUSPENDED', statusCode: 403 });
        expect(res.redirect).not.toHaveBeenCalled();
      } finally {
        if (prevPub === undefined) delete process.env['AUTH_PUBLIC_BASE_URL'];
        else process.env['AUTH_PUBLIC_BASE_URL'] = prevPub;
        if (prevLegacy === undefined) delete process.env['AUTH_COGNITO_REDIRECT_URI'];
        else process.env['AUTH_COGNITO_REDIRECT_URI'] = prevLegacy;
      }
    });

    it('hostile/unvalidated host never derives a redirect base (PR-3.1 §2 → JSON)', async () => {
      // HostBaseResolver returns derivedBase=null for an unvalidated host
      // (evil.com); with the env chain cleared, no base resolves → JSON. A raw
      // Host never reaches the redirect.
      const prevPub = process.env['AUTH_PUBLIC_BASE_URL'];
      const prevLegacy = process.env['AUTH_COGNITO_REDIRECT_URI'];
      delete process.env['AUTH_PUBLIC_BASE_URL'];
      delete process.env['AUTH_COGNITO_REDIRECT_URI'];
      try {
        const sessionOrch = {
          handleCallback: vi
            .fn()
            .mockResolvedValue({ kind: 'auth_error', reason: 'tenant_suspended' }),
        } as unknown as SessionOrchestratorService;
        const ctl = makeController({ sessionOrch, hostBase: nullHostBase() });
        const res = makeRes();
        const req = {
          cookies: { aramo_pkce_state: 'c' },
          requestId: 'r',
          get: () => 'evil.com',
        } as never;
        await expect(
          ctl.callback('recruiter', 'code', 'state', undefined, undefined, req, res as never),
        ).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
        expect(res.redirect).not.toHaveBeenCalled();
      } finally {
        if (prevPub === undefined) delete process.env['AUTH_PUBLIC_BASE_URL'];
        else process.env['AUTH_PUBLIC_BASE_URL'] = prevPub;
        if (prevLegacy === undefined) delete process.env['AUTH_COGNITO_REDIRECT_URI'];
        else process.env['AUTH_COGNITO_REDIRECT_URI'] = prevLegacy;
      }
    });
  });
});

describe('AuthController.login (Subdomain-Identity B — Home Realm Discovery)', () => {
  const DOMAIN = 'aramo.auth.example.test';
  const CLIENT_ID = 'client-abc';
  const REDIRECT_URI = 'https://app.staging.example.test/auth/recruiter/callback';

  // login() needs the Cognito Hosted-UI config + a stable apex for the slug
  // parse. Set them for the whole block and restore after, mirroring the
  // logoutRedirect tests' env discipline.
  const ENV = {
    AUTH_COGNITO_DOMAIN: DOMAIN,
    AUTH_COGNITO_CLIENT_ID: CLIENT_ID,
    AUTH_COGNITO_REDIRECT_URI: REDIRECT_URI,
    APP_ROOT_DOMAIN: 'aramo.ai',
  } as const;
  const savedEnv: Partial<Record<string, string | undefined>> = {};

  beforeAll(() => {
    for (const k of Object.keys(ENV) as (keyof typeof ENV)[]) {
      savedEnv[k] = process.env[k];
      process.env[k] = ENV[k];
    }
  });
  afterAll(() => {
    for (const k of Object.keys(ENV) as (keyof typeof ENV)[]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  function fakePkce(): PkceService {
    return {
      generate: vi.fn().mockReturnValue({
        verifier: 'verifier',
        state: 'state-xyz',
        challenge: 'challenge-abc',
      }),
      encryptState: vi.fn().mockReturnValue('cipher'),
    } as unknown as PkceService;
  }

  // PR-3.1: the login IdP hint now comes from HostBaseResolver.resolve (which
  // folds the slug parse + findActiveBySlug — those internals are covered in
  // host-base-resolver.spec.ts). These controller tests verify only that login
  // wires resolve()'s identityProvider into the authorize URL. `derivedBase:
  // null` here → redirect_uri falls back to the legacy env (REDIRECT_URI).
  function hostBaseYielding(identityProvider: string | null): HostBaseResolver {
    return {
      resolve: vi.fn().mockResolvedValue({ derivedBase: null, identityProvider }),
    } as unknown as HostBaseResolver;
  }

  function reqWithHost(host: string | undefined): never {
    return {
      requestId: 'r',
      get: (name: string) =>
        name.toLowerCase() === 'host' ? host : undefined,
    } as never;
  }

  function locationOf(res: FakeResponse): URL {
    expect(res.redirect).toHaveBeenCalledTimes(1);
    const [status, location] = res.redirect.mock.calls[0] as [number, string];
    expect(status).toBe(302);
    return new URL(location);
  }

  it('pins identity_provider from HostBaseResolver.resolve, passing the request host', async () => {
    const hostBase = hostBaseYielding('microsoft');
    const ctl = makeController({ pkce: fakePkce(), hostBase });
    const res = makeRes();

    await ctl.login('recruiter', reqWithHost('astre.aramo.ai'), res as never);

    // The controller shares ONE resolve() call, keyed on the request host.
    expect((hostBase.resolve as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('astre.aramo.ai');
    const url = locationOf(res);
    expect(url.searchParams.get('identity_provider')).toBe('microsoft');
    // The base authorize params are untouched by the additive hint; derivedBase
    // null → redirect_uri from the legacy env.
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('shows the chooser (no param) when resolve yields a null IdP', async () => {
    const ctl = makeController({ pkce: fakePkce(), hostBase: hostBaseYielding(null) });
    const res = makeRes();
    await ctl.login('recruiter', reqWithHost('acme.aramo.ai'), res as never);
    expect(locationOf(res).searchParams.has('identity_provider')).toBe(false);
  });

  it('derivedBase from resolve WINS the redirect_uri (host-derived callback)', async () => {
    const hostBase = {
      resolve: vi.fn().mockResolvedValue({
        derivedBase: 'https://admin.aramo.ai',
        identityProvider: null,
      }),
    } as unknown as HostBaseResolver;
    const ctl = makeController({ pkce: fakePkce(), hostBase });
    const res = makeRes();
    await ctl.login('platform', reqWithHost('admin.aramo.ai'), res as never);
    expect(locationOf(res).searchParams.get('redirect_uri')).toBe(
      'https://admin.aramo.ai/auth/platform/callback',
    );
  });
});
