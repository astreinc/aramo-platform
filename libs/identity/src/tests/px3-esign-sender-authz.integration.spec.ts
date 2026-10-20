import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  ARAMO_POSTGRES_TEST_IMAGE, resolveIdentityMigrations } from '@aramo/common';

import { AuthorizationVersionService } from '../lib/authorization-version.service.js';
import { IdentityEffectiveAuthorizationResolver } from '../lib/authorization/identity-effective-authorization-resolver.js';
import { InMemoryScopeCache } from '../lib/authorization/in-memory-scope-cache.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleRepository } from '../lib/role.repository.js';
import { RoleService } from '../lib/role.service.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';
import { runIdentitySeed, SEED_IDS } from '../../prisma/seed.js';
import { ORG_ADMIN_SCOPE_KEYS } from '../lib/dto/role.dto.js';

// PX-V1 PX-3 — proves the E-Sign sender identity resolves through the SHARED
// identity substrate: a user assigned ONLY sign_sender receives EXACTLY the
// esign:* scopes and ZERO ATS scopes. At baseline 130bfb65 the esign_* roles and
// esign:* scopes did not exist, so this authority was unreachable. The role-scope
// partition is what keeps sign_sender an E-Sign product role, never an ATS role.

const MIGRATION_PATHS = resolveIdentityMigrations(resolve(__dirname, '../../../..'));

function splitDdl(sql: string): string[] {
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  return noLineComments.split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('PX-V1 PX-3 sign_sender scope resolution — real Postgres 17', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaService;
  let roleSvc: RoleService;

  // Fresh, valid, deterministic uuids well above every seeded id range (0xf000+).
  let seq = 0xf000;
  const nextId = (): string => `01900000-0000-7000-8000-${(++seq).toString(16).padStart(12, '0')}`;

  async function assignRoleToFreshUser(label: string, roleId: string): Promise<string> {
    const userId = nextId();
    const membershipId = nextId();
    const assignId = nextId();
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId, email: `px3-${label}@aramo.dev`, display_name: `px3 ${label}`, is_active: true, tenant_id: SEED_IDS.tenant } });
    await prisma.userTenantMembership.upsert({
      where: { user_id_tenant_id: { user_id: userId, tenant_id: SEED_IDS.tenant } },
      update: {},
      create: { id: membershipId, user_id: userId, tenant_id: SEED_IDS.tenant, is_active: true },
    });
    await prisma.userTenantMembershipRole.upsert({
      where: { membership_id_role_id: { membership_id: membershipId, role_id: roleId } },
      update: {},
      create: { id: assignId, membership_id: membershipId, role_id: roleId },
    });
    return userId;
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
    roleSvc = new RoleService(new RoleRepository(prisma));
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  it('sign_sender resolves EXACTLY the esign:* scopes — no ATS scope leaks', async () => {
    const userId = await assignRoleToFreshUser('e1', SEED_IDS.roles.sign_sender);
    const scopes = await roleSvc.getScopesByUserAndTenant({ user_id: userId, tenant_id: SEED_IDS.tenant });
    expect([...scopes].sort()).toEqual(['sign:contact:read', 'sign:envelope:create', 'sign:envelope:read', 'sign:envelope:send', 'sign:template:use']);
    // The decisive partition: every resolved scope is in the esign namespace.
    expect([...scopes].every((s) => s.startsWith('sign:'))).toBe(true);
  });

  // IC-2 PR-6 — through the EFFECTIVE resolver (what the guard and /session use):
  // an sign_sender identity carries its esign:* scopes ONLY on the esign consumer
  // AND only while the tenant holds the esign capability; on the recruiter
  // consumer the same identity resolves NO scopes.
  it('IC-2 PR-6: sign_sender via the effective resolver — esign consumer + entitlement → esign:*; not entitled → []; recruiter consumer → []', async () => {
    const userId = await assignRoleToFreshUser('e3', SEED_IDS.roles.sign_sender);
    const versions = new AuthorizationVersionService(prisma);
    await versions.ensureBaseline(prisma, { tenant_id: SEED_IDS.tenant, principal_id: userId });
    const caps = { current: new Set<string>(['core', 'ats', 'portal']) };
    const resolver = new IdentityEffectiveAuthorizationResolver(
      roleSvc, versions, new InMemoryScopeCache(), { portalScopes: [], scopeCacheTtlSeconds: 300 },
      { getCapabilities: async () => caps.current } as unknown as TenantEntitlementReader,
    );
    const input = (consumer_type: 'sign' | 'recruiter') => ({
      tenant_id: SEED_IDS.tenant, principal_id: userId, consumer_type, actor_kind: 'user' as const, token_authz_version: 1,
    });
    expect(await resolver.resolve(input('sign'))).toEqual({ status: 'ok', scopes: [] });
    caps.current = new Set(['core', 'ats', 'portal', 'sign']);
    const entitled = await resolver.resolve(input('sign'));
    expect(entitled.status).toBe('ok');
    if (entitled.status === 'ok') expect([...entitled.scopes].sort()).toEqual(['sign:contact:read', 'sign:envelope:create', 'sign:envelope:read', 'sign:envelope:send', 'sign:template:use']);
    expect(await resolver.resolve(input('recruiter'))).toEqual({ status: 'ok', scopes: [] });
  });

  // IC-3 PR-7 — org_admin: the product-neutral organization administrator.
  it('IC-3 PR-7: org_admin resolves EXACTLY ORG_ADMIN_SCOPE_KEYS — no ATS, no esign, no platform scope', async () => {
    const userId = await assignRoleToFreshUser('oa1', SEED_IDS.roles.org_admin);
    const scopes = await roleSvc.getScopesByUserAndTenant({ user_id: userId, tenant_id: SEED_IDS.tenant });
    expect([...scopes].sort()).toEqual([...ORG_ADMIN_SCOPE_KEYS].sort());
    expect(scopes.some((s) => s.startsWith('sign:') || s.startsWith('platform:'))).toBe(false);
    for (const ats of ['talent:read', 'requisition:read', 'pipeline:add', 'org:manage', 'team:manage', 'identity:resolve']) {
      expect(scopes).not.toContain(ats);
    }
  });

  it('IC-3 PR-7: org_admin through the effective resolver — recruiter (ATS tenant) and esign (Sign tenant) consumers both carry the organization subset; platform carries nothing', async () => {
    const userId = await assignRoleToFreshUser('oa2', SEED_IDS.roles.org_admin);
    const versions = new AuthorizationVersionService(prisma);
    await versions.ensureBaseline(prisma, { tenant_id: SEED_IDS.tenant, principal_id: userId });
    const caps = { current: new Set<string>(['core', 'sign']) };
    const resolver = new IdentityEffectiveAuthorizationResolver(
      roleSvc, versions, new InMemoryScopeCache(), { portalScopes: [], scopeCacheTtlSeconds: 300 },
      { getCapabilities: async () => caps.current } as unknown as TenantEntitlementReader,
    );
    const input = (consumer_type: 'sign' | 'recruiter' | 'platform') => ({
      tenant_id: SEED_IDS.tenant, principal_id: userId, consumer_type, actor_kind: 'user' as const, token_authz_version: 1,
    });
    const esign = await resolver.resolve(input('sign'));
    expect(esign.status).toBe('ok');
    if (esign.status === 'ok') expect([...esign.scopes].sort()).toEqual([...ORG_ADMIN_SCOPE_KEYS].sort());
    const recruiter = await resolver.resolve(input('recruiter'));
    if (recruiter.status === 'ok') expect([...recruiter.scopes].sort()).toEqual([...ORG_ADMIN_SCOPE_KEYS].sort());
    expect(await resolver.resolve(input('platform'))).toEqual({ status: 'ok', scopes: [] });
    // Sign capability revoked → the esign consumer resolves nothing (no org admin via a dead product).
    caps.current = new Set(['core']);
    expect(await resolver.resolve(input('sign'))).toEqual({ status: 'ok', scopes: [] });
  });

  it('sign_viewer resolves read-only within the esign namespace', async () => {
    const userId = await assignRoleToFreshUser('e2', SEED_IDS.roles.sign_viewer);
    const scopes = await roleSvc.getScopesByUserAndTenant({ user_id: userId, tenant_id: SEED_IDS.tenant });
    expect([...scopes].sort()).toEqual(['sign:envelope:read', 'sign:envelope:read:all', 'sign:report:read']); // Sign S-1 Viewer: organization read + reports
  });
});
