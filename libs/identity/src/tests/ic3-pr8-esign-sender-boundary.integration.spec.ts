import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { Controller, HttpCode, HttpStatus, Post, type INestApplication } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { SignJWT, exportSPKI, generateKeyPair, type CryptoKey, type KeyObject } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EFFECTIVE_AUTHORIZATION_RESOLVER, PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { ARAMO_POSTGRES_TEST_IMAGE, AramoExceptionFilter, resolveIdentityMigrations } from '@aramo/common';
import { EntitlementRepository } from '@aramo/entitlement';

import { AuthorizationVersionService } from '../lib/authorization-version.service.js';
import { EsignSenderBoundary } from '../lib/authorization/esign-sender-boundary.js';
import { ORG_ADMIN_SCOPE_KEYS } from '../lib/dto/role.dto.js';
import { IdentityEffectiveAuthorizationResolver } from '../lib/authorization/identity-effective-authorization-resolver.js';
import { InMemoryScopeCache } from '../lib/authorization/in-memory-scope-cache.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleRepository } from '../lib/role.repository.js';
import { RoleService } from '../lib/role.service.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';
import { runIdentitySeed, SEED_IDS } from '../../prisma/seed.js';

// IC-3 PR-8 — the Sign SENDER authorization boundary, proven END-TO-END over
// HTTP against real Postgres 17 with the REAL guard chain (JwtAuthGuard →
// EsignSenderConsumerGuard → EntitlementGuard → RolesGuard), the REAL effective
// authorization resolver (seeded roles/scopes, authz_version, scope cache) and
// RS256 tokens minted the way auth-service mints them. The ONLY substitution is
// the entitlement STORE (an in-memory map standing in for the entitlement
// schema), because the thing under test is what the boundary does with a live
// capability read — including flipping it between requests.
//
// The route is a TEST-ONLY probe mounting `@EsignSenderBoundary()` — the exact
// decorator the future `v1/sign/sender/*` controller on sign-service mounts
// (PX-V1 §8 D-2; the surface itself is an activation dependency PR-8 does not
// build). Directive §8 cases #1–#10 are the `it` titles.

const MIGRATION_PATHS = resolveIdentityMigrations(resolve(__dirname, '../../../..'));
const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-ic3-pr8-esign-sender-boundary-spec';
const ALG = 'RS256';
type SignKey = CryptoKey | KeyObject;

const SIGN_ONLY_TENANT = SEED_IDS.tenant; // [core, esign] — no ats
const ATS_ONLY_TENANT = '01900000-0000-7000-8000-00000000a8a1'; // [core, ats, portal]
const BOTH_TENANT = '01900000-0000-7000-8000-00000000a8a2'; // [core, ats, portal, esign]

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

@Controller('v1/sign/sender-boundary-probe')
class SenderBoundaryProbeController {
  @Post('send')
  @HttpCode(HttpStatus.OK)
  @EsignSenderBoundary()
  send(): { sent: true } {
    return { sent: true };
  }
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('IC-3 PR-8 — Sign sender boundary over HTTP (real guards + real resolver + real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let app: INestApplication;
  let port = 0;
  let key: SignKey;
  let versions: AuthorizationVersionService;
  let resolver: IdentityEffectiveAuthorizationResolver;
  let identityRepo: IdentityRepository;
  const savedEnv: Record<string, string | undefined> = {};

  // The entitlement STORE the boundary reads live (EntitlementGuard + resolver).
  const caps = new Map<string, Set<string>>([
    [SIGN_ONLY_TENANT, new Set(['core', 'sign'])],
    [ATS_ONLY_TENANT, new Set(['core', 'ats', 'portal'])],
    [BOTH_TENANT, new Set(['core', 'ats', 'portal', 'sign'])],
  ]);
  const store = { getCapabilities: async (tenantId: string) => new Set<string>(caps.get(tenantId) ?? []) };

  let seq = 0xf100;
  const nextId = (): string => `01900000-0000-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;

  async function userWithRoles(label: string, tenantId: string, roleIds: readonly string[]): Promise<{ userId: string; membershipId: string }> {
    const userId = nextId();
    const membershipId = nextId();
    await prisma.user.create({ data: { id: userId, email: `pr8-${label}@aramo.dev`, display_name: `pr8 ${label}`, is_active: true, tenant_id: tenantId } });
    await prisma.userTenantMembership.create({ data: { id: membershipId, user_id: userId, tenant_id: tenantId, is_active: true } });
    for (const roleId of roleIds) {
      await prisma.userTenantMembershipRole.create({ data: { id: nextId(), membership_id: membershipId, role_id: roleId } });
    }
    await versions.ensureBaseline(prisma, { tenant_id: tenantId, principal_id: userId });
    return { userId, membershipId };
  }

  async function token(args: { sub: string; tenant: string; consumer: string; version?: number }): Promise<string> {
    const authz_version = args.version ?? (await versions.getCurrentVersion({ tenant_id: args.tenant, principal_id: args.sub }));
    return new SignJWT({ sub: args.sub, consumer_type: args.consumer, actor_kind: 'user', tenant_id: args.tenant, authz_version })
      .setProtectedHeader({ alg: ALG }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime('1h').sign(key);
  }

  async function send(bearer: string): Promise<{ status: number; body: { sent?: true; error?: { code: string; details?: Record<string, unknown> } } }> {
    const res = await fetch(`http://127.0.0.1:${port}/v1/sign/sender-boundary-probe/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: '{}',
    });
    return { status: res.status, body: (await res.json()) as never };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    const setup = new PrismaService(url);
    await setup.$connect();
    for (const p of MIGRATION_PATHS) {
      for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
        const t = stmt.trim();
        if (t.length > 0) await setup.$executeRawUnsafe(t);
      }
    }
    await setup.$disconnect();
    prisma = new PrismaService(url);
    await prisma.$connect();
    await runIdentitySeed(prisma);
    await prisma.tenant.create({ data: { id: ATS_ONLY_TENANT, name: 'PR-8 ATS-only tenant' } });
    await prisma.tenant.create({ data: { id: BOTH_TENANT, name: 'PR-8 ATS + Sign tenant' } });

    versions = new AuthorizationVersionService(prisma);
    identityRepo = new IdentityRepository(prisma);
    resolver = new IdentityEffectiveAuthorizationResolver(
      new RoleService(new RoleRepository(prisma)),
      versions,
      new InMemoryScopeCache(),
      { portalScopes: [], scopeCacheTtlSeconds: 300 },
      store as unknown as TenantEntitlementReader,
    );

    const kp = await generateKeyPair(ALG);
    key = kp.privateKey;
    const publicPem = await exportSPKI(kp.publicKey as never);
    for (const k of ['AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY']) savedEnv[k] = process.env[k];
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
    process.env['AUTH_PUBLIC_KEY'] = publicPem;

    const moduleRef = await Test.createTestingModule({
      controllers: [SenderBoundaryProbeController],
      providers: [
        { provide: EFFECTIVE_AUTHORIZATION_RESOLVER, useValue: resolver },
        { provide: EntitlementRepository, useValue: store },
        // The PRODUCTION exception filter, so error BODIES carry the real contract
        // shape ({ error: { code, details } }) and not Nest's default envelope.
        { provide: APP_FILTER, useClass: AramoExceptionFilter },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
    await container?.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('#1 Sign-only tenant ([core, esign], no ats) + sign_sender + esign consumer → 200 (eligible); sign_owner and sign_admin likewise', async () => {
    for (const [label, roleId] of [['sender', SEED_IDS.roles.sign_sender], ['owner', SEED_IDS.roles.sign_owner], ['admin', SEED_IDS.roles.sign_admin]] as const) {
      const { userId } = await userWithRoles(`so-${label}`, SIGN_ONLY_TENANT, [roleId]);
      const res = await send(await token({ sub: userId, tenant: SIGN_ONLY_TENANT, consumer: 'sign' }));
      expect(res, label).toEqual({ status: 200, body: { sent: true } });
    }
  });

  it('#2 Sign-only tenant WITHOUT a sender role (sign_viewer) → 403 INSUFFICIENT_PERMISSIONS, missing sign:envelope:send', async () => {
    const { userId } = await userWithRoles('so-viewer', SIGN_ONLY_TENANT, [SEED_IDS.roles.sign_viewer]);
    const res = await send(await token({ sub: userId, tenant: SIGN_ONLY_TENANT, consumer: 'sign' }));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', details: { missing_scopes: ['sign:envelope:send'] } });
  });

  it('#3 org_admin ALONE (the Sign-only owner role) does not send → 403 INSUFFICIENT_PERMISSIONS; org_admin + sign_sender → 200', async () => {
    const alone = await userWithRoles('so-orgadmin', SIGN_ONLY_TENANT, [SEED_IDS.roles.org_admin]);
    const r1 = await send(await token({ sub: alone.userId, tenant: SIGN_ONLY_TENANT, consumer: 'sign' }));
    expect(r1.status).toBe(403);
    expect(r1.body.error).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', details: { missing_scopes: ['sign:envelope:send'] } });
    const both = await userWithRoles('so-orgadmin-sender', SIGN_ONLY_TENANT, [SEED_IDS.roles.org_admin, SEED_IDS.roles.sign_sender]);
    expect((await send(await token({ sub: both.userId, tenant: SIGN_ONLY_TENANT, consumer: 'sign' }))).status).toBe(200);
  });

  it('#4 ATS-only tenant → 403 TENANT_CAPABILITY_NOT_ENTITLED (missing esign) even for a principal holding sign_sender', async () => {
    const { userId } = await userWithRoles('ats-sender', ATS_ONLY_TENANT, [SEED_IDS.roles.sign_sender]);
    const res = await send(await token({ sub: userId, tenant: ATS_ONLY_TENANT, consumer: 'sign' }));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'TENANT_CAPABILITY_NOT_ENTITLED', details: { tenant_id: ATS_ONLY_TENANT, missing_capabilities: ['sign'] } });
  });

  it('#5 ATS recruiter never sends: a recruiter-role principal → 403; and a recruiter-CONSUMER token of a principal who ALSO holds sign_sender → 403 consumer_not_esign (PR-6 filter + layer 2)', async () => {
    const recruiter = await userWithRoles('both-recruiter', BOTH_TENANT, [SEED_IDS.roles.recruiter]);
    const r1 = await send(await token({ sub: recruiter.userId, tenant: BOTH_TENANT, consumer: 'sign' }));
    expect(r1.status).toBe(403);
    expect(r1.body.error).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', details: { missing_scopes: ['sign:envelope:send'] } });

    const dual = await userWithRoles('both-dual', BOTH_TENANT, [SEED_IDS.roles.recruiter, SEED_IDS.roles.sign_sender]);
    const r2 = await send(await token({ sub: dual.userId, tenant: BOTH_TENANT, consumer: 'recruiter' }));
    expect(r2.status).toBe(403);
    expect(r2.body.error).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', details: { reason: 'consumer_not_esign', consumer_type: 'recruiter' } });
  });

  it('#6 multi-product tenant, ONE identity: the esign consumer carries Sign scopes only (→ 200), the recruiter consumer carries ATS scopes only — disjoint namespaces', async () => {
    const { userId } = await userWithRoles('both-split', BOTH_TENANT, [SEED_IDS.roles.recruiter, SEED_IDS.roles.sign_sender]);
    expect((await send(await token({ sub: userId, tenant: BOTH_TENANT, consumer: 'sign' }))).status).toBe(200);
    const v = await versions.getCurrentVersion({ tenant_id: BOTH_TENANT, principal_id: userId });
    const base = { tenant_id: BOTH_TENANT, principal_id: userId, actor_kind: 'user' as const, token_authz_version: v };
    const esign = await resolver.resolve({ ...base, consumer_type: 'sign' });
    const recruiter = await resolver.resolve({ ...base, consumer_type: 'recruiter' });
    expect(esign.status).toBe('ok');
    expect(recruiter.status).toBe('ok');
    if (esign.status === 'ok' && recruiter.status === 'ok') {
      // esign consumer: the three Sign scopes + ONLY the product-neutral
      // organization subset (IC-3 PR-7 rule) — never an ATS product scope.
      expect(esign.scopes.filter((s) => s.startsWith('sign:')).sort()).toEqual(['sign:contact:read', 'sign:envelope:create', 'sign:envelope:read', 'sign:envelope:send', 'sign:template:use']);
      expect(esign.scopes.every((s) => s.startsWith('sign:') || (ORG_ADMIN_SCOPE_KEYS as readonly string[]).includes(s))).toBe(true);
      expect(esign.scopes).not.toContain('talent:read');
      // recruiter consumer: the ATS scopes, never a Sign scope.
      expect(recruiter.scopes.some((s) => s.startsWith('sign:'))).toBe(false);
      expect(recruiter.scopes).toContain('talent:read');
    }
  });

  it('#7 revoked Sign entitlement → 403 TENANT_CAPABILITY_NOT_ENTITLED on the very next request (live read, no cache); re-granted → 200', async () => {
    const { userId } = await userWithRoles('so-revoke-ent', SIGN_ONLY_TENANT, [SEED_IDS.roles.sign_sender]);
    const bearer = await token({ sub: userId, tenant: SIGN_ONLY_TENANT, consumer: 'sign' });
    expect((await send(bearer)).status).toBe(200);
    const signOnlyCaps = caps.get(SIGN_ONLY_TENANT) ?? new Set<string>();
    signOnlyCaps.delete('sign');
    try {
      const denied = await send(bearer);
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatchObject({ code: 'TENANT_CAPABILITY_NOT_ENTITLED', details: { missing_capabilities: ['sign'] } });
    } finally {
      signOnlyCaps.add('sign');
    }
    expect((await send(bearer)).status).toBe(200);
  });

  it('#8 sender-role revocation cannot be bypassed by the scope cache or by a refreshed token: the old token is STALE (401) and a token at the new version lacks the scope (403)', async () => {
    const { userId, membershipId } = await userWithRoles('so-revoke-role', SIGN_ONLY_TENANT, [SEED_IDS.roles.sign_sender]);
    const before = await versions.getCurrentVersion({ tenant_id: SIGN_ONLY_TENANT, principal_id: userId });
    const oldToken = await token({ sub: userId, tenant: SIGN_ONLY_TENANT, consumer: 'sign', version: before });
    // Warm the scope cache with the authorized snapshot.
    expect((await send(oldToken)).status).toBe(200);
    // Revoke: sign_sender → sign_viewer through the SAME primitive the PATCH
    // roles route uses; the version bump is in the same transaction.
    await identityRepo.replaceMembershipRoles({ membership_id: membershipId, role_ids: [SEED_IDS.roles.sign_viewer] });
    const after = await versions.getCurrentVersion({ tenant_id: SIGN_ONLY_TENANT, principal_id: userId });
    expect(after).toBe(before + 1);
    // The cached snapshot is keyed by the OLD version: the old token is refused outright.
    const stale = await send(oldToken);
    expect(stale.status).toBe(401);
    // A token minted at the new version (what a refresh would carry) resolves the
    // NEW role set: the send scope is gone.
    const refreshed = await send(await token({ sub: userId, tenant: SIGN_ONLY_TENANT, consumer: 'sign', version: after }));
    expect(refreshed.status).toBe(403);
    expect(refreshed.body.error).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', details: { missing_scopes: ['sign:envelope:send'] } });
  });

  it('#9 foreign-tenant sender access is denied: a Sign-only sender presenting a token bound to ANOTHER (esign-entitled) tenant resolves no scopes there → 403', async () => {
    const { userId } = await userWithRoles('so-foreign', SIGN_ONLY_TENANT, [SEED_IDS.roles.sign_sender]);
    const res = await send(await token({ sub: userId, tenant: BOTH_TENANT, consumer: 'sign' }));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', details: { missing_scopes: ['sign:envelope:send'] } });
  });

  it('#10 platform super_admin is never a tenant sender: a platform token is refused on the sender boundary (403), and the platform:* namespace never satisfies the send scope', async () => {
    const admin = await userWithRoles('platform-admin', PLATFORM_TENANT_SENTINEL_ID, [SEED_IDS.roles.super_admin]);
    const r1 = await send(await token({ sub: admin.userId, tenant: PLATFORM_TENANT_SENTINEL_ID, consumer: 'platform' }));
    expect(r1.status).toBe(403);
    expect(r1.body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
    // Even an `sign` credential for the same principal against a Sign tenant it
    // has no membership in resolves nothing.
    const r2 = await send(await token({ sub: admin.userId, tenant: SIGN_ONLY_TENANT, consumer: 'sign' }));
    expect(r2.status).toBe(403);
  });

  it('negative control: no bearer → 401 AUTH_REQUIRED; the probe never answers without the full chain', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/sign/sender-boundary-probe/send`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
