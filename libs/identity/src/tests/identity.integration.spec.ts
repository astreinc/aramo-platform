import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';

import {
  IdentityAuditRepository,
  TENANT_SCOPED_EVENT_TYPES,
  type EventType,
} from '../lib/audit/identity-audit.repository.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleRepository } from '../lib/role.repository.js';
import { RoleService } from '../lib/role.service.js';
import { TenantRepository } from '../lib/tenant.repository.js';
import { TenantService } from '../lib/tenant.service.js';
import {
  encodeCursor,
  decodeCursor,
} from '../lib/util/identity-audit-cursor.js';
import {
  runIdentitySeed,
  SEED_IDS,
  SEED_COGNITO_SUB,
  SEED_ADMIN_EMAIL,
  SEED_TENANT_NAME,
  SEED_SERVICE_ACCOUNT_NAME,
} from '../../prisma/seed.js';

// PL-93 PR-A1a: integration spec applies BOTH the init migration AND the
// new add_site_axis migration so the test database matches the post-A1a
// schema (Site model + UserTenantMembership.site_id).
const MIGRATION_PATHS = [
  resolve(
    __dirname,
    '../../prisma/migrations/20260512000000_init_identity_model/migration.sql',
  ),
  resolve(
    __dirname,
    '../../prisma/migrations/20260601000000_add_site_axis/migration.sql',
  ),
];

const TENANT_KEYSET = '20000000-2222-7222-8222-200000000001';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Identity module — integration (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let identitySvc: IdentityService;
    let tenantSvc: TenantService;
    let roleSvc: RoleService;
    let auditRepo: IdentityAuditRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setupClient = new PrismaService(url);
      await setupClient.$connect();
      for (const migrationPath of MIGRATION_PATHS) {
        const migrationSql = readFileSync(migrationPath, 'utf8');
        const statements = splitDdl(migrationSql);
        for (const stmt of statements) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setupClient.$executeRawUnsafe(trimmed);
        }
      }
      await setupClient.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();

      identitySvc = new IdentityService(new IdentityRepository(prisma));
      tenantSvc = new TenantService(new TenantRepository(prisma));
      roleSvc = new RoleService(new RoleRepository(prisma));
      auditRepo = new IdentityAuditRepository(prisma);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    // -----------------------------------------------------------------
    // Tests 10 + 11 — seed determinism
    // -----------------------------------------------------------------

    it('test 10 — seed first run creates all 10 entity categories', async () => {
      await runIdentitySeed(prisma);

      const tenant = await prisma.tenant.findUnique({ where: { id: SEED_IDS.tenant } });
      expect(tenant?.name).toBe(SEED_TENANT_NAME);

      const user = await prisma.user.findUnique({ where: { id: SEED_IDS.user_admin } });
      expect(user?.email).toBe(SEED_ADMIN_EMAIL);

      const membership = await prisma.userTenantMembership.findUnique({
        where: { id: SEED_IDS.membership_admin },
      });
      expect(membership?.user_id).toBe(SEED_IDS.user_admin);
      expect(membership?.tenant_id).toBe(SEED_IDS.tenant);

      const extId = await prisma.externalIdentity.findUnique({
        where: { id: SEED_IDS.external_identity_admin },
      });
      expect(extId?.provider).toBe('cognito');
      expect(extId?.provider_subject).toBe(SEED_COGNITO_SUB);
      expect(extId?.user_id).toBe(SEED_IDS.user_admin);

      const roles = await prisma.role.findMany({ orderBy: { key: 'asc' } });
      // AUTHZ-1 (2026-06-04): tenant role catalog expanded from 4 to 13.
      // AUTHZ-2 (2026-06-04): adds the platform-tier super_admin role
      // (catalog row 14; namespace-separate from the 13 tenant roles).
      expect(roles.map((r) => r.key)).toEqual([
        'account_manager',
        'auditor',
        'candidate',
        'coordinator',
        'external_agency',
        'finance_hr',
        'hiring_manager',
        'interviewer',
        'recruiter',
        'sourcer',
        'super_admin',
        'tenant_admin',
        'tenant_owner',
        'viewer',
      ]);

      const scopes = await prisma.scope.findMany({ orderBy: { key: 'asc' } });
      // HK-IDENT-SCOPES: +6 scopes (41 -> 47). AUTHZ-2: +3 platform:*
      // scopes (the SEPARATE namespace; 47 tenant + 3 platform = 50 rows
      // in the catalog, but the tenant-catalog assertion in proof 7
      // /proof 8 still pins the tenant slice at 47).
      expect(scopes.map((s) => s.key)).toEqual([
        'activity:create',
        'activity:read',
        'attachment:create',
        'attachment:delete',
        'attachment:read',
        'auth:session:read',
        'calendar:event-create',
        'calendar:event-delete',
        'calendar:event-edit',
        'company:create',
        'company:delete',
        'company:edit',
        'company:read',
        'consent:decision-log:read',
        'consent:read',
        'consent:write',
        'contact:create',
        'contact:delete',
        'contact:edit',
        'contact:read',
        'examination:read',
        'identity:tenant:read',
        'identity:user:read',
        'pipeline:add',
        'pipeline:add-activity',
        'pipeline:change-status',
        'pipeline:read',
        'pipeline:remove',
        // AUTHZ-2: 3 platform-namespace scopes interleaved alphabetically.
        'platform:admin:invite',
        'platform:tenant:provision',
        'platform:tenant:read',
        'portal:consent:read',
        'portal:consent:write',
        'portal:profile:edit',
        'portal:profile:read',
        'requisition:assign',
        'requisition:create',
        'requisition:delete',
        'requisition:edit',
        'requisition:read',
        'requisition:read:all',
        'submittal:approve',
        'submittal:create',
        'talent:create',
        'talent:delete',
        'talent:edit',
        'talent:read',
        'talent:search',
        'tenant:admin:settings',
        'tenant:admin:user-manage',
      ]);

      const roleScopes = await prisma.roleScope.count();
      // AUTHZ-1: +122 role_scope rows for the 9 new tenant roles
      // (tenant_owner 43 + hiring_manager 12 + account_manager 33 +
      // interviewer 3 + sourcer 14 + coordinator 4 + finance_hr 6 +
      // auditor 5 + external_agency 2). 88 -> 210.
      // AUTHZ-2: +3 role_scope rows for the super_admin platform-role
      // bundle (the 3 platform:* scopes). 210 -> 213. The tenant
      // 47-scope catalog is UNCHANGED — the platform scopes form a
      // SEPARATE namespace.
      expect(roleScopes).toBe(213);

      const utmRole = await prisma.userTenantMembershipRole.findUnique({
        where: { id: SEED_IDS.membership_role_admin },
      });
      expect(utmRole?.membership_id).toBe(SEED_IDS.membership_admin);
      expect(utmRole?.role_id).toBe(SEED_IDS.roles.tenant_admin);

      const sa = await prisma.serviceAccount.findUnique({
        where: { id: SEED_IDS.service_account_system },
      });
      expect(sa?.name).toBe(SEED_SERVICE_ACCOUNT_NAME);

      const auditRows = await prisma.identityAuditEvent.findMany();
      // AUTHZ-2 audit count. Re-derived breakdown:
      //   - pre-A1a baseline (1 tenant + 1 user + 1 membership +
      //     1 external_identity + 3 roles + 6 scopes + 1 SA)         = 14
      //   - PR-A1a (1 role.candidate + 8 portal/ATS-subset scopes)   = +9
      //   - PR-A1a-2 + HK-IDENT-SCOPES (33 scope.created entries in
      //     the A1A2_NEW_SCOPES loop: 27 + 6)                         = +33
      //   - AUTHZ-1 (9 role.created events for the new tenant roles) = +9
      //   - AUTHZ-2 (1 platform tenant.created + 1 super_admin
      //     role.created + 3 platform scope.created)                  = +5
      //                                                       total   = 70
      expect(auditRows.length).toBe(70);
      // Every audit event uses actor_type 'system' and actor_id = SA id.
      for (const row of auditRows) {
        expect(row.actor_type).toBe('system');
        expect(row.actor_id).toBe(SEED_IDS.service_account_system);
      }
    });

    it('test 11 — second seed run is idempotent (no errors, no duplicates, state identical)', async () => {
      // Snapshot before re-run.
      const countsBefore = await collectCounts(prisma);

      await runIdentitySeed(prisma);

      const countsAfter = await collectCounts(prisma);
      expect(countsAfter).toEqual(countsBefore);
    });

    // -----------------------------------------------------------------
    // AUTHZ-2 §5 proof 7 — platform-scope namespace separation.
    //   - The 47 tenant scope keys do not contain any platform:* scope.
    //   - The super_admin role bundle is exactly the 3 platform:* scopes.
    //   - No tenant role bundle contains any platform:* scope.
    // -----------------------------------------------------------------
    it('AUTHZ-2 proof 7 — platform scope namespace is disjoint from tenant 47-catalog', async () => {
      const tenantScopes = await prisma.scope.findMany({
        where: { NOT: { key: { startsWith: 'platform:' } } },
        select: { key: true },
      });
      expect(tenantScopes.length).toBe(47);
      for (const s of tenantScopes) {
        expect(s.key.startsWith('platform:')).toBe(false);
      }

      const platformScopes = await prisma.scope.findMany({
        where: { key: { startsWith: 'platform:' } },
        select: { key: true },
      });
      expect(platformScopes.map((s) => s.key).sort()).toEqual([
        'platform:admin:invite',
        'platform:tenant:provision',
        'platform:tenant:read',
      ]);

      const superAdmin = await prisma.role.findUnique({
        where: { key: 'super_admin' },
        include: { role_scopes: { include: { scope: true } } },
      });
      expect(superAdmin).not.toBeNull();
      const superAdminScopes = superAdmin!.role_scopes
        .map((rs) => rs.scope.key)
        .sort();
      expect(superAdminScopes).toEqual([
        'platform:admin:invite',
        'platform:tenant:provision',
        'platform:tenant:read',
      ]);

      // No tenant role holds any platform:* scope (the DDR §13.1
      // namespace-partition tripwire).
      const tenantRoles = await prisma.role.findMany({
        where: { key: { not: 'super_admin' } },
        include: { role_scopes: { include: { scope: true } } },
      });
      for (const r of tenantRoles) {
        for (const rs of r.role_scopes) {
          expect(rs.scope.key.startsWith('platform:')).toBe(false);
        }
      }
    });

    // -----------------------------------------------------------------
    // AUTHZ-2 §5 proof 8 — no tenant-permission regression. The 13
    // tenant role catalog is byte-identical to the AUTHZ-1 baseline.
    // -----------------------------------------------------------------
    it('AUTHZ-2 proof 8 — tenant 13-role catalog byte-identical to AUTHZ-1', async () => {
      const tenantRoles = await prisma.role.findMany({
        where: { key: { not: 'super_admin' } },
        select: { key: true },
      });
      expect(tenantRoles.length).toBe(13);
    });

    // -----------------------------------------------------------------
    // AUTHZ-2 §5 proof 2 supporting — the sentinel platform Tenant is
    // seeded (Lead ruling 2 B1).
    // -----------------------------------------------------------------
    it('AUTHZ-2 sentinel — the platform Tenant row exists with name "Aramo Platform"', async () => {
      const sentinel = await prisma.tenant.findUnique({
        where: { id: SEED_IDS.platform_tenant },
      });
      expect(sentinel).not.toBeNull();
      expect(sentinel?.name).toBe('Aramo Platform');
      expect(sentinel?.is_active).toBe(true);
    });

    // -----------------------------------------------------------------
    // Tests 12–14 — service surfaces against seeded DB
    // -----------------------------------------------------------------

    it('test 12 — resolveUser resolves the seed admin via cognito provider_subject', async () => {
      const user = await identitySvc.resolveUser({
        provider: 'cognito',
        provider_subject: SEED_COGNITO_SUB,
      });
      expect(user?.id).toBe(SEED_IDS.user_admin);
      expect(user?.email).toBe(SEED_ADMIN_EMAIL);
    });

    it('test 12b — resolveUser returns null for an unknown provider_subject', async () => {
      const user = await identitySvc.resolveUser({
        provider: 'cognito',
        provider_subject: 'never-issued-sub',
      });
      expect(user).toBeNull();
    });

    it('test 13 — getTenantsByUser returns the seed tenant for the seed admin', async () => {
      const tenants = await tenantSvc.getTenantsByUser({ user_id: SEED_IDS.user_admin });
      expect(tenants).toHaveLength(1);
      expect(tenants[0]?.id).toBe(SEED_IDS.tenant);
    });

    it('test 14 — getScopesByUserAndTenant returns tenant_admin scope set (43 scopes post HK-IDENT-SCOPES)', async () => {
      const scopes = await roleSvc.getScopesByUserAndTenant({
        user_id: SEED_IDS.user_admin,
        tenant_id: SEED_IDS.tenant,
      });
      const sorted = [...scopes].sort();
      // HK-IDENT-SCOPES: tenant_admin gains the 6 deferred ATS scopes
      // (recruiter+ includes tenant_admin). 37 + 6 = 43.
      expect(sorted).toEqual([
        'activity:create',
        'activity:read',
        'attachment:create',
        'attachment:delete',
        'attachment:read',
        'auth:session:read',
        'calendar:event-create',
        'calendar:event-delete',
        'calendar:event-edit',
        'company:create',
        'company:delete',
        'company:edit',
        'company:read',
        'consent:decision-log:read',
        'consent:read',
        'consent:write',
        'contact:create',
        'contact:delete',
        'contact:edit',
        'contact:read',
        'examination:read',
        'identity:tenant:read',
        'identity:user:read',
        'pipeline:add',
        'pipeline:add-activity',
        'pipeline:change-status',
        'pipeline:read',
        'pipeline:remove',
        'requisition:assign',
        'requisition:create',
        'requisition:delete',
        'requisition:edit',
        'requisition:read',
        'requisition:read:all',
        'submittal:approve',
        'submittal:create',
        'talent:create',
        'talent:delete',
        'talent:edit',
        'talent:read',
        'talent:search',
        'tenant:admin:settings',
        'tenant:admin:user-manage',
      ]);
    });

    // -----------------------------------------------------------------
    // Tests 15 + 16 — IdentityAuditEvent keyset traversal
    // -----------------------------------------------------------------

    it('test 15 — tenant-scoped keyset traversal with identical created_at, paginates without skips/duplicates', async () => {
      const SUBJECT = '30000000-3333-7333-8333-300000000001';
      const SAME_TS = new Date('2026-05-12T12:00:00.000Z');
      const N = 7;

      // Insert N tenant-scoped events sharing identical created_at. We bypass
      // the auditRepo here so we can pin created_at exactly; the (created_at
      // DESC, id DESC) ordering invariant requires keys be distinct on `id`.
      const ids: string[] = [];
      for (let i = 0; i < N; i++) {
        const id = uuidv7();
        ids.push(id);
        await prisma.identityAuditEvent.create({
          data: {
            id,
            tenant_id: TENANT_KEYSET,
            actor_id: SEED_IDS.service_account_system,
            actor_type: 'system',
            event_type: 'identity.membership.created', // tenant-scoped per §6
            subject_id: SUBJECT,
            event_payload: { i } as never,
            created_at: SAME_TS,
          },
        });
      }

      const pageSize = 3;
      // Helper: paginate using the cursor util through the tenant-scoped index.
      const seen: string[] = [];
      let cursor: { created_at: Date; event_id: string } | undefined;
      let safety = 10;
      while (safety-- > 0) {
        const where: Record<string, unknown> = {
          tenant_id: TENANT_KEYSET,
          subject_id: SUBJECT,
        };
        if (cursor !== undefined) {
          where['OR'] = [
            { created_at: { lt: cursor.created_at } },
            {
              AND: [
                { created_at: cursor.created_at },
                { id: { lt: cursor.event_id } },
              ],
            },
          ];
        }
        const rows = await prisma.identityAuditEvent.findMany({
          where,
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          take: pageSize + 1,
        });
        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        for (const r of pageRows) seen.push(r.id);
        if (!hasMore) break;
        const last = pageRows[pageRows.length - 1];
        if (last === undefined) break;
        const encoded = encodeCursor({ created_at: last.created_at, event_id: last.id });
        cursor = decodeCursor(encoded);
      }

      // Ordering: ids descending (UUID v7 is time-ordered; we used uuidv7).
      const expectedOrder = [...ids].sort().reverse();
      expect(seen).toEqual(expectedOrder);
      // No duplicates.
      expect(new Set(seen).size).toBe(N);
    });

    it('test 16 — global keyset traversal with tenant_id null, paginates without skips/duplicates', async () => {
      const SUBJECT = '30000000-3333-7333-8333-300000000002';
      const SAME_TS = new Date('2026-05-12T13:00:00.000Z');
      const N = 5;

      const ids: string[] = [];
      for (let i = 0; i < N; i++) {
        const id = uuidv7();
        ids.push(id);
        await prisma.identityAuditEvent.create({
          data: {
            id,
            tenant_id: null,
            actor_id: SEED_IDS.service_account_system,
            actor_type: 'system',
            event_type: 'identity.role.created', // global per §6
            subject_id: SUBJECT,
            event_payload: { i } as never,
            created_at: SAME_TS,
          },
        });
      }

      const pageSize = 2;
      const seen: string[] = [];
      let cursor: { created_at: Date; event_id: string } | undefined;
      let safety = 10;
      while (safety-- > 0) {
        const where: Record<string, unknown> = {
          tenant_id: null,
          subject_id: SUBJECT,
        };
        if (cursor !== undefined) {
          where['OR'] = [
            { created_at: { lt: cursor.created_at } },
            {
              AND: [
                { created_at: cursor.created_at },
                { id: { lt: cursor.event_id } },
              ],
            },
          ];
        }
        const rows = await prisma.identityAuditEvent.findMany({
          where,
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          take: pageSize + 1,
        });
        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        for (const r of pageRows) seen.push(r.id);
        if (!hasMore) break;
        const last = pageRows[pageRows.length - 1];
        if (last === undefined) break;
        const encoded = encodeCursor({ created_at: last.created_at, event_id: last.id });
        cursor = decodeCursor(encoded);
      }

      const expectedOrder = [...ids].sort().reverse();
      expect(seen).toEqual(expectedOrder);
      expect(new Set(seen).size).toBe(N);
    });

    // -----------------------------------------------------------------
    // Test 17 — scope catalog correctness
    // -----------------------------------------------------------------

    it('test 17 — scope catalog correctness: 13-role catalog per §6+§9 + PR-A1a-2 + HK-IDENT-SCOPES + AUTHZ-1 (tenant_admin 43, recruiter 31, viewer 10, candidate 4, tenant_owner 43, hiring_manager 12, account_manager 33, interviewer 3, sourcer 14, coordinator 4, finance_hr 6, auditor 5, external_agency 2)', async () => {
      // tenant_admin scope set (43 post HK-IDENT-SCOPES; 37 + 6)
      const adminScopes = await roleSvc.getScopesByUserAndTenant({
        user_id: SEED_IDS.user_admin,
        tenant_id: SEED_IDS.tenant,
      });
      expect([...adminScopes].sort()).toEqual([
        'activity:create',
        'activity:read',
        'attachment:create',
        'attachment:delete',
        'attachment:read',
        'auth:session:read',
        'calendar:event-create',
        'calendar:event-delete',
        'calendar:event-edit',
        'company:create',
        'company:delete',
        'company:edit',
        'company:read',
        'consent:decision-log:read',
        'consent:read',
        'consent:write',
        'contact:create',
        'contact:delete',
        'contact:edit',
        'contact:read',
        'examination:read',
        'identity:tenant:read',
        'identity:user:read',
        'pipeline:add',
        'pipeline:add-activity',
        'pipeline:change-status',
        'pipeline:read',
        'pipeline:remove',
        'requisition:assign',
        'requisition:create',
        'requisition:delete',
        'requisition:edit',
        'requisition:read',
        'requisition:read:all',
        'submittal:approve',
        'submittal:create',
        'talent:create',
        'talent:delete',
        'talent:edit',
        'talent:read',
        'talent:search',
        'tenant:admin:settings',
        'tenant:admin:user-manage',
      ]);

      // recruiter scope set (31 post HK-IDENT-SCOPES; 26 + 5 — all new
      // ATS scopes except requisition:assign, which is tenant_admin only).
      // Ruling 1 uniform divergence preserved (NO :delete, NO :read:all,
      // NO pipeline:remove, NO tenant:admin:*); attachment:delete is the
      // bounded Ruling 1 carve-out for junction/link deletes.
      const recruiterRoleScopes = await prisma.roleScope.findMany({
        where: { role: { key: 'recruiter' } },
        include: { scope: true },
      });
      const recruiterKeys = [...new Set(recruiterRoleScopes.map((r) => r.scope.key))].sort();
      expect(recruiterKeys).toEqual([
        'auth:session:read',
        'activity:create',
        'activity:read',
        'attachment:create',
        'attachment:delete',
        'attachment:read',
        'calendar:event-create',
        'calendar:event-edit',
        'company:create',
        'company:edit',
        'company:read',
        'consent:decision-log:read',
        'consent:read',
        'consent:write',
        'contact:create',
        'contact:edit',
        'contact:read',
        'examination:read',
        'pipeline:add',
        'pipeline:add-activity',
        'pipeline:change-status',
        'pipeline:read',
        'requisition:create',
        'requisition:edit',
        'requisition:read',
        'submittal:approve',
        'submittal:create',
        'talent:create',
        'talent:edit',
        'talent:read',
        'talent:search',
      ].sort());

      // Ruling 1 EXPLICIT DIVERGENCE ASSERTIONS — recruiter must NOT
      // have any destructive (`:delete` on owning entity) or see-all
      // (`:read:all`) scope, nor any tenant_admin-only scope (incl.
      // requisition:assign, HK-IDENT-SCOPES tenant_admin tier).
      const FORBIDDEN_FOR_RECRUITER = [
        'talent:delete',
        'company:delete',
        'contact:delete',
        'requisition:delete',
        'calendar:event-delete',
        'pipeline:remove',
        'requisition:read:all',
        'requisition:assign',
        'tenant:admin:user-manage',
        'tenant:admin:settings',
      ];
      for (const forbidden of FORBIDDEN_FOR_RECRUITER) {
        expect(
          recruiterKeys,
          `recruiter must NOT carry '${forbidden}' per A1a-2 Ruling 1 uniform divergence`,
        ).not.toContain(forbidden);
      }

      // viewer scope set (10 post-A1a-2)
      const viewerRoleScopes = await prisma.roleScope.findMany({
        where: { role: { key: 'viewer' } },
        include: { scope: true },
      });
      const viewerKeys = [...new Set(viewerRoleScopes.map((r) => r.scope.key))].sort();
      expect(viewerKeys).toEqual([
        'activity:read',
        'auth:session:read',
        'company:read',
        'consent:decision-log:read',
        'consent:read',
        'contact:read',
        'examination:read',
        'requisition:read',
        'talent:read',
        'talent:search',
      ]);

      // PR-A1a Ruling 3: candidate scope set (portal-only, 4 scopes)
      const candidateRoleScopes = await prisma.roleScope.findMany({
        where: { role: { key: 'candidate' } },
        include: { scope: true },
      });
      const candidateKeys = [...new Set(candidateRoleScopes.map((r) => r.scope.key))].sort();
      expect(candidateKeys).toEqual([
        'portal:consent:read',
        'portal:consent:write',
        'portal:profile:edit',
        'portal:profile:read',
      ]);

      // ====================================================================
      // AUTHZ-1 — 9 new tenant role bundles (assembled from the live
      // 43-scope catalog; no new scope keys added — gap-and-note discipline).
      // Bundle composition is the catalog LOCK; any change requires a
      // directive amendment + Lead approval.
      // ====================================================================

      // Helper: assert a role's bundle by role.key.
      const expectRoleScopes = async (
        roleKey: string,
        expected: string[],
      ): Promise<void> => {
        const rows = await prisma.roleScope.findMany({
          where: { role: { key: roleKey } },
          include: { scope: true },
        });
        const keys = [...new Set(rows.map((r) => r.scope.key))].sort();
        expect(keys, `role ${roleKey} bundle`).toEqual([...expected].sort());
      };

      // tenant_owner — 43 scopes. Owner = Admin scope set (position-only
      // distinction per AUTHZ-1 §4 Lead lean; AUTHZ-2 may add platform-
      // facing tenant-lifecycle scopes that distinguish Owner).
      await expectRoleScopes('tenant_owner', [
        'activity:create', 'activity:read',
        'attachment:create', 'attachment:delete', 'attachment:read',
        'auth:session:read',
        'calendar:event-create', 'calendar:event-delete', 'calendar:event-edit',
        'company:create', 'company:delete', 'company:edit', 'company:read',
        'consent:decision-log:read', 'consent:read', 'consent:write',
        'contact:create', 'contact:delete', 'contact:edit', 'contact:read',
        'examination:read',
        'identity:tenant:read', 'identity:user:read',
        'pipeline:add', 'pipeline:add-activity', 'pipeline:change-status',
        'pipeline:read', 'pipeline:remove',
        'requisition:assign', 'requisition:create', 'requisition:delete',
        'requisition:edit', 'requisition:read', 'requisition:read:all',
        'submittal:approve', 'submittal:create',
        'talent:create', 'talent:delete', 'talent:edit', 'talent:read', 'talent:search',
        'tenant:admin:settings', 'tenant:admin:user-manage',
      ]);

      // hiring_manager — 12 scopes (read + approve + feedback; NO :delete,
      // NO :read:all). Sees jobs/candidates/contacts/companies, the
      // examination output, pipeline state, and attachments; approves
      // submittals and creates feedback activities.
      await expectRoleScopes('hiring_manager', [
        'activity:create', 'activity:read',
        'attachment:read',
        'auth:session:read',
        'company:read', 'consent:read', 'contact:read',
        'examination:read', 'pipeline:read',
        'requisition:read', 'submittal:approve', 'talent:read',
      ]);

      // account_manager — 33 scopes (Recruiter's 31 operational set +
      // tenant:admin:user-manage + requisition:assign). The two AM-specific
      // delegations: managing the user/membership surface within scope, and
      // assigning users to requisitions (the management act).
      await expectRoleScopes('account_manager', [
        'activity:create', 'activity:read',
        'attachment:create', 'attachment:delete', 'attachment:read',
        'auth:session:read',
        'calendar:event-create', 'calendar:event-edit',
        'company:create', 'company:edit', 'company:read',
        'consent:decision-log:read', 'consent:read', 'consent:write',
        'contact:create', 'contact:edit', 'contact:read',
        'examination:read',
        'pipeline:add', 'pipeline:add-activity', 'pipeline:change-status',
        'pipeline:read',
        'requisition:assign', 'requisition:create', 'requisition:edit', 'requisition:read',
        'submittal:approve', 'submittal:create',
        'talent:create', 'talent:edit', 'talent:read', 'talent:search',
        'tenant:admin:user-manage',
      ]);

      // interviewer — 3 scopes (narrowest tenant role; views assigned
      // candidates, reads activity log, records interview feedback).
      // calendar:read gap deferred — Interviewer learns of events via
      // direct invitation, not via a calendar read primitive.
      await expectRoleScopes('interviewer', [
        'activity:create', 'activity:read', 'talent:read',
      ]);

      // sourcer — 14 scopes (intake-focused; NO :delete, NO submittal).
      // Adds talents, manages the pipeline-sourcing surface, reads
      // requisitions/companies/contacts to source against.
      await expectRoleScopes('sourcer', [
        'activity:create', 'activity:read',
        'auth:session:read',
        'company:read', 'contact:create', 'contact:read',
        'pipeline:add', 'pipeline:add-activity', 'pipeline:change-status', 'pipeline:read',
        'requisition:read',
        'talent:create', 'talent:read', 'talent:search',
      ]);

      // coordinator — 4 scopes (Lead exact set). Scheduling logistics:
      // creates/edits calendar events, reads talent context, records
      // scheduling activities. calendar:event-delete deferred (Ruling 1
      // reserves entity-destruction to tenant_admin; reschedule = edit).
      await expectRoleScopes('coordinator', [
        'activity:create',
        'calendar:event-create', 'calendar:event-edit',
        'talent:read',
      ]);

      // finance_hr — 6 scopes (offer-approval surface). Compensation field
      // visibility is D5 (field-masking) — the compensation fields don't
      // yet exist on the entities; D5 wires the mask matrix after they're
      // modeled.
      await expectRoleScopes('finance_hr', [
        'activity:create', 'activity:read',
        'auth:session:read',
        'requisition:read', 'submittal:approve', 'talent:read',
      ]);

      // auditor — 5 scopes (Lead exact set; read-only audit-side surface).
      // Sees consent decision log, sessions, identity, activity log. The
      // operational reads (talent:read, requisition:read, etc.) are NOT
      // in the bundle — Auditor reads the audit trail and identity state,
      // not the operational data. report:read + audit-log:read deferred
      // to the Reporting/Audit DDR.
      await expectRoleScopes('auditor', [
        'activity:read', 'auth:session:read',
        'consent:decision-log:read',
        'identity:tenant:read', 'identity:user:read',
      ]);

      // external_agency — 2 scopes (most restricted tenant role). D4 will
      // enforce that talent:read + requisition:read see ONLY explicitly-
      // shared records (a stricter predicate than Recruiter's assigned-only).
      await expectRoleScopes('external_agency', [
        'requisition:read', 'talent:read',
      ]);
    });

    // -----------------------------------------------------------------
    // AUTHZ-1 — multi-role union (DDR D7 mechanism proof)
    // -----------------------------------------------------------------

    it('AUTHZ-1 — a user holding two roles in a tenant gets the DEDUPED union of both scope bundles', async () => {
      // The catalog mechanism MUST support multiple roles on one
      // membership (the 12-role catalog assumes this — a user may be
      // both Coordinator and Interviewer, for example). The junction
      // table UserTenantMembershipRole carries the assignments;
      // RoleRepository.findScopeKeysForUserInTenant walks the role
      // graph and DEDUPES the scope keys across all assignments.
      //
      // Setup: a fresh user with one membership in the seed tenant,
      // holding BOTH coordinator (4 scopes) and interviewer (3 scopes).
      // Their scope sets overlap on {talent:read, activity:create},
      // so the deduped union is 4 + 3 - 2 = 5 unique scopes.
      const userId = '01900000-0000-7000-8000-0000000000a1';
      const membershipId = '01900000-0000-7000-8000-0000000000a2';
      const coordinatorAssignId = '01900000-0000-7000-8000-0000000000a3';
      const interviewerAssignId = '01900000-0000-7000-8000-0000000000a4';

      await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: {
          id: userId,
          email: 'authz1-multirole@aramo.dev',
          display_name: 'AUTHZ-1 multirole',
          is_active: true,
        },
      });
      await prisma.userTenantMembership.upsert({
        where: { user_id_tenant_id: { user_id: userId, tenant_id: SEED_IDS.tenant } },
        update: {},
        create: {
          id: membershipId,
          user_id: userId,
          tenant_id: SEED_IDS.tenant,
          is_active: true,
        },
      });
      await prisma.userTenantMembershipRole.upsert({
        where: {
          membership_id_role_id: {
            membership_id: membershipId,
            role_id: SEED_IDS.roles.coordinator,
          },
        },
        update: {},
        create: {
          id: coordinatorAssignId,
          membership_id: membershipId,
          role_id: SEED_IDS.roles.coordinator,
        },
      });
      await prisma.userTenantMembershipRole.upsert({
        where: {
          membership_id_role_id: {
            membership_id: membershipId,
            role_id: SEED_IDS.roles.interviewer,
          },
        },
        update: {},
        create: {
          id: interviewerAssignId,
          membership_id: membershipId,
          role_id: SEED_IDS.roles.interviewer,
        },
      });

      const scopes = await roleSvc.getScopesByUserAndTenant({
        user_id: userId,
        tenant_id: SEED_IDS.tenant,
      });
      expect([...scopes].sort()).toEqual([
        'activity:create',
        'activity:read',
        'calendar:event-create',
        'calendar:event-edit',
        'talent:read',
      ]);
    });

    // -----------------------------------------------------------------
    // Test 19 — ExternalIdentity unique constraint
    // -----------------------------------------------------------------

    it('test 19 — duplicate (provider, provider_subject) raises a unique-constraint error', async () => {
      const dupUserId = '01900000-0000-7000-8000-0000000000d1';
      // Pre-create a User so the second ExternalIdentity insert hits the
      // ExternalIdentity unique check, not a FK violation.
      await prisma.user.create({
        data: {
          id: dupUserId,
          email: 'dup-test-user@aramo.dev',
          display_name: 'dup test',
          is_active: true,
        },
      });

      const provider = 'cognito';
      const sub = 'dup-cognito-sub';
      await prisma.externalIdentity.create({
        data: {
          id: uuidv7(),
          provider,
          provider_subject: sub,
          user_id: dupUserId,
          email_snapshot: 'dup@aramo.dev',
        },
      });

      await expect(
        prisma.externalIdentity.create({
          data: {
            id: uuidv7(),
            provider,
            provider_subject: sub, // same pair → unique violation
            user_id: dupUserId,
            email_snapshot: 'dup@aramo.dev',
          },
        }),
      ).rejects.toThrow();
    });

    // -----------------------------------------------------------------
    // Audit-writer guardrails (closed-set enforcement)
    // -----------------------------------------------------------------

    it('audit writer rejects event_type values outside the §6 closed set', async () => {
      await expect(
        auditRepo.writeEvent({
          tenant_id: null,
          actor_id: SEED_IDS.service_account_system,
          actor_type: 'system',
          event_type: 'identity.not_a_real_event' as EventType,
          subject_id: SEED_IDS.user_admin,
          event_payload: {},
        }),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    });

    it('audit writer enforces §6 event_type → index-category mapping', async () => {
      // Tenant-scoped event with tenant_id null → reject.
      await expect(
        auditRepo.writeEvent({
          tenant_id: null,
          actor_id: SEED_IDS.service_account_system,
          actor_type: 'system',
          event_type: 'identity.tenant.created',
          subject_id: SEED_IDS.tenant,
          event_payload: {},
        }),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });

      // Global event with tenant_id set → reject.
      await expect(
        auditRepo.writeEvent({
          tenant_id: SEED_IDS.tenant,
          actor_id: SEED_IDS.service_account_system,
          actor_type: 'system',
          event_type: 'identity.user.created',
          subject_id: SEED_IDS.user_admin,
          event_payload: {},
        }),
      ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    });

    it('TENANT_SCOPED_EVENT_TYPES set matches directive §6 mapping exactly', () => {
      // Updated by PR-8.0a-Reground §6 amendment: 4 session.* event_types
      // added to the tenant-scoped set (prereq's 2 entries + 4 new = 6).
      // AUTHZ-2: +2 invitation.* events (both tenant-scoped, carry the
      // invited-into tenant_id). 6 -> 8.
      expect([...TENANT_SCOPED_EVENT_TYPES].sort()).toEqual([
        'identity.invitation.accepted',
        'identity.invitation.created',
        'identity.membership.created',
        'identity.session.issued',
        'identity.session.refreshed',
        'identity.session.reuse_detected',
        'identity.session.revoked',
        'identity.tenant.created',
      ]);
    });
  },
);

interface PrismaModelLike {
  count(): Promise<number>;
}

async function collectCounts(p: PrismaService): Promise<Record<string, number>> {
  // Snapshot the row counts for every model the seed touches; the
  // seed must produce the same counts on every re-run.
  const sources: [string, PrismaModelLike][] = [
    ['tenant', p.tenant],
    ['user', p.user],
    ['service_account', p.serviceAccount],
    ['membership', p.userTenantMembership],
    ['membership_role', p.userTenantMembershipRole],
    ['role', p.role],
    ['scope', p.scope],
    ['role_scope', p.roleScope],
    ['external_identity', p.externalIdentity],
    ['audit', p.identityAuditEvent],
  ];
  const out: Record<string, number> = {};
  for (const [name, model] of sources) {
    out[name] = await model.count();
  }
  return out;
}

// Naive DDL splitter — sufficient for the Prisma-generated migration file
// (semicolon-terminated statements, no PL/pgSQL functions in identity).
// Mirrors the helper in libs/consent/src/tests/consent.integration.spec.ts.
function splitDdl(sql: string): string[] {
  // Strip line comments
  const noLineComments = sql.replace(/--[^\n]*$/gm, '');
  // Split on semicolon at end-of-statement boundaries
  return noLineComments.split(/;\s*\n/);
}
