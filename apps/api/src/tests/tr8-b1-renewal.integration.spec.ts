import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TalentTrustService, TalentTrustRepository } from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';
import { RecomputeSweepService } from '../talent-identity/recompute-sweep.service.js';

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
].map(M);

const TENANT = '01900000-0000-7000-8000-0000000000f8';
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-8 B1 — renewal refreshes the aging + verified_control_stale (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let module: TestingModule;
    let db: Client;
    const savedEnv: Partial<Record<string, string | undefined>> = {};
    let trust: TalentTrustService;
    let repo: TalentTrustRepository;
    let sweep: RecomputeSweepService;

    const EMAIL = 'ada@x.com';
    const refOf = (recordId: string) => ({ tenant_id: TENANT, ref_type: 'ATS_TALENT_RECORD' as const, ref_id: recordId });

    async function firstVerify(recordId: string): Promise<string> {
      // recordAnchor mints the subject + the SELF anchor; the confirm then mints the
      // PLATFORM_VERIFIED anchor + the first EMAIL_CONTROL_VERIFIED evidence.
      await trust.recordAnchor({ tenant_id: TENANT, talent_record_id: recordId, anchor_kind: 'EMAIL', normalized_value: EMAIL, raw_source: EMAIL, created_by: 'test' });
      const subject = (await trust.resolveSubjectRef(refOf(recordId)))!;
      await confirmVia(subject.id, recordId, 'hash-first');
      return subject.id;
    }
    async function confirmVia(subjectId: string, recordId: string, tokenHash: string): Promise<void> {
      await repo.createVerificationRequest({
        tenant_id: TENANT,
        talent_record_id: recordId,
        subject_id: subjectId,
        anchor_kind: 'EMAIL',
        normalized_value: EMAIL,
        token_hash: tokenHash,
        created_by: 'test',
        expires_at: new Date(Date.now() + DAY),
      });
      const res = await trust.confirmEmailVerification(tokenHash);
      expect(res.verified).toBe(true);
    }
    async function anchorCount(subjectId: string): Promise<number> {
      const r = await db.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM talent_trust."SubjectAnchor" WHERE subject_id = $1::uuid AND source_class = 'PLATFORM_VERIFIED'`,
        [subjectId],
      );
      return Number(r.rows[0]!.n);
    }
    async function verificationEvidence(subjectId: string): Promise<Array<{ id: string; current_status: string; collected_at: Date }>> {
      const r = await db.query<{ id: string; current_status: string; collected_at: Date }>(
        `SELECT id, current_status, collected_at FROM talent_trust."EvidenceRecord"
          WHERE subject_id = $1::uuid AND assertion_type = 'EMAIL_CONTROL_VERIFIED' ORDER BY collected_at ASC`,
        [subjectId],
      );
      return r.rows;
    }
    async function staleFlag(subjectId: string): Promise<boolean> {
      const r = await db.query<{ verified_control_stale: boolean }>(
        `SELECT verified_control_stale FROM talent_trust."TrustState" WHERE subject_id = $1::uuid`,
        [subjectId],
      );
      return r.rows[0]!.verified_control_stale;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      await db.query(`INSERT INTO identity."Tenant" (id, name, updated_at) VALUES ($1::uuid, 'TR8B1', now()) ON CONFLICT DO NOTHING`, [TENANT]);
      await db.query(`INSERT INTO entitlement."TenantEntitlement" (tenant_id, capability) VALUES ($1::uuid, 'core') ON CONFLICT DO NOTHING`, [TENANT]);
      savedEnv['DATABASE_URL'] = process.env['DATABASE_URL'];
      savedEnv['MAILER_PROVIDER'] = process.env['MAILER_PROVIDER'];
      process.env['DATABASE_URL'] = url;
      process.env['MAILER_PROVIDER'] = 'stub';
      module = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await module.init();
      trust = module.get(TalentTrustService);
      repo = module.get(TalentTrustRepository);
      sweep = module.get(RecomputeSweepService);
    }, 300_000);

    afterAll(async () => {
      await module?.close();
      await db?.end();
      await container?.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 60_000);

    beforeEach(async () => {
      for (const t of ['EvidenceLink', 'EvidenceEvent', 'EvidenceRecord', 'TrustState', 'SubjectAnchor', 'VerificationRequest', 'ResolutionSubjectRef', 'ResolutionSubject']) {
        await db.query(`TRUNCATE TABLE talent_trust."${t}" CASCADE`);
      }
    });

    // ---- (a) renewal e2e: fresh evidence + supersede prior; anchor count unchanged ----

    it('(a) confirm on an already-verified slot mints NEW verification evidence + SUPERSEDES the prior; anchor untouched', async () => {
      const R = uuidv7();
      const sid = await firstVerify(R);
      expect(await anchorCount(sid)).toBe(1);
      const afterFirst = await verificationEvidence(sid);
      expect(afterFirst.filter((e) => e.current_status === 'VALID')).toHaveLength(1);

      // RENEWAL — confirm again on the already-verified slot.
      await confirmVia(sid, R, 'hash-renew');

      const afterRenew = await verificationEvidence(sid);
      // exactly one CURRENT truth; the prior is superseded; two rows total.
      expect(afterRenew).toHaveLength(2);
      expect(afterRenew.filter((e) => e.current_status === 'VALID')).toHaveLength(1);
      expect(afterRenew.filter((e) => e.current_status === 'SUPERSEDED')).toHaveLength(1);
      // the anchor row count is UNCHANGED (dedup untouched — D1).
      expect(await anchorCount(sid)).toBe(1);
      // the fresh evidence is newer than the prior.
      const valid = afterRenew.find((e) => e.current_status === 'VALID')!;
      const superseded = afterRenew.find((e) => e.current_status === 'SUPERSEDED')!;
      expect(valid.collected_at.getTime()).toBeGreaterThanOrEqual(superseded.collected_at.getTime());
    });

    // ---- (b) the clock restarts — fresh verification is full-strength ----

    it('(b) renewal restarts the SLOW decay clock (the current act is fresh)', async () => {
      const R = uuidv7();
      const sid = await firstVerify(R);
      await confirmVia(sid, R, 'hash-renew');
      const valid = (await verificationEvidence(sid)).find((e) => e.current_status === 'VALID')!;
      // fresh collected_at ≈ now → the SLOW clock restarts (age ~0).
      expect(Date.now() - valid.collected_at.getTime()).toBeLessThan(60_000);
    });

    // ---- (c) the flag both ways, incl. via the T5-B1 sweep with zero writes ----

    it('(c) verified_control_stale flips TRUE via the sweep (zero writes) and clears on renewal', async () => {
      const R = uuidv7();
      // Seed an AGED verification act (collected_at set 400d ago AT CREATION —
      // immutable after) + its PLATFORM_VERIFIED anchor, so a renewal can supersede it.
      const aged = await trust.recordEvidence({
        subjectRef: refOf(R),
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
      const sid = (await trust.resolveSubjectRef(refOf(R)))!.id;
      await db.query(
        `INSERT INTO talent_trust."SubjectAnchor"
           (id, subject_id, tenant_id, anchor_kind, normalized_value, source_evidence_id, source_class)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'EMAIL',$4,$5::uuid,'PLATFORM_VERIFIED')`,
        [uuidv7(), sid, TENANT, EMAIL, aged.id],
      );
      // Simulate the pre-threshold STORED state — flag FALSE, last recomputed 40d ago
      // (when the act was still fresh) — so the sweep must flip it.
      await db.query(
        `UPDATE talent_trust."TrustState"
            SET verified_control_stale = false, last_recomputed_at = now() - interval '40 days'
          WHERE subject_id = $1::uuid`,
        [sid],
      );

      // The T5-B1 sweep re-selects (ACTIVE + last_recomputed_at<now-30d + EXISTS SLOW
      // evidence) and RECOMPUTES — the flag flips via recompute, no explicit write.
      const r = await sweep.drainBatch({ batchSize: 100 });
      expect(r.recomputed).toBeGreaterThanOrEqual(1);
      expect(await staleFlag(sid)).toBe(true);

      // Renewal supersedes the aged act + mints a fresh one → clears on recompute.
      await confirmVia(sid, R, 'hash-renew');
      expect(await staleFlag(sid)).toBe(false);
      const ev = await verificationEvidence(sid);
      expect(ev.filter((e) => e.current_status === 'VALID')).toHaveLength(1);
      expect(ev.filter((e) => e.current_status === 'SUPERSEDED')).toHaveLength(1);
    });
  },
);
