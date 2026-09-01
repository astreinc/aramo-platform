import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { resolveIdentityMigrations } from '@aramo/common';
import type { EffectiveAuthorizationInput } from '@aramo/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleRepository } from '../lib/role.repository.js';
import { RoleService } from '../lib/role.service.js';
import { AuthorizationVersionService } from '../lib/authorization-version.service.js';
import { bumpPrincipalsWithRoleVersion } from '../lib/authorization-version.ops.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { InMemoryScopeCache } from '../lib/authorization/in-memory-scope-cache.js';
import {
  IdentityEffectiveAuthorizationResolver,
} from '../lib/authorization/identity-effective-authorization-resolver.js';

// HF-AUTH-1 — MODE B: the real identity-backed resolver against seeded RBAC.
//
// These prove the NEW server-side authorization authority actually works end to
// end — not merely that the token got smaller. Every acceptance-bar item that
// concerns authorization DERIVATION, VERSIONING, INVALIDATION, ISOLATION, CACHE,
// and FAIL-CLOSED is proven here with the production resolver path (RoleService +
// AuthorizationVersionService + the versioned cache) reading a real Postgres.

const MIGRATION_PATHS = resolveIdentityMigrations(resolve(__dirname, '../../../..'));

// Comment-aware DDL splitter (the migration-comment-semicolon trap).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      cur += ch;
      continue;
    }
    if (ch === ';') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const BASE_INPUT = { consumer_type: 'recruiter' as const, actor_kind: 'user' as const };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'HF-AUTH-1 — authorization-version resolver (real Postgres 17, seeded RBAC)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let roleService: RoleService;
    let versions: AuthorizationVersionService;
    let cache: InMemoryScopeCache;
    let resolver: IdentityEffectiveAuthorizationResolver;
    let identityRepo: IdentityRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const p of MIGRATION_PATHS) {
        for (const stmt of splitDdl(readFileSync(p, 'utf8'))) {
          if (stmt.trim()) await setup.$executeRawUnsafe(stmt.trim());
        }
      }
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      roleService = new RoleService(new RoleRepository(prisma));
      versions = new AuthorizationVersionService(prisma);
      cache = new InMemoryScopeCache();
      resolver = new IdentityEffectiveAuthorizationResolver(roleService, versions, cache, {
        portalScopes: ['portal:profile:read'],
        scopeCacheTtlSeconds: 300,
      });
      identityRepo = new IdentityRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    // Seed a tenant + user + role (with the given scopes) + an active membership
    // assigning that role. Returns the ids + a resolver-input builder.
    async function seedPrincipal(scopeKeys: string[]): Promise<{
      tenant_id: string;
      user_id: string;
      role_id: string;
      membership_id: string;
      scopeIds: Record<string, string>;
      input(version: number, site_id?: string): EffectiveAuthorizationInput;
    }> {
      const tenant_id = randomUUID();
      const user_id = randomUUID();
      const role_id = randomUUID();
      const membership_id = randomUUID();
      await prisma.tenant.create({ data: { id: tenant_id, name: `T-${tenant_id.slice(0, 8)}` } });
      await prisma.user.create({ data: { id: user_id, email: `${user_id}@ex.test` } });
      await prisma.role.create({ data: { id: role_id, key: `role-${role_id.slice(0, 8)}` } });
      const scopeIds: Record<string, string> = {};
      for (const key of scopeKeys) {
        const sid = randomUUID();
        scopeIds[key] = sid;
        await prisma.scope.create({ data: { id: sid, key: `${key}-${sid.slice(0, 4)}` } });
        await prisma.roleScope.create({ data: { id: randomUUID(), role_id, scope_id: sid } });
      }
      await prisma.userTenantMembership.create({ data: { id: membership_id, user_id, tenant_id } });
      await prisma.userTenantMembershipRole.create({
        data: { id: randomUUID(), membership_id, role_id },
      });
      // Birth baseline (mirrors identity.repository's ensureBaseline).
      await versions.ensureBaseline(prisma, { tenant_id, principal_id: user_id });
      const input = (version: number, site_id?: string): EffectiveAuthorizationInput => ({
        tenant_id,
        principal_id: user_id,
        token_authz_version: version,
        ...BASE_INPUT,
        ...(site_id !== undefined ? { site_id } : {}),
      });
      return { tenant_id, user_id, role_id, membership_id, scopeIds, input };
    }

    it('version match → AuthContext.scopes resolved from canonical RBAC', async () => {
      const p = await seedPrincipal(['pipeline:read']);
      const v = await versions.getCurrentVersion({ tenant_id: p.tenant_id, principal_id: p.user_id });
      expect(v).toBe(1);
      const r = await resolver.resolve(p.input(1));
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.scopes).toHaveLength(1);
    });

    it('grant ADD bumps the version → old authz_version STALE; new version resolves the added scope', async () => {
      const p = await seedPrincipal(['pipeline:read']);
      // Add a second scope to the role, then bump every holder of that role.
      const s2 = randomUUID();
      await prisma.scope.create({ data: { id: s2, key: `req-create-${s2.slice(0, 4)}` } });
      await prisma.roleScope.create({ data: { id: randomUUID(), role_id: p.role_id, scope_id: s2 } });
      await bumpPrincipalsWithRoleVersion(prisma, { role_id: p.role_id });

      const now = await versions.getCurrentVersion({ tenant_id: p.tenant_id, principal_id: p.user_id });
      expect(now).toBe(2);
      // The token minted at v1 is now STALE.
      expect((await resolver.resolve(p.input(1))).status).toBe('stale');
      // A token minted at the current version resolves the enlarged set.
      const r2 = await resolver.resolve(p.input(2));
      expect(r2.status).toBe('ok');
      if (r2.status === 'ok') expect(r2.scopes).toHaveLength(2);
    });

    it('grant REMOVE bumps the version → old token STALE; new version resolves the reduced set', async () => {
      const p = await seedPrincipal(['a:x', 'b:y']);
      // Remove one grant from the role.
      const someScopeId = Object.values(p.scopeIds)[0]!;
      await prisma.roleScope.deleteMany({ where: { role_id: p.role_id, scope_id: someScopeId } });
      await bumpPrincipalsWithRoleVersion(prisma, { role_id: p.role_id });
      const now = await versions.getCurrentVersion({ tenant_id: p.tenant_id, principal_id: p.user_id });
      expect((await resolver.resolve(p.input(1))).status).toBe('stale');
      const r = await resolver.resolve(p.input(now));
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.scopes).toHaveLength(1);
    });

    it('ROLE change (replaceMembershipRoles) bumps the version → old token STALE, scopes reflect new roles', async () => {
      const p = await seedPrincipal(['x:1']);
      // Replace the membership's roles with an empty set → loses all scopes.
      await identityRepo.replaceMembershipRoles({ membership_id: p.membership_id, role_ids: [] });
      const now = await versions.getCurrentVersion({ tenant_id: p.tenant_id, principal_id: p.user_id });
      expect(now).toBeGreaterThan(1);
      expect((await resolver.resolve(p.input(1))).status).toBe('stale');
      const r = await resolver.resolve(p.input(now));
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.scopes).toEqual([]);
    });

    it('MEMBERSHIP DISABLE bumps the version → old token STALE; disabled membership yields no scopes', async () => {
      const p = await seedPrincipal(['y:2']);
      await identityRepo.disableMembership({ user_id: p.user_id, tenant_id: p.tenant_id });
      const now = await versions.getCurrentVersion({ tenant_id: p.tenant_id, principal_id: p.user_id });
      expect(now).toBeGreaterThan(1);
      expect((await resolver.resolve(p.input(1))).status).toBe('stale');
      const r = await resolver.resolve(p.input(now));
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.scopes).toEqual([]); // is_active=false → no scopes
    });

    it('CACHE: a hit returns the same set; a version MISMATCH is stale (never serves stale scopes)', async () => {
      const p = await seedPrincipal(['c:1', 'c:2']);
      const r1 = await resolver.resolve(p.input(1)); // miss → canonical → cached
      const r2 = await resolver.resolve(p.input(1)); // hit
      expect(r1.status).toBe('ok');
      expect(r2.status).toBe('ok');
      if (r1.status === 'ok' && r2.status === 'ok') expect(r2.scopes.sort()).toEqual(r1.scopes.sort());
      // A token carrying a version that is not current is denied.
      expect((await resolver.resolve(p.input(999))).status).toBe('stale');
    });

    it('TENANT ISOLATION: same user id in two tenants resolves independent versions + scopes', async () => {
      const a = await seedPrincipal(['ta:1']);
      // A second membership for the SAME user in a DIFFERENT tenant, different scopes.
      const tenant_b = randomUUID();
      const role_b = randomUUID();
      const scope_b = randomUUID();
      await prisma.tenant.create({ data: { id: tenant_b, name: 'T-B' } });
      await prisma.role.create({ data: { id: role_b, key: `rb-${role_b.slice(0, 6)}` } });
      await prisma.scope.create({ data: { id: scope_b, key: `tb-${scope_b.slice(0, 4)}` } });
      await prisma.roleScope.create({ data: { id: randomUUID(), role_id: role_b, scope_id: scope_b } });
      const mb = randomUUID();
      await prisma.userTenantMembership.create({ data: { id: mb, user_id: a.user_id, tenant_id: tenant_b } });
      await prisma.userTenantMembershipRole.create({ data: { id: randomUUID(), membership_id: mb, role_id: role_b } });
      await versions.ensureBaseline(prisma, { tenant_id: tenant_b, principal_id: a.user_id });

      const inB = (v: number): EffectiveAuthorizationInput => ({
        tenant_id: tenant_b, principal_id: a.user_id, token_authz_version: v, ...BASE_INPUT,
      });
      const rA = await resolver.resolve(a.input(1));
      const rB = await resolver.resolve(inB(1));
      expect(rA.status).toBe('ok');
      expect(rB.status).toBe('ok');
      if (rA.status === 'ok' && rB.status === 'ok') {
        expect(rA.scopes).toHaveLength(1);
        expect(rB.scopes).toHaveLength(1);
        expect(rA.scopes[0]).not.toBe(rB.scopes[0]); // no cross-tenant leak
      }
      // Bumping tenant B's version does NOT stale tenant A's token.
      await bumpPrincipalsWithRoleVersion(prisma, { role_id: role_b });
      expect((await resolver.resolve(a.input(1))).status).toBe('ok');
      expect((await resolver.resolve(inB(1))).status).toBe('stale');
    });

    it('SITE ISOLATION: a site-scoped membership resolves only under its site; tenant-wide token gets no site scopes', async () => {
      // Seed a site-scoped membership: the role scopes only apply under site S.
      const tenant_id = randomUUID();
      const user_id = randomUUID();
      const role_id = randomUUID();
      const scope_id = randomUUID();
      const site_id = randomUUID();
      await prisma.tenant.create({ data: { id: tenant_id, name: 'T-Site' } });
      await prisma.user.create({ data: { id: user_id, email: `${user_id}@ex.test` } });
      await prisma.$executeRawUnsafe(
        `INSERT INTO identity."Site" (id, tenant_id, name, updated_at) VALUES ('${site_id}','${tenant_id}','Site A', now())`,
      );
      await prisma.role.create({ data: { id: role_id, key: `rs-${role_id.slice(0, 6)}` } });
      await prisma.scope.create({ data: { id: scope_id, key: `site-scope-${scope_id.slice(0, 4)}` } });
      await prisma.roleScope.create({ data: { id: randomUUID(), role_id, scope_id } });
      const m = randomUUID();
      await prisma.userTenantMembership.create({ data: { id: m, user_id, tenant_id, site_id } });
      await prisma.userTenantMembershipRole.create({ data: { id: randomUUID(), membership_id: m, role_id } });
      await versions.ensureBaseline(prisma, { tenant_id, principal_id: user_id });

      const mk = (v: number, site?: string): EffectiveAuthorizationInput => ({
        tenant_id, principal_id: user_id, token_authz_version: v, ...BASE_INPUT,
        ...(site !== undefined ? { site_id: site } : {}),
      });
      // With the site → resolves the site-scoped scope.
      const withSite = await resolver.resolve(mk(1, site_id));
      expect(withSite.status).toBe('ok');
      if (withSite.status === 'ok') expect(withSite.scopes).toHaveLength(1);
      // Tenant-wide token (no site) → site authority does NOT leak.
      const tenantWide = await resolver.resolve(mk(1));
      expect(tenantWide.status).toBe('ok');
      if (tenantWide.status === 'ok') expect(tenantWide.scopes).toEqual([]);
    });

    it('FAIL CLOSED: canonical store unreachable → unresolvable (never trust the token, never expand privilege)', async () => {
      const p = await seedPrincipal(['z:1']);
      // A resolver whose RBAC read throws — must fail closed, not fall back to any
      // token-carried scopes (the compact token has none anyway).
      const throwingRole = {
        getScopesByUserTenantAndSite: async () => {
          throw new Error('db down');
        },
      } as unknown as RoleService;
      const failResolver = new IdentityEffectiveAuthorizationResolver(throwingRole, versions, new InMemoryScopeCache(), {
        portalScopes: [],
        scopeCacheTtlSeconds: 300,
      });
      expect((await failResolver.resolve(p.input(1))).status).toBe('unresolvable');

      // Version-authority unreachable → also unresolvable.
      const throwingVersions = {
        getCurrentVersion: async () => {
          throw new Error('version store down');
        },
      } as unknown as AuthorizationVersionService;
      const failResolver2 = new IdentityEffectiveAuthorizationResolver(roleService, throwingVersions, new InMemoryScopeCache(), {
        portalScopes: [],
        scopeCacheTtlSeconds: 300,
      });
      expect((await failResolver2.resolve(p.input(1))).status).toBe('unresolvable');
    });

    it('PORTAL: fixed scopes, version pinned to 1 (independent of RBAC growth)', async () => {
      const input: EffectiveAuthorizationInput = {
        tenant_id: randomUUID(),
        principal_id: randomUUID(),
        token_authz_version: 1,
        consumer_type: 'portal',
        actor_kind: 'user',
      };
      const r = await resolver.resolve(input);
      expect(r.status).toBe('ok');
      if (r.status === 'ok') expect(r.scopes).toEqual(['portal:profile:read']);
      // A portal token at any other version is stale (portal authorization is fixed).
      expect((await resolver.resolve({ ...input, token_authz_version: 2 })).status).toBe('stale');
    });
  },
);
