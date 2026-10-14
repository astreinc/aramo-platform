import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, createAramoLogger, resolveIdentityMigrations } from '@aramo/common';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';

import { IdentityAuditRepository } from '../lib/audit/identity-audit.repository.js';
import { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { AuthorizationVersionService } from '../lib/authorization-version.service.js';
import { IdentityEffectiveAuthorizationResolver } from '../lib/authorization/identity-effective-authorization-resolver.js';
import { InMemoryScopeCache } from '../lib/authorization/in-memory-scope-cache.js';
import { ESIGN_SENDER_SCOPE_KEY, ORG_ADMIN_SCOPE_KEYS } from '../lib/dto/role.dto.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleRepository } from '../lib/role.repository.js';
import { RoleService } from '../lib/role.service.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';
import { TenantRepository } from '../lib/tenant.repository.js';
import { TenantService } from '../lib/tenant.service.js';
import { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';
import { runIdentitySeed, SEED_IDS } from '../../prisma/seed.js';

// IC-4 PR-9 — PERSONAL tenancy on the REAL identity spine (Postgres 17, the
// full identity migration set incl. 20261017000000_ic4_tenant_kind, the seed,
// the real TenantService / IdentityService / effective resolver) PLUS the
// Talent Portal namespace (portal_identity migration applied alongside):
//   §6 #1  personal Tenant → one owning User + one membership + authz baseline
//   §6 #2  the personal User cannot acquire a second (business) membership — DB
//   §6 #3  a registered email cannot create a second identity — DB unique
//   §6 #4  no ATS authorization without the ats entitlement (resolver)
//   §6 #6  Sign sender authority is a SEPARATE, governed grant (resolver)
//   §6 #10 personal registration: allowed_domain NULL, personal-provider allowed
//   §6 #11 PortalUser with the SAME email coexists in its own namespace, unlinked
//   §6 #12 the portal credential's authorization is the fixed portal set —
//          roles held by a same-email tenant User never widen it
//   kind column default: every pre-existing/seeded row is BUSINESS

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION_PATHS = resolveIdentityMigrations(ROOT);
const PORTAL_MIGRATION = resolve(ROOT, 'libs/portal-identity/prisma/migrations/20260714120000_init_portal_identity/migration.sql');

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('IC-4 PR-9 — PERSONAL tenancy + Talent Portal boundary (real Postgres 17)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let tenantSvc: TenantService;
  let identitySvc: IdentityService;
  let identityRepo: IdentityRepository;
  let versions: AuthorizationVersionService;
  let roleSvc: RoleService;
  const caps = new Map<string, Set<string>>();
  const entitlements = { getCapabilities: async (t: string) => new Set<string>(caps.get(t) ?? []) } as unknown as TenantEntitlementReader;

  let seq = 0xf200;
  const nextId = (): string => `01900000-0000-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;
  const ACTOR = SEED_IDS.tenant; // any uuid; audit actor_id is not an FK
  const PERSONAL_EMAIL = 'jane.doe@gmail.com';

  let personalTenantId = '';
  let personalUserId = '';
  let personalMembershipId = '';

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    const url = container.getConnectionUri();
    const setup = new PrismaService(url);
    await setup.$connect();
    for (const p of [...MIGRATION_PATHS, PORTAL_MIGRATION]) {
      for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
        const t = stmt.trim();
        if (t.length > 0) await setup.$executeRawUnsafe(t);
      }
    }
    await setup.$disconnect();
    prisma = new PrismaService(url);
    await prisma.$connect();
    await runIdentitySeed(prisma);
    const audit = new IdentityAuditService(new IdentityAuditRepository(prisma), createAramoLogger('ic4-pr9-spec'));
    tenantSvc = new TenantService(new TenantRepository(prisma), audit);
    identityRepo = new IdentityRepository(prisma);
    identitySvc = new IdentityService(identityRepo, audit, new RoleBundleValidator(prisma), entitlements);
    versions = new AuthorizationVersionService(prisma);
    roleSvc = new RoleService(new RoleRepository(prisma));
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  it('kind column: every seeded tenant (Astre, the platform sentinel) is BUSINESS by default', async () => {
    const rows = await prisma.tenant.findMany({ select: { id: true, kind: true } });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const r of rows) expect(r.kind, r.id).toBe('BUSINESS');
    expect(rows.some((r) => r.id === PLATFORM_TENANT_SENTINEL_ID)).toBe(true);
  });

  it('#1 / #10 — provisionTenant(kind PERSONAL, personal-provider owner) → tenant PERSONAL, allowed_domain NULL, PROVISIONED; birth event carries kind; BUSINESS with the same address is refused', async () => {
    await expect(tenantSvc.provisionTenant({ name: 'Jane Doe (business)', owner_email: PERSONAL_EMAIL, actor_user_id: ACTOR }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'personal_email_not_allowed' } } });
    const tenant = await tenantSvc.provisionTenant({ name: 'Jane Doe', owner_email: PERSONAL_EMAIL, actor_user_id: ACTOR, kind: 'PERSONAL' });
    personalTenantId = tenant.id;
    expect(tenant.kind).toBe('PERSONAL');
    expect(tenant.status).toBe('PROVISIONED');
    const row = await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
    expect(row.kind).toBe('PERSONAL');
    expect(row.allowed_domain).toBeNull();
    expect(row.slug).toBeNull();
    expect(row.domain_verification_status).toBe('UNVERIFIED');
    const birth = await prisma.identityAuditEvent.findFirst({ where: { event_type: 'identity.tenant.created', tenant_id: tenant.id } });
    expect(birth?.event_payload).toMatchObject({ kind: 'PERSONAL', allowed_domain: null, source: 'platform.provision' });
    caps.set(personalTenantId, new Set(['core', 'esign']));
  });

  it('#1 — the owner is an ordinary tenant-owned User: one membership, org_admin only, authz baseline; NO ATS role', async () => {
    const created = await identitySvc.createUserFromInvitation({
      email: PERSONAL_EMAIL, display_name: 'Jane Doe', provider: 'cognito', provider_subject: 'cog-jane-1',
      tenant_id: personalTenantId, role_keys: ['org_admin'], role_ids: [SEED_IDS.roles.org_admin], actor_user_id: ACTOR, request_id: 'rq-pr9-1',
    });
    personalUserId = created.user.id;
    personalMembershipId = created.membership_id;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: personalUserId } });
    expect(user.tenant_id).toBe(personalTenantId);
    const memberships = await prisma.userTenantMembership.findMany({ where: { user_id: personalUserId } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.tenant_id).toBe(personalTenantId);
    expect(await identitySvc.findRoleKeysForMembership(personalMembershipId)).toEqual(['org_admin']);
    expect(await versions.getCurrentVersion({ tenant_id: personalTenantId, principal_id: personalUserId })).toBeGreaterThanOrEqual(1);
  });

  it('#2 — the personal User cannot acquire a membership in a business tenant (DB cardinality: UNIQUE(user_id) + composite owner FK)', async () => {
    const business = await tenantSvc.provisionTenant({ name: 'Acme Business', owner_email: 'owner@acme-business.corp', actor_user_id: ACTOR });
    expect(business.kind).toBe('BUSINESS');
    await expect(
      prisma.userTenantMembership.create({ data: { id: nextId(), user_id: personalUserId, tenant_id: business.id, is_active: true } }),
    ).rejects.toThrow(/UserTenantMembership_user_id_key|UserTenantMembership_user_id_tenant_id_fkey|Unique constraint|Foreign key constraint/);
    expect(await prisma.userTenantMembership.count({ where: { user_id: personalUserId } })).toBe(1);
  });

  it('#3 — the registered personal email cannot create a second tenant identity: service guard (409 EMAIL_UNAVAILABLE, details {}) and the DB unique', async () => {
    const other = await tenantSvc.provisionTenant({ name: 'Other Corp', owner_email: 'owner@other-corp.example', actor_user_id: ACTOR });
    await expect(identitySvc.createUserFromInvitation({
      email: PERSONAL_EMAIL.toUpperCase(), display_name: null, provider: 'cognito', provider_subject: 'cog-jane-2',
      tenant_id: other.id, role_keys: ['recruiter'], role_ids: [SEED_IDS.roles.recruiter], actor_user_id: ACTOR, request_id: 'rq-pr9-3',
    })).rejects.toMatchObject({ code: 'EMAIL_UNAVAILABLE', statusCode: 409, context: { details: {} } });
    await expect(prisma.user.create({ data: { id: nextId(), email: PERSONAL_EMAIL, tenant_id: other.id } })).rejects.toThrow(/Unique constraint|User_email_key/);
    expect(await prisma.user.count({ where: { email: PERSONAL_EMAIL } })).toBe(1);
  });

  it('#4 / #6 — authorization: esign consumer carries the organization subset only (no send scope) until esign_owner is granted through the governed path; recruiter consumer carries NO esign scope; ATS scopes need the ats entitlement the tenant does not hold', async () => {
    const resolver = new IdentityEffectiveAuthorizationResolver(roleSvc, versions, new InMemoryScopeCache(), { portalScopes: ['portal:profile:read'], scopeCacheTtlSeconds: 300 }, entitlements);
    const v = () => versions.getCurrentVersion({ tenant_id: personalTenantId, principal_id: personalUserId });
    const input = async (consumer_type: 'esign' | 'recruiter') => ({ tenant_id: personalTenantId, principal_id: personalUserId, consumer_type, actor_kind: 'user' as const, token_authz_version: await v() });
    const before = await resolver.resolve(await input('esign'));
    expect(before.status).toBe('ok');
    if (before.status === 'ok') {
      expect([...before.scopes].sort()).toEqual([...ORG_ADMIN_SCOPE_KEYS].sort());
      expect(before.scopes).not.toContain(ESIGN_SENDER_SCOPE_KEY);
    }
    // The governed grant (IC-3 PR-8): the org_admin owner assigns esign_owner in
    // its own esign-entitled tenant — the SAME primitive PATCH roles uses.
    await identitySvc.replaceMembershipRoles({
      membership_id: personalMembershipId, tenant_id: personalTenantId,
      role_keys: ['org_admin', 'esign_owner'], role_ids: [SEED_IDS.roles.org_admin, SEED_IDS.roles.esign_owner], request_id: 'rq-pr9-6',
    });
    const after = await resolver.resolve(await input('esign'));
    expect(after.status).toBe('ok');
    if (after.status === 'ok') expect(after.scopes).toContain(ESIGN_SENDER_SCOPE_KEY);
    const recruiter = await resolver.resolve(await input('recruiter'));
    expect(recruiter.status).toBe('ok');
    if (recruiter.status === 'ok') {
      expect(recruiter.scopes.some((s) => s.startsWith('esign:'))).toBe(false);
      expect(recruiter.scopes).not.toContain('talent:read');
    }
    // An ATS-only tenant could not grant the Sign role at all (PR-8 assignability).
    caps.set(personalTenantId, new Set(['core']));
    await expect(identitySvc.replaceMembershipRoles({
      membership_id: personalMembershipId, tenant_id: personalTenantId,
      role_keys: ['org_admin', 'esign_sender'], role_ids: [SEED_IDS.roles.org_admin, SEED_IDS.roles.esign_sender], request_id: 'rq-pr9-6b',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'esign_role_not_entitled' } } });
    caps.set(personalTenantId, new Set(['core', 'esign']));
  });

  it('#11 — a Talent Portal identity with the SAME normalized email coexists in portal_identity: separate row, no tenant, no User pointer, no FK', async () => {
    const portalId = nextId();
    await prisma.$executeRawUnsafe(
      `INSERT INTO portal_identity."PortalUser" (id, email_normalized, created_at, updated_at) VALUES ('${portalId}', '${PERSONAL_EMAIL}', now(), now())`,
    );
    const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM portal_identity."PortalUser" WHERE id = '${portalId}'`);
    expect(rows).toHaveLength(1);
    const columns = Object.keys(rows[0] ?? {});
    expect(columns).toContain('email_normalized');
    expect(columns).not.toContain('tenant_id');
    expect(columns).not.toContain('user_id');
    // Neither row knows about the other: the identity User still has exactly one
    // membership and no portal column; deleting the portal row touches nothing in identity.
    await prisma.$executeRawUnsafe(`DELETE FROM portal_identity."PortalUser" WHERE id = '${portalId}'`);
    expect(await prisma.user.count({ where: { email: PERSONAL_EMAIL } })).toBe(1);
    expect(await prisma.userTenantMembership.count({ where: { user_id: personalUserId } })).toBe(1);
    const fks = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM information_schema.table_constraints WHERE table_schema = 'portal_identity' AND constraint_type = 'FOREIGN KEY'`,
    );
    expect(Number(fks[0]?.count ?? -1)).toBe(0);
  });

  it('#12 — the portal credential resolves EXACTLY the fixed portal set: the roles the same-email tenant User holds (org_admin + esign_owner) never widen it', async () => {
    const resolver = new IdentityEffectiveAuthorizationResolver(roleSvc, versions, new InMemoryScopeCache(), { portalScopes: ['portal:profile:read'], scopeCacheTtlSeconds: 300 }, entitlements);
    const portal = await resolver.resolve({ tenant_id: PLATFORM_TENANT_SENTINEL_ID, principal_id: personalUserId, consumer_type: 'portal', actor_kind: 'user', token_authz_version: 1 });
    expect(portal).toEqual({ status: 'ok', scopes: ['portal:profile:read'] });
    const portalInPersonalTenant = await resolver.resolve({ tenant_id: personalTenantId, principal_id: personalUserId, consumer_type: 'portal', actor_kind: 'user', token_authz_version: 1 });
    expect(portalInPersonalTenant).toEqual({ status: 'ok', scopes: ['portal:profile:read'] });
  });
});
