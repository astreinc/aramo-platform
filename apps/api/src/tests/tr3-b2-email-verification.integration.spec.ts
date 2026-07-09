import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
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
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAILER_PORT } from '@aramo/mailer';
import { TalentTrustService } from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';
import { VerificationConfirmBudget } from '../controllers/public-verification.controller.js';

import { applyTalentRecordMigrations } from './talent-record-fixtures.js';

// TR-3 B2 (§5) — the email-verification flow over real Postgres 17. Boots the
// AppModule, seeds a live TalentRecord + consent + a SELF email anchor, and
// drives request → send (spy mailer) → public confirm → mint, asserting the
// nine §5 acceptance criteria (a)-(i) except (h) pact (proven in the pact suite).

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
  'libs/consent/prisma/migrations/20260630170000_rekey_consent_to_talent_record/migration.sql',
  // talent_trust — all migrations, INCLUDING the T3-B1 VerificationRequest table
  // this slice writes to (regenerated client SELECTs its columns).
  'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  'libs/talent-trust/prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706120000_ats_ref_partial_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706160000_sourcing_pool_keyset_index/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
  'libs/talent-trust/prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
  'libs/talent-trust/prisma/migrations/20260712120000_tr8_b1_verified_control_stale/migration.sql',
  'libs/talent-trust/prisma/migrations/20260708120000_tr3_b1_verification_request/migration.sql',
].map(M);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-tr3-b2-verification-spec';
const ALG = 'RS256';

const TENANT_A = '01900000-0000-7000-8000-0000000000a1';
const TENANT_B = '01900000-0000-7000-8000-0000000000b2';
const RECRUITER = '00000000-0000-7000-8000-00000000c001';
const EDIT_SCOPES = ['talent:edit', 'talent:read'];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-3 B2 — email-verification flow (request → confirm → mint, real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let privateKey: SignKey;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    const mailerSpy = { send: vi.fn().mockResolvedValue({ message_id: 'spy-1' }) };

    async function signJwt(scopes: string[], tenant = TENANT_A): Promise<string> {
      return new SignJWT({
        sub: RECRUITER,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: tenant,
        scopes,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }

    async function post(
      path: string,
      jwt: string,
      body: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, body: json };
    }

    async function get(
      path: string,
      jwt: string,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, body: json };
    }

    // The PUBLIC confirm — NO Authorization header (the talent has no session).
    async function postConfirm(
      body: unknown,
    ): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}/v1/email-verifications/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, body: json };
    }

    // Seed a live TalentRecord with a stored email1 (email2 optional).
    async function seedRecord(args: {
      id: string;
      tenant_id: string;
      email1?: string | null;
      email2?: string | null;
      record_status?: string;
    }): Promise<void> {
      await db.query(
        `INSERT INTO talent_record."TalentRecord"
           (id, tenant_id, first_name, last_name, email1, email2, record_status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'Ada', 'Verify', $3, $4, $5, now(), now())`,
        [
          args.id,
          args.tenant_id,
          args.email1 ?? null,
          args.email2 ?? null,
          args.record_status ?? 'live',
        ],
      );
    }

    // Grant the full consent chain (profile_storage + matching + contacting) so a
    // contacting/email check is `allowed`.
    async function grantFullConsent(talentId: string, tenantId: string): Promise<void> {
      for (const scope of ['profile_storage', 'matching', 'contacting']) {
        await db.query(
          `INSERT INTO consent."TalentConsentEvent"
             (id, talent_record_id, tenant_id, scope, action, captured_by_actor_id,
              captured_method, consent_version, occurred_at, created_at)
           VALUES ($1, $2::uuid, $3::uuid, $4, 'granted', $5::uuid,
                   'recruiter_capture', 'v1', now(), now())`,
          [randomUUID(), talentId, tenantId, scope, RECRUITER],
        );
      }
    }

    // Grant the prerequisite chain but NOT contacting → check returns `denied`
    // (consent_not_granted), NOT the 422 dependency path.
    async function grantPrereqOnly(talentId: string, tenantId: string): Promise<void> {
      for (const scope of ['profile_storage', 'matching']) {
        await db.query(
          `INSERT INTO consent."TalentConsentEvent"
             (id, talent_record_id, tenant_id, scope, action, captured_by_actor_id,
              captured_method, consent_version, occurred_at, created_at)
           VALUES ($1, $2::uuid, $3::uuid, $4, 'granted', $5::uuid,
                   'recruiter_capture', 'v1', now(), now())`,
          [randomUUID(), talentId, tenantId, scope, RECRUITER],
        );
      }
    }

    function trust(): TalentTrustService {
      return module.get(TalentTrustService);
    }

    // Extract the raw token from the last captured verification email.
    function lastMailedToken(): string {
      const calls = mailerSpy.send.mock.calls;
      const last = calls[calls.length - 1]?.[0] as { text: string } | undefined;
      const m = /token=([^\s&]+)/.exec(last?.text ?? '');
      if (m === null) throw new Error('no token in mailed text');
      return decodeURIComponent(m[1]!);
    }

    async function anchorRows(
      subjectId: string,
      normalized: string,
    ): Promise<Array<{ source_class: string }>> {
      const r = await db.query<{ source_class: string }>(
        `SELECT source_class FROM talent_trust."SubjectAnchor"
         WHERE subject_id = $1::uuid AND anchor_kind = 'EMAIL' AND normalized_value = $2
         ORDER BY source_class`,
        [subjectId, normalized],
      );
      return r.rows;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await applyTalentRecordMigrations(db);

      for (const id of [TENANT_A, TENANT_B]) {
        await db.query(
          `INSERT INTO identity."Tenant" (id, name, updated_at)
           VALUES ($1::uuid, 'TR3B2 Tenant', now()) ON CONFLICT (id) DO NOTHING`,
          [id],
        );
        for (const cap of ['ats', 'core']) {
          await db.query(
            `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability)
             VALUES ($1::uuid, $2) ON CONFLICT (tenant_id, capability) DO NOTHING`,
            [id, cap],
          );
        }
      }

      const kp = await generateKeyPair(ALG);
      const publicPem = await exportSPKI(kp.publicKey as never);
      privateKey = kp.privateKey as SignKey;

      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['AUTH_AUDIENCE'] = process.env['AUTH_AUDIENCE'];
      savedEnv['AUTH_PUBLIC_KEY'] = process.env['AUTH_PUBLIC_KEY'];
      savedEnv['MAILER_PROVIDER'] = process.env['MAILER_PROVIDER'];
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MAILER_PORT)
        .useValue(mailerSpy)
        .compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    beforeEach(async () => {
      mailerSpy.send.mockClear();
      // Isolate the shared per-process confirm budget between tests.
      module.get(VerificationConfirmBudget).reset();
      // A clean ledger each test (avoid cross-test anchor/request bleed).
      await db.query('TRUNCATE TABLE talent_trust."SubjectAnchor" CASCADE');
      await db.query('TRUNCATE TABLE talent_trust."VerificationRequest" CASCADE');
      await db.query('TRUNCATE TABLE talent_trust."EvidenceRecord" CASCADE');
      await db.query('TRUNCATE TABLE talent_trust."TrustState" CASCADE');
      await db.query('TRUNCATE TABLE talent_trust."ResolutionSubjectRef" CASCADE');
      await db.query('TRUNCATE TABLE talent_trust."ResolutionSubject" CASCADE');
      await db.query('TRUNCATE TABLE talent_record."TalentRecord" CASCADE');
      await db.query('TRUNCATE TABLE consent."TalentConsentEvent" CASCADE');
    });

    // ---- (a) consent divergence — denied AND empty-ledger both → 403 --------

    it('(a) consent DENIED → 403 VERIFICATION_CONSENT_REQUIRED', async () => {
      const rec = uuidv7();
      await seedRecord({ id: rec, tenant_id: TENANT_A, email1: 'a@example.com' });
      await grantPrereqOnly(rec, TENANT_A); // contacting absent → denied

      const res = await post(
        `/v1/talent-records/${rec}/email-verifications`,
        await signJwt(EDIT_SCOPES),
        { slot: 'email1' },
      );
      expect(res.status).toBe(403);
      expect((res.body['error'] as Record<string, unknown>)['code']).toBe(
        'VERIFICATION_CONSENT_REQUIRED',
      );
      expect(mailerSpy.send).not.toHaveBeenCalled();
    });

    it('(a) consent EMPTY-LEDGER (unknown) → 403 — the ruled divergence from the engagement 500', async () => {
      const rec = uuidv7();
      await seedRecord({ id: rec, tenant_id: TENANT_A, email1: 'b@example.com' });
      // No consent events at all → resolver result:'error' (consent_state_unknown).

      const res = await post(
        `/v1/talent-records/${rec}/email-verifications`,
        await signJwt(EDIT_SCOPES),
        { slot: 'email1' },
      );
      expect(res.status).toBe(403);
      expect((res.body['error'] as Record<string, unknown>)['code']).toBe(
        'VERIFICATION_CONSENT_REQUIRED',
      );
      expect(mailerSpy.send).not.toHaveBeenCalled();
    });

    // ---- (b) superseded refused; non-tenant refused -------------------------

    it('(b) a SUPERSEDED record is refused (422 TALENT_RECORD_SUPERSEDED)', async () => {
      const rec = uuidv7();
      await seedRecord({
        id: rec,
        tenant_id: TENANT_A,
        email1: 'c@example.com',
        record_status: 'superseded',
      });
      await grantFullConsent(rec, TENANT_A);

      const res = await post(
        `/v1/talent-records/${rec}/email-verifications`,
        await signJwt(EDIT_SCOPES),
        { slot: 'email1' },
      );
      expect(res.status).toBe(422);
      expect((res.body['error'] as Record<string, unknown>)['code']).toBe(
        'TALENT_RECORD_SUPERSEDED',
      );
    });

    it('(b) a NON-TENANT record is refused (404) — findById is tenant-scoped', async () => {
      const rec = uuidv7();
      await seedRecord({ id: rec, tenant_id: TENANT_B, email1: 'd@example.com' });
      await grantFullConsent(rec, TENANT_B);

      const res = await post(
        `/v1/talent-records/${rec}/email-verifications`,
        await signJwt(EDIT_SCOPES, TENANT_A), // a TENANT_A recruiter
        { slot: 'email1' },
      );
      expect(res.status).toBe(404);
    });

    // ---- (c) recipient is ALWAYS the stored slot ----------------------------

    it('(c) the DTO admits no free-form address — a rogue "email" field is rejected/ignored, mail goes to the STORED slot', async () => {
      const rec = uuidv7();
      const stored = 'Stored.Slot@Example.COM';
      await seedRecord({ id: rec, tenant_id: TENANT_A, email1: stored });
      await grantFullConsent(rec, TENANT_A);

      // Attacker attaches an extra `email` field. forbidNonWhitelisted rejects it
      // (400) — but even were it stripped, the send would still target the slot.
      const res = await post(
        `/v1/talent-records/${rec}/email-verifications`,
        await signJwt(EDIT_SCOPES),
        { slot: 'email1', email: 'attacker@evil.test' },
      );
      expect(res.status).toBe(400);

      // A clean request mails ONLY the stored address (never the attacker value).
      const ok = await post(
        `/v1/talent-records/${rec}/email-verifications`,
        await signJwt(EDIT_SCOPES),
        { slot: 'email1' },
      );
      expect(ok.status).toBe(200);
      expect(mailerSpy.send).toHaveBeenCalledTimes(1);
      expect(mailerSpy.send.mock.calls[0]![0]).toMatchObject({ to: stored });
    });

    it('(c) a slot with NO stored address → 400 (email_slot_empty), no send', async () => {
      const rec = uuidv7();
      await seedRecord({ id: rec, tenant_id: TENANT_A, email1: 'x@example.com', email2: null });
      await grantFullConsent(rec, TENANT_A);

      const res = await post(
        `/v1/talent-records/${rec}/email-verifications`,
        await signJwt(EDIT_SCOPES),
        { slot: 'email2' }, // empty slot
      );
      expect(res.status).toBe(400);
      expect(mailerSpy.send).not.toHaveBeenCalled();
    });

    // ---- (d) idempotent open-request return; resend rotates in place --------

    it('(d) a repeat while one is open RESENDS (rotates the token in place), same request identity', async () => {
      const rec = uuidv7();
      await seedRecord({ id: rec, tenant_id: TENANT_A, email1: 'dup@example.com' });
      await grantFullConsent(rec, TENANT_A);
      const jwt = await signJwt(EDIT_SCOPES);

      const first = await post(`/v1/talent-records/${rec}/email-verifications`, jwt, {
        slot: 'email1',
      });
      expect(first.status).toBe(200);
      expect(first.body['resent']).toBe(false);
      const firstToken = lastMailedToken();

      const second = await post(`/v1/talent-records/${rec}/email-verifications`, jwt, {
        slot: 'email1',
      });
      expect(second.status).toBe(200);
      expect(second.body['resent']).toBe(true);
      // Same request identity (idempotent-return), rotated secret (resend).
      expect(second.body['verification_id']).toBe(first.body['verification_id']);
      expect(lastMailedToken()).not.toBe(firstToken);
      // Exactly one open PENDING row (no duplicate mint).
      const rows = await db.query(
        `SELECT count(*)::int AS n FROM talent_trust."VerificationRequest"
         WHERE talent_record_id = $1::uuid AND status = 'PENDING'`,
        [rec],
      );
      expect(rows.rows[0].n).toBe(1);
    });

    // ---- (e) confirm single-use + oracle-resistant + per-IP budget ----------

    it('(e) confirm is single-use (replay-guarded); replay + bad + rotated tokens all 404 byte-identically', async () => {
      const rec = uuidv7();
      await seedRecord({ id: rec, tenant_id: TENANT_A, email1: 'e@example.com' });
      await grantFullConsent(rec, TENANT_A);
      const jwt = await signJwt(EDIT_SCOPES);

      await post(`/v1/talent-records/${rec}/email-verifications`, jwt, { slot: 'email1' });
      const validToken = lastMailedToken();

      // First confirm — 200 VERIFIED.
      const first = await postConfirm({ token: validToken });
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ status: 'VERIFIED' });

      // Replay (consumed) — 404.
      const replay = await postConfirm({ token: validToken });
      expect(replay.status).toBe(404);

      // Bad token — 404.
      const bad = await postConfirm({ token: randomBytes(32).toString('base64url') });
      expect(bad.status).toBe(404);

      // Rotated ("revoked"): a fresh request then a resend kills the first token.
      const rec2 = uuidv7();
      await seedRecord({ id: rec2, tenant_id: TENANT_A, email1: 'e2@example.com' });
      await grantFullConsent(rec2, TENANT_A);
      await post(`/v1/talent-records/${rec2}/email-verifications`, jwt, { slot: 'email1' });
      const oldToken = lastMailedToken();
      await post(`/v1/talent-records/${rec2}/email-verifications`, jwt, { slot: 'email1' }); // rotate
      const rotated = await postConfirm({ token: oldToken });
      expect(rotated.status).toBe(404);

      // Missing token — 404 (folded, no "you sent no token" signal).
      const missing = await postConfirm({});
      expect(missing.status).toBe(404);

      // BYTE-IDENTICAL bodies (modulo the always-random request_id): every
      // invalid state is indistinguishable to an attacker.
      const strip = (b: Record<string, unknown>): unknown => {
        const err = { ...(b['error'] as Record<string, unknown>) };
        delete err['request_id'];
        return { error: err };
      };
      const canonical = strip(replay.body);
      expect(strip(bad.body)).toEqual(canonical);
      expect(strip(rotated.body)).toEqual(canonical);
      expect(strip(missing.body)).toEqual(canonical);
      expect((canonical as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    });

    it('(e) the per-IP budget is enforced — past the window cap even a VALID token is refused (404)', async () => {
      const rec = uuidv7();
      await seedRecord({ id: rec, tenant_id: TENANT_A, email1: 'budget@example.com' });
      await grantFullConsent(rec, TENANT_A);
      await post(
        `/v1/talent-records/${rec}/email-verifications`,
        await signJwt(EDIT_SCOPES),
        { slot: 'email1' },
      );
      const validToken = lastMailedToken();

      // Spend the whole window on bad tokens (all 404 anyway).
      for (let i = 0; i < 10; i++) {
        await postConfirm({ token: `probe-${i}` });
      }
      // The valid token now lands OVER budget → still 404 (the budget fired, not
      // the token). Proof it is the budget: without exhausting it, this token 200s.
      const overBudget = await postConfirm({ token: validToken });
      expect(overBudget.status).toBe(404);

      // Reset the window; the same valid token now confirms — proving it was live.
      module.get(VerificationConfirmBudget).reset();
      const afterReset = await postConfirm({ token: validToken });
      expect(afterReset.status).toBe(200);
      expect(afterReset.body).toEqual({ status: 'VERIFIED' });
    });

    // ---- (f) mint proven end-to-end -----------------------------------------

    it('(f) confirm mints the PLATFORM_VERIFIED anchor BESIDE the unverified row, exact evidence, IDENTITY=CORROBORATED, watermark re-selects', async () => {
      const rec = uuidv7();
      const stored = 'Mint.Me@Example.COM';
      const normalized = 'mint.me@example.com';
      await seedRecord({ id: rec, tenant_id: TENANT_A, email1: stored });
      await grantFullConsent(rec, TENANT_A);

      // Pre-existing UNVERIFIED (SELF) anchor via the ATS producer path.
      await trust().recordAnchor({
        tenant_id: TENANT_A,
        talent_record_id: rec,
        anchor_kind: 'EMAIL',
        normalized_value: normalized,
        raw_source: stored,
        created_by: 'seed',
      });
      const subject = await trust().resolveSubjectRef({
        tenant_id: TENANT_A,
        ref_type: 'ATS_TALENT_RECORD',
        ref_id: rec,
      });
      expect(subject).not.toBeNull();
      const subjectId = subject!.id;
      // Watermark it reconciled so the confirm's newer evidence is a genuine RE-select.
      await trust().markReconciled(subjectId);

      // Request → confirm.
      await post(
        `/v1/talent-records/${rec}/email-verifications`,
        await signJwt(EDIT_SCOPES),
        { slot: 'email1' },
      );
      const okConfirm = await postConfirm({ token: lastMailedToken() });
      expect(okConfirm.status).toBe(200);

      // Two anchor rows for the value: SELF (unverified) + PLATFORM_VERIFIED (new).
      const rows = await anchorRows(subjectId, normalized);
      expect(rows.map((r) => r.source_class).sort()).toEqual([
        'PLATFORM_VERIFIED',
        'SELF',
      ]);

      // The verifying evidence row is exact.
      const ev = await db.query(
        `SELECT dimension, assertion_type, source_class, method, ai_derived, created_by
         FROM talent_trust."EvidenceRecord"
         WHERE subject_id = $1::uuid AND assertion_type = 'EMAIL_CONTROL_VERIFIED'`,
        [subjectId],
      );
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0]).toMatchObject({
        dimension: 'IDENTITY',
        assertion_type: 'EMAIL_CONTROL_VERIFIED',
        source_class: 'PLATFORM_VERIFIED',
        method: 'CONTROL_ROUND_TRIP',
        ai_derived: false,
        created_by: 'verification',
      });

      // Recompute fired: IDENTITY band lifts to CORROBORATED.
      const ts = await db.query(
        `SELECT identity_band FROM talent_trust."TrustState" WHERE subject_id = $1::uuid`,
        [subjectId],
      );
      expect(ts.rows[0].identity_band).toBe('CORROBORATED');

      // The TR-6 watermark re-selects the subject (newer evidence > watermark).
      const needing = await trust().findSubjectsNeedingReconcile({ limit: 50, maxAttempts: 5 });
      expect(needing.map((n) => n.subject_id)).toContain(subjectId);

      // Status read now shows the slot verified.
      const status = await get(
        `/v1/talent-records/${rec}/email-verifications`,
        await signJwt(EDIT_SCOPES),
      );
      const items = status.body['items'] as Array<{ slot: string; status: string }>;
      expect(items.find((i) => i.slot === 'email1')?.status).toBe('verified');
    });

    // ---- (g) NO auto-resolve on confirm (DDR §5) ----------------------------

    it('(g) confirm performs NO subject merge/auto-resolve — the subject stays ACTIVE, no advisory/merge op created', async () => {
      const rec = uuidv7();
      await seedRecord({ id: rec, tenant_id: TENANT_A, email1: 'noresolve@example.com' });
      await grantFullConsent(rec, TENANT_A);
      await post(
        `/v1/talent-records/${rec}/email-verifications`,
        await signJwt(EDIT_SCOPES),
        { slot: 'email1' },
      );
      await postConfirm({ token: lastMailedToken() });

      const subj = await db.query(
        `SELECT status, merged_into_subject_id FROM talent_trust."ResolutionSubject"`,
      );
      for (const row of subj.rows) {
        expect(row.status).toBe('ACTIVE');
        expect(row.merged_into_subject_id).toBeNull();
      }
      const merges = await db.query(
        `SELECT count(*)::int AS n FROM talent_trust."SubjectMergeOperation"`,
      );
      expect(merges.rows[0].n).toBe(0);
      const advisories = await db.query(
        `SELECT count(*)::int AS n FROM talent_trust."SubjectMatchAdvisory"`,
      );
      expect(advisories.rows[0].n).toBe(0);
    });

    // ---- (i) e2e happy path via the stub mailer -----------------------------

    it('(i) e2e — request → (mailer-captured link) → confirm → verified state on the record detail', async () => {
      const rec = uuidv7();
      await seedRecord({ id: rec, tenant_id: TENANT_A, email1: 'e2e@example.com' });
      await grantFullConsent(rec, TENANT_A);
      const jwt = await signJwt(EDIT_SCOPES);

      // Before: status is not verified.
      const before = await get(`/v1/talent-records/${rec}/email-verifications`, jwt);
      const beforeItems = before.body['items'] as Array<{ slot: string; status: string }>;
      expect(beforeItems.find((i) => i.slot === 'email1')?.status).not.toBe('verified');

      const reqRes = await post(`/v1/talent-records/${rec}/email-verifications`, jwt, {
        slot: 'email1',
      });
      expect(reqRes.status).toBe(200);
      expect(reqRes.body['status']).toBe('PENDING');
      expect(mailerSpy.send).toHaveBeenCalledTimes(1);

      // Pending in-flight.
      const pending = await get(`/v1/talent-records/${rec}/email-verifications`, jwt);
      const pendingItems = pending.body['items'] as Array<{ slot: string; status: string }>;
      expect(pendingItems.find((i) => i.slot === 'email1')?.status).toBe('pending');

      // Confirm the mailed link.
      const confirmed = await postConfirm({ token: lastMailedToken() });
      expect(confirmed.status).toBe(200);

      // After: verified.
      const after = await get(`/v1/talent-records/${rec}/email-verifications`, jwt);
      const afterItems = after.body['items'] as Array<{ slot: string; status: string }>;
      expect(afterItems.find((i) => i.slot === 'email1')?.status).toBe('verified');
    });
  },
);
