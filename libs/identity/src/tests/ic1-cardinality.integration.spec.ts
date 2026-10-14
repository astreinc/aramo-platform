import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';
import {
  ARAMO_POSTGRES_TEST_IMAGE,
  createAramoLogger,
  resolveIdentityMigrations,
} from '@aramo/common';

import { AuditQueryService } from '../lib/audit/audit-query.service.js';
import { IdentityAuditRepository } from '../lib/audit/identity-audit.repository.js';
import { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';

// IC-1 PR-1 — D-AUTHZ-PLATFORM-INVITE-1 Amendment A1 (ONE USER, ONE TENANT),
// proven against the REAL module graph (real IdentityService +
// IdentityRepository + IdentityAuditService + Postgres 17), NOT unit mocks:
//
//   L18 — every User-creating transaction (createInvitedUserNoSub — tenant
//         tier; createUserFromInvitation — platform tier) produces exactly
//         ONE membership and a baseline AuthorizationVersion for the new User.
//   §4  — inviting an email already owned by ANOTHER tenant is refused at
//         both tiers with 409 EMAIL_UNAVAILABLE and EXACTLY `details: {}`;
//         nothing persists; the tenant-scoped audit entry
//         identity.invitation.rejected_cross_tenant retains the reason.
//   §3  — a SAME-tenant re-invite is the preserved 409
//         INVITATION_ALREADY_EXISTS (never converted into EMAIL_UNAVAILABLE).
//   §4  — the pre-check/insert RACE: a real Postgres User.email unique
//         violation lost after the pre-check maps to the governed 409 (the
//         transaction rolled back, nothing persisted), never a raw P2002.
//   §2  — the retired AUTHZ-2 entry points are absent from the surface.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = resolveIdentityMigrations(ROOT);

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b1';
const ACTOR = '01900000-0000-7000-8000-0000000000a2';
const RECRUITER_ROLE = '01900000-0000-7000-8000-0000000000a3';

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'IC-1 PR-1 — one User, one tenant (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: IdentityRepository;
    let svc: IdentityService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();

      const setup = new PrismaService(url);
      await setup.$connect();
      for (const file of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(file, 'utf8'))) {
          const t = stmt.trim();
          if (t.length > 0) await setup.$executeRawUnsafe(t);
        }
      }
      for (const [id, name] of [
        [TENANT_A, 'Tenant A'],
        [TENANT_B, 'Tenant B'],
      ] as const) {
        await setup.$executeRawUnsafe(
          `INSERT INTO identity."Tenant" (id, name, is_active, created_at, updated_at)
           VALUES ('${id}'::uuid, '${name}', true, now(), now())`,
        );
      }
      await setup.$executeRawUnsafe(
        `INSERT INTO identity."Role" (id, key, description, is_active, created_at, updated_at)
         VALUES ('${RECRUITER_ROLE}'::uuid, 'recruiter', 'Recruiter', true, now(), now())`,
      );
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new IdentityRepository(prisma);
      svc = new IdentityService(
        repo,
        new IdentityAuditService(
          new IdentityAuditRepository(prisma),
          createAramoLogger('ic1-cardinality-spec'),
        ),
        new RoleBundleValidator(prisma),
        // IC-3 PR-8 — ATS tenant without the Sign product (no esign role assigned here).
        { getCapabilities: async () => new Set<string>(['core', 'ats', 'portal']) } as unknown as TenantEntitlementReader,
      );
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function counts(): Promise<Record<string, number>> {
      return {
        users: await prisma.user.count(),
        memberships: await prisma.userTenantMembership.count(),
        external_identities: await prisma.externalIdentity.count(),
        invitations: await prisma.invitation.count(),
        authz_versions: await prisma.authorizationVersion.count(),
        refusal_audits: await prisma.identityAuditEvent.count({
          where: { event_type: 'identity.invitation.rejected_cross_tenant' },
        }),
      };
    }

    // Request ids are opaque sequence numbers (never derived from the email),
    // so the only place an email could reach an audit row is the payload.
    let seq = 0;

    async function inviteTenantTier(email: string, tenant_id: string) {
      return svc.createInvitedUserNoSub({
        email,
        display_name: 'Invitee',
        tenant_id,
        role_keys: ['recruiter'],
        role_ids: [RECRUITER_ROLE],
        actor_user_id: ACTOR,
        request_id: `req-tenant-${++seq}`,
      });
    }

    async function invitePlatformTier(email: string, tenant_id: string, sub: string) {
      return svc.createUserFromInvitation({
        email,
        display_name: 'Invitee',
        provider: 'cognito',
        provider_subject: sub,
        tenant_id,
        role_keys: ['recruiter'],
        role_ids: [RECRUITER_ROLE],
        actor_user_id: ACTOR,
        request_id: `req-platform-${++seq}`,
      });
    }

    async function rejected(p: Promise<unknown>): Promise<{
      code: string;
      statusCode: number;
      context?: { details?: unknown };
    }> {
      try {
        await p;
      } catch (e) {
        return e as { code: string; statusCode: number; context?: { details?: unknown } };
      }
      throw new Error('expected the call to be refused');
    }

    let ownedByA = '';

    it('L18 — createInvitedUserNoSub (tenant tier) creates the User with EXACTLY one membership and a baseline AuthorizationVersion', async () => {
      const r = await inviteTenantTier('owned.by.a@example.test', TENANT_A);
      ownedByA = r.user.id;
      expect(
        await prisma.userTenantMembership.count({ where: { user_id: ownedByA } }),
      ).toBe(1);
      const versions = await prisma.authorizationVersion.findMany({
        where: { principal_id: ownedByA },
      });
      expect(versions).toHaveLength(1);
      expect(versions[0]?.tenant_id).toBe(TENANT_A);
      expect(versions[0]?.version).toBe(1);
      expect(await prisma.externalIdentity.count({ where: { user_id: ownedByA } })).toBe(0);
      // IC-1 PR-2 — born OWNED: User.tenant_id equals the single membership tenant.
      expect((await prisma.user.findUnique({ where: { id: ownedByA } }))?.tenant_id).toBe(TENANT_A);
    });

    it('L18 — createUserFromInvitation (platform tier) creates the User with EXACTLY one membership, one ExternalIdentity and a baseline AuthorizationVersion', async () => {
      const r = await invitePlatformTier('platform.fresh@example.test', TENANT_B, 'cog-fresh-1');
      const id = r.user.id;
      expect(await prisma.userTenantMembership.count({ where: { user_id: id } })).toBe(1);
      expect(await prisma.externalIdentity.count({ where: { user_id: id } })).toBe(1);
      // IC-1 PR-2 — born OWNED: User.tenant_id equals the single membership tenant.
      expect((await prisma.user.findUnique({ where: { id } }))?.tenant_id).toBe(TENANT_B);
      const versions = await prisma.authorizationVersion.findMany({
        where: { principal_id: id },
      });
      expect(versions).toHaveLength(1);
      expect(versions[0]?.tenant_id).toBe(TENANT_B);
      expect(versions[0]?.version).toBe(1);
    });

    it('§4 tenant tier — the email owned by Tenant A invited into Tenant B (mixed case + whitespace) → 409 EMAIL_UNAVAILABLE, details {}, nothing persisted, audit reason retained in B only', async () => {
      const before = await counts();
      const err = await rejected(inviteTenantTier('  Owned.By.A@Example.TEST ', TENANT_B));
      expect(err).toMatchObject({ code: 'EMAIL_UNAVAILABLE', statusCode: 409 });
      expect(err.context?.details).toEqual({});
      const serialized = JSON.stringify(err.context ?? {});
      expect(serialized).not.toContain(TENANT_A);
      expect(serialized).not.toContain(ownedByA);
      expect(serialized).not.toContain('owned.by.a');

      const after = await counts();
      expect(after).toEqual({ ...before, refusal_audits: before['refusal_audits']! + 1 });
      // The owner still holds exactly ONE membership (in Tenant A).
      const memberships = await prisma.userTenantMembership.findMany({
        where: { user_id: ownedByA },
      });
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.tenant_id).toBe(TENANT_A);

      const audit = await prisma.identityAuditEvent.findMany({
        where: { event_type: 'identity.invitation.rejected_cross_tenant' },
        orderBy: { created_at: 'desc' },
        take: 1,
      });
      expect(audit[0]?.tenant_id).toBe(TENANT_B);
      expect(audit[0]?.actor_id).toBe(ACTOR);
      // Gate-5 G5-08 — the STORED row carries no foreign-tenant identifier:
      // subject is the attempted tenant; payload is exactly the 4 whitelisted
      // keys; the foreign user id / owning tenant id / email appear nowhere.
      expect(audit[0]?.subject_id).toBe(TENANT_B);
      expect(audit[0]?.event_payload).toEqual({
        reason: 'existing_user_owned_by_other_tenant',
        tier: 'tenant',
        attempted_tenant_id: TENANT_B,
        request_id: expect.stringMatching(/^req-tenant-\d+$/),
      });
      const storedRow = JSON.stringify(audit[0]);
      expect(storedRow).not.toContain(ownedByA);
      expect(storedRow).not.toContain(TENANT_A);
      expect(storedRow).not.toContain('owned.by.a');
      expect(
        await prisma.identityAuditEvent.count({
          where: { tenant_id: TENANT_A, event_type: 'identity.invitation.rejected_cross_tenant' },
        }),
      ).toBe(0);
    });

    it('G5-08 — the tenant audit READ projection (AuditQueryService, the GET /v1/tenant/audit-events seam) exposes no foreign identifier to Tenant B, and a ?subject_id= probe for the foreign user returns nothing', async () => {
      const query = new AuditQueryService(new IdentityAuditRepository(prisma), prisma);
      const page = await query.query({
        tenant_id: TENANT_B,
        viewerScopes: ['audit:read', 'compensation:view:bill'],
        requestId: 'req-audit-read',
        event_type: 'identity.invitation.rejected_cross_tenant',
      });
      expect(page.items.length).toBeGreaterThanOrEqual(1);
      const serialized = JSON.stringify(page);
      expect(serialized).not.toContain(ownedByA);
      expect(serialized).not.toContain(TENANT_A);
      expect(serialized).not.toContain('owned.by.a');
      for (const item of page.items) {
        expect(item.subject_id).toBe(TENANT_B);
        expect(item.detail).toBe('Refused an invitation — the email is already registered to another tenant');
        expect(item.category).toBe('user');
      }
      // The subject_id filter cannot be used to probe for the foreign user.
      const probe = await query.query({
        tenant_id: TENANT_B,
        viewerScopes: ['audit:read'],
        requestId: 'req-audit-probe',
        subject_id: ownedByA,
      });
      expect(probe.items).toEqual([]);
    });

    it('§4 platform tier — the same email with a Cognito sub into Tenant B → 409 EMAIL_UNAVAILABLE; no ExternalIdentity is linked; audit tier=platform', async () => {
      const before = await counts();
      const err = await rejected(invitePlatformTier('owned.by.a@example.test', TENANT_B, 'cog-owned-a'));
      expect(err).toMatchObject({ code: 'EMAIL_UNAVAILABLE', statusCode: 409 });
      expect(err.context?.details).toEqual({});
      const after = await counts();
      expect(after).toEqual({ ...before, refusal_audits: before['refusal_audits']! + 1 });
      expect(
        await prisma.externalIdentity.findFirst({ where: { provider_subject: 'cog-owned-a' } }),
      ).toBeNull();
      const audit = await prisma.identityAuditEvent.findMany({
        where: { event_type: 'identity.invitation.rejected_cross_tenant' },
        orderBy: { created_at: 'desc' },
        take: 1,
      });
      expect(audit[0]?.event_payload).toMatchObject({ tier: 'platform', attempted_tenant_id: TENANT_B });
      expect(audit[0]?.subject_id).toBe(TENANT_B);
      expect(JSON.stringify(audit[0])).not.toContain(ownedByA);
    });

    it('§3 same tenant — re-inviting the email into Tenant A → preserved 409 INVITATION_ALREADY_EXISTS; nothing persisted; no refusal audit', async () => {
      const before = await counts();
      const err = await rejected(inviteTenantTier('owned.by.a@example.test', TENANT_A));
      expect(err).toMatchObject({ code: 'INVITATION_ALREADY_EXISTS', statusCode: 409 });
      expect(await counts()).toEqual(before);
    });

    it('§4 race — a REAL User.email unique violation lost after the pre-check maps to 409 EMAIL_UNAVAILABLE (reason email_uniqueness_race_lost); the transaction rolled back, nothing persisted', async () => {
      const before = await counts();
      // Force the pre-check to MISS once (the concurrent writer "has not
      // committed yet"); the insert then hits the real unique index.
      const spy = vi.spyOn(repo, 'findUserByEmail').mockResolvedValueOnce(null);
      try {
        const err = await rejected(inviteTenantTier('owned.by.a@example.test', TENANT_B));
        expect(err).toMatchObject({ code: 'EMAIL_UNAVAILABLE', statusCode: 409 });
        expect(err.context?.details).toEqual({});
      } finally {
        spy.mockRestore();
      }
      const after = await counts();
      expect(after).toEqual({ ...before, refusal_audits: before['refusal_audits']! + 1 });
      expect(
        await prisma.userTenantMembership.count({ where: { tenant_id: TENANT_B, user_id: ownedByA } }),
      ).toBe(0);
      const audit = await prisma.identityAuditEvent.findMany({
        where: { event_type: 'identity.invitation.rejected_cross_tenant' },
        orderBy: { created_at: 'desc' },
        take: 1,
      });
      expect(audit[0]?.event_payload).toMatchObject({
        reason: 'email_uniqueness_race_lost',
        tier: 'tenant',
      });
    });

    it('§2 — the retired AUTHZ-2 entry points are absent from the real service and repository', () => {
      expect((svc as unknown as Record<string, unknown>)['addMembershipForExistingUser']).toBeUndefined();
      expect((repo as unknown as Record<string, unknown>)['createMembershipForExistingUser']).toBeUndefined();
    });

    it('invariant snapshot — after the whole run, NO user holds more than one membership', async () => {
      const rows = await prisma.$queryRawUnsafe<Array<{ user_id: string; n: bigint }>>(
        `SELECT user_id, count(*)::bigint AS n
           FROM identity."UserTenantMembership"
          GROUP BY user_id HAVING count(*) > 1`,
      );
      expect(rows).toHaveLength(0);
    });

    // ── IC-1 PR-3 (Amendment A1 §1; Invite-S2 Amendment A1) — the DATABASE now
    // enforces: owner mandatory (NOT NULL), AT MOST one membership per User
    // (UNIQUE user_id), membership tenant = owner tenant (composite FK), owner
    // immutable (trigger). AT LEAST one membership is NOT a database rule — it is
    // the transactional writers' guarantee (L18 above). The tests below keep the
    // two halves distinct (readiness v1.2 §11 C-3).
    it('PR-3 L3 — a SECOND membership for an owned User is REFUSED by the database (UNIQUE user_id)', async () => {
      await expect(
        prisma.userTenantMembership.create({
          data: { id: uuidv7(), user_id: ownedByA, tenant_id: TENANT_B },
        }),
      ).rejects.toThrow(/UserTenantMembership_user_id_key|UserTenantMembership_user_id_tenant_id_fkey|Unique constraint|Foreign key constraint/);
      expect(await prisma.userTenantMembership.count({ where: { user_id: ownedByA } })).toBe(1);
    });

    it('PR-3 L4 — a membership whose tenant differs from the owner tenant is REFUSED (composite FK), even for a User that has no membership yet', async () => {
      // A User owned by A with NO membership (allowed by the DB — at-least-one is not a DB rule).
      const orphanOwnedByA = uuidv7();
      await prisma.user.create({
        data: { id: orphanOwnedByA, email: 'orphan.owned.by.a@example.test', tenant_id: TENANT_A },
      });
      expect(await prisma.userTenantMembership.count({ where: { user_id: orphanOwnedByA } })).toBe(0);
      // Membership in B for a User owned by A → composite FK violation.
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at)
           VALUES ('${uuidv7()}'::uuid, '${orphanOwnedByA}'::uuid, '${TENANT_B}'::uuid, now())`,
        ),
      ).rejects.toThrow(/UserTenantMembership_user_id_tenant_id_fkey/);
      // Membership in A (the owner tenant) is accepted — the same-tenant lifecycle is intact.
      await prisma.$executeRawUnsafe(
        `INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, updated_at)
         VALUES ('${uuidv7()}'::uuid, '${orphanOwnedByA}'::uuid, '${TENANT_A}'::uuid, now())`,
      );
      expect(await prisma.userTenantMembership.count({ where: { user_id: orphanOwnedByA } })).toBe(1);
    });

    it('PR-3 L4b — re-pointing User.tenant_id is REFUSED by the immutability trigger; unrelated User updates still succeed', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE identity."User" SET tenant_id = '${TENANT_B}'::uuid WHERE id = '${ownedByA}'::uuid`,
        ),
      ).rejects.toThrow(/User\.tenant_id is immutable/);
      expect((await prisma.user.findUnique({ where: { id: ownedByA } }))?.tenant_id).toBe(TENANT_A);
      // A same-value assignment is a no-op (IS DISTINCT FROM) and an unrelated column update passes.
      await prisma.$executeRawUnsafe(
        `UPDATE identity."User" SET tenant_id = '${TENANT_A}'::uuid, display_name = 'Renamed' WHERE id = '${ownedByA}'::uuid`,
      );
      expect((await prisma.user.findUnique({ where: { id: ownedByA } }))?.display_name).toBe('Renamed');
    });

    it('PR-3 — an owner-less User is REFUSED by the database (NOT NULL); the retired AUTHZ-2 second-membership shape is unreachable from persisted data', async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO identity."User" (id, email, updated_at) VALUES ('${uuidv7()}'::uuid, 'ownerless@example.test', now())`,
        ),
      ).rejects.toThrow(/null value in column "tenant_id"/);
    });

    it('IC-1 PR-2 invariant snapshot — after the whole run, every User created by a saga is OWNED and its owner equals its membership tenant (0 NULL, 0 mismatches)', async () => {
      // PR-3: tenant_id is non-null in the client type (NOT NULL in the DB), so the
      // NULL probe is a raw count — it must be 0 by construction now.
      const nulls = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM identity."User" WHERE tenant_id IS NULL`,
      );
      expect(Number(nulls[0]?.n ?? -1)).toBe(0);
      const mismatches = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT u.id FROM identity."User" u
           JOIN identity."UserTenantMembership" m ON m.user_id = u.id
          WHERE m.tenant_id <> u.tenant_id`,
      );
      expect(mismatches).toHaveLength(0);
    });

    // Keep the fresh-id helper referenced (uuidv7 is the project's id scheme).
    it('ids — uuid v7 scheme stays in force for new rows', () => {
      expect(uuidv7()).toMatch(/^[0-9a-f-]{36}$/);
    });
  },
);
