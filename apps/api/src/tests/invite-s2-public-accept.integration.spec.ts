import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAILER_PORT } from '@aramo/mailer';

import { AppModule } from '../app.module.js';

// Invite-S2 (Pattern-2) — the PUBLIC acceptance endpoint over HTTP (§3).
//
// The service logic (validation / single-use / expiry / revoke / state flip)
// is proven at the service layer in libs/identity's 3-state integration spec.
// THIS spec proves the HTTP surface + the ABSENCE OF GUARDS:
//   - POST /v1/invitations/accept is reachable WITHOUT a JWT (no 401) — it is
//     genuinely public (the invitee has no session yet).
//   - a valid token → 200, membership flips INVITED → ACCEPTED, the
//     confirmation email send is invoked (spy mailer), and NO session is
//     issued in the response (no token/cookie).
//   - invalid / expired / used / revoked → a clear 400 (never 500), no state
//     change.
//
// The mailer is overridden with a recording spy so the confirmation-send can
// be asserted without touching SES.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
  'libs/identity/prisma/migrations/20260626000000_add_tenant_domain_verification/migration.sql',
  'libs/identity/prisma/migrations/20260626120000_add_tenant_slug/migration.sql',
  'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
].map((p) => resolve(ROOT, p));

const TENANT = '01900000-0000-7000-8000-0000000000a1';
const ROLE = '01900000-0000-7000-8000-0000000000a3';

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Invite-S2 — public POST /v1/invitations/accept (un-guarded HTTP surface)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    const mailerSpy = { send: vi.fn().mockResolvedValue({ message_id: 'spy-1' }) };

    // Seed a no-sub INVITED user + an Invitation token, returning the RAW
    // token (only the hash is stored, as production does). Mirrors what
    // createInvitedUserNoSub persists, but seeded directly so the test owns
    // the raw token (the invite HTTP response never returns it — it goes only
    // in the email).
    async function seedInvite(args: {
      email: string;
      expiresAt?: Date;
      revoked?: boolean;
    }): Promise<{ userId: string; membershipId: string; invitationId: string; rawToken: string }> {
      const userId = uuidv7();
      const membershipId = uuidv7();
      const invitationId = uuidv7();
      const rawToken = randomBytes(32).toString('base64url');
      await db.query(
        `INSERT INTO identity."User" (id, email, is_active, created_at, updated_at)
         VALUES ($1::uuid, $2, true, now(), now())`,
        [userId, args.email],
      );
      await db.query(
        `INSERT INTO identity."UserTenantMembership"
           (id, user_id, tenant_id, is_active, invite_status, joined_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, true, 'INVITED', now(), now(), now())`,
        [membershipId, userId, TENANT],
      );
      await db.query(
        `INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
        [uuidv7(), membershipId, ROLE],
      );
      await db.query(
        `INSERT INTO identity."Invitation"
           (id, user_id, tenant_id, membership_id, token_hash, expires_at, revoked_at, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz, $7::timestamptz, now(), now())`,
        [
          invitationId,
          userId,
          TENANT,
          membershipId,
          hashToken(rawToken),
          (args.expiresAt ?? new Date(Date.now() + 7 * 24 * 3600 * 1000)).toISOString(),
          args.revoked ? new Date().toISOString() : null,
        ],
      );
      return { userId, membershipId, invitationId, rawToken };
    }

    async function inviteStatus(membershipId: string): Promise<string> {
      const r = await db.query<{ invite_status: string }>(
        `SELECT invite_status FROM identity."UserTenantMembership" WHERE id = $1::uuid`,
        [membershipId],
      );
      return r.rows[0]!.invite_status;
    }

    // POST the public endpoint with NO Authorization header (the point of the
    // test — it must be reachable without a JWT).
    async function postAccept(
      body: unknown,
    ): Promise<{ status: number; setCookie: string | null; body: Record<string, unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/invitations/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, setCookie: res.headers.get('set-cookie'), body: json };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) {
        await db.query(readFileSync(p, 'utf8'));
      }
      await db.query(
        `INSERT INTO identity."Tenant" (id, name, display_name, is_active, created_at, updated_at)
         VALUES ($1::uuid, 'Astre', 'Astre Inc', true, now(), now())`,
        [TENANT],
      );
      await db.query(
        `INSERT INTO identity."Role" (id, key, description, is_active, created_at, updated_at)
         VALUES ($1::uuid, 'recruiter', 'Recruiter', true, now(), now())`,
        [ROLE],
      );

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'aramo-invite-s2-accept-spec';
      // A throwaway public key so AppModule's auth pipeline constructs; the
      // public endpoint never reads it (no JWT), but other guarded controllers
      // wire it at boot.
      process.env['AUTH_PUBLIC_KEY'] =
        '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEEXAMPLE\n-----END PUBLIC KEY-----';

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MAILER_PORT)
        .useValue(mailerSpy)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 240_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    it('valid token (NO JWT) → 200, INVITED→ACCEPTED, confirmation email sent, NO session issued', async () => {
      const inv = await seedInvite({ email: 'accept-http@astre.test' });
      mailerSpy.send.mockClear();
      expect(await inviteStatus(inv.membershipId)).toBe('INVITED');

      const res = await postAccept({ token: inv.rawToken });

      // Reachable WITHOUT a JWT — not a 401. Genuinely public.
      expect(res.status).toBe(200);
      // The accepted state is returned; NO session / token / cookie.
      expect(res.body).toMatchObject({ status: 'ACCEPTED', tenant_id: TENANT });
      expect(res.body['accessJwt']).toBeUndefined();
      expect(res.body['refreshToken']).toBeUndefined();
      expect(res.body['token']).toBeUndefined();
      expect(res.setCookie).toBeNull();

      // Membership flipped.
      expect(await inviteStatus(inv.membershipId)).toBe('ACCEPTED');
      // Confirmation email send invoked exactly once, to the invitee.
      expect(mailerSpy.send).toHaveBeenCalledTimes(1);
      expect(mailerSpy.send.mock.calls[0]![0]).toMatchObject({
        to: 'accept-http@astre.test',
      });
    });

    it('used token → 400 (not 500), membership stays ACCEPTED', async () => {
      const inv = await seedInvite({ email: 'used-http@astre.test' });
      const first = await postAccept({ token: inv.rawToken });
      expect(first.status).toBe(200);

      mailerSpy.send.mockClear();
      const second = await postAccept({ token: inv.rawToken });
      expect(second.status).toBe(400);
      expect((second.body['error'] as Record<string, unknown>)?.['code']).toBe(
        'VALIDATION_ERROR',
      );
      expect(await inviteStatus(inv.membershipId)).toBe('ACCEPTED');
      // No second confirmation email on a rejected re-accept.
      expect(mailerSpy.send).not.toHaveBeenCalled();
    });

    it('expired token → 400, membership stays INVITED, no email', async () => {
      const inv = await seedInvite({
        email: 'expired-http@astre.test',
        expiresAt: new Date(Date.now() - 1000),
      });
      mailerSpy.send.mockClear();
      const res = await postAccept({ token: inv.rawToken });
      expect(res.status).toBe(400);
      expect(await inviteStatus(inv.membershipId)).toBe('INVITED');
      expect(mailerSpy.send).not.toHaveBeenCalled();
    });

    it('revoked token → 400, membership stays INVITED', async () => {
      const inv = await seedInvite({ email: 'revoked-http@astre.test', revoked: true });
      const res = await postAccept({ token: inv.rawToken });
      expect(res.status).toBe(400);
      expect(await inviteStatus(inv.membershipId)).toBe('INVITED');
    });

    it('invalid (unknown) token → 400, never 500', async () => {
      const res = await postAccept({ token: 'not-a-real-token' });
      expect(res.status).toBe(400);
      expect((res.body['error'] as Record<string, unknown>)?.['code']).toBe(
        'VALIDATION_ERROR',
      );
    });

    it('missing token → 400 (body validation)', async () => {
      const res = await postAccept({});
      expect(res.status).toBe(400);
    });
  },
);
