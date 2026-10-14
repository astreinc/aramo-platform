import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';
import {
  ARAMO_POSTGRES_TEST_IMAGE, createAramoLogger, resolveIdentityMigrations } from '@aramo/common';

import { IdentityAuditRepository } from '../lib/audit/identity-audit.repository.js';
import { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';

// Invite-S2 (Pattern-2) — the 3-STATE TRANSITION + TOKEN-LIFECYCLE proof
// (directive §8.10 LOCAL PROOF + the mandatory 3-state + token specs).
//
// Exercises the FULL flow through the REAL module graph (real IdentityService
// + IdentityRepository + Postgres 17) — NOT unit mocks:
//
//   INVITED  — createInvitedUserNoSub creates a no-sub User + membership
//              (invite_status=INVITED) + roles + an Invitation token (hash
//              stored, raw returned once); NO ExternalIdentity.
//   ACCEPTED — acceptInvitationByToken validates the raw token by its hash,
//              stamps accepted_at, flips the membership INVITED → ACCEPTED.
//   ACTIVE   — activateAcceptedMembershipsOnSession (the single authenticated-
//              session activation seam, invoked here to SIMULATE a sign-in)
//              flips ACCEPTED → ACTIVE.
//
// Plus the token invariants: hash-at-rest (never the raw token), single-use
// (a second accept is rejected), expiry enforced, revoke honored.

const ROOT = resolve(__dirname, '../../../..');
// IC-1 PR-2 — this spec used to hand-list a pure-identity SUBSET (8 of the
// migrations). The regenerated identity client now SELECTs User.tenant_id on
// every User read, so the subset broke on `column "tenant_id" does not exist`.
// Retrofitted to the single ordered helper (PR-1.5 Workstream C convention):
// the extra additive tables are behavior-neutral for this proof.
const IDENTITY_MIGRATION_SQL_PATHS = resolveIdentityMigrations(ROOT);

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const ACTOR = '01900000-0000-7000-8000-0000000000a2';
const RECRUITER_ROLE = '01900000-0000-7000-8000-0000000000a3';

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Invite-S2 — 3-state transition + token lifecycle (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let svc: IdentityService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      const url = container.getConnectionUri();

      const setup = new PrismaService(url);
      await setup.$connect();
      for (const file of IDENTITY_MIGRATION_SQL_PATHS) {
        for (const stmt of splitDdl(readFileSync(file, 'utf8'))) {
          const t = stmt.trim();
          if (t.length > 0) await setup.$executeRawUnsafe(t);
        }
      }
      // Seed the FK targets: a tenant + the recruiter role the invite grants.
      await setup.$executeRawUnsafe(
        `INSERT INTO identity."Tenant" (id, name, is_active, created_at, updated_at)
         VALUES ('${TENANT}'::uuid, 'Astre', true, now(), now())`,
      );
      await setup.$executeRawUnsafe(
        `INSERT INTO identity."Role" (id, key, description, is_active, created_at, updated_at)
         VALUES ('${RECRUITER_ROLE}'::uuid, 'recruiter', 'Recruiter', true, now(), now())`,
      );
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      const audit = new IdentityAuditService(
        new IdentityAuditRepository(prisma),
        createAramoLogger('invite-s2-spec'),
      );
      svc = new IdentityService(
        new IdentityRepository(prisma),
        audit,
        new RoleBundleValidator(prisma),
        // IC-3 PR-8 — ATS tenant without the Sign product (no esign role assigned here).
        { getCapabilities: async () => new Set<string>(['core', 'ats', 'portal']) } as unknown as TenantEntitlementReader,
      );
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function inviteStatus(userId: string): Promise<string | null> {
      const m = await prisma.userTenantMembership.findFirst({
        where: { user_id: userId, tenant_id: TENANT },
        select: { invite_status: true },
      });
      return m?.invite_status ?? null;
    }

    async function invite(email: string): Promise<{
      user_id: string;
      membership_id: string;
      invitation_id: string;
      raw_token: string;
    }> {
      const r = await svc.createInvitedUserNoSub({
        email,
        display_name: email,
        tenant_id: TENANT,
        role_keys: ['recruiter'],
        role_ids: [RECRUITER_ROLE],
        actor_user_id: ACTOR,
        request_id: `req-${email}`,
      });
      return {
        user_id: r.user.id,
        membership_id: r.membership_id,
        invitation_id: r.invitation_id,
        raw_token: r.raw_token,
      };
    }

    it('INVITED — no-sub create: User (no ExternalIdentity) + membership INVITED + roles + hashed token', async () => {
      const inv = await invite('three-state@astre.test');

      // User exists; NO ExternalIdentity (sub links at first login).
      const user = await prisma.user.findUnique({ where: { id: inv.user_id } });
      expect(user?.email).toBe('three-state@astre.test');
      const ext = await prisma.externalIdentity.findMany({
        where: { user_id: inv.user_id },
      });
      expect(ext).toHaveLength(0);

      // Membership in INVITED, active, recruiter role attached.
      expect(await inviteStatus(inv.user_id)).toBe('INVITED');
      const roles = await prisma.userTenantMembershipRole.findMany({
        where: { membership_id: inv.membership_id },
      });
      expect(roles.map((r) => r.role_id)).toEqual([RECRUITER_ROLE]);

      // Token is HASH-stored — the row holds sha256(raw)·base64url, never raw.
      const row = await prisma.invitation.findUnique({
        where: { id: inv.invitation_id },
      });
      expect(row).not.toBeNull();
      expect(row?.accepted_at).toBeNull();
      expect(row?.revoked_at).toBeNull();
      const expectedHash = createHash('sha256')
        .update(inv.raw_token)
        .digest('base64url');
      expect(row?.token_hash).toBe(expectedHash);
      expect(row?.token_hash).not.toBe(inv.raw_token);
    });

    it('ACCEPTED — accept validates the token, stamps accepted_at, flips membership INVITED → ACCEPTED', async () => {
      const inv = await invite('accept-flow@astre.test');
      expect(await inviteStatus(inv.user_id)).toBe('INVITED');

      const ctx = await svc.acceptInvitationByToken({
        raw_token: inv.raw_token,
        request_id: 'req-accept',
      });
      expect(ctx.tenant_id).toBe(TENANT);
      expect(ctx.email).toBe('accept-flow@astre.test');

      expect(await inviteStatus(inv.user_id)).toBe('ACCEPTED');
      const row = await prisma.invitation.findUnique({
        where: { id: inv.invitation_id },
      });
      expect(row?.accepted_at).not.toBeNull();
    });

    it('ACTIVE — the single authenticated-session activation seam flips ACCEPTED → ACTIVE (every login: by-sub HIT and MISS)', async () => {
      // People&Access activation-on-sign-in fix — the ONE activation seam. It
      // is called by the session-orchestrator on EVERY authenticated session
      // (both the by-sub MISS first-login and the by-sub HIT path that was the
      // bug: a user whose Cognito sub was already linked when they first sign in
      // after accepting). Strict ACCEPTED → ACTIVE, idempotent.
      const inv = await invite('active-flow@astre.test');
      await svc.acceptInvitationByToken({
        raw_token: inv.raw_token,
        request_id: 'req-accept-2',
      });
      expect(await inviteStatus(inv.user_id)).toBe('ACCEPTED');

      const res = await svc.activateAcceptedMembershipsOnSession({
        user_id: inv.user_id,
      });
      expect(res.activated).toBe(1);
      expect(await inviteStatus(inv.user_id)).toBe('ACTIVE');

      // Idempotent: a re-run (a later session) touches nothing (already ACTIVE).
      const again = await svc.activateAcceptedMembershipsOnSession({
        user_id: inv.user_id,
      });
      expect(again.activated).toBe(0);
      expect(await inviteStatus(inv.user_id)).toBe('ACTIVE');
    });

    it('NEVER INVITED — the authenticated-session activation does not lift a still-INVITED (un-accepted) membership', async () => {
      // The Lead-ruled guard: strict ACCEPTED→ACTIVE only. A user who somehow
      // authenticates before accepting must NOT be auto-activated.
      const inv = await invite('session-invited@astre.test');
      expect(await inviteStatus(inv.user_id)).toBe('INVITED');

      const res = await svc.activateAcceptedMembershipsOnSession({
        user_id: inv.user_id,
      });
      expect(res.activated).toBe(0);
      expect(await inviteStatus(inv.user_id)).toBe('INVITED');
    });

    it('TOKEN single-use — a second accept of the same token is rejected (4xx, not 500)', async () => {
      const inv = await invite('single-use@astre.test');
      await svc.acceptInvitationByToken({
        raw_token: inv.raw_token,
        request_id: 'req-su-1',
      });
      await expect(
        svc.acceptInvitationByToken({
          raw_token: inv.raw_token,
          request_id: 'req-su-2',
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        context: { details: { reason: 'already_accepted' } },
      });
    });

    it('TOKEN expiry — an expired invite cannot be accepted (4xx)', async () => {
      const inv = await invite('expired@astre.test');
      // Force the token past its expiry.
      await prisma.invitation.update({
        where: { id: inv.invitation_id },
        data: { expires_at: new Date(Date.now() - 1000) },
      });
      await expect(
        svc.acceptInvitationByToken({
          raw_token: inv.raw_token,
          request_id: 'req-exp',
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        context: { details: { reason: 'expired' } },
      });
      // The membership stays INVITED (an expired token does not accept).
      expect(await inviteStatus(inv.user_id)).toBe('INVITED');
    });

    it('TOKEN revoke — a revoked invite cannot be accepted (4xx)', async () => {
      const inv = await invite('revoked@astre.test');
      const revoke = await svc.revokeInvitation({
        invitation_id: inv.invitation_id,
      });
      expect(revoke.changed).toBe(true);
      await expect(
        svc.acceptInvitationByToken({
          raw_token: inv.raw_token,
          request_id: 'req-rev',
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        context: { details: { reason: 'revoked' } },
      });
      expect(await inviteStatus(inv.user_id)).toBe('INVITED');
    });

    it('TOKEN unknown — a garbage token is rejected (4xx invalid_token, never 500)', async () => {
      await expect(
        svc.acceptInvitationByToken({
          raw_token: 'not-a-real-token',
          request_id: 'req-bad',
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        context: { details: { reason: 'invalid_token' } },
      });
    });
  },
);
