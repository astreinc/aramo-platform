import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { createAramoLogger } from '@aramo/common';
import type { MailerPort } from '@aramo/mailer';

import { IdentityAuditRepository } from '../lib/audit/identity-audit.repository.js';
import { IdentityAuditService } from '../lib/audit/identity-audit.service.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';
import { TenantUserLifecycleService } from '../lib/tenant-user/tenant-user-lifecycle.service.js';
import type { TenantCognitoPort } from '../lib/tenant-user/tenant-cognito.port.js';
import type { AuditFinancialsGate } from '../lib/tenant-user/audit-financials-gate.port.js';
import { deriveDisplayedStatus } from '../lib/tenant-user/invitation-token.js';

// Invite-S3 — the LOCAL e2e PROOF (§8.3) through the REAL module graph (real
// IdentityService + IdentityRepository + TenantUserLifecycleService + Postgres
// 17; a recording stub mailer; a stub Cognito). It proves the 5-state DISPLAY
// derivation + EVERY admin action against real rows — NOT mocks:
//
//   invite → INVITED → resend(invitation, token rotates) → accept → ACCEPTED
//   → resend(confirmation, no rotate) → activate(first login) → ACTIVE
//   → disable → INACTIVE → enable → ACTIVE → edit-roles
//   plus: revoke a pending invite → INACTIVE; edit-email rejected (not FAILED).
//
// At each step it reads the roster (svc.listTenantUsers) and asserts the
// displayed status the FE would render (deriveDisplayedStatus over is_active +
// invite_status) — proving the §0 model through the real graph.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = [
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
  'libs/identity/prisma/migrations/20260626000000_add_tenant_domain_verification/migration.sql',
  'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
].map((p) => resolve(ROOT, p));

const TENANT = '01900000-0000-7000-8000-0000000000b1';
const ACTOR = '01900000-0000-7000-8000-0000000000b2';
const RECRUITER_ROLE = '01900000-0000-7000-8000-0000000000b3';
const SOURCER_ROLE = '01900000-0000-7000-8000-0000000000b4';

function splitDdl(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Invite-S3 — 5-state derivation + admin actions (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let svc: IdentityService;
    let lifecycle: TenantUserLifecycleService;
    const sent: Array<{ to: string; subject: string; html: string }> = [];
    const cognitoCalls: string[] = [];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new PrismaService(url);
      await setup.$connect();
      for (const file of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(file, 'utf8'))) {
          const t = stmt.trim();
          if (t.length > 0) await setup.$executeRawUnsafe(t);
        }
      }
      await setup.$executeRawUnsafe(
        `INSERT INTO identity."Tenant" (id, name, is_active, created_at, updated_at)
         VALUES ('${TENANT}'::uuid, 'Astre', true, now(), now())`,
      );
      await setup.$executeRawUnsafe(
        `INSERT INTO identity."Role" (id, key, description, is_active, created_at, updated_at)
         VALUES ('${RECRUITER_ROLE}'::uuid, 'recruiter', 'Recruiter', true, now(), now()),
                ('${SOURCER_ROLE}'::uuid, 'sourcer', 'Sourcer', true, now(), now())`,
      );
      await setup.$disconnect();

      prisma = new PrismaService(url);
      await prisma.$connect();
      const audit = new IdentityAuditService(
        new IdentityAuditRepository(prisma),
        createAramoLogger('invite-s3-spec'),
      );
      svc = new IdentityService(
        new IdentityRepository(prisma),
        audit,
        new RoleBundleValidator(prisma),
      );
      const mailer: MailerPort = {
        send: async (m) => {
          sent.push({ to: m.to, subject: m.subject, html: m.html });
          return { message_id: `stub-${sent.length}` };
        },
      };
      const cognito: TenantCognitoPort = {
        adminCreateUser: async () => ({ cognito_sub: 'sub-x' }),
        adminDeleteUser: async () => undefined,
        adminDisableUser: async () => {
          cognitoCalls.push('disable');
        },
        adminEnableUser: async () => {
          cognitoCalls.push('enable');
        },
      };
      const gate: AuditFinancialsGate = {
        isFinancialsAuditEnabled: async () => false,
      };
      lifecycle = new TenantUserLifecycleService(svc, cognito, gate, mailer);
    }, 120_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    // The displayed status the FE would render for a given user, read off the
    // real roster row (the §0 two-axis model).
    async function displayedFor(userId: string): Promise<string> {
      const roster = await svc.listTenantUsers(TENANT);
      const row = roster.find((u) => u.user_id === userId);
      if (row === undefined) return 'MISSING';
      return deriveDisplayedStatus(row.is_active, row.invite_status);
    }

    async function tokenHash(invitationId: string): Promise<string> {
      const row = await prisma.invitation.findUnique({
        where: { id: invitationId },
      });
      return row?.token_hash ?? '';
    }

    it('full e2e: invite → resend → accept → resend → activate → disable → enable → edit-roles', async () => {
      // ── invite → INVITED ──
      const invited = await lifecycle.inviteTenantUser({
        tenant_id: TENANT,
        email: 'e2e@astre.test',
        display_name: 'E2E User',
        role_keys: ['recruiter'],
        actor_user_id: ACTOR,
        request_id: 'req-invite',
      });
      const userId = invited.user.id;
      expect(invited.invite_status).toBe('INVITED');
      expect(await displayedFor(userId)).toBe('INVITED');
      // The invite email was logged by the stub mailer.
      expect(sent.at(-1)?.to).toBe('e2e@astre.test');

      const invitation = await svc.findActiveInvitation({
        user_id: userId,
        tenant_id: TENANT,
      });
      const hashBefore = await tokenHash(invitation!.id);

      // ── resend (INVITED) → invitation email + token ROTATE ──
      const r1 = await lifecycle.resendInvitation({
        tenant_id: TENANT,
        user_id: userId,
        request_id: 'req-resend-1',
      });
      expect(r1.sent).toBe('invitation');
      expect(await tokenHash(invitation!.id)).not.toBe(hashBefore); // rotated
      expect(await displayedFor(userId)).toBe('INVITED');

      // ── accept (with the ROTATED token) → ACCEPTED ──
      // Re-issue is in place; grab the live raw token via a fresh resend so we
      // can accept. (The raw token is only returned to the mailer, so we rotate
      // once more and capture through the service.)
      const rot = await svc.rotateInvitationToken({
        invitation_id: invitation!.id,
      });
      const ctx = await svc.acceptInvitationByToken({
        raw_token: rot.raw_token,
        request_id: 'req-accept',
      });
      expect(ctx.tenant_id).toBe(TENANT);
      expect(await displayedFor(userId)).toBe('ACCEPTED');

      // ── resend (ACCEPTED) → confirmation email, NO token change ──
      const hashAccepted = await tokenHash(invitation!.id);
      const r2 = await lifecycle.resendInvitation({
        tenant_id: TENANT,
        user_id: userId,
        request_id: 'req-resend-2',
      });
      expect(r2.sent).toBe('confirmation');
      expect(await tokenHash(invitation!.id)).toBe(hashAccepted); // unchanged
      expect(await displayedFor(userId)).toBe('ACCEPTED');

      // ── activate (simulate first federated login) → ACTIVE ──
      await svc.activateMembershipsOnLink({ user_id: userId });
      expect(await displayedFor(userId)).toBe('ACTIVE');

      // ── disable → INACTIVE (is_active overrides) ──
      await lifecycle.disableTenantUser({
        tenant_id: TENANT,
        user_id: userId,
        actor_user_id: ACTOR,
        reason: null,
        request_id: 'req-disable',
      });
      expect(cognitoCalls).toContain('disable');
      expect(await displayedFor(userId)).toBe('INACTIVE');

      // ── enable → ACTIVE (invite_status preserved through the disable) ──
      await lifecycle.enableTenantUser({
        tenant_id: TENANT,
        user_id: userId,
        request_id: 'req-enable',
      });
      expect(await displayedFor(userId)).toBe('ACTIVE');

      // ── edit-roles (available in every state) ──
      const assigned = await lifecycle.assignTenantUserRoles({
        tenant_id: TENANT,
        user_id: userId,
        role_keys: ['recruiter', 'sourcer'],
        actor_user_id: ACTOR,
        request_id: 'req-roles',
      });
      expect(assigned.added_role_keys).toEqual(['sourcer']);
      expect(await displayedFor(userId)).toBe('ACTIVE');
    });

    it('revoke a pending invite → INACTIVE (invitation revoked + membership soft-disabled)', async () => {
      const invited = await lifecycle.inviteTenantUser({
        tenant_id: TENANT,
        email: 'revoke-e2e@astre.test',
        display_name: null,
        role_keys: ['recruiter'],
        actor_user_id: ACTOR,
        request_id: 'req-invite-rev',
      });
      const userId = invited.user.id;
      expect(await displayedFor(userId)).toBe('INVITED');

      const before = await svc.findActiveInvitation({
        user_id: userId,
        tenant_id: TENANT,
      });
      const out = await lifecycle.revokeTenantInvite({
        tenant_id: TENANT,
        user_id: userId,
        request_id: 'req-revoke',
      });
      expect(out.revoked).toBe(true);
      // The invitation is stamped revoked, the membership soft-disabled.
      const after = await prisma.invitation.findUnique({
        where: { id: before!.id },
      });
      expect(after?.revoked_at).not.toBeNull();
      expect(await displayedFor(userId)).toBe('INACTIVE');
    });

    it('edit-email is FAILED-only — rejected for a real (non-FAILED) user', async () => {
      const invited = await lifecycle.inviteTenantUser({
        tenant_id: TENANT,
        email: 'lock-e2e@astre.test',
        display_name: null,
        role_keys: ['recruiter'],
        actor_user_id: ACTOR,
        request_id: 'req-invite-lock',
      });
      await expect(
        lifecycle.editInvitedUserEmail({
          tenant_id: TENANT,
          user_id: invited.user.id,
          new_email: 'changed@astre.test',
          request_id: 'req-edit-email',
        }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        statusCode: 400,
        context: { details: { reason: 'email_locked' } },
      });
    });
  },
);
