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

// PL-93 PR-A1a: integration spec applies the init migration + add_site_axis
// + AUTHZ-D4a's add_authz_team_models so the test database matches the
// post-D4a schema (Site model + UserTenantMembership.site_id +
// ManagementEdge + Team + TeamMembership).
const MIGRATION_PATHS = [
  resolve(
    __dirname,
    '../../prisma/migrations/20260512000000_init_identity_model/migration.sql',
  ),
  resolve(
    __dirname,
    '../../prisma/migrations/20260601000000_add_site_axis/migration.sql',
  ),
  // AUTHZ-D4a — PL-95 finally exercised (the first authz migration).
  resolve(
    __dirname,
    '../../prisma/migrations/20260604000000_add_authz_team_models/migration.sql',
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

      // D-AUTHZ-PLATFORM-INVITE-1 — IdentityService now also takes
      // IdentityAuditService + RoleBundleValidator. The read paths exercised
      // in this spec never reach either dependency, so stub them with
      // undefined-casts (mirrors the resolveUser unit spec pattern).
      identitySvc = new IdentityService(
        new IdentityRepository(prisma),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        undefined as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        undefined as any,
      );
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
      // AUTHZ-1 (2026-06-04): tenant role catalog expanded 4 -> 13.
      // AUTHZ-1b (2026-06-04): revised to the 12 staffing-tenant roles
      // (retire 5 / add 4 / rename finance_hr -> finance / preserve
      // candidate). AUTHZ-2 (2026-06-04): adds the platform-tier
      // super_admin role (catalog row 13; namespace-separate from the
      // 12 tenant roles).
      // Settings S4 (2026-06-05): adds tenant-tier auditor_with_financials
      // (catalog 14 total = 13 tenant + 1 platform; the grant is gated by
      // the audit.financials_enabled KNOWN_SETTING at the role-assign
      // path, NOT at seed/catalog level).
      expect(roles.map((r) => r.key)).toEqual([
        'account_manager',
        'auditor',
        'auditor_with_financials',
        'back_office',
        'candidate',
        'delivery_manager',
        'finance',
        'lead_recruiter',
        'recruiter',
        'recruiting_manager',
        'sourcer',
        'super_admin',
        'tenant_admin',
        'tenant_owner',
      ]);

      const scopes = await prisma.scope.findMany({ orderBy: { key: 'asc' } });
      // HK-IDENT-SCOPES: +6 scopes (41 -> 47). AUTHZ-2: +3 platform:*
      // scopes (a SEPARATE namespace). AUTHZ-D4a: +4 team-model scopes
      // (company:assign, org:manage, team:manage, company:read:all) —
      // tenant scopes 47 -> 51; the platform slice is unchanged at 3.
      // Total in the catalog: 51 + 3 = 54.
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
        'company:assign',
        'company:create',
        'company:delete',
        'company:edit',
        'company:read',
        'company:read:all',
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
        'org:manage',
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
        'team:manage',
        'tenant:admin:settings',
        'tenant:admin:user-manage',
      ]);

      const roleScopes = await prisma.roleScope.count();
      // AUTHZ-1 / AUTHZ-1b row count for the 9 staffing-tenant roles:
      //   tenant_owner 47 + account_manager 35 + sourcer 14 + finance 6 +
      //   auditor 5 + recruiting_manager 33 + delivery_manager 12 +
      //   lead_recruiter 31 + back_office 12 = 195 rows. (AUTHZ-D4a adds
      //   4 scopes to tenant_owner, 2 to account_manager, 1 to recruiting_manager
      //   — +7 rows over the AUTHZ-1b 188.)
      // Pre-A1a / A1a / A1a-2 / HK rows (kept roles only — viewer retired):
      //   tenant_admin 47 + recruiter 31 + candidate 4 = 82 rows. (AUTHZ-D4a
      //   adds 4 to tenant_admin — +4 over AUTHZ-1b 78.)
      // AUTHZ-2 super_admin: +3 (the 3 platform:* scopes).
      // Settings S4 auditor_with_financials: 5 Auditor non-comp scopes +
      //   6 see-all compensation:view:* = +11 rows (0x405..0x409 in the
      //   AUTHZ-1 range; 0x50c..0x511 in the D5 range, post-D5's 0x500..
      //   0x50b for the 26 existing rows).
      // Tenant rows: 82 + 195 + 11 = 288. Total with platform: 288 + 3 = 291.
      expect(roleScopes).toBe(291);

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
      // Settings S4 audit count. Re-derived breakdown:
      //   - pre-A1a baseline (1 tenant + 1 user + 1 membership +
      //     1 external_identity + 2 roles + 6 scopes + 1 SA)          = 13
      //   - PR-A1a (1 role.candidate + 8 portal/ATS-subset scopes)   = +9
      //   - PR-A1a-2 + HK-IDENT-SCOPES (33 scope.created entries:
      //     27 + 6)                                                    = +33
      //   - AUTHZ-1 / AUTHZ-1b (9 role.created events for the 9
      //     staffing-tenant roles)                                     = +9
      //   - AUTHZ-2 (1 platform tenant.created + 1 super_admin
      //     role.created + 3 platform scope.created)                  = +5
      //   - AUTHZ-D4a (4 scope.created events for the team-model
      //     scopes; the +9 runtime EVENT_TYPES are emitted by the
      //     mechanisms at use-time, NOT at seed-time)                  = +4
      //   - Settings S4 (1 role.created event for the
      //     auditor_with_financials seed role; the role grants no new
      //     scopes, so no scope.created events)                       = +1
      //                                                       total   = 74
      expect(auditRows.length).toBe(74);
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
    //   - The tenant scope keys do not contain any platform:* scope.
    //   - The super_admin role bundle is exactly the 3 platform:* scopes.
    //   - No tenant role bundle contains any platform:* scope.
    // AUTHZ-D4a: tenant catalog grew 47 -> 51 (+4 team-model scopes); the
    // namespace separation principle is unchanged — platform:* still
    // disjoint from the tenant slice.
    // -----------------------------------------------------------------
    it('AUTHZ-2 proof 7 — platform scope namespace is disjoint from tenant catalog (51 post-D4a)', async () => {
      const tenantScopes = await prisma.scope.findMany({
        where: { NOT: { key: { startsWith: 'platform:' } } },
        select: { key: true },
      });
      expect(tenantScopes.length).toBe(51);
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
    // AUTHZ-2 §5 proof 8 — no tenant-permission regression from the
    // platform tier. The tenant catalog was the AUTHZ-1b 12-role staffing
    // set; Settings S4 grows it to 13 by adding auditor_with_financials
    // (the gated see-all-comp grant). The kept-role bundles are still
    // byte-identical (no A2-A8 regression).
    // -----------------------------------------------------------------
    it('Settings S4 — tenant 13-role catalog (AUTHZ-1b staffing set + auditor_with_financials), no platform leakage', async () => {
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

    it('test 14 — getScopesByUserAndTenant returns tenant_admin scope set (47 scopes post AUTHZ-D4a)', async () => {
      const scopes = await roleSvc.getScopesByUserAndTenant({
        user_id: SEED_IDS.user_admin,
        tenant_id: SEED_IDS.tenant,
      });
      const sorted = [...scopes].sort();
      // HK-IDENT-SCOPES: tenant_admin gained the 6 deferred ATS scopes
      // (recruiter+ includes tenant_admin). 37 + 6 = 43.
      // AUTHZ-D4a: tenant_admin gains the 4 team-model scopes. 43 + 4 = 47.
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
        'company:assign',
        'company:create',
        'company:delete',
        'company:edit',
        'company:read',
        'company:read:all',
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
        'org:manage',
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
        'team:manage',
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

    it('test 17 — scope catalog correctness: 12-role staffing catalog per AUTHZ-1b + AUTHZ-D4a (tenant_admin 47, recruiter 31, candidate 4, tenant_owner 47, account_manager 35, sourcer 14, finance 6, auditor 5, recruiting_manager 33, delivery_manager 12, lead_recruiter 31, back_office 12)', async () => {
      // tenant_admin scope set (47 post AUTHZ-D4a; 43 + 4 team-model scopes)
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
        'company:assign',
        'company:create',
        'company:delete',
        'company:edit',
        'company:read',
        'company:read:all',
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
        'org:manage',
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
        'team:manage',
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
        // AUTHZ-D4a — recruiter has NO team-model mechanism scopes
        // and NO see-all (company:read:all stays TA+TO).
        'company:assign',
        'org:manage',
        'team:manage',
        'company:read:all',
      ];
      for (const forbidden of FORBIDDEN_FOR_RECRUITER) {
        expect(
          recruiterKeys,
          `recruiter must NOT carry '${forbidden}' per A1a-2 Ruling 1 uniform divergence`,
        ).not.toContain(forbidden);
      }

      // AUTHZ-1b: viewer role retired — its bundle assertion removed.

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
      // AUTHZ-1 / AUTHZ-1b — 9 staffing-tenant role bundles (assembled
      // from the live 47-scope catalog; no new scope keys added). Bundle
      // composition is the catalog LOCK; any change requires a directive
      // amendment + Lead approval. AUTHZ-1b ruling: management roles get
      // OPERATIONAL bundles; their "broader visibility" comes from the
      // TEAM MODEL (D4b), NEVER a see-all scope here.
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

      // tenant_owner — 47 scopes (post-AUTHZ-D4a; 43 + 4 team-model scopes).
      // Owner = Admin scope set incl. the AUTHZ-D4a top-tier additions.
      await expectRoleScopes('tenant_owner', [
        'activity:create', 'activity:read',
        'attachment:create', 'attachment:delete', 'attachment:read',
        'auth:session:read',
        'calendar:event-create', 'calendar:event-delete', 'calendar:event-edit',
        'company:assign', 'company:create', 'company:delete', 'company:edit', 'company:read', 'company:read:all',
        'consent:decision-log:read', 'consent:read', 'consent:write',
        'contact:create', 'contact:delete', 'contact:edit', 'contact:read',
        'examination:read',
        'identity:tenant:read', 'identity:user:read',
        'org:manage',
        'pipeline:add', 'pipeline:add-activity', 'pipeline:change-status',
        'pipeline:read', 'pipeline:remove',
        'requisition:assign', 'requisition:create', 'requisition:delete',
        'requisition:edit', 'requisition:read', 'requisition:read:all',
        'submittal:approve', 'submittal:create',
        'talent:create', 'talent:delete', 'talent:edit', 'talent:read', 'talent:search',
        'team:manage',
        'tenant:admin:settings', 'tenant:admin:user-manage',
      ]);

      // account_manager — 35 scopes (Recruiter's 31 operational set +
      // tenant:admin:user-manage + requisition:assign + AUTHZ-D4a's
      // company:assign + team:manage). AM is the client-ownership anchor
      // (Amendment §5.4 + D4a Lead ruling 6); three AM-specific
      // delegations: user/membership mgmt, requisition:assign, and the
      // D4a client-ownership mechanisms.
      await expectRoleScopes('account_manager', [
        'activity:create', 'activity:read',
        'attachment:create', 'attachment:delete', 'attachment:read',
        'auth:session:read',
        'calendar:event-create', 'calendar:event-edit',
        'company:assign', 'company:create', 'company:edit', 'company:read',
        'consent:decision-log:read', 'consent:read', 'consent:write',
        'contact:create', 'contact:edit', 'contact:read',
        'examination:read',
        'pipeline:add', 'pipeline:add-activity', 'pipeline:change-status',
        'pipeline:read',
        'requisition:assign', 'requisition:create', 'requisition:edit', 'requisition:read',
        'submittal:approve', 'submittal:create',
        'talent:create', 'talent:edit', 'talent:read', 'talent:search',
        'team:manage',
        'tenant:admin:user-manage',
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

      // finance — 6 scopes (offer-approval surface; AUTHZ-1b KEY rename
      // from finance_hr; bundle preserved verbatim). Compensation field
      // visibility is D5 (field-masking) — the compensation fields don't
      // yet exist on the entities; D5 wires the mask matrix after they're
      // modeled.
      await expectRoleScopes('finance', [
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

      // recruiting_manager — 33 scopes (Recruiter's 31 + tenant:admin:
      // user-manage + AUTHZ-D4a's org:manage; NO requisition:assign,
      // NO company:assign — those are the AM's acts). RM manages PEOPLE
      // (user-manage + org:manage are the Axis-1 management operations);
      // team-tier visibility at D4b (NOT a see-all scope here).
      await expectRoleScopes('recruiting_manager', [
        'activity:create', 'activity:read',
        'attachment:create', 'attachment:delete', 'attachment:read',
        'auth:session:read',
        'calendar:event-create', 'calendar:event-edit',
        'company:create', 'company:edit', 'company:read',
        'consent:decision-log:read', 'consent:read', 'consent:write',
        'contact:create', 'contact:edit', 'contact:read',
        'examination:read',
        'org:manage',
        'pipeline:add', 'pipeline:add-activity', 'pipeline:change-status',
        'pipeline:read',
        'requisition:create', 'requisition:edit', 'requisition:read',
        'submittal:approve', 'submittal:create',
        'talent:create', 'talent:edit', 'talent:read', 'talent:search',
        'tenant:admin:user-manage',
      ]);

      // delivery_manager — 12 scopes (the fulfillment quality gate:
      // read + submittal:approve + activity:create). NO requisition:
      // read:all — team-oversight visibility comes from D4b, NOT a
      // see-all scope (AUTHZ-1b §2 ruling).
      await expectRoleScopes('delivery_manager', [
        'activity:create', 'activity:read',
        'attachment:read',
        'auth:session:read',
        'company:read', 'consent:read', 'contact:read',
        'examination:read', 'pipeline:read',
        'requisition:read', 'submittal:approve', 'talent:read',
      ]);

      // lead_recruiter — 31 scopes (= Recruiter verbatim). Lead-ness is
      // purely team-tier visibility via D4b (Axis-1 mid-tier); no
      // operational delta from Recruiter (AUTHZ-1b §2 ruling).
      await expectRoleScopes('lead_recruiter', [
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
        'requisition:create', 'requisition:edit', 'requisition:read',
        'submittal:approve', 'submittal:create',
        'talent:create', 'talent:edit', 'talent:read', 'talent:search',
      ]);

      // back_office — 12 scopes (operational-read + activity entry).
      // The onboarding:* / timesheet:* / compliance:* CAPABILITY scopes
      // the role ultimately needs DO NOT EXIST yet — gap-and-noted to
      // a future Onboarding/Operations DDR (AUTHZ-1b §2 ruling).
      await expectRoleScopes('back_office', [
        'activity:create', 'activity:read',
        'attachment:read',
        'auth:session:read',
        'company:read', 'consent:decision-log:read', 'consent:read',
        'contact:read', 'examination:read', 'pipeline:read',
        'requisition:read', 'talent:read',
      ]);
    });

    // -----------------------------------------------------------------
    // AUTHZ-1 — multi-role union (DDR D7 mechanism proof)
    // -----------------------------------------------------------------

    it('AUTHZ-1 — a user holding two roles in a tenant gets the DEDUPED union of both scope bundles', async () => {
      // The catalog mechanism MUST support multiple roles on one
      // membership (the 12-role catalog assumes this — a user may be
      // both Finance and Auditor, for example). The junction table
      // UserTenantMembershipRole carries the assignments;
      // RoleRepository.findScopeKeysForUserInTenant walks the role
      // graph and DEDUPES the scope keys across all assignments.
      //
      // Setup: a fresh user with one membership in the seed tenant,
      // holding BOTH finance (6 scopes) and auditor (5 scopes). Their
      // scope sets overlap on {auth:session:read, activity:read}, so
      // the deduped union is 6 + 5 - 2 = 9 unique scopes. (AUTHZ-1b
      // fixture swap from the retired coordinator+interviewer pair.)
      const userId = '01900000-0000-7000-8000-0000000000a1';
      const membershipId = '01900000-0000-7000-8000-0000000000a2';
      const financeAssignId = '01900000-0000-7000-8000-0000000000a3';
      const auditorAssignId = '01900000-0000-7000-8000-0000000000a4';

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
            role_id: SEED_IDS.roles.finance,
          },
        },
        update: {},
        create: {
          id: financeAssignId,
          membership_id: membershipId,
          role_id: SEED_IDS.roles.finance,
        },
      });
      await prisma.userTenantMembershipRole.upsert({
        where: {
          membership_id_role_id: {
            membership_id: membershipId,
            role_id: SEED_IDS.roles.auditor,
          },
        },
        update: {},
        create: {
          id: auditorAssignId,
          membership_id: membershipId,
          role_id: SEED_IDS.roles.auditor,
        },
      });

      const scopes = await roleSvc.getScopesByUserAndTenant({
        user_id: userId,
        tenant_id: SEED_IDS.tenant,
      });
      expect([...scopes].sort()).toEqual([
        'activity:create',
        'activity:read',
        'auth:session:read',
        'consent:decision-log:read',
        'identity:tenant:read',
        'identity:user:read',
        'requisition:read',
        'submittal:approve',
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
      // AUTHZ-2: +2 invitation.* events (6 -> 8).
      // AUTHZ-D4a: +9 team-model events (all tenant-scoped — they carry the
      // tenant_id the substrate write happened in). 8 -> 17.
      // Settings S2: +1 tenant_setting.updated (17 -> 18).
      // Settings S3a: +1 tenant_user.disabled (18 -> 19).
      // Settings S3b: +2 tenant_user.role_assigned + tenant_user.role_removed (19 -> 21).
      expect([...TENANT_SCOPED_EVENT_TYPES].sort()).toEqual([
        'identity.invitation.accepted',
        'identity.invitation.created',
        'identity.management_edge.cleared',
        'identity.management_edge.set',
        'identity.membership.created',
        'identity.session.issued',
        'identity.session.refreshed',
        'identity.session.reuse_detected',
        'identity.session.revoked',
        'identity.team.client_ownership.added',
        'identity.team.client_ownership.removed',
        'identity.team.created',
        'identity.team.membership.added',
        'identity.team.membership.removed',
        'identity.tenant.created',
        'identity.tenant_setting.updated',
        'identity.tenant_user.disabled',
        'identity.tenant_user.role_assigned',
        'identity.tenant_user.role_removed',
        'identity.user_client_assignment.created',
        'identity.user_client_assignment.removed',
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
