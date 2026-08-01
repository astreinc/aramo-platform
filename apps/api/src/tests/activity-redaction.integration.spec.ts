import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';

import { AppModule } from '../app.module.js';

import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// Charter §4 Amendment — Activity Redaction Fields (defect #23). redact-never-
// delete: POST /v1/activities/:id/redact clears the note body while the row,
// author and timestamp survive. Real Postgres 17; skipped unless
// ARAMO_RUN_INTEGRATION=1.
//
// Proves the amendment's rulings end-to-end:
//   R1 author-OR-activity:redact (never scope-alone) · R2 reason mandatory
//   (code + free text, code in the closed vocab) · R3 type='note' only,
//   enforced SERVER-SIDE · R5 irreversible / no re-redact / no un-redact.
// Plus the §2 shape: notes cleared, created_by_id + created_at retained, row
// still returned.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');

const ENTITLEMENT_INIT = resolve(
  ROOT,
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
);
const ACTIVITY_INIT = resolve(
  ROOT,
  'libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
);
const ACTIVITY_REDACTION = resolve(
  ROOT,
  'libs/activity/prisma/migrations/20260801120000_add_activity_redaction_fields/migration.sql',
);
const POLICY_STORE_INIT = resolve(
  ROOT,
  'libs/policy-store/prisma/migrations/20260730120000_init_policy_store/migration.sql',
);
const POLICY_DECISION_RECORD = resolve(
  ROOT,
  'libs/policy-store/prisma/migrations/20260730160000_add_policy_decision_record/migration.sql',
);

const MIGRATIONS = [
  ENTITLEMENT_INIT,
  ACTIVITY_INIT,
  ACTIVITY_REDACTION,
  POLICY_STORE_INIT,
  POLICY_DECISION_RECORD,
];

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-activity-redaction-spec';
const ALG = 'RS256';

const TENANT_ATS = '01900000-0000-7000-8000-0000000000d3';
const REQ_SUBJECT = '22222222-2222-7222-8222-2222222222d3';
const AUTHOR = '00000000-0000-7000-8000-00000000da01';
const REDACTOR = '00000000-0000-7000-8000-00000000da02';
const STRANGER = '00000000-0000-7000-8000-00000000da03';

let uuidCounter = 0;
const uuid = (): string =>
  `0a000000-0000-7000-8000-${(++uuidCounter).toString(16).padStart(12, '0')}`;

const SEED_AT = '2026-07-01T08:30:00.000Z';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'Charter §4 Amendment — activity note redaction (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let savedEnv: Partial<Record<string, string | undefined>> = {};
    let signingKey: SignKey;

    async function jwtFor(sub: string, scopes: string[]): Promise<string> {
      return new SignJWT({
        sub,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT_ATS,
        scopes,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(signingKey);
    }

    // Seed an activity row directly (bypassing the create path) so type +
    // created_by_id + created_at are controlled precisely.
    async function seedActivity(args: {
      createdBy: string | null;
      type?: string;
      notes?: string;
    }): Promise<string> {
      const id = uuid();
      await db.query(
        `INSERT INTO activity."Activity"
           (id, tenant_id, site_id, type, subject_type, subject_id, notes, created_by_id, created_at)
         VALUES ($1::uuid, $2::uuid, NULL, $3::"activity"."ActivityType",
                 'requisition', $4::uuid, $5, $6, $7::timestamptz)`,
        [
          id,
          TENANT_ATS,
          args.type ?? 'note',
          REQ_SUBJECT,
          args.notes ?? 'a logged note with something private',
          args.createdBy,
          SEED_AT,
        ],
      );
      return id;
    }

    async function redact(
      jwt: string,
      id: string,
      body: Record<string, unknown>,
    ): Promise<{ status: number; body: { error?: { code?: string }; redacted_at?: string | null; notes?: string | null; redacted_by?: string | null; redaction_reason_code?: string | null } }> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/activities/${id}/redact`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as never };
    }

    async function rawRow(id: string): Promise<{
      notes: string | null;
      created_by_id: string | null;
      created_at: Date;
      redacted_at: Date | null;
      redacted_by: string | null;
      redaction_reason_code: string | null;
      redaction_reason: string | null;
    }> {
      const r = await db.query(
        `SELECT notes, created_by_id, created_at, redacted_at, redacted_by,
                redaction_reason_code, redaction_reason
           FROM activity."Activity" WHERE id = $1::uuid`,
        [id],
      );
      return r.rows[0];
    }

    const GOOD = {
      redaction_reason_code: 'CONTAINED_SENSITIVE_DATA',
      redaction_reason: 'contained a home address',
    };

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT_ATS);
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats') ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT_ATS],
      );

      const kp = await generateKeyPair(ALG);
      signingKey = kp.privateKey as SignKey;
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = pem;

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
      );
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

    it('§2 — redact clears notes, RETAINS created_by_id + created_at, and the row is still returned with the redaction fields', async () => {
      const id = await seedActivity({ createdBy: AUTHOR });
      const res = await redact(await jwtFor(AUTHOR, ['activity:read']), id, GOOD);
      expect(res.status).toBe(200);
      expect(res.body.notes).toBeNull();
      expect(res.body.redacted_at).not.toBeNull();
      expect(res.body.redacted_by).toBe(AUTHOR);
      expect(res.body.redaction_reason_code).toBe('CONTAINED_SENSITIVE_DATA');

      // The row survives with author + timestamp intact; only notes cleared.
      const row = await rawRow(id);
      expect(row.notes).toBeNull();
      expect(row.created_by_id).toBe(AUTHOR);
      expect(new Date(row.created_at).toISOString()).toBe(SEED_AT);
      expect(row.redacted_at).not.toBeNull();
      expect(row.redaction_reason).toBe('contained a home address');
      // The row never disappears: redact RETURNS the surviving ActivityView
      // (not a 204/empty), and the persisted row above confirms it. (The GET
      // read path is separately visibility-scoped and out of scope here.)
    });

    it('R1 — the author can redact their OWN note without the activity:redact scope', async () => {
      const id = await seedActivity({ createdBy: AUTHOR });
      const res = await redact(await jwtFor(AUTHOR, ['activity:read']), id, GOOD);
      expect(res.status).toBe(200);
    });

    it('R1 — an activity:redact holder can redact ANOTHER author\'s note', async () => {
      const id = await seedActivity({ createdBy: AUTHOR });
      const res = await redact(
        await jwtFor(REDACTOR, ['activity:read', 'activity:redact']),
        id,
        GOOD,
      );
      expect(res.status).toBe(200);
      expect(res.body.redacted_by).toBe(REDACTOR);
    });

    it('R1 — neither author nor scope-holder → 403 INSUFFICIENT_PERMISSIONS (never scope-alone)', async () => {
      const id = await seedActivity({ createdBy: AUTHOR });
      const res = await redact(await jwtFor(STRANGER, ['activity:read']), id, GOOD);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('INSUFFICIENT_PERMISSIONS');
      // Unredacted — the refused call mutated nothing.
      expect((await rawRow(id)).redacted_at).toBeNull();
    });

    it('R2 — missing reason_code → 400; missing reason text → 400; unregistered reason_code → 400', async () => {
      const author = await jwtFor(AUTHOR, ['activity:read']);
      const noCode = await redact(author, await seedActivity({ createdBy: AUTHOR }), {
        redaction_reason: 'x',
      });
      expect(noCode.status).toBe(400);

      const noText = await redact(author, await seedActivity({ createdBy: AUTHOR }), {
        redaction_reason_code: 'ENTERED_IN_ERROR',
        redaction_reason: '   ',
      });
      expect(noText.status).toBe(400);

      const badCode = await redact(author, await seedActivity({ createdBy: AUTHOR }), {
        redaction_reason_code: 'NOT_A_REAL_CODE',
        redaction_reason: 'x',
      });
      expect(badCode.status).toBe(400);
    });

    it('R3 — a non-note (pipeline_status_change) is NOT redactable → 422 ACTIVITY_NOT_REDACTABLE, enforced server-side', async () => {
      const id = await seedActivity({ createdBy: AUTHOR, type: 'pipeline_status_change', notes: 'moved to interviewing' });
      // Even a scope holder cannot redact system activity.
      const res = await redact(
        await jwtFor(REDACTOR, ['activity:read', 'activity:redact']),
        id,
        GOOD,
      );
      expect(res.status).toBe(422);
      expect(res.body.error?.code).toBe('ACTIVITY_NOT_REDACTABLE');
      expect((await rawRow(id)).redacted_at).toBeNull();
    });

    it('R5 — re-redacting an already-redacted row → 409 ACTIVITY_ALREADY_REDACTED (irreversible, single-shot)', async () => {
      const id = await seedActivity({ createdBy: AUTHOR });
      const first = await redact(await jwtFor(AUTHOR, ['activity:read']), id, GOOD);
      expect(first.status).toBe(200);
      const firstAt = (await rawRow(id)).redacted_at;

      const second = await redact(await jwtFor(AUTHOR, ['activity:read']), id, {
        redaction_reason_code: 'FACTUALLY_INCORRECT',
        redaction_reason: 'trying again',
      });
      expect(second.status).toBe(409);
      expect(second.body.error?.code).toBe('ACTIVITY_ALREADY_REDACTED');

      // The original redaction is unchanged — no re-write, no un-redact path.
      const row = await rawRow(id);
      expect(row.redacted_at?.toISOString()).toBe(firstAt?.toISOString());
      expect(row.redaction_reason).toBe('contained a home address');
    });

    it('a redaction on a missing activity → 404 NOT_FOUND', async () => {
      const res = await redact(await jwtFor(AUTHOR, ['activity:read', 'activity:redact']), uuid(), GOOD);
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe('NOT_FOUND');
    });
  },
);
