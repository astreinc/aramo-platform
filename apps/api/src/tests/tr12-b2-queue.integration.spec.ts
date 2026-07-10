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
import { DossierService } from '../talent-identity/dossier.service.js';

// TR-12 B2 (§5) — the queue, the pointers, the ACT bookkeeping, end-to-end on real
// Postgres 17. Proves: (a) SETTLED both ways in both hosts (actor + justification);
// (b) the drift-heal (act without mark → settled next pass); (c) mark-acted's
// OPEN-only guard + actor + EXECUTES NOTHING; (d)-backend the act-target enrichment
// (email VERIFY → slot + record_id, the anchor value ABSENT; PHONE → deep-link, no
// slot); (e)-backend dossier proposal_pointers (OPEN only). The FE one-click/deep-
// link/consent-refusal render is proven in the ats-web component test.

type SignKey = CryptoKey | KeyObject;
const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

const MIGRATIONS = [
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  // talent_record chain (the enrichment reads email1/email2 via findById).
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260603140100_add_import_batch_id_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260609120000_search_pr1_pg_trgm_gin/migration.sql',
  'libs/talent-record/prisma/migrations/20260609130000_search_pr2_resume_text/migration.sql',
  'libs/talent-record/prisma/migrations/20260615000000_talent_stated_fields/migration.sql',
  'libs/talent-record/prisma/migrations/20260615120000_talent_search_indexes/migration.sql',
  'libs/talent-record/prisma/migrations/20260630140000_overlay_fold_cluster_id/migration.sql',
  'libs/talent-record/prisma/migrations/20260701120000_drop_core_talent_id/migration.sql',
  'libs/talent-record/prisma/migrations/20260702120000_add_work_authorization_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260706210000_tr2a_b3a_talent_record_supersession/migration.sql',
  // talent_trust chain.
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
const AUDIENCE = 'aramo-tr12-b2-spec';
const ALG = 'RS256';
const TENANT = '01900000-0000-7000-8000-0000000012b2';
const ACTOR = '00000000-0000-7000-8000-0000000012a2';
const READ_SCOPE = 'talent:read';
const DAY = 24 * 60 * 60 * 1000;
const EMAIL = 'ada@x.com';
const PHONE = '+15125551234';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-12 B2 — the queue, pointers, and ACT bookkeeping (real Postgres 17)',
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
    let dossier: DossierService;

    const refOf = (recordId: string) => ({
      tenant_id: TENANT,
      ref_type: 'ATS_TALENT_RECORD' as const,
      ref_id: recordId,
    });

    async function signJwt(scopes: string[]): Promise<string> {
      return new SignJWT({ sub: ACTOR, consumer_type: 'recruiter', actor_kind: 'user', tenant_id: TENANT, scopes })
        .setProtectedHeader({ alg: ALG })
        .setIssuedAt()
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setExpirationTime('1h')
        .sign(privateKey);
    }
    async function get(path: string, jwt: string) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${jwt}` } });
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

    async function seedRecord(recordId: string, opts: { email1?: string } = {}): Promise<void> {
      await db.query(
        `INSERT INTO talent_record."TalentRecord" (id, tenant_id, first_name, last_name, email1)
         VALUES ($1::uuid,$2::uuid,'Ada','Lovelace',$3)`,
        [recordId, TENANT, opts.email1 ?? null],
      );
    }
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
      await trust.contradictRecord(ev.id, 'seeded');
      const subjectId = (await trust.resolveSubjectRef(refOf(recordId)))!.id;
      return { subjectId, evidenceId: ev.id };
    }
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
        `UPDATE talent_trust."TrustState" SET verified_control_stale=false, last_recomputed_at=now()-interval '40 days' WHERE subject_id=$1::uuid`,
        [subjectId],
      );
      return { subjectId, anchorId };
    }
    async function proposals(subjectId: string) {
      return repo.listProposalsForSubject(TENANT, subjectId);
    }
    async function ledgerCounts(subjectId: string): Promise<{ ev: number; an: number; vr: number }> {
      const q = async (t: string, col = 'subject_id') => {
        const r = await db.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM talent_trust."${t}" WHERE ${col}=$1::uuid`,
          [subjectId],
        );
        return Number(r.rows[0]!.n);
      };
      return { ev: await q('EvidenceRecord'), an: await q('SubjectAnchor'), vr: await q('VerificationRequest') };
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid,'TR12B2',now()) ON CONFLICT DO NOTHING`, [TENANT]);
      for (const cap of ['ats', 'core']) {
        await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING`, [TENANT, cap]);
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
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await app.init();
      const server = await app.listen(0);
      port = (server.address() as AddressInfo).port;
      trust = module.get(TalentTrustService);
      repo = module.get(TalentTrustRepository);
      consistency = module.get(ConsistencyService);
      sweep = module.get(RecomputeSweepService);
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
      await db.query(`TRUNCATE TABLE talent_record."TalentRecord" CASCADE`);
      for (const t of [
        'VerificationProposal', 'EvidenceLink', 'EvidenceEvent', 'EvidenceRecord',
        'TrustState', 'SubjectAnchor', 'VerificationRequest', 'ResolutionSubjectRef', 'ResolutionSubject',
      ]) {
        await db.query(`TRUNCATE TABLE talent_trust."${t}" CASCADE`);
      }
    });

    // ---- (a) SETTLED both ways, both hosts -----------------------------------

    it('(a1) the consistency host SETTLES a trigger-cleared row (actor+justification); a still-triggering row does not', async () => {
      const R = uuidv7();
      const { subjectId, evidenceId } = await seedContradiction(R);
      // A SECOND, independent contradiction whose trigger will STILL hold.
      const ev2 = await trust.recordEvidence({
        subjectRef: refOf(R), dimension: 'CLAIMS', assertion_type: 'SKILL',
        assertion_payload: { value_raw: 'Rust' }, source_class: 'SELF', method: 'SELF_DECLARED',
        portability_class: 'TENANT_ONLY', decay_profile: 'MODERATE', created_by: 'test',
      });
      await trust.contradictRecord(ev2.id, 'still holds');

      await consistency.drainBatch({ batchSize: 100 });
      let rows = await proposals(subjectId);
      expect(rows.filter((r) => r.kind === 'RESOLVE_CONTRADICTION' && r.status === 'OPEN')).toHaveLength(2);

      // Resolve ONE contradiction — its trigger clears; the other still holds.
      await trust.resolveContradiction(evidenceId, ACTOR, 'resolved', 'req');
      // Re-arm the watermark so the consistency host re-visits the subject (the
      // opportunistic drift-heal fires whenever a subject is next examined; a
      // resolve writes no new EvidenceRecord, so the gate needs re-arming here —
      // the recompute host (a2) is the guaranteed time-driven backstop).
      await db.query(`UPDATE talent_trust."ResolutionSubject" SET last_consistency_at=NULL WHERE id=$1::uuid`, [subjectId]);
      await consistency.drainBatch({ batchSize: 100 });

      rows = await proposals(subjectId);
      const settled = rows.filter((r) => r.status === 'SETTLED');
      const open = rows.filter((r) => r.status === 'OPEN' && r.kind === 'RESOLVE_CONTRADICTION');
      expect(settled).toHaveLength(1);
      expect(settled[0]!.basis_ref_id).toBe(evidenceId);
      expect(settled[0]!.resolved_by).toBe('consistency');
      expect(settled[0]!.justification).toBe('trigger cleared');
      // The still-triggering row is untouched.
      expect(open).toHaveLength(1);
      expect(open[0]!.basis_ref_id).toBe(ev2.id);
    });

    it('(a2) the recompute host SETTLES a RENEW once the flag clears (actor=recompute_sweep)', async () => {
      const R = uuidv7();
      const { subjectId } = await seedStaleVerification(R);
      await sweep.drainBatch({ batchSize: 100 });
      expect((await proposals(subjectId)).filter((r) => r.kind === 'RENEW_VERIFICATION' && r.status === 'OPEN')).toHaveLength(1);

      // Renew (fresh act) → the flag clears on recompute.
      await trust.recordEvidence({
        subjectRef: refOf(R), dimension: 'IDENTITY', assertion_type: 'EMAIL_CONTROL_VERIFIED',
        assertion_payload: { normalized_value: EMAIL }, source_class: 'PLATFORM_VERIFIED',
        method: 'CONTROL_ROUND_TRIP', source_ref: null, portability_class: 'TENANT_ONLY',
        decay_profile: 'SLOW', collected_at: new Date(), created_by: 'verification',
      });
      // Re-arm the sweep gate so drainBatch re-selects the subject.
      await db.query(`UPDATE talent_trust."TrustState" SET last_recomputed_at=now()-interval '40 days' WHERE subject_id=$1::uuid`, [subjectId]);
      await sweep.drainBatch({ batchSize: 100 });

      const renew = (await proposals(subjectId)).filter((r) => r.kind === 'RENEW_VERIFICATION');
      expect(renew).toHaveLength(1);
      expect(renew[0]!.status).toBe('SETTLED');
      expect(renew[0]!.resolved_by).toBe('recompute_sweep');
      expect(renew[0]!.justification).toBe('trigger cleared');
    });

    // ---- (b) the drift-heal --------------------------------------------------

    it('(b) act-without-mark: the acted trigger clears → the OPEN proposal settles next pass', async () => {
      const R = uuidv7();
      const { subjectId, evidenceId } = await seedContradiction(R);
      await trust.generateProposalsForSubject(subjectId, TENANT);
      expect((await proposals(subjectId))[0]!.status).toBe('OPEN');

      // The human resolves it (the ACT) but never marks the proposal acted.
      await trust.resolveContradiction(evidenceId, ACTOR, 'resolved', 'req');
      await trust.generateProposalsForSubject(subjectId, TENANT, new Date(), 'consistency');

      const row = (await proposals(subjectId))[0]!;
      expect(row.status).toBe('SETTLED');
      expect(row.justification).toBe('trigger cleared');
    });

    // ---- (c) mark-acted: guard + actor + executes nothing --------------------

    it('(c) mark-acted records the actor, is OPEN-only guarded, and EXECUTES NOTHING', async () => {
      const R = uuidv7();
      const { subjectId } = await seedContradiction(R);
      await trust.generateProposalsForSubject(subjectId, TENANT);
      const id = (await proposals(subjectId))[0]!.id;
      const before = await ledgerCounts(subjectId);
      const jwt = await signJwt([READ_SCOPE]);

      const ok = await post(`/v1/talent/identity/proposals/${id}/act`, jwt, { note: 'sent from record' });
      expect(ok.status).toBe(200);
      const row = (await proposals(subjectId))[0]!;
      expect(row.status).toBe('ACTED');
      expect(row.resolved_by).toBe(ACTOR);
      expect(row.justification).toBe('sent from record');
      // Executes nothing — no evidence / anchor / verification-request written.
      expect(await ledgerCounts(subjectId)).toEqual(before);

      // OPEN-only guard: a second act → 409 PROPOSAL_NOT_OPEN.
      const again = await post(`/v1/talent/identity/proposals/${id}/act`, jwt, {});
      expect(again.status).toBe(409);
      const body = (await again.json()) as { error: { code: string } };
      expect(body.error.code).toBe('PROPOSAL_NOT_OPEN');
    });

    // ---- (d)-backend the act-target enrichment -------------------------------

    it('(d) an email VERIFY item enriches record_id + slot; the anchor VALUE is absent from the wire', async () => {
      const R = uuidv7();
      await seedRecord(R, { email1: EMAIL });
      // recordAnchor mints the subject + a SELF EMAIL anchor + the ATS ref; one
      // FIRST-HAND evidence → single_source_only, and the slot is never-verified.
      await trust.recordAnchor({ tenant_id: TENANT, talent_record_id: R, anchor_kind: 'EMAIL', normalized_value: EMAIL, raw_source: EMAIL, created_by: 'test' });
      const subjectId = (await trust.resolveSubjectRef(refOf(R)))!.id;
      await trust.generateProposalsForSubject(subjectId, TENANT);

      const jwt = await signJwt([READ_SCOPE]);
      const res = await get('/v1/talent/identity/proposals?kind=VERIFY_CONTACT', jwt);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<Record<string, unknown>> };
      const item = body.items.find((i) => i['subject_id'] === subjectId)!;
      expect(item).toBeDefined();
      expect(item['record_id']).toBe(R);
      expect(item['slot']).toBe('email1'); // ada@x.com matched the normalized email1
      // The anchor VALUE never crosses the wire.
      expect(JSON.stringify(body)).not.toContain(EMAIL);
    });

    it('(d) a PHONE VERIFY item has record_id but NO slot (the deep-link state)', async () => {
      const R = uuidv7();
      await seedRecord(R); // no email — a phone-only contact
      await trust.recordAnchor({ tenant_id: TENANT, talent_record_id: R, anchor_kind: 'PHONE', normalized_value: PHONE, raw_source: PHONE, created_by: 'test' });
      const subjectId = (await trust.resolveSubjectRef(refOf(R)))!.id;
      await trust.generateProposalsForSubject(subjectId, TENANT);

      const jwt = await signJwt([READ_SCOPE]);
      const res = await get('/v1/talent/identity/proposals?kind=VERIFY_CONTACT', jwt);
      const body = (await res.json()) as { items: Array<Record<string, unknown>> };
      const item = body.items.find((i) => i['subject_id'] === subjectId)!;
      expect(item['record_id']).toBe(R);
      expect(item['slot']).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain(PHONE);
    });

    // ---- (e)-backend dossier proposal_pointers (OPEN only) -------------------

    it('(e) the dossier head carries proposal_pointers (OPEN only; id + kind, no number)', async () => {
      const R = uuidv7();
      const { subjectId } = await seedContradiction(R);
      await trust.generateProposalsForSubject(subjectId, TENANT);
      const openId = (await proposals(subjectId))[0]!.id;

      const head = await dossier.getDossier(TENANT, R);
      expect(head.proposal_pointers).toHaveLength(1);
      expect(head.proposal_pointers[0]).toEqual({ id: openId, kind: 'RESOLVE_CONTRADICTION' });

      // Dismiss it → it leaves the OPEN-only pointer set.
      await trust.dismissProposal({ tenant_id: TENANT, id: openId, dismissed_by: ACTOR, justification: 'x', requestId: 'r' });
      const head2 = await dossier.getDossier(TENANT, R);
      expect(head2.proposal_pointers).toHaveLength(0);
    });
  },
);
