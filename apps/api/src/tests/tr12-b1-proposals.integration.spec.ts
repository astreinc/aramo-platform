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
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TalentTrustService, TalentTrustRepository } from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';
import { ConsistencyService } from '../talent-identity/consistency.service.js';
import { RecomputeSweepService } from '../talent-identity/recompute-sweep.service.js';

// TR-12 B1 (DDR §3/§4 + §5) — the caseworker's proposal substrate, end-to-end on
// real Postgres 17. Proves: (b) dedup + lifecycle (OPEN refresh / DISMISSED
// permanent no-op / new-basis new-row / dismiss guard); (c) BOTH hosts (the
// signal-driven consistency pass AND the time-driven recompute sweep, incl. a
// RENEW on a flipped verified_control_stale with ZERO new evidence); (d) the
// natural settling (renewal / resolution stop regeneration); (f) the API (keyset,
// filters, PII-lean wire, scope gating). The pure engine + the propose-never-
// dispose import assertion live in libs/talent-trust/.../proposal-generator.spec.ts.

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
const AUDIENCE = 'aramo-tr12-b1-spec';
const ALG = 'RS256';
const TENANT = '01900000-0000-7000-8000-0000000012b1';
const ACTOR = '00000000-0000-7000-8000-0000000012a1';
const READ_SCOPE = 'talent:read';
const DAY = 24 * 60 * 60 * 1000;
const EMAIL = 'ada@x.com';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-12 B1 — the caseworker: proposals, hosts, and the worklist API (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let app: INestApplication;
    let db: Client;
    let port = 0;
    let privateKey: SignKey;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let trust: TalentTrustService;
    let repo: TalentTrustRepository;
    let consistency: ConsistencyService;
    let sweep: RecomputeSweepService;

    const refOf = (recordId: string) => ({
      tenant_id: TENANT,
      ref_type: 'ATS_TALENT_RECORD' as const,
      ref_id: recordId,
    });

    async function signJwt(scopes: string[]): Promise<string> {
      return new SignJWT({
        sub: ACTOR,
        consumer_type: 'recruiter',
        actor_kind: 'user',
        tenant_id: TENANT,
        scopes,
      })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }
    async function get(path: string, jwt: string) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      return { status: res.status, json: () => res.json() as Promise<never> };
    }
    async function post(path: string, jwt: string, body: unknown) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, json: () => res.json() as Promise<never> };
    }

    // A subject with one open contradiction (basis = the evidence id).
    async function seedContradiction(recordId: string): Promise<{ subjectId: string; evidenceId: string }> {
      const ev = await trust.recordEvidence({
        subjectRef: refOf(recordId),
        dimension: 'CLAIMS',
        assertion_type: 'SKILL',
        assertion_payload: { value_raw: 'Go' },
        source_class: 'SELF',
        method: 'SELF_DECLARED',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'MODERATE',
        created_by: 'test',
      });
      await trust.contradictRecord(ev.id, 'seeded contradiction');
      const subjectId = (await trust.resolveSubjectRef(refOf(recordId)))!.id;
      return { subjectId, evidenceId: ev.id };
    }

    // A subject with an AGED platform-verification act + its anchor, and a STORED
    // TrustState primed pre-threshold (flag false, last recomputed 40d ago) so the
    // recompute sweep must flip verified_control_stale — the TR-8 (c) seed shape.
    async function seedStaleVerification(recordId: string): Promise<{ subjectId: string; anchorId: string }> {
      const aged = await trust.recordEvidence({
        subjectRef: refOf(recordId),
        dimension: 'IDENTITY',
        assertion_type: 'EMAIL_CONTROL_VERIFIED',
        assertion_payload: { normalized_value: EMAIL },
        source_class: 'PLATFORM_VERIFIED',
        method: 'CONTROL_ROUND_TRIP',
        source_ref: null,
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        collected_at: new Date(Date.now() - 400 * DAY),
        created_by: 'verification',
      });
      const subjectId = (await trust.resolveSubjectRef(refOf(recordId)))!.id;
      const anchorId = uuidv7();
      await db.query(
        `INSERT INTO talent_trust."SubjectAnchor"
           (id, subject_id, tenant_id, anchor_kind, normalized_value, source_evidence_id, source_class)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'EMAIL',$4,$5::uuid,'PLATFORM_VERIFIED')`,
        [anchorId, subjectId, TENANT, EMAIL, aged.id],
      );
      await db.query(
        `UPDATE talent_trust."TrustState"
            SET verified_control_stale = false, last_recomputed_at = now() - interval '40 days'
          WHERE subject_id = $1::uuid`,
        [subjectId],
      );
      return { subjectId, anchorId };
    }

    async function proposals(subjectId: string) {
      return repo.listProposalsForSubject(TENANT, subjectId);
    }
    async function evidenceCount(subjectId: string): Promise<number> {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM talent_trust."EvidenceRecord" WHERE subject_id = $1::uuid`,
        [subjectId],
      );
      return Number(r.rows[0]!.n);
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.query(
        `INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid,'TR12B1',now()) ON CONFLICT DO NOTHING`,
        [TENANT],
      );
      for (const cap of ['ats', 'core']) {
        await db.query(
          `INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING`,
          [TENANT, cap],
        );
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
      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = module.createNestApplication();
      app.use(cookieParser());
      app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
      );
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
      trust = module.get(TalentTrustService);
      repo = module.get(TalentTrustRepository);
      consistency = module.get(ConsistencyService);
      sweep = module.get(RecomputeSweepService);
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
      for (const t of [
        'VerificationProposal',
        'EvidenceLink',
        'EvidenceEvent',
        'EvidenceRecord',
        'TrustState',
        'SubjectAnchor',
        'VerificationRequest',
        'ResolutionSubjectRef',
        'ResolutionSubject',
      ]) {
        await db.query(`TRUNCATE TABLE talent_trust."${t}" CASCADE`);
      }
    });

    // ---- (b) dedup + lifecycle ----------------------------------------------

    it('(b) OPEN refresh, DISMISSED permanent no-op, new basis new row, dismiss guard', async () => {
      const R = uuidv7();
      const { subjectId, evidenceId } = await seedContradiction(R);

      // First generation → one OPEN RESOLVE_CONTRADICTION, basis = the evidence id.
      await trust.generateProposalsForSubject(subjectId, TENANT);
      let rows = await proposals(subjectId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe('RESOLVE_CONTRADICTION');
      expect(rows[0]!.basis_ref_id).toBe(evidenceId);
      expect(rows[0]!.status).toBe('OPEN');
      const firstId = rows[0]!.id;

      // Re-generation refreshes the OPEN row WITHOUT duplicating.
      await trust.generateProposalsForSubject(subjectId, TENANT);
      rows = await proposals(subjectId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(firstId);

      // Dismiss it, then re-generate — the DISMISSED basis NEVER re-mints.
      await trust.dismissProposal({
        tenant_id: TENANT,
        id: firstId,
        dismissed_by: ACTOR,
        justification: 'not now',
        requestId: 'req-1',
      });
      await trust.generateProposalsForSubject(subjectId, TENANT);
      rows = await proposals(subjectId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('DISMISSED');

      // A materially NEW basis (a second contradiction) mints a NEW row.
      const ev2 = await trust.recordEvidence({
        subjectRef: refOf(R),
        dimension: 'CLAIMS',
        assertion_type: 'SKILL',
        assertion_payload: { value_raw: 'Rust' },
        source_class: 'SELF',
        method: 'SELF_DECLARED',
        portability_class: 'TENANT_ONLY',
        decay_profile: 'MODERATE',
        created_by: 'test',
      });
      await trust.contradictRecord(ev2.id, 'second contradiction');
      await trust.generateProposalsForSubject(subjectId, TENANT);
      rows = await proposals(subjectId);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.basis_ref_id))).toEqual(new Set([evidenceId, ev2.id]));

      // The dismiss guard: dismissing the already-DISMISSED row → PROPOSAL_NOT_OPEN.
      await expect(
        trust.dismissProposal({
          tenant_id: TENANT,
          id: firstId,
          dismissed_by: ACTOR,
          justification: 'again',
          requestId: 'req-2',
        }),
      ).rejects.toMatchObject({ code: 'PROPOSAL_NOT_OPEN', statusCode: 409 });
    });

    // ---- (c) BOTH hosts ------------------------------------------------------

    it('(c1) the signal-driven consistency pass mints on an open contradiction', async () => {
      const R = uuidv7();
      const { subjectId, evidenceId } = await seedContradiction(R);
      // The fresh subject (last_consistency_at NULL) is selected; the pass runs the
      // detectors + recompute, then the caseworker.
      const res = await consistency.drainBatch({ batchSize: 100 });
      expect(res.checked).toBeGreaterThanOrEqual(1);
      const rows = await proposals(subjectId);
      const resolveRows = rows.filter((r) => r.kind === 'RESOLVE_CONTRADICTION');
      expect(resolveRows).toHaveLength(1);
      expect(resolveRows[0]!.basis_ref_id).toBe(evidenceId);
    });

    it('(c2) the time-driven recompute sweep mints a RENEW on a flipped stale flag with ZERO new evidence', async () => {
      const R = uuidv7();
      const { subjectId, anchorId } = await seedStaleVerification(R);
      const before = await evidenceCount(subjectId);

      const res = await sweep.drainBatch({ batchSize: 100 });
      expect(res.recomputed).toBeGreaterThanOrEqual(1);

      // The flag flipped via recompute (no explicit write) …
      const flag = await db.query<{ verified_control_stale: boolean }>(
        `SELECT verified_control_stale FROM talent_trust."TrustState" WHERE subject_id = $1::uuid`,
        [subjectId],
      );
      expect(flag.rows[0]!.verified_control_stale).toBe(true);
      // … the caseworker minted a RENEW, basis = the anchor id …
      const rows = await proposals(subjectId);
      const renew = rows.filter((r) => r.kind === 'RENEW_VERIFICATION');
      expect(renew).toHaveLength(1);
      expect(renew[0]!.basis_ref_id).toBe(anchorId);
      // … and NO new evidence was written (generation is read + proposal-write only).
      expect(await evidenceCount(subjectId)).toBe(before);
    });

    // ---- (d) the natural settling -------------------------------------------

    it('(d1) resolving the contradiction stops regeneration (no new RESOLVE minted)', async () => {
      const R = uuidv7();
      const { subjectId, evidenceId } = await seedContradiction(R);
      await trust.generateProposalsForSubject(subjectId, TENANT);
      expect((await proposals(subjectId)).filter((r) => r.kind === 'RESOLVE_CONTRADICTION')).toHaveLength(1);

      // The human resolves it (executed directly in-test). The contradiction clears.
      await trust.resolveContradiction(evidenceId, ACTOR, 'resolved', 'req-r');
      await trust.generateProposalsForSubject(subjectId, TENANT);
      // Still exactly one RESOLVE row — nothing NEW minted (the trigger cleared).
      expect((await proposals(subjectId)).filter((r) => r.kind === 'RESOLVE_CONTRADICTION')).toHaveLength(1);
    });

    it('(d2) renewal clears the flag → the next generation mints nothing new', async () => {
      const R = uuidv7();
      const { subjectId } = await seedStaleVerification(R);
      await sweep.drainBatch({ batchSize: 100 });
      const renewBefore = (await proposals(subjectId)).filter((r) => r.kind === 'RENEW_VERIFICATION');
      expect(renewBefore).toHaveLength(1);

      // Renew directly (mint a fresh VALID act; supersede the aged one) → flag clears.
      await trust.recordEvidence({
        subjectRef: refOf(R),
        dimension: 'IDENTITY',
        assertion_type: 'EMAIL_CONTROL_VERIFIED',
        assertion_payload: { normalized_value: EMAIL },
        source_class: 'PLATFORM_VERIFIED',
        method: 'CONTROL_ROUND_TRIP',
        source_ref: null,
        portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW',
        collected_at: new Date(),
        created_by: 'verification',
      });
      await trust.recomputeTrustState(subjectId, TENANT);
      await trust.generateProposalsForSubject(subjectId, TENANT);
      // No NEW RENEW row (the flag is clear; the generator emits nothing for it).
      const renewAfter = (await proposals(subjectId)).filter((r) => r.kind === 'RENEW_VERIFICATION');
      expect(renewAfter).toHaveLength(1);
      expect(renewAfter[0]!.id).toBe(renewBefore[0]!.id);
    });

    // ---- (f) the API: keyset, filters, PII-lean wire, scope gating -----------

    it('(f1) list requires talent:read (403 without it) and returns PII-lean items with no numbers', async () => {
      const R = uuidv7();
      const { subjectId } = await seedContradiction(R);
      await trust.generateProposalsForSubject(subjectId, TENANT);

      // Scope gating — without talent:read the queue is forbidden.
      const forbidden = await get('/v1/talent/identity/proposals', await signJwt([]));
      expect(forbidden.status).toBe(403);

      const ok = await get('/v1/talent/identity/proposals', await signJwt([READ_SCOPE]));
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { items: Array<Record<string, unknown>>; next_cursor: string | null };
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      const item = body.items[0]!;
      // PII-lean shape: kinds + pointers + timestamps only.
      expect(item['kind']).toBe('RESOLVE_CONTRADICTION');
      expect(Array.isArray(item['basis_kinds'])).toBe(true);
      // No value, no number anywhere on the wire. A positive allowlist: every key
      // is in the allowed set — no ordering ordinal of any name, no raw snapshot.
      // record_id/slot are the B2 act-target enrichment (optional; UUID pointer +
      // slot NAME, never a value or a number).
      const wire = JSON.stringify(body);
      expect(wire).not.toContain(EMAIL);
      const ALLOWED = new Set([
        'basis_kinds',
        'basis_ref_id',
        'created_at',
        'id',
        'kind',
        'status',
        'subject_id',
        'tenant_id',
        'trigger_kind',
        'record_id',
        'slot',
      ]);
      for (const k of Object.keys(item)) expect(ALLOWED.has(k)).toBe(true);
      // Every field is a string or an array of strings — never a number.
      for (const v of Object.values(item)) {
        if (Array.isArray(v)) for (const e of v) expect(typeof e).toBe('string');
        else expect(typeof v).toBe('string');
      }
    });

    it('(f2) keyset paging is stable and status/kind filters apply', async () => {
      // Three subjects each with a contradiction → three OPEN RESOLVE proposals.
      const subs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { subjectId } = await seedContradiction(uuidv7());
        await trust.generateProposalsForSubject(subjectId, TENANT);
        subs.push(subjectId);
      }
      const jwt = await signJwt([READ_SCOPE]);

      // Page 1 (limit 2) → next_cursor present.
      const p1 = (await (await get('/v1/talent/identity/proposals?limit=2', jwt)).json()) as {
        items: Array<{ id: string; created_at: string }>;
        next_cursor: string | null;
      };
      expect(p1.items).toHaveLength(2);
      expect(p1.next_cursor).not.toBeNull();

      // Page 2 via the cursor → the remaining item, no overlap.
      const p2 = (await (
        await get(`/v1/talent/identity/proposals?limit=2&cursor=${p1.next_cursor}`, jwt)
      ).json()) as { items: Array<{ id: string }>; next_cursor: string | null };
      expect(p2.items.length).toBeGreaterThanOrEqual(1);
      const p1ids = new Set(p1.items.map((i) => i.id));
      for (const i of p2.items) expect(p1ids.has(i.id)).toBe(false);

      // kind filter — RENEW returns none (all seeded are RESOLVE).
      const renew = (await (
        await get('/v1/talent/identity/proposals?kind=RENEW_VERIFICATION', jwt)
      ).json()) as { items: unknown[] };
      expect(renew.items).toHaveLength(0);

      // status filter — DISMISSED returns none yet.
      const dismissed = (await (
        await get('/v1/talent/identity/proposals?status=DISMISSED', jwt)
      ).json()) as { items: unknown[] };
      expect(dismissed.items).toHaveLength(0);
    });

    it('(f3) dismiss over HTTP: 200 → DISMISSED, re-dismiss 409, empty justification 400', async () => {
      const R = uuidv7();
      const { subjectId } = await seedContradiction(R);
      await trust.generateProposalsForSubject(subjectId, TENANT);
      const id = (await proposals(subjectId))[0]!.id;
      const jwt = await signJwt([READ_SCOPE]);

      const ok = await post(`/v1/talent/identity/proposals/${id}/dismiss`, jwt, {
        justification: 'handled offline',
      });
      expect(ok.status).toBe(200);
      expect((await proposals(subjectId))[0]!.status).toBe('DISMISSED');

      // Re-dismiss the terminal row → 409 PROPOSAL_NOT_OPEN.
      const again = await post(`/v1/talent/identity/proposals/${id}/dismiss`, jwt, {
        justification: 'again',
      });
      expect(again.status).toBe(409);

      // Empty justification → 400 (the pipe's VALIDATION_ERROR, distinct from 409).
      const R2 = uuidv7();
      const { subjectId: s2 } = await seedContradiction(R2);
      await trust.generateProposalsForSubject(s2, TENANT);
      const id2 = (await proposals(s2))[0]!.id;
      const empty = await post(`/v1/talent/identity/proposals/${id2}/dismiss`, jwt, {
        justification: '',
      });
      expect(empty.status).toBe(400);
    });
  },
);
