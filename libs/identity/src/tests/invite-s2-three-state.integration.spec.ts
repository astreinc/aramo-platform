import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { createAramoLogger } from '@aramo/common';

import { IdentityAuditRepository } from '../lib/audit/identity-audit.repository.js';
import { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';

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
//   ACTIVE   — activateMembershipsOnLink (the reconcile-spine hook, invoked
//              here to SIMULATE first federated login) flips ACCEPTED → ACTIVE.
//
// Plus the token invariants: hash-at-rest (never the raw token), single-use
// (a second accept is rejected), expiry enforced, revoke honored.

const ROOT = resolve(__dirname, '../../../..');
const IDENTITY_INIT = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
);
// Domain-Enforcement P1 — additive Tenant.allowed_domain column.
const IDENTITY_ALLOWED_DOMAIN = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
);
// The site axis adds UserTenantMembership.site_id, which the generated Prisma
// client SELECTs/INSERTs on every membership op — required for the client to
// match the DB even though this proof never sets a site.
const IDENTITY_SITE_AXIS = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
);
// Tenant.display_name (used by the invite/acceptance email greeting) comes
// from the tenant-profile migration; the Prisma client SELECTs it.
const IDENTITY_PROFILE = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
);
const IDENTITY_INVITATION = resolve(
  ROOT,
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
);

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
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new PrismaService(url);
      await setup.$connect();
      for (const file of [
        IDENTITY_INIT,
        IDENTITY_ALLOWED_DOMAIN,
        IDENTITY_SITE_AXIS,
        IDENTITY_PROFILE,
        IDENTITY_INVITATION,
      ]) {
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

    it('ACTIVE — the reconcile-spine hook (simulated first login) flips ACCEPTED → ACTIVE', async () => {
      const inv = await invite('active-flow@astre.test');
      await svc.acceptInvitationByToken({
        raw_token: inv.raw_token,
        request_id: 'req-accept-2',
      });
      expect(await inviteStatus(inv.user_id)).toBe('ACCEPTED');

      // Simulate the by-sub-MISS first login: the session-orchestrator calls
      // this right after linkExternalIdentity.
      const res = await svc.activateMembershipsOnLink({ user_id: inv.user_id });
      expect(res.activated).toBe(1);
      expect(await inviteStatus(inv.user_id)).toBe('ACTIVE');

      // Idempotent: a re-run touches nothing (already ACTIVE).
      const again = await svc.activateMembershipsOnLink({ user_id: inv.user_id });
      expect(again.activated).toBe(0);
      expect(await inviteStatus(inv.user_id)).toBe('ACTIVE');
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
