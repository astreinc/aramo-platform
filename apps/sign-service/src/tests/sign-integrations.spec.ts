import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { type AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY, RolesGuard } from '@aramo/authorization';
import { EnvelopeNotFoundError } from '@aramo/sign';
import { ESIGN_ROLE_PERMISSIONS, ESIGN_SCOPE } from '@aramo/identity';
import { describe, expect, it, vi } from 'vitest';

import { digest } from '../app/integrations/credentials.js';
import { effectiveAuthority, type ApplicationView, type InstallationView } from '../app/integrations/effective-authority.js';
import { IntegrationAdminController } from '../app/integrations/integration-admin.controller.js';
import { IntegrationAdminService } from '../app/integrations/integration-admin.service.js';
import { SignApiController } from '../app/integrations/sign-api.controller.js';
import { SignApiGuard } from '../app/integrations/sign-api.guard.js';
import { SignApiService } from '../app/integrations/sign-api.service.js';
import { GRANT_CLIENT_CREDENTIALS, GRANT_SIGN_EVENT, GRANT_TOKEN_EXCHANGE, SignTokenService, TOKEN_TYPE_ACCESS_TOKEN } from '../app/integrations/sign-token.service.js';

// Sign Unified Product S-4 (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.4, mandatory refinement A):
//   Effective = Principal authority ∩ Installation grants ∩ Delegated scope.

const S = ESIGN_SCOPE;
const TENANT = '22222222-2222-7222-8222-222222222222';
const OTHER_TENANT = '44444444-4444-7444-8444-444444444444';
const USER = '11111111-1111-7111-8111-111111111111';
const OTHER_USER = '33333333-3333-7333-8333-333333333333';
const INST = '55555555-5555-7555-8555-555555555555';

const ATS: ApplicationView = {
  key: 'aramo-ats',
  kind: 'FIRST_PARTY',
  status: 'ACTIVE',
  requested_permissions: [S.ENVELOPE_READ, S.ENVELOPE_READ_ALL, S.ENVELOPE_CREATE, S.ENVELOPE_SEND, S.ENVELOPE_MANAGE_ALL],
  modes: ['USER'],
  assertable_roles: [],
  delegation_profile: [S.ENVELOPE_READ, S.ENVELOPE_READ_ALL, S.ENVELOPE_CREATE, S.ENVELOPE_SEND, S.ENVELOPE_MANAGE_ALL],
  delegation_required_scope: 'document:execute',
};
const PARTNER: ApplicationView = {
  key: 'acme-hr',
  kind: 'THIRD_PARTY',
  status: 'ACTIVE',
  requested_permissions: [S.ENVELOPE_READ, S.ENVELOPE_CREATE, S.ENVELOPE_SEND, S.ENVELOPE_READ_ALL],
  modes: ['USER', 'APPLICATION'],
  assertable_roles: ['hr_manager', 'hr_clerk'],
  delegation_profile: [],
  delegation_required_scope: null,
};
const inst = (over: Partial<InstallationView> = {}): InstallationView => ({
  status: 'ACTIVE',
  granted_permissions: [...ATS.requested_permissions],
  modes: ['USER'],
  integration_role: null,
  role_assertion_enabled: false,
  ...over,
});

describe('effective authority — refinement A: platform permissions never manufacture Sign authority', () => {
  it('an ATS user without the ATS signature permission and without a Sign role gets nothing', () => {
    expect(effectiveAuthority({ mode: 'USER', application: ATS, installation: inst(), user_sign_scopes: [], user_platform_scopes: ['talent:read'] })).toEqual({ ok: false, reason: 'no_authority' });
  });

  it('an ATS user holding document:execute gets the narrow delegated profile — not a Sign role', () => {
    const r = effectiveAuthority({ mode: 'USER', application: ATS, installation: inst(), user_sign_scopes: [], user_platform_scopes: ['document:execute'] });
    expect(r).toEqual({ ok: true, scopes: [...ATS.delegation_profile].sort() });
    expect(r.ok && r.scopes).not.toContain(S.MEMBER_MANAGE);
  });

  it('the installation grant narrows the delegation (a Sign admin limited ATS to reading)', () => {
    const r = effectiveAuthority({ mode: 'USER', application: ATS, installation: inst({ granted_permissions: [S.ENVELOPE_READ] }), user_sign_scopes: [], user_platform_scopes: ['document:execute'] });
    expect(r).toEqual({ ok: true, scopes: [S.ENVELOPE_READ] });
  });

  it('a grant beyond what the application requested is ignored', () => {
    const r = effectiveAuthority({ mode: 'USER', application: ATS, installation: inst({ granted_permissions: [S.ENVELOPE_READ, S.MEMBER_MANAGE, S.BILLING_MANAGE] }), user_sign_scopes: [S.MEMBER_MANAGE, S.BILLING_MANAGE], user_platform_scopes: ['document:execute'] });
    expect(r).toEqual({ ok: true, scopes: [S.ENVELOPE_READ] });
  });

  it('a third-party application never gets delegation from platform permissions; only the user’s own Sign role counts', () => {
    const ins = inst({ granted_permissions: [...PARTNER.requested_permissions], modes: ['USER', 'APPLICATION'] });
    expect(effectiveAuthority({ mode: 'USER', application: PARTNER, installation: ins, user_sign_scopes: [], user_platform_scopes: ['document:execute'] })).toEqual({ ok: false, reason: 'no_authority' });
    expect(effectiveAuthority({ mode: 'USER', application: PARTNER, installation: ins, user_sign_scopes: [...ESIGN_ROLE_PERMISSIONS.sign_sender], user_platform_scopes: [] })).toEqual({
      ok: true,
      scopes: [S.ENVELOPE_CREATE, S.ENVELOPE_READ, S.ENVELOPE_SEND].sort(),
    });
  });

  it('only esign:* user scopes count as Sign authority', () => {
    const r = effectiveAuthority({ mode: 'USER', application: PARTNER, installation: inst({ granted_permissions: [...PARTNER.requested_permissions], modes: ['USER'] }), user_sign_scopes: ['document:execute', 'tenant:admin:settings'] });
    expect(r).toEqual({ ok: false, reason: 'no_authority' });
  });

  it('a requested scope beyond the effective set is refused (no silent widening)', () => {
    expect(effectiveAuthority({ mode: 'USER', application: ATS, installation: inst({ granted_permissions: [S.ENVELOPE_READ] }), user_platform_scopes: ['document:execute'], requested: [S.ENVELOPE_SEND] })).toEqual({ ok: false, reason: 'scope_not_granted' });
    expect(effectiveAuthority({ mode: 'USER', application: ATS, installation: inst(), user_platform_scopes: ['document:execute'], requested: [S.ENVELOPE_READ] })).toEqual({ ok: true, scopes: [S.ENVELOPE_READ] });
  });

  it('revoked installation, disabled application and disallowed modes fail closed', () => {
    expect(effectiveAuthority({ mode: 'USER', application: ATS, installation: inst({ status: 'REVOKED' }), user_platform_scopes: ['document:execute'] })).toEqual({ ok: false, reason: 'installation_revoked' });
    expect(effectiveAuthority({ mode: 'USER', application: { ...ATS, status: 'DISABLED' }, installation: inst(), user_platform_scopes: ['document:execute'] })).toEqual({ ok: false, reason: 'application_disabled' });
    expect(effectiveAuthority({ mode: 'APPLICATION', application: ATS, installation: inst(), user_platform_scopes: ['document:execute'] })).toEqual({ ok: false, reason: 'mode_not_allowed' });
  });

  describe('application mode — integration identity + narrowing role mappings', () => {
    const ins = (over: Partial<InstallationView> = {}) =>
      inst({ granted_permissions: [...PARTNER.requested_permissions], modes: ['APPLICATION'], integration_role: 'sign_sender', ...over });

    it('needs an integration role; the role’s permissions ∩ the grant apply', () => {
      expect(effectiveAuthority({ mode: 'APPLICATION', application: PARTNER, installation: ins({ integration_role: null }) })).toEqual({ ok: false, reason: 'no_integration_role' });
      expect(effectiveAuthority({ mode: 'APPLICATION', application: PARTNER, installation: ins() })).toEqual({ ok: true, scopes: [S.ENVELOPE_CREATE, S.ENVELOPE_READ, S.ENVELOPE_SEND].sort() });
    });

    it('a role assertion is refused unless the installation is authorized to assert it', () => {
      expect(effectiveAuthority({ mode: 'APPLICATION', application: PARTNER, installation: ins(), external_role: 'hr_manager', role_mappings: new Map([['hr_manager', 'sign_admin']]) })).toEqual({ ok: false, reason: 'role_assertion_not_allowed' });
      expect(effectiveAuthority({ mode: 'APPLICATION', application: PARTNER, installation: ins({ role_assertion_enabled: true }), external_role: 'ceo', role_mappings: new Map([['ceo', 'sign_admin']]) })).toEqual({ ok: false, reason: 'role_assertion_not_allowed' });
    });

    it('an unmapped asserted role fails closed', () => {
      expect(effectiveAuthority({ mode: 'APPLICATION', application: PARTNER, installation: ins({ role_assertion_enabled: true }), external_role: 'hr_clerk', role_mappings: new Map() })).toEqual({ ok: false, reason: 'role_unmapped' });
    });

    it('a mapping can only narrow — mapping to Sign Admin never exceeds the integration role', () => {
      const widened = effectiveAuthority({ mode: 'APPLICATION', application: PARTNER, installation: ins({ role_assertion_enabled: true }), external_role: 'hr_manager', role_mappings: new Map([['hr_manager', 'sign_admin']]) });
      expect(widened).toEqual({ ok: true, scopes: [S.ENVELOPE_CREATE, S.ENVELOPE_READ, S.ENVELOPE_SEND].sort() });
      expect(widened.ok && widened.scopes).not.toContain(S.ENVELOPE_READ_ALL);
      const narrowed = effectiveAuthority({ mode: 'APPLICATION', application: PARTNER, installation: ins({ role_assertion_enabled: true }), external_role: 'hr_clerk', role_mappings: new Map([['hr_clerk', 'sign_viewer']]) });
      expect(narrowed).toEqual({ ok: true, scopes: [S.ENVELOPE_READ] });
    });
  });

  it('property: the result is always within installation grants ∩ application request ∩ request', () => {
    const all = Object.values(S) as string[];
    const pick = (seed: number) => all.filter((_, i) => (seed >> i) & 1);
    for (let seed = 1; seed < 400; seed += 7) {
      const grants = pick(seed * 31);
      const user = pick(seed * 17);
      const r = effectiveAuthority({ mode: 'USER', application: PARTNER, installation: inst({ granted_permissions: grants, modes: ['USER'] }), user_sign_scopes: user });
      if (r.ok) for (const s of r.scopes) expect(grants.includes(s) && PARTNER.requested_permissions.includes(s) && user.includes(s)).toBe(true);
    }
  });
});

// ── Token endpoint ────────────────────────────────────────────────────────────
const SECRET = 'sgs_correct-horse-battery-staple-0123456789';
function tokenService(opts: {
  cred?: Partial<{ installation_id: string | null; status: string; expires_at: Date | null; secret: string }> | null;
  app?: Partial<ApplicationView & { id: string }>;
  installation?: Record<string, unknown> | null;
  caps?: string[];
  user?: Partial<AuthContextType> | 'invalid';
  signScopes?: string[];
}) {
  const app = { id: 'app-1', ...ATS, ...opts.app };
  const cred =
    opts.cred === null
      ? null
      : {
          id: 'cred-1',
          application_id: app.id,
          installation_id: null,
          status: 'ACTIVE',
          expires_at: null,
          secret_hash: digest(opts.cred?.secret ?? SECRET),
          application: app,
          ...opts.cred,
        };
  const installation = opts.installation === undefined ? null : opts.installation;
  const repo = {
    findCredentialByClientId: vi.fn(async () => cred),
    findInstallationById: vi.fn(async () => installation),
    findInstallation: vi.fn(async () => installation),
    createFirstPartyIfAbsent: vi.fn(async (i: { tenant_id: string; grants: string[]; modes: string[] }) => ({ id: INST, tenant_id: i.tenant_id, status: 'ACTIVE', granted_permissions: i.grants, modes: i.modes, integration_role: null, role_assertion_enabled: false, application: app })),
    createToken: vi.fn(async () => ({})),
    touchCredential: vi.fn(async () => undefined),
  };
  const now = Math.floor(Date.now() / 1000);
  const userCtx = opts.user === 'invalid' ? null : { sub: USER, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: TENANT, scopes: ['document:execute'], iat: now, exp: now + 900, ...opts.user };
  const jwt = {
    verifyAccessToken: vi.fn(async () => {
      if (userCtx === null) throw new Error('bad token');
      return { context: userCtx, authz_version: 3 };
    }),
    resolveScopesForConsumer: vi.fn(async () => opts.signScopes ?? []),
  };
  const entitlements = { getCapabilities: vi.fn(async () => new Set(opts.caps ?? ['core', 'ats', 'sign'])) };
  return { svc: new SignTokenService(repo as never, jwt as never, entitlements as never, {} as never, {} as never), repo, jwt };
}
const exchange = (over: Record<string, unknown> = {}) => ({
  grant_type: GRANT_TOKEN_EXCHANGE,
  client_id: 'sgc_abc',
  client_secret: SECRET,
  subject_token: 'eyJ.user.token',
  subject_token_type: TOKEN_TYPE_ACCESS_TOKEN,
  ...over,
});

describe('Sign token endpoint', () => {
  it.each([
    ['unknown client', { cred: null }, {}],
    ['wrong secret', {}, { client_secret: 'sgs_wrong' }],
    ['revoked credential', { cred: { status: 'REVOKED' } }, {}],
    ['expired credential', { cred: { expires_at: new Date(Date.now() - 1000) } }, {}],
    ['disabled application', { app: { status: 'DISABLED' } }, {}],
  ] as const)('%s → 401 invalid_client (no oracle)', async (_n, opts, req) => {
    const { svc, repo } = tokenService(opts as never);
    await expect(svc.issue(exchange(req), 'r')).rejects.toMatchObject({ statusCode: 401, context: { details: { reason: 'invalid_client' } } });
    expect(repo.createToken).not.toHaveBeenCalled();
  });

  it('token exchange: issues a short-lived, tenant-scoped token; stores only its digest; auto-establishes the first-party installation', async () => {
    const { svc, repo, jwt } = tokenService({});
    const t = await svc.issue(exchange(), 'r');
    expect(t).toMatchObject({ token_type: 'Bearer', tenant_id: TENANT, installation_id: INST, mode: 'USER' });
    expect(t.expires_in).toBeLessThanOrEqual(300);
    expect(t.access_token).toMatch(/^sgt_/);
    expect(t.scope.split(' ').sort()).toEqual([...ATS.delegation_profile].sort());
    expect(jwt.resolveScopesForConsumer).toHaveBeenCalledWith(expect.objectContaining({ sub: USER }), 'sign', 3, 'r');
    expect(repo.createFirstPartyIfAbsent).toHaveBeenCalledTimes(1);
    const stored = (repo.createToken.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(stored['token_hash']).toBe(digest(t.access_token));
    expect(JSON.stringify(stored)).not.toContain(t.access_token);
    expect(stored).toMatchObject({ tenant_id: TENANT, subject_id: USER, mode: 'USER', audience: 'aramo-sign-api' });
  });

  it('the token never outlives the subject token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { svc } = tokenService({ user: { exp: now + 40 } });
    expect((await svc.issue(exchange(), 'r')).expires_in).toBeLessThanOrEqual(40);
  });

  it('an invalid subject token, a non-delegable session or caller-supplied identity fields are refused', async () => {
    await expect(tokenService({ user: 'invalid' }).svc.issue(exchange(), 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'invalid_grant' } } });
    for (const consumer_type of ['platform', 'portal', 'ingestion']) {
      await expect(tokenService({ user: { consumer_type } }).svc.issue(exchange(), 'r')).rejects.toMatchObject({ context: { details: { reason: 'invalid_grant' } } });
    }
    await expect(tokenService({ user: { actor_kind: 'service_account' } }).svc.issue(exchange(), 'r')).rejects.toMatchObject({ context: { details: { reason: 'invalid_grant' } } });
    await expect(tokenService({}).svc.issue(exchange({ external_role: 'admin' }), 'r')).rejects.toMatchObject({ statusCode: 400 });
    await expect(tokenService({}).svc.issue(exchange({ subject_token_type: 'jwt' }), 'r')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a tenant without Sign, or without ATS for the ATS application, gets no token', async () => {
    await expect(tokenService({ caps: ['core', 'ats'] }).svc.issue(exchange(), 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'tenant_not_entitled' } } });
    await expect(tokenService({ caps: ['core', 'sign'] }).svc.issue(exchange(), 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'installation_not_eligible' } } });
  });

  it('a revoked first-party installation stays revoked (no auto re-install)', async () => {
    const { svc, repo } = tokenService({ installation: { id: INST, tenant_id: TENANT, status: 'REVOKED', granted_permissions: ATS.requested_permissions, modes: ['USER'], integration_role: null, role_assertion_enabled: false } });
    await expect(svc.issue(exchange(), 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'installation_revoked' } } });
    expect(repo.createFirstPartyIfAbsent).not.toHaveBeenCalled();
    expect(repo.createToken).not.toHaveBeenCalled();
  });

  it('an ATS user without the ATS signature permission gets no token', async () => {
    await expect(tokenService({ user: { scopes: ['talent:read'] } }).svc.issue(exchange(), 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'no_authority' } } });
  });

  it('an installation-bound credential refuses a user from another tenant', async () => {
    const { svc } = tokenService({
      app: { ...PARTNER, id: 'app-2' },
      cred: { installation_id: INST },
      installation: { id: INST, tenant_id: OTHER_TENANT, status: 'ACTIVE', granted_permissions: PARTNER.requested_permissions, modes: ['USER'], integration_role: null, role_assertion_enabled: false, role_mappings: [] },
      signScopes: [...ESIGN_ROLE_PERMISSIONS.sign_sender],
    });
    await expect(svc.issue(exchange(), 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'invalid_grant' } } });
  });

  it('client_credentials: installation-bound only; the integration identity is the subject; actor recorded for audit', async () => {
    const appOnly = tokenService({ cred: { installation_id: null } });
    await expect(appOnly.svc.issue({ grant_type: GRANT_CLIENT_CREDENTIALS, client_id: 'sgc_abc', client_secret: SECRET }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'unauthorized_client' } } });
    const { svc, repo } = tokenService({
      app: { ...PARTNER, id: 'app-2' },
      cred: { installation_id: INST },
      installation: { id: INST, tenant_id: TENANT, status: 'ACTIVE', granted_permissions: PARTNER.requested_permissions, modes: ['APPLICATION'], integration_role: 'sign_viewer', role_assertion_enabled: false, role_mappings: [] },
    });
    const t = await svc.issue({ grant_type: GRANT_CLIENT_CREDENTIALS, client_id: 'sgc_abc', client_secret: SECRET, external_actor: 'jane@acme.test' }, 'r');
    expect(t).toMatchObject({ mode: 'APPLICATION', tenant_id: TENANT, scope: [S.ENVELOPE_READ, S.ENVELOPE_READ_ALL].sort().join(' ') });
    expect((repo.createToken.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ subject_id: INST, external_actor: 'jane@acme.test', mode: 'APPLICATION' });
  });

  it('an unsupported grant type is refused', async () => {
    await expect(tokenService({}).svc.issue({ grant_type: 'password', client_id: 'sgc_abc', client_secret: SECRET }, 'r')).rejects.toMatchObject({ context: { details: { reason: 'unsupported_grant_type' } } });
  });
});

// ── API guard ─────────────────────────────────────────────────────────────────
function guardWith(row: Record<string, unknown> | null, caps = ['sign']) {
  const repo = { findTokenByHash: vi.fn(async () => row) };
  const entitlements = { getCapabilities: vi.fn(async () => new Set(caps)) };
  return { guard: new SignApiGuard(repo as never, entitlements as never), repo };
}
const RAW = 'sgt_0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
const tokenRow = (over: Record<string, unknown> = {}) => ({
  token_hash: digest(RAW),
  audience: 'aramo-sign-api',
  revoked_at: null,
  expires_at: new Date(Date.now() + 60_000),
  created_at: new Date(),
  tenant_id: TENANT,
  subject_id: USER,
  mode: 'USER',
  scopes: [S.ENVELOPE_READ],
  external_actor: null,
  external_role: null,
  credential: { status: 'ACTIVE', expires_at: null },
  installation: { id: INST, tenant_id: TENANT, status: 'ACTIVE', application: { key: 'aramo-ats', kind: 'FIRST_PARTY', status: 'ACTIVE' } },
  ...over,
});
function ctxFor(authorization: string | undefined) {
  const req: Record<string, unknown> = { requestId: 'r', header: (n: string) => (n === 'authorization' ? authorization : undefined) };
  return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }) } as never };
}

describe('Sign API guard', () => {
  it.each([
    ['no token', undefined, tokenRow(), 'missing_or_malformed_token'],
    ['a session JWT is not an integration token', 'Bearer eyJhbGciOiJSUzI1NiJ9.x.y', tokenRow(), 'missing_or_malformed_token'],
    ['unknown token', `Bearer ${RAW}`, null, 'unknown_token'],
    ['wrong audience', `Bearer ${RAW}`, tokenRow({ audience: 'other' }), 'wrong_audience'],
    ['revoked token', `Bearer ${RAW}`, tokenRow({ revoked_at: new Date() }), 'token_revoked'],
    ['expired token', `Bearer ${RAW}`, tokenRow({ expires_at: new Date(Date.now() - 1) }), 'token_expired'],
    ['revoked credential', `Bearer ${RAW}`, tokenRow({ credential: { status: 'REVOKED', expires_at: null } }), 'credential_revoked'],
    ['revoked installation', `Bearer ${RAW}`, tokenRow({ installation: { id: INST, tenant_id: TENANT, status: 'REVOKED', application: { key: 'x', kind: 'FIRST_PARTY', status: 'ACTIVE' } } }), 'installation_revoked'],
    ['disabled application', `Bearer ${RAW}`, tokenRow({ installation: { id: INST, tenant_id: TENANT, status: 'ACTIVE', application: { key: 'x', kind: 'FIRST_PARTY', status: 'DISABLED' } } }), 'application_disabled'],
  ] as const)('%s → 401', async (_n, header, row, reason) => {
    const { guard } = guardWith(row as never);
    await expect(guard.canActivate(ctxFor(header).ctx)).rejects.toMatchObject({ statusCode: 401, context: { details: { reason } } });
  });

  it('a tenant that lost Sign is refused even with a live token', async () => {
    const { guard } = guardWith(tokenRow(), ['core', 'ats']);
    await expect(guard.canActivate(ctxFor(`Bearer ${RAW}`).ctx)).rejects.toMatchObject({ statusCode: 403, code: 'TENANT_CAPABILITY_NOT_ENTITLED' });
  });

  it('sets the principal from the token record only', async () => {
    const { guard } = guardWith(tokenRow());
    const { req, ctx } = ctxFor(`Bearer ${RAW}`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req['authContext']).toMatchObject({ sub: USER, tenant_id: TENANT, consumer_type: 'sign', actor_kind: 'user', scopes: [S.ENVELOPE_READ] });
    expect(req['signIntegration']).toMatchObject({ application_key: 'aramo-ats', installation_id: INST, mode: 'USER' });
  });
});

// ── API service: installation isolation + ownership ──────────────────────────
const integ = (over: Record<string, unknown> = {}) => ({ application_key: 'aramo-ats', application_kind: 'FIRST_PARTY', installation_id: INST, mode: 'USER' as const, external_actor: null, external_role: null, grant_kind: 'STANDARD' as const, bound_envelope_id: null, ...over });
const apiAuth = (scopes: string[], sub = USER): AuthContextType => ({ sub, consumer_type: 'sign', actor_kind: 'user', tenant_id: TENANT, scopes, iat: 0, exp: 0 });
function apiService(env: Record<string, unknown>) {
  const repo = {
    getEnvelope: vi.fn(async () => ({ id: 'e1', created_by: USER, installation_id: INST, source_application: 'aramo-ats', ...env })),
    createEnvelope: vi.fn(async () => ({ id: 'e9' })),
  };
  const provider = { getEnvelope: vi.fn(async () => ({ envelope_id: 'e1' })), voidEnvelope: vi.fn(async () => ({})), remindEnvelopeSigner: vi.fn(async () => ({})), sendEnvelope: vi.fn(async () => ({})) };
  return { svc: new SignApiService(repo as never, provider as never, {} as never, {} as never, {} as never), repo, provider };
}
const DELEGATED = [...ATS.delegation_profile];

describe('Sign API — an integration acts only on its own application’s envelopes', () => {
  it('another installation’s envelope reads as not found, even with organization read', async () => {
    const { svc } = apiService({ installation_id: '99999999-9999-7999-8999-999999999999', source_application: 'acme-hr' });
    await expect(svc.get(apiAuth(DELEGATED), integ(), 'e1', 'r')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a Sign-app envelope (no installation) is invisible to the ATS integration', async () => {
    const { svc } = apiService({ installation_id: null, source_application: 'aramo-sign' });
    await expect(svc.get(apiAuth(DELEGATED), integ(), 'e1', 'r')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('an ATS envelope created before installations existed is the ATS integration’s', async () => {
    const { svc } = apiService({ installation_id: null, source_application: 'aramo-ats', created_by: OTHER_USER });
    await expect(svc.get(apiAuth(DELEGATED), integ(), 'e1', 'r')).resolves.toEqual({ envelope_id: 'e1' });
  });

  it('without organization read, another user’s envelope reads as not found; without manage-all it cannot be changed', async () => {
    const own = [S.ENVELOPE_READ, S.ENVELOPE_SEND];
    const { svc, provider } = apiService({ created_by: OTHER_USER });
    await expect(svc.get(apiAuth(own), integ(), 'e1', 'r')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.void(apiAuth([...own, S.ENVELOPE_READ_ALL]), integ(), 'e1', 'x', 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'envelope_not_owned' } } });
    expect(provider.voidEnvelope).not.toHaveBeenCalled();
  });

  it('a delegated ATS user may follow up another recruiter’s ATS envelope (the ATS workflow), and the actor is recorded', async () => {
    const { svc, provider } = apiService({ created_by: OTHER_USER });
    await svc.remind(apiAuth(DELEGATED), integ(), 'e1', 'r');
    expect(provider.remindEnvelopeSigner).toHaveBeenCalledWith(TENANT, 'e1', USER);
  });

  it('a third-party application cannot reference Aramo Core documents; sending inline needs the send permission', async () => {
    const { svc, repo } = apiService({});
    const body = { subject: 'NDA', documents: [{ document_ref: 'd', document_revision_ref: 'r', source_sha256: 'x' }], signers: [{ name: 'A', email: 'a@x.test' }] };
    await expect(svc.create(apiAuth([S.ENVELOPE_CREATE, S.ENVELOPE_SEND]), integ({ application_kind: 'THIRD_PARTY', application_key: 'acme-hr' }), body, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'reference_not_allowed' } } });
    await expect(svc.create(apiAuth([S.ENVELOPE_CREATE]), integ(), { ...body, send: true }, 'r')).rejects.toMatchObject({ statusCode: 403 });
    expect(repo.createEnvelope).not.toHaveBeenCalled();
  });
});

// ── Workspace installation administration ────────────────────────────────────
function adminService(kind = 'BUSINESS', app: Record<string, unknown> = { id: 'app-2', key: 'acme-hr', status: 'ACTIVE', kind: 'THIRD_PARTY', ...PARTNER }) {
  const installation = { id: INST, tenant_id: TENANT, application_id: 'app-2', status: 'ACTIVE', application: app, role_mappings: [] };
  const repo = {
    findApplicationByKey: vi.fn(async () => app),
    upsertInstallation: vi.fn(async () => installation),
    getInstallation: vi.fn(async () => installation),
    createCredential: vi.fn(async () => ({ id: 'cred-9', created_at: new Date() })),
    revokeInstallation: vi.fn(async () => true),
    replaceRoleMappings: vi.fn(async () => undefined),
    listActiveApplications: vi.fn(async () => []),
    listInstallations: vi.fn(async () => [{ ...installation, granted_permissions: [], modes: [], integration_role: null, role_assertion_enabled: false, first_party_auto: false, approved_at: new Date(), revoked_at: null, credentials: [] }]),
  };
  const ctx = { tenantKind: vi.fn(async () => kind) };
  return { svc: new IntegrationAdminService(repo as never, ctx as never), repo };
}
const admin = apiAuth(ESIGN_ROLE_PERMISSIONS.sign_admin as string[]);

describe('installation administration (sign:integration:manage)', () => {
  it('a grant must stay within the application’s request and use known Sign permissions', async () => {
    const { svc, repo } = adminService();
    await expect(svc.install(admin, { application_key: 'acme-hr', granted_permissions: [S.MEMBER_MANAGE], modes: ['USER'] }, 'r')).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.install(admin, { application_key: 'acme-hr', granted_permissions: ['talent:read'], modes: ['USER'] }, 'r')).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.install(admin, { application_key: 'acme-hr', granted_permissions: [S.ENVELOPE_READ], modes: ['APPLICATION'] }, 'r')).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.install(admin, { application_key: 'acme-hr', granted_permissions: [S.ENVELOPE_READ], modes: ['APPLICATION'], integration_role: 'sign_owner' }, 'r')).rejects.toMatchObject({ statusCode: 400 });
    expect(repo.upsertInstallation).not.toHaveBeenCalled();
    await svc.install(admin, { application_key: 'acme-hr', granted_permissions: [S.ENVELOPE_READ], modes: ['APPLICATION'], integration_role: 'sign_viewer' }, 'r');
    expect(repo.upsertInstallation).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT, approved_by: USER, granted_permissions: [S.ENVELOPE_READ], first_party_auto: false }));
  });

  it('a third-party client secret is returned once and stored only as its digest', async () => {
    const { svc, repo } = adminService();
    const c = await svc.createCredential(admin, INST, 'r');
    expect(c.client_secret).toMatch(/^sgs_/);
    const stored = (repo.createCredential.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(stored['secret_hash']).toBe(digest(c.client_secret));
    expect(JSON.stringify(stored)).not.toContain(c.client_secret);
  });

  it('Aramo applications use operator-provisioned credentials, not workspace-issued ones', async () => {
    const { svc } = adminService('BUSINESS', { id: 'app-1', status: 'ACTIVE', ...ATS });
    await expect(svc.createCredential(admin, INST, 'r')).rejects.toMatchObject({ statusCode: 400, context: { details: { reason: 'first_party_credentials' } } });
  });

  it('role mappings only for roles the application declares, and only to non-Owner Sign roles', async () => {
    const { svc, repo } = adminService();
    await expect(svc.setRoleMappings(admin, INST, { mappings: [{ external_role: 'ceo', sign_role: 'sign_viewer' }] }, 'r')).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.setRoleMappings(admin, INST, { mappings: [{ external_role: 'hr_manager', sign_role: 'sign_owner' }] }, 'r')).rejects.toMatchObject({ statusCode: 400 });
    await svc.setRoleMappings(admin, INST, { mappings: [{ external_role: 'hr_manager', sign_role: 'sign_sender' }] }, 'r');
    expect(repo.replaceRoleMappings).toHaveBeenCalledWith(INST, [{ external_role: 'hr_manager', sign_role: 'sign_sender' }]);
  });

  it('revoke goes through the cascading revocation; PERSONAL accounts have no integrations', async () => {
    const { svc, repo } = adminService();
    await svc.revoke(admin, INST, 'r');
    expect(repo.revokeInstallation).toHaveBeenCalledWith(TENANT, INST, USER);
    await expect(adminService('PERSONAL').svc.list(admin, 'r')).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('route metadata', () => {
  const api = (n: string): object => (SignApiController.prototype as unknown as Record<string, object>)[n] ?? {};
  it.each([
    ['availability', S.ENVELOPE_READ],
    ['create', S.ENVELOPE_CREATE],
    ['forDocument', S.ENVELOPE_READ],
    ['get', S.ENVELOPE_READ],
    ['evidence', S.ENVELOPE_READ],
    ['executed', S.ENVELOPE_READ],
    ['send', S.ENVELOPE_SEND],
    ['remind', S.ENVELOPE_SEND],
    ['void', S.ENVELOPE_SEND],
  ])('Sign API %s: integration-token guard + %s', (name, scope) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, api(name))).toEqual([SignApiGuard, RolesGuard]);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, api(name))).toEqual([scope]);
  });

  it('every installation administration route requires sign:integration:manage', () => {
    const names = Object.getOwnPropertyNames(IntegrationAdminController.prototype).filter((n) => n !== 'constructor' && n !== 'run');
    expect(names.length).toBe(12); // S-4 installation administration (7) + S-5 webhook subscriptions (5)
    for (const n of names) {
      expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, (IntegrationAdminController.prototype as unknown as Record<string, object>)[n] ?? {})).toEqual([S.INTEGRATION_MANAGE]);
    }
  });
});

// ── Addendum S6 ruling 1 — the event-bound executed-artifact read grant ──────

describe('event-bound executed-artifact grant (Addendum S6)', () => {
  const EVENT_ID = '66666666-6666-7666-8666-666666666666';
  const ENVELOPE = '77777777-7777-7777-8777-777777777777';
  function eventService(opts: {
    cred?: Record<string, unknown> | null;
    deliveries?: Record<string, unknown>[];
    envelope?: Record<string, unknown> | 'missing';
    installation?: Record<string, unknown> | null;
    caps?: string[];
  } = {}) {
    const app = { id: 'app-1', ...ATS };
    const cred = opts.cred === null ? null : { id: 'cred-1', client_id: 'sgc_ats', application_id: 'app-1', installation_id: null, status: 'ACTIVE', expires_at: null, secret_hash: digest(SECRET), application: app, ...opts.cred };
    const repo = {
      findCredentialByClientId: vi.fn(async () => cred),
      findInstallation: vi.fn(async () => (opts.installation === undefined ? { id: INST, tenant_id: TENANT, status: 'ACTIVE' } : opts.installation)),
      createToken: vi.fn(async () => ({})),
      touchCredential: vi.fn(async () => undefined),
    };
    const webhooks = {
      deliveriesOfEventForApplication: vi.fn(async () =>
        opts.deliveries ?? [{ event_id: EVENT_ID, tenant_id: TENANT, envelope_id: ENVELOPE, event_type: 'sign.envelope.executed.v1', subscription: { installation_id: null, application_id: 'app-1' } }],
      ),
    };
    const envelopes = {
      getEnvelope: vi.fn(async () => {
        if (opts.envelope === 'missing') throw new EnvelopeNotFoundError(ENVELOPE);
        return { id: ENVELOPE, status: 'COMPLETED', source_application: 'aramo-ats', installation_id: INST, ...opts.envelope };
      }),
    };
    const entitlements = { getCapabilities: vi.fn(async () => new Set(opts.caps ?? ['ats', 'sign'])) };
    const svc = new SignTokenService(repo as never, { verifyAccessToken: vi.fn() } as never, entitlements as never, webhooks as never, envelopes as never);
    return { svc, repo, webhooks };
  }
  const req = (over: Record<string, unknown> = {}) => ({ grant_type: GRANT_SIGN_EVENT, client_id: 'sgc_ats', client_secret: SECRET, event_id: EVENT_ID, ...over });

  it('GREEN: issues a 5-minute, read-only grant bound to the event’s envelope, scoped from Sign’s records', async () => {
    const { svc, repo, webhooks } = eventService();
    const t = await svc.issue(req(), 'r');
    expect(t).toMatchObject({ mode: 'APPLICATION', tenant_id: TENANT, installation_id: INST, envelope_id: ENVELOPE, scope: 'sign:envelope:read', expires_in: 300 });
    expect(webhooks.deliveriesOfEventForApplication).toHaveBeenCalledWith(EVENT_ID, 'app-1');
    expect((repo.createToken.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ grant_kind: 'EVENT_ARTIFACT', envelope_id: ENVELOPE, event_id: EVENT_ID, subject_id: INST, scopes: ['sign:envelope:read'] });
  });

  it('the event id alone is never enough: no or wrong client credential → 401 invalid_client', async () => {
    await expect(eventService({ cred: null }).svc.issue(req(), 'r')).rejects.toMatchObject({ statusCode: 401 });
    await expect(eventService().svc.issue(req({ client_secret: 'sgs_wrong' }), 'r')).rejects.toMatchObject({ statusCode: 401 });
  });

  it.each([
    ['a forged / unknown event id', { deliveries: [] }],
    ['an event delivered to another installation (installation-bound credential)', { cred: { installation_id: 'other-inst' } }],
    ['a non-completion event', { deliveries: [{ event_id: EVENT_ID, tenant_id: TENANT, envelope_id: ENVELOPE, event_type: 'sign.envelope.sent.v1', subscription: { installation_id: null } }] }],
    ['an envelope not completed', { envelope: { status: 'IN_PROGRESS' } }],
    ['an envelope of another application', { envelope: { source_application: 'acme-hr' } }],
    ['a revoked installation', { installation: { id: INST, tenant_id: TENANT, status: 'REVOKED' } }],
    ['an envelope of another installation', { envelope: { installation_id: 'other-inst' } }],
    ['a missing envelope', { envelope: 'missing' as const }],
  ])('%s → 403 event_not_available (one answer)', async (_n, opts) => {
    const { svc, repo } = eventService(opts as never);
    await expect(svc.issue(req(), 'r')).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'event_not_available' } } });
    expect(repo.createToken).not.toHaveBeenCalled();
  });

  it('a malformed event id is refused before any lookup', async () => {
    const { svc, webhooks } = eventService();
    await expect(svc.issue(req({ event_id: 'x' }), 'r')).rejects.toMatchObject({ statusCode: 400 });
    expect(webhooks.deliveriesOfEventForApplication).not.toHaveBeenCalled();
  });

  it('repeat requests (webhook retries) each get a fresh grant — idempotent recovery', async () => {
    const { svc, repo } = eventService();
    await svc.issue(req(), 'r');
    await svc.issue(req(), 'r');
    expect(repo.createToken).toHaveBeenCalledTimes(2);
  });

  it('the grant reads ONLY its envelope’s executed documents and evidence', async () => {
    const restricted = integ({ grant_kind: 'EVENT_ARTIFACT', bound_envelope_id: 'e1', mode: 'APPLICATION' });
    const { svc, provider } = apiService({ id: 'e1' });
    (provider as unknown as Record<string, unknown>)['getExecutedArtifacts'] = vi.fn(async () => ({ envelope_id: 'e1', documents: [] }));
    (provider as unknown as Record<string, unknown>)['getEvidence'] = vi.fn(async () => ({ envelope_id: 'e1' }));
    const a = apiAuth(['sign:envelope:read'], INST);
    await expect(svc.executed(a, restricted, 'e1', 'r')).resolves.toMatchObject({ envelope_id: 'e1' });
    await expect(svc.evidence(a, restricted, 'e1', 'r')).resolves.toMatchObject({ envelope_id: 'e1' });
    await expect(svc.executed(a, restricted, 'e2', 'r')).rejects.toMatchObject({ statusCode: 404 });
    for (const call of [() => svc.get(a, restricted, 'e1', 'r'), () => svc.forDocument(a, restricted, 'd', 'v', 'r'), () => svc.availability(a, restricted, 'r'), () => svc.create(a, restricted, {}, 'r'), () => svc.void(a, restricted, 'e1', 'x', 'r')]) {
      await expect(call()).rejects.toMatchObject({ statusCode: 403, context: { details: { reason: 'grant_restricted' } } });
    }
  });
});
