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
import { v7 as uuidv7 } from 'uuid';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TalentTrustService,
  TalentTrustRepository,
  type SubjectRef,
} from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';
import { DossierService } from '../talent-identity/dossier.service.js';

// TR-15 B1 (DDR §2 / directive §5) — the dispute machinery, completed. Proves
// the arms against real Postgres: the VALID-only raise guard + idempotent repeat
// (a); DISPUTED excluded from accrual + has_open_dispute flipped, the existing
// derivation regression-proven under its FIRST real caller (b); resolve both
// outcomes — rejected → VALID (accrual restored), upheld → DISPUTE_RESOLVED +
// REVOKED atomically (both events, one tx; a mid-tx failure leaves NEITHER) (c);
// the API gated on identity:resolve; and the dossier timeline ride-along (e).
// The decision-log gate (d) is pinned by the ats-web consent pact (consumer 403
// + provider verification against the real guarded route).

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
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
  'libs/talent-trust/prisma/migrations/20260708120000_tr3_b1_verification_request/migration.sql',
  'libs/talent-trust/prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
  'libs/talent-trust/prisma/migrations/20260712120000_tr8_b1_verified_control_stale/migration.sql',
  'libs/talent-trust/prisma/migrations/20260713120000_tr12_b1_verification_proposal/migration.sql',
].map(M);

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-tr15-b1-spec';
const TENANT = '01900000-0000-7000-8000-0000000000f1';
const ADMIN = '00000000-0000-7000-8000-00000000f001';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-15 B1 — dispute completion + the API (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: INestApplication;
    let module: TestingModule;
    let db: Client;
    let port = 0;
    let privateKey: SignKey;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let trust: TalentTrustService;
    let repo: TalentTrustRepository;
    let dossier: DossierService;

    async function signJwt(scopes: string[]): Promise<string> {
      return new SignJWT({ sub: ADMIN, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: TENANT, scopes })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }
    async function post(path: string, jwt: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    }
    // The locked envelope is { error: { code, message, request_id, details } }.
    const codeOf = (body: Record<string, unknown>): string | undefined =>
      (body['error'] as Record<string, unknown> | undefined)?.['code'] as string | undefined;

    const refFor = (talentId: string): SubjectRef => ({
      tenant_id: TENANT,
      ref_type: 'ATS_TALENT_RECORD',
      ref_id: talentId,
    });

    // A VALID, authoritative CLAIMS record → the CLAIMS band reaches AUTHORITATIVE
    // when it accrues, and collapses to NOT_ESTABLISHED when it stops (disputed /
    // revoked). This is the single-evidence lever for the accrual assertions.
    async function seedAuthoritativeClaim(talentId: string, srcId: string): Promise<string> {
      const ev = await trust.recordEvidence({
        subjectRef: refFor(talentId),
        dimension: 'CLAIMS',
        assertion_type: 'CERTIFICATION',
        assertion_payload: { name_raw: 'CKA' },
        source_class: 'AUTHORITATIVE_ISSUER',
        method: 'API_REGISTRY',
        source_ref: { talent_evidence_id: srcId },
        portability_class: 'TENANT_ONLY',
        decay_profile: 'MODERATE',
        created_by: 'tr15-test',
      });
      await trust.recomputeTrustState((await trust.resolveSubjectRef(refFor(talentId)))!.id, TENANT);
      return ev.id;
    }
    async function statusOf(evidenceId: string): Promise<string> {
      const r = await db.query<{ current_status: string }>(
        `SELECT current_status FROM talent_trust."EvidenceRecord" WHERE id = $1::uuid`,
        [evidenceId],
      );
      return r.rows[0]!.current_status;
    }
    async function eventTypes(evidenceId: string): Promise<string[]> {
      const r = await db.query<{ event_type: string }>(
        `SELECT event_type FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid ORDER BY occurred_at ASC, id ASC`,
        [evidenceId],
      );
      return r.rows.map((x) => x.event_type);
    }
    async function claimsBand(talentId: string): Promise<string | undefined> {
      const s = await trust.getTrustState(refFor(talentId));
      return s?.claims_band;
    }
    async function hasOpenDispute(talentId: string): Promise<boolean | undefined> {
      const s = await trust.getTrustState(refFor(talentId));
      return s?.has_open_dispute;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.query(
        `INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid, 'TR15B1', now()) ON CONFLICT DO NOTHING`,
        [TENANT],
      );
      await db.query(
        `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'core') ON CONFLICT DO NOTHING`,
        [TENANT],
      );

      const kp = await generateKeyPair('RS256');
      const publicPem = await exportSPKI(kp.publicKey as never);
      privateKey = kp.privateKey as SignKey;
      for (const k of ['DATABASE_URL', 'AUTH_AUDIENCE', 'AUTH_PUBLIC_KEY', 'MAILER_PROVIDER'] as const) {
        savedEnv[k] = process.env[k];
      }
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = AUDIENCE;
      process.env['AUTH_PUBLIC_KEY'] = publicPem;
      process.env['MAILER_PROVIDER'] = 'stub';

      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
      trust = module.get(TalentTrustService);
      repo = module.get(TalentTrustRepository);
      dossier = module.get(DossierService);
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
      for (const t of ['EvidenceLink', 'EvidenceEvent', 'EvidenceRecord', 'TrustState', 'ResolutionSubjectRef', 'ResolutionSubject']) {
        await db.query(`TRUNCATE TABLE talent_trust."${t}" CASCADE`);
      }
    });

    const RAISE = (id: string): string => `/v1/talent/identity/disputes/${id}/raise`;
    const RESOLVE = (id: string): string => `/v1/talent/identity/disputes/${id}/resolve`;

    // ---- (a) raise both ways + idempotent repeat ---------------------------
    it('(a) a VALID record disputes with a full actor+grounds audit; non-VALID refuses; repeat no-ops', async () => {
      const talent = uuidv7();
      const ev = await seedAuthoritativeClaim(talent, 's1');
      const jwt = await signJwt(['identity:resolve']);

      // VALID → DISPUTED, one audit event carrying actor (JWT sub) + grounds.
      const r1 = await post(RAISE(ev), jwt, { grounds: 'talent objects: certification expired' });
      expect(r1.status).toBe(200);
      expect(r1.body['status']).toBe('DISPUTED');
      expect(await statusOf(ev)).toBe('DISPUTED');
      const auditRow = await db.query<{ actor: string | null; reason: string | null }>(
        `SELECT actor, reason FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid AND event_type = 'DISPUTED'`,
        [ev],
      );
      expect(auditRow.rows[0]!.actor).toBe(ADMIN);
      expect(auditRow.rows[0]!.reason).toBe('talent objects: certification expired');

      // Repeat raise on the already-DISPUTED record → idempotent no-op (still
      // DISPUTED, still exactly ONE DISPUTED event).
      const r2 = await post(RAISE(ev), jwt, { grounds: 'again' });
      expect(r2.status).toBe(200);
      expect(r2.body['status']).toBe('DISPUTED');
      expect((await eventTypes(ev)).filter((t) => t === 'DISPUTED').length).toBe(1);

      // A non-VALID record refuses with EVIDENCE_NOT_DISPUTABLE (422).
      const other = await seedAuthoritativeClaim(uuidv7(), 's2');
      await trust.markStale(other);
      const r3 = await post(RAISE(other), jwt, { grounds: 'x' });
      expect(r3.status).toBe(422);
      expect(codeOf(r3.body)).toBe('EVIDENCE_NOT_DISPUTABLE');
    });

    // ---- (b) DISPUTED accrues nothing; has_open_dispute flips ---------------
    it('(b) a DISPUTED record accrues nothing (band collapses) and has_open_dispute flips — the derivation regression-proven under the first real caller', async () => {
      const talent = uuidv7();
      const ev = await seedAuthoritativeClaim(talent, 's1');
      expect(await claimsBand(talent)).toBe('AUTHORITATIVE');
      expect(await hasOpenDispute(talent)).toBe(false);

      const jwt = await signJwt(['identity:resolve']);
      await post(RAISE(ev), jwt, { grounds: 'objection' });

      // The single evidence is now DISPUTED → excluded from accrual → the band
      // collapses; the rollup flag flips true.
      expect(await claimsBand(talent)).toBe('NOT_ESTABLISHED');
      expect(await hasOpenDispute(talent)).toBe(true);
    });

    // ---- (c) resolve both outcomes; upheld is atomic -----------------------
    it('(c) rejected → VALID (accrual restored); upheld → DISPUTE_RESOLVED + REVOKED atomically', async () => {
      const jwt = await signJwt(['identity:resolve']);

      // rejected — the dispute did not hold; the record returns to VALID.
      const talentR = uuidv7();
      const evR = await seedAuthoritativeClaim(talentR, 'sr');
      await post(RAISE(evR), jwt, { grounds: 'objection' });
      const rej = await post(RESOLVE(evR), jwt, { outcome: 'rejected', justification: 'reviewed; record stands' });
      expect(rej.status).toBe(200);
      expect(rej.body['status']).toBe('VALID');
      expect(await statusOf(evR)).toBe('VALID');
      expect(await claimsBand(talentR)).toBe('AUTHORITATIVE'); // accrual restored
      expect(await hasOpenDispute(talentR)).toBe(false);

      // upheld — the evidence was wrong; DISPUTE_RESOLVED then REVOKED, both
      // events present, terminal status REVOKED, band collapses permanently.
      const talentU = uuidv7();
      const evU = await seedAuthoritativeClaim(talentU, 'su');
      await post(RAISE(evU), jwt, { grounds: 'objection' });
      const uph = await post(RESOLVE(evU), jwt, { outcome: 'upheld', justification: 'confirmed wrong; retiring' });
      expect(uph.status).toBe(200);
      expect(uph.body['status']).toBe('REVOKED');
      expect(await statusOf(evU)).toBe('REVOKED');
      expect(await eventTypes(evU)).toEqual(['CREATED', 'DISPUTED', 'DISPUTE_RESOLVED', 'REVOKED']);
      expect(await claimsBand(talentU)).toBe('NOT_ESTABLISHED');

      // A bad outcome on a standing dispute → DISPUTE_OUTCOME_INVALID (422);
      // a resolve on a non-DISPUTED record → EVIDENCE_NOT_DISPUTED (422).
      const talentB = uuidv7();
      const evB = await seedAuthoritativeClaim(talentB, 'sb');
      const notDisputed = await post(RESOLVE(evB), jwt, { outcome: 'upheld', justification: 'x' });
      expect(notDisputed.status).toBe(422);
      expect(codeOf(notDisputed.body)).toBe('EVIDENCE_NOT_DISPUTED');
      await post(RAISE(evB), jwt, { grounds: 'objection' });
      const badOutcome = await post(RESOLVE(evB), jwt, { outcome: 'maybe', justification: 'x' });
      expect(badOutcome.status).toBe(422);
      expect(codeOf(badOutcome.body)).toBe('DISPUTE_OUTCOME_INVALID');
    });

    // ---- (c-atomicity) a mid-tx failure leaves NEITHER event ----------------
    it('(c) the upheld pair is one transaction: a mid-tx failure leaves neither event', async () => {
      // EvidenceEvent has no FK to EvidenceRecord, so the two event inserts would
      // individually succeed for a non-existent id — but the record UPDATE (the
      // 3rd statement) fails (no such row), rolling back the WHOLE transaction.
      // Neither event persists.
      const ghost = uuidv7();
      await expect(
        repo.appendResolvedThenRevoked({ evidence_id: ghost, tenant_id: TENANT, actor: ADMIN, justification: 'x' }),
      ).rejects.toThrow();
      const n = await db.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM talent_trust."EvidenceEvent" WHERE evidence_id = $1::uuid`,
        [ghost],
      );
      expect(Number(n.rows[0]!.n)).toBe(0);
    });

    // ---- (a/gate) the API is gated on identity:resolve ---------------------
    it('(gate) raise/resolve refuse without the identity:resolve scope', async () => {
      const talent = uuidv7();
      const ev = await seedAuthoritativeClaim(talent, 's1');
      const noScope = await signJwt(['talent:read']); // valid session, wrong scope
      const r = await post(RAISE(ev), noScope, { grounds: 'x' });
      expect(r.status).toBe(403);
      expect(codeOf(r.body)).toBe('INSUFFICIENT_PERMISSIONS');
    });

    // ---- (e) the dossier timeline ride-along (zero renderer changes) --------
    it('(e) dispute events appear in the dossier evidence timeline unchanged', async () => {
      const talent = uuidv7();
      const ev = await seedAuthoritativeClaim(talent, 's1');
      const jwt = await signJwt(['identity:resolve']);
      await post(RAISE(ev), jwt, { grounds: 'talent objection recorded' });

      const page = await dossier.getDossierEvidence(TENANT, talent, { limit: 50 });
      const disputed = page.items.find((i) => i.event.event_type === 'DISPUTED');
      expect(disputed).toBeDefined();
      expect(disputed!.event.actor).toBe(ADMIN);
      expect(disputed!.event.reason).toBe('talent objection recorded');
    });
  },
);
