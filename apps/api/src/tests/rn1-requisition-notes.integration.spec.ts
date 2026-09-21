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
import { EFFECTIVE_AUTHORIZATION_RESOLVER } from '@aramo/auth';

import { AppModule } from '../app.module.js';

import { ConfigurableTestResolver } from './support/test-auth-harness.js';
import { ensureWriteFreezeTenant } from './write-freeze-tenant.js';

// RN-1 Requisition Enterprise Notes (+ RN-1-A1 ActivityNoteEvent ledger) —
// end-to-end runtime proofs against real Postgres 17. Skipped unless
// ARAMO_RUN_INTEGRATION=1. Drives the real controller (create / pin / unpin /
// redact) and inspects the persisted activity.* rows directly. Proves the LOCKED
// acceptance criteria AC-1/5/6/7/8/11/12/15 + A1 ledger atomicity, idempotency,
// DB-level immutability, no-content, and the Note != Evidence boundary.

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
// RN-1 — SEPARATE const (never a 2nd resolve() arg — ENOTDIR/variadic trap).
const ACTIVITY_NOTE_EXTENSION = resolve(
  ROOT,
  'libs/activity/prisma/migrations/20260921160000_rn1_activity_note_extension/migration.sql',
);
const POLICY_STORE_INIT = resolve(
  ROOT,
  'libs/policy-store/prisma/migrations/20260730120000_init_policy_store/migration.sql',
);
const POLICY_DECISION_RECORD = resolve(
  ROOT,
  'libs/policy-store/prisma/migrations/20260730160000_add_policy_decision_record/migration.sql',
);
// The AppModule wires a DARK CI-processing reconciler that queries the
// conversation_intelligence schema on a timer. Migrate its tables so that
// background query returns empty rather than raising TableDoesNotExist (it is
// unrelated to RN-1; this keeps the run clean).
const CI_INIT = resolve(
  ROOT,
  'libs/conversation-intelligence/prisma/migrations/20260907130000_ci_requisition_analysis_context_init/migration.sql',
);
const CI_PROCESSING_RUN = resolve(
  ROOT,
  'libs/conversation-intelligence/prisma/migrations/20260909120000_ci_b6_processing_run/migration.sql',
);

// Split around the RN-1 extension so a LEGACY note row can be seeded BEFORE the
// extension migration runs — exercising the backfill on real pre-existing data
// in the SAME container (AC-1), no second container.
const MIGRATIONS_PRE_EXTENSION = [
  ENTITLEMENT_INIT,
  ACTIVITY_INIT,
  ACTIVITY_REDACTION,
];
const MIGRATIONS_POST_EXTENSION = [
  ACTIVITY_NOTE_EXTENSION,
  POLICY_STORE_INIT,
  POLICY_DECISION_RECORD,
  CI_INIT,
  CI_PROCESSING_RUN,
];

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-rn1-notes-spec';
const ALG = 'RS256';

const TENANT = '01900000-0000-7000-8000-0000000000e1';
const REQ_SUBJECT = '22222222-2222-7222-8222-2222222222e1';
const AUTHOR = '00000000-0000-7000-8000-00000000db01';
const STRANGER = '00000000-0000-7000-8000-00000000db02';
// A legacy note row seeded before the RN-1 extension migration (AC-1 backfill).
const LEGACY_ID = '0b000000-0000-7000-8000-00000000ba01';

// See-all scopes collapse the subject-visibility OR to {}, isolating the note
// PRIVATE-privacy clause as the only differentiator between the two actors.
const READER_SCOPES = [
  'activity:read',
  'activity:create',
  'requisition:read:all',
  'company:read:all',
];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RN-1 Requisition Enterprise Notes — real Postgres 17',
  () => {
    const __authzTestResolver = new ConfigurableTestResolver();
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
        tenant_id: TENANT,
        authz_version: __authzTestResolver.grant(TENANT, sub, scopes),
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(signingKey);
    }

    function api(
      method: string,
      path: string,
      jwt: string,
      body?: unknown,
    ): Promise<Response> {
      return fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    async function createNote(
      jwt: string,
      overrides: Record<string, unknown> = {},
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await api('POST', '/v1/activities', jwt, {
        type: 'note',
        subject_type: 'requisition',
        subject_id: REQ_SUBJECT,
        notes: 'a logged note',
        ...overrides,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    async function events(
      activityId: string,
    ): Promise<Array<{ event_type: string; actor_user_id: string; tenant_id: string; metadata: unknown }>> {
      const r = await db.query(
        `SELECT event_type, actor_user_id, tenant_id, metadata
           FROM activity."ActivityNoteEvent" WHERE activity_id = $1::uuid
          ORDER BY created_at ASC`,
        [activityId],
      );
      return r.rows;
    }

    async function noteRow(
      activityId: string,
    ): Promise<{ category: string; visibility: string; body_format: string; is_pinned: boolean; pinned_by_id: string | null } | undefined> {
      const r = await db.query(
        `SELECT category, visibility, body_format, is_pinned, pinned_by_id
           FROM activity."ActivityNote" WHERE activity_id = $1::uuid`,
        [activityId],
      );
      return r.rows[0];
    }

    const countType = (
      evs: Array<{ event_type: string }>,
      t: string,
    ): number => evs.filter((e) => e.event_type === t).length;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS_PRE_EXTENSION) await db.query(readFileSync(p, 'utf8'));
      // AC-1 — seed a LEGACY note (no ActivityNote extension yet) BEFORE the RN-1
      // migration, so its in-migration backfill runs on real pre-existing data.
      await db.query(
        `INSERT INTO activity."Activity" (id, tenant_id, type, subject_type, subject_id, notes)
         VALUES ($1::uuid, $2::uuid, 'note', 'requisition', $3::uuid, 'legacy body kept verbatim')`,
        [LEGACY_ID, TENANT, REQ_SUBJECT],
      );
      for (const p of MIGRATIONS_POST_EXTENSION) await db.query(readFileSync(p, 'utf8'));
      await ensureWriteFreezeTenant((s) => db.query(s), TENANT);
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
         VALUES ($1::uuid, 'ats') ON CONFLICT (tenant_id, capability) DO NOTHING`,
        [TENANT],
      );

      const kp = await generateKeyPair(ALG);
      signingKey = kp.privateKey as SignKey;
      const pem = await exportSPKI(kp.publicKey as never);
      savedEnv = {
        DATABASE_URL: process.env['DATABASE_URL'],
        AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
        AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
        MAILER_PROVIDER: process.env['MAILER_PROVIDER'],
      };
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = pem;
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER)
        .useValue(__authzTestResolver)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
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

    // ---- A. migration / backfill (AC-1) ---------------------------------
    it('legacy note survives the RN-1 backfill: body unchanged, defaults GENERAL/TEAM/plain_text/not-pinned', async () => {
      const act = await db.query(
        `SELECT notes FROM activity."Activity" WHERE id = $1::uuid`,
        [LEGACY_ID],
      );
      expect(act.rows).toHaveLength(1);
      expect(act.rows[0].notes).toBe('legacy body kept verbatim'); // body unchanged (Q2)
      const note = await noteRow(LEGACY_ID);
      expect(note).toMatchObject({
        category: 'GENERAL',
        visibility: 'TEAM',
        body_format: 'plain_text',
        is_pinned: false,
      });
    });

    // ---- B. body validation (AC-3) --------------------------------------
    it('accepts a 20,000-char note body', async () => {
      const res = await createNote(await jwtFor(AUTHOR, READER_SCOPES), {
        notes: 'x'.repeat(20000),
      });
      expect(res.status).toBe(201);
    });

    it('rejects a 20,001-char note body → 400 VALIDATION_ERROR', async () => {
      const res = await createNote(await jwtFor(AUTHOR, READER_SCOPES), {
        notes: 'x'.repeat(20001),
      });
      expect(res.status).toBe(400);
      expect((res.body as { error?: { code?: string } }).error?.code).toBe(
        'VALIDATION_ERROR',
      );
    });

    it('rejects a whitespace-only note body', async () => {
      const res = await createNote(await jwtFor(AUTHOR, READER_SCOPES), {
        notes: '    ',
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    // ---- C. create + ledger atomicity (AC-2, AC-12) ---------------------
    it('create appends exactly ONE CREATED event (server-derived actor + tenant, no body)', async () => {
      const res = await createNote(await jwtFor(AUTHOR, READER_SCOPES), {
        notes: 'kickoff sync — private detail alpha',
        category: 'CLIENT_INTERACTION',
        visibility: 'TEAM',
      });
      expect(res.status).toBe(201);
      const id = res.body['id'] as string;
      expect(res.body['category']).toBe('CLIENT_INTERACTION');

      const evs = await events(id);
      expect(evs).toHaveLength(1);
      expect(evs[0].event_type).toBe('CREATED');
      expect(evs[0].actor_user_id).toBe(AUTHOR); // AC-12 server-derived actor
      expect(evs[0].tenant_id).toBe(TENANT); // AC-12 trusted-context tenant
      // AC-12 no-content: the event row carries no substring of the note body.
      expect(JSON.stringify(evs[0])).not.toContain('private detail alpha');
      // metadata carries only IDs/enums/booleans (allowed non-content).
      expect(Object.keys(evs[0].metadata as object).sort()).toEqual([
        'category',
        'is_pinned',
        'visibility',
      ]);
    });

    it('pin-at-create records is_pinned in the CREATED event, not a separate PINNED', async () => {
      const res = await createNote(await jwtFor(AUTHOR, READER_SCOPES), {
        pinned: true,
      });
      const id = res.body['id'] as string;
      const evs = await events(id);
      expect(evs).toHaveLength(1);
      expect(evs[0].event_type).toBe('CREATED');
      expect((evs[0].metadata as { is_pinned: boolean }).is_pinned).toBe(true);
      expect((await noteRow(id))?.is_pinned).toBe(true);
    });

    it('forced event-insert failure ROLLS BACK the whole create (AC-12 atomicity)', async () => {
      // A CHECK that every real insert violates (actor is never the zero-uuid),
      // NOT VALID so existing rows are not re-checked.
      await db.query(
        `ALTER TABLE activity."ActivityNoteEvent"
           ADD CONSTRAINT tmp_reject_all
           CHECK (actor_user_id = '00000000-0000-0000-0000-000000000000'::uuid) NOT VALID`,
      );
      const before = await db.query(`SELECT count(*)::int AS n FROM activity."Activity"`);
      const res = await createNote(await jwtFor(AUTHOR, READER_SCOPES), {
        notes: 'this create must not survive',
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
      const after = await db.query(`SELECT count(*)::int AS n FROM activity."Activity"`);
      expect(after.rows[0].n).toBe(before.rows[0].n); // no Activity survived
      await db.query(
        `ALTER TABLE activity."ActivityNoteEvent" DROP CONSTRAINT tmp_reject_all`,
      );
    });

    // ---- D. PRIVATE visibility (AC-5, AC-7) -----------------------------
    it('PRIVATE note: author reads it, a different see-all user does NOT; TEAM stays visible', async () => {
      const authorJwt = await jwtFor(AUTHOR, READER_SCOPES);
      const strangerJwt = await jwtFor(STRANGER, READER_SCOPES);
      const priv = await createNote(authorJwt, {
        notes: 'private working note',
        visibility: 'PRIVATE',
      });
      const team = await createNote(authorJwt, {
        notes: 'team-visible note',
        visibility: 'TEAM',
      });
      const privId = priv.body['id'];
      const teamId = team.body['id'];

      const listFor = async (jwt: string): Promise<string[]> => {
        const res = await api(
          'GET',
          `/v1/activities?subject_type=requisition&subject_id=${REQ_SUBJECT}`,
          jwt,
        );
        const body = (await res.json()) as { items: Array<{ id: string }> };
        return body.items.map((i) => i.id);
      };

      const authorSees = await listFor(authorJwt);
      const strangerSees = await listFor(strangerJwt);
      expect(authorSees).toContain(privId); // AC-5 author reads own PRIVATE
      expect(strangerSees).not.toContain(privId); // AC-5/AC-7 no cross-user leak
      expect(strangerSees).toContain(teamId); // TEAM visible to the team
    });

    // ---- E. pin / unpin idempotency + events (AC-8) ---------------------
    it('pin/unpin append one event each; repeats are no-ops; provenance recorded', async () => {
      const jwt = await jwtFor(AUTHOR, READER_SCOPES);
      const id = (await createNote(jwt)).body['id'] as string;

      expect((await api('POST', `/v1/activities/${id}/pin`, jwt)).status).toBe(200);
      expect((await api('POST', `/v1/activities/${id}/pin`, jwt)).status).toBe(200); // no-op
      expect((await api('POST', `/v1/activities/${id}/unpin`, jwt)).status).toBe(200);
      expect((await api('POST', `/v1/activities/${id}/unpin`, jwt)).status).toBe(200); // no-op

      const evs = await events(id);
      expect(countType(evs, 'CREATED')).toBe(1);
      expect(countType(evs, 'PINNED')).toBe(1); // re-pin appended nothing
      expect(countType(evs, 'UNPINNED')).toBe(1); // re-unpin appended nothing
      const note = await noteRow(id);
      expect(note?.is_pinned).toBe(false);
      expect(note?.pinned_by_id).toBeNull(); // unpin cleared provenance
    });

    // ---- F. redaction + REDACTED event (AC-6) ---------------------------
    it('redact clears the body, retains the row, and appends exactly one REDACTED event', async () => {
      const jwt = await jwtFor(AUTHOR, READER_SCOPES);
      const id = (await createNote(jwt, { notes: 'sensitive body to remove' })).body[
        'id'
      ] as string;
      const res = await api('POST', `/v1/activities/${id}/redact`, jwt, {
        redaction_reason_code: 'CONTAINED_SENSITIVE_DATA',
        redaction_reason: 'contained a home address',
      });
      expect(res.status).toBe(200);
      const raw = await db.query(
        `SELECT notes, redacted_at FROM activity."Activity" WHERE id = $1::uuid`,
        [id],
      );
      expect(raw.rows[0].notes).toBeNull();
      expect(raw.rows[0].redacted_at).not.toBeNull();
      const evs = await events(id);
      expect(countType(evs, 'REDACTED')).toBe(1);
      // AC-12 no-content: REDACTED metadata carries only the reason CODE.
      const red = evs.find((e) => e.event_type === 'REDACTED');
      expect(JSON.stringify(red)).not.toContain('home address');
    });

    // ---- G. event immutability — DB trigger (Rule-F negative control) ---
    it('ActivityNoteEvent is append-only at the DB: INSERT ok, UPDATE and DELETE raise', async () => {
      const id = (await createNote(await jwtFor(AUTHOR, READER_SCOPES))).body['id'] as string;
      const ev = await db.query(
        `SELECT id FROM activity."ActivityNoteEvent" WHERE activity_id = $1::uuid LIMIT 1`,
        [id],
      );
      const evId = ev.rows[0].id as string;
      await expect(
        db.query(
          `UPDATE activity."ActivityNoteEvent" SET event_type = 'PINNED' WHERE id = $1::uuid`,
          [evId],
        ),
      ).rejects.toThrow();
      await expect(
        db.query(`DELETE FROM activity."ActivityNoteEvent" WHERE id = $1::uuid`, [evId]),
      ).rejects.toThrow();
    });

    // ---- I. Note != Evidence (AC-15) ------------------------------------
    it('creating CLIENT_INTERACTION / COMMERCIAL notes writes ONLY the activity schema', async () => {
      const jwt = await jwtFor(AUTHOR, READER_SCOPES);
      const before = await db.query(
        `SELECT count(*)::int AS n FROM activity."ActivityNoteEvent"`,
      );
      await createNote(jwt, { notes: 'client wants X', category: 'CLIENT_INTERACTION' });
      await createNote(jwt, { notes: 'rate is $85/hr', category: 'COMMERCIAL' });
      const after = await db.query(
        `SELECT count(*)::int AS n FROM activity."ActivityNoteEvent"`,
      );
      // Exactly two CREATED events — the ONLY side effect. The communications,
      // selection, offer, placement, assignment, pre-start and commercial
      // schemas are not even migrated in this DB, so a note create physically
      // cannot (and does not) write authoritative state elsewhere; the 201
      // responses prove the write path is confined to the activity schema.
      expect(after.rows[0].n - before.rows[0].n).toBe(2);
    });
  },
);
