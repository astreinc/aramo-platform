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
      // PR-A1a Ruling 3: candidate role added.
      expect(roles.map((r) => r.key)).toEqual([
        'candidate',
        'recruiter',
        'tenant_admin',
        'viewer',
      ]);

      const scopes = await prisma.scope.findMany({ orderBy: { key: 'asc' } });
      // PR-A1a-2: 27 new ATS scopes added. Pre-A1a-2 14 -> 41.
      expect(scopes.map((s) => s.key)).toEqual([
        'activity:read',
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
        'pipeline:remove',
        'portal:consent:read',
        'portal:consent:write',
        'portal:profile:edit',
        'portal:profile:read',
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
      // Pre-A1a-2: 25 (post-A1a). PR-A1a-2 adds 27 tenant_admin + 19 recruiter + 6 viewer = 52. Total 77.
      expect(roleScopes).toBe(77);

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
      // 1 tenant + 1 user + 1 membership + 1 external_identity + 3 roles + 6 scopes + 1 SA = 14.
      expect(auditRows.length).toBe(14);
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

    it('test 14 — getScopesByUserAndTenant returns tenant_admin scope set (37 scopes post-A1a-2)', async () => {
      const scopes = await roleSvc.getScopesByUserAndTenant({
        user_id: SEED_IDS.user_admin,
        tenant_id: SEED_IDS.tenant,
      });
      const sorted = [...scopes].sort();
      // PR-A1a-2 Ruling 1: tenant_admin gains the full 27 ATS scopes
      // (incl. all :delete + tenant:admin:*). Pre-A1a-2 10 + 27 = 37.
      expect(sorted).toEqual([
        'activity:read',
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
        'pipeline:remove',
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

    it('test 17 — scope catalog correctness: tenant_admin 37/recruiter 26/viewer 10/candidate 4 per §6+§9 + PR-A1a-2', async () => {
      // tenant_admin scope set (37 post-A1a-2)
      const adminScopes = await roleSvc.getScopesByUserAndTenant({
        user_id: SEED_IDS.user_admin,
        tenant_id: SEED_IDS.tenant,
      });
      expect([...adminScopes].sort()).toEqual([
        'activity:read',
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
        'pipeline:remove',
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

      // recruiter scope set (26 post-A1a-2; Ruling 1 uniform divergence
      // — NO :delete, NO :read:all, NO pipeline:remove, NO tenant:admin:*)
      const recruiterRoleScopes = await prisma.roleScope.findMany({
        where: { role: { key: 'recruiter' } },
        include: { scope: true },
      });
      const recruiterKeys = [...new Set(recruiterRoleScopes.map((r) => r.scope.key))].sort();
      expect(recruiterKeys).toEqual([
        'auth:session:read',
        'activity:read',
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

      // PR-A1a-2 Ruling 1 EXPLICIT DIVERGENCE ASSERTIONS — the heart of
      // the directive. Recruiter must NOT have any destructive (`:delete`)
      // or see-all (`:read:all`) scope across any domain.
      const FORBIDDEN_FOR_RECRUITER = [
        'talent:delete',
        'company:delete',
        'contact:delete',
        'requisition:delete',
        'calendar:event-delete',
        'pipeline:remove',
        'requisition:read:all',
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
      expect([...TENANT_SCOPED_EVENT_TYPES].sort()).toEqual([
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
