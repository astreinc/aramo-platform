import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';

import { IdentityRepository } from '../lib/identity.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// §5 Auth-Hardening Directive 2 — reconcile-spine, the SECURITY-CRITICAL core.
//
// Federated login reconciles a verified email to its existing Aramo account by
// LINKING the federated Cognito `sub` to that user. The failure mode is
// ACCOUNT-TAKEOVER: if the link primitive RE-POINTS an already-linked sub to a
// different user, an attacker could hijack an existing identity.
//
// The source branch's `linkExternalIdentity` re-pointed (`update: { user_id }`).
// Main `cb16dbb` deliberately landed the NO-OP (`update: {}`) — link-if-absent,
// refuse-to-re-point. This directive grafts the reconcile slice WIRED TO THE
// NO-OP and drops the re-point. These integration tests prove, against real
// Postgres 17, the security primitive the whole program rests on:
//
//   1. CREATE path (reconcile happy path) — linking an ABSENT sub creates the
//      mapping; the sub then resolves to the user.
//   2. ★ TAKEOVER-CLOSED (the single most important assertion in the program)
//      — attempting to link an ALREADY-LINKED sub to a DIFFERENT user is a
//      NO-OP: the existing mapping is UNCHANGED (sub still → original user,
//      email_snapshot not rewritten). The re-point hole is closed.
//   3. IDEMPOTENT re-link — re-linking the same (sub → user) pair is a clean
//      no-op (the reconcile is safe to re-run).
//
// Substrate fact this rests on (re-confirmed in §B of the directive): the
// reconcile calls linkExternalIdentity ONLY on a resolveUser-by-sub MISS, so
// on that path the (provider, sub) row is ALWAYS absent and only the create
// branch runs — the no-op is byte-equivalent there. Test 2 proves that even if
// some OTHER caller passes an already-linked sub, the primitive refuses to
// re-point. Defense-in-depth at the primitive, not just the call site.

const ROOT = resolve(__dirname, '../../../..');

const MIGRATIONS = [
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260625000000_add_tenant_allowed_domain/migration.sql',
  'libs/identity/prisma/migrations/20260626000000_add_tenant_domain_verification/migration.sql',
  'libs/identity/prisma/migrations/20260626120000_add_tenant_slug/migration.sql',
  'libs/identity/prisma/migrations/20260624000000_add_invitation_and_invite_status/migration.sql',
  'libs/identity/prisma/migrations/20260601000000_add_site_axis/migration.sql',
  'libs/identity/prisma/migrations/20260604000000_add_authz_team_models/migration.sql',
  'libs/identity/prisma/migrations/20260619000000_add_tenant_profile/migration.sql',
  'libs/identity/prisma/migrations/20260620000000_add_site_hierarchy/migration.sql',
].map((p) => resolve(ROOT, p));

const PROVIDER = 'cognito';
// The federated sub under contention (the would-be takeover target).
const SUB_X = 'federated-sub-x-0001';

// Two distinct seeded users — the legitimate owner (A) and the attacker (B).
const USER_A = '01900000-0000-7000-8000-0000000000a1';
const USER_B = '01900000-0000-7000-8000-0000000000b2';
const EMAIL_A = 'owner.a@aramo.test';
const EMAIL_B = 'attacker.b@aramo.test';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  '§5 Auth-Hardening D2 — reconcile link primitive (account-takeover-closed, real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;
    let prisma: PrismaService;
    let repo: IdentityRepository;

    async function seedUser(id: string, email: string): Promise<void> {
      await db.query(
        `INSERT INTO identity."User" (id, email, display_name, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, true, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO NOTHING`,
        [id, email, email],
      );
    }

    async function rawExternalIdentity(
      sub: string,
    ): Promise<{ user_id: string; email_snapshot: string | null } | null> {
      const res = await db.query<{ user_id: string; email_snapshot: string | null }>(
        `SELECT user_id, email_snapshot FROM identity."ExternalIdentity"
          WHERE provider = $1 AND provider_subject = $2`,
        [PROVIDER, sub],
      );
      return res.rows[0] ?? null;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) {
        await db.query(readFileSync(p, 'utf8'));
      }
      await seedUser(USER_A, EMAIL_A);
      await seedUser(USER_B, EMAIL_B);

      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new IdentityRepository(prisma);
    }, 240_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await db?.end();
      await container?.stop();
    }, 60_000);

    // -----------------------------------------------------------------------
    // 1 — CREATE path (reconcile happy path): an ABSENT sub links + resolves.
    // -----------------------------------------------------------------------
    it('1 — links an absent sub to the existing user (create), then resolves by sub', async () => {
      // Precondition: the sub is not yet linked (a resolveUser-by-sub miss).
      expect(await repo.findUserByExternalIdentity({ provider: PROVIDER, provider_subject: SUB_X })).toBeNull();

      const dto = await repo.linkExternalIdentity({
        user_id: USER_A,
        provider: PROVIDER,
        provider_subject: SUB_X,
        email_snapshot: EMAIL_A,
      });
      expect(dto.user_id).toBe(USER_A);

      // The sub now resolves to user A via the normal by-sub path.
      const resolved = await repo.findUserByExternalIdentity({ provider: PROVIDER, provider_subject: SUB_X });
      expect(resolved?.id).toBe(USER_A);
    });

    // -----------------------------------------------------------------------
    // 2 — ★ THE CRITICAL TEST — account-takeover-closed.
    //     An attempt to RE-POINT the already-linked sub to a DIFFERENT user is
    //     a no-op: the existing mapping is UNCHANGED.
    // -----------------------------------------------------------------------
    it('2 — ★ refuses to re-point an already-linked sub to a different user (takeover-closed)', async () => {
      // Sanity: SUB_X is linked to A (from test 1).
      const before = await rawExternalIdentity(SUB_X);
      expect(before?.user_id).toBe(USER_A);

      // Attacker B tries to claim SUB_X (the re-point attempt).
      await repo.linkExternalIdentity({
        user_id: USER_B,
        provider: PROVIDER,
        provider_subject: SUB_X,
        email_snapshot: EMAIL_B,
      });

      // ★ The mapping is UNCHANGED — the no-op refused the re-point.
      const resolved = await repo.findUserByExternalIdentity({ provider: PROVIDER, provider_subject: SUB_X });
      expect(resolved?.id).toBe(USER_A);
      expect(resolved?.id).not.toBe(USER_B);

      // The row's user_id AND email_snapshot are untouched (update: {} no-op).
      const after = await rawExternalIdentity(SUB_X);
      expect(after?.user_id).toBe(USER_A);
      expect(after?.email_snapshot).toBe(EMAIL_A); // NOT rewritten to EMAIL_B
    });

    // -----------------------------------------------------------------------
    // 3 — IDEMPOTENT re-link: re-running the same (sub → user) is a clean no-op.
    // -----------------------------------------------------------------------
    it('3 — re-linking the same sub→user pair is an idempotent no-op', async () => {
      const dto = await repo.linkExternalIdentity({
        user_id: USER_A,
        provider: PROVIDER,
        provider_subject: SUB_X,
        email_snapshot: EMAIL_A,
      });
      expect(dto.user_id).toBe(USER_A);
      const resolved = await repo.findUserByExternalIdentity({ provider: PROVIDER, provider_subject: SUB_X });
      expect(resolved?.id).toBe(USER_A);
    });
  },
);
