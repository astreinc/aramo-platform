import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  SubjectMatcherService,
  SubjectResolutionService,
  TalentTrustRepository,
  TalentTrustService,
} from '@aramo/talent-trust';

import { AppModule } from '../app.module.js';
import { MatchSweepService } from '../talent-anchor/match-sweep.service.js';
import { IdentityDetectionService } from '../talent-identity/identity-detection.service.js';

// TR-6 B1 (DDR §8 acceptance) — the maintenance-layer proof (real Postgres 17).
// Boots AppModule to DI-wire the sweep + detection services over the real repos.
//   (i)   incremental sweep — a subject matched with no new anchor is NOT re-matched
//         on the next tick; a new anchor re-queues it.
//   (iii) the fan-out guard flows through the SWEEP too (a K>cap value → zero
//         advisories + a log line when drained by the sweep, not just inline).
//   (v)   the detection cron reports each seeded anomaly class and performs ZERO
//         writes (row counts unchanged).

const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

const MIGRATIONS = [
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  'libs/talent-trust/prisma/migrations/20260628000000_init_talent_trust/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703120000_tr2a1_subject_anchor/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703130000_tr2a2_match_advisory/migration.sql',
  'libs/talent-trust/prisma/migrations/20260703140000_tr2a3_advisory_resolution/migration.sql',
  'libs/talent-trust/prisma/migrations/20260705120000_add_reconcile_watermark_to_resolution_subject/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707120000_tr6_b1_last_matched_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706170000_tr2a_b1_subject_anchor_source_class/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706180000_tr2a_b1_subject_anchor_source_class_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706200000_tr2a_b2_advisory_reopen_provenance/migration.sql',
  'libs/talent-trust/prisma/migrations/20260706230000_tr2a_b3b_subject_merge_operation/migration.sql',
  'libs/talent-trust/prisma/migrations/20260707130000_tr6_b1_merge_operation_kind/migration.sql',
  'libs/talent-trust/prisma/migrations/20260709120000_tr4_b1_evidence_link_unique/migration.sql',
  'libs/talent-trust/prisma/migrations/20260710120000_tr4_b3_last_consistency_at/migration.sql',
  'libs/talent-trust/prisma/migrations/20260711120000_tr5_b2_thinness_flags/migration.sql',
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260603140100_add_import_batch_id_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260615000000_talent_stated_fields/migration.sql',
  'libs/talent-record/prisma/migrations/20260630140000_overlay_fold_cluster_id/migration.sql',
  'libs/talent-record/prisma/migrations/20260701120000_drop_core_talent_id/migration.sql',
  'libs/talent-record/prisma/migrations/20260702120000_add_work_authorization_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260706210000_tr2a_b3a_talent_record_supersession/migration.sql',
].map(M);

const CREATED_BY = 'tr6-b1-maintenance';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-6 B1 maintenance — incremental sweep + read-only detection (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: TestingModule;
    let db: Client;
    let sweep: MatchSweepService;
    let detection: IdentityDetectionService;
    let trust: TalentTrustService;
    let repo: TalentTrustRepository;
    let resolution: SubjectResolutionService;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'tr6b1';
      process.env['AUTH_PUBLIC_KEY'] = 'unused-in-this-suite';

      app = await Test.createTestingModule({ imports: [AppModule] }).compile();
      sweep = app.get(MatchSweepService);
      detection = app.get(IdentityDetectionService);
      trust = app.get(TalentTrustService);
      repo = app.get(TalentTrustRepository);
      resolution = app.get(SubjectResolutionService);
      void app.get(SubjectMatcherService); // ensure DI graph resolves the matcher
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // Seed a subject via the producer seam. Returns {subjectId, talentRecordId} so a
    // later anchor can be added to the SAME subject (re-queue proof).
    async function seed(
      tenantId: string,
      value: string,
      talentRecordId = uuidv7(),
    ): Promise<{ subjectId: string; talentRecordId: string }> {
      const written = await trust.recordAnchor({
        tenant_id: tenantId,
        talent_record_id: talentRecordId,
        anchor_kind: 'EMAIL',
        normalized_value: value,
        raw_source: value,
        created_by: CREATED_BY,
      });
      if (written === null) throw new Error('seed recorded no anchor');
      return { subjectId: written.anchor.subject_id, talentRecordId };
    }

    async function advisoryCount(tenantId: string): Promise<number> {
      const r = await db.query(
        `SELECT count(*)::int AS n FROM talent_trust."SubjectMatchAdvisory" WHERE tenant_id = $1::uuid`,
        [tenantId],
      );
      return r.rows[0].n;
    }

    // ---- (i) incremental sweep --------------------------------------------

    it('(i) a subject with no new anchor is not re-matched next tick; a new anchor re-queues it', async () => {
      const T = '0a600000-0000-7000-8000-000000000001';
      const s1 = await seed(T, 'incr-a@x.com');
      await seed(T, 'incr-a@x.com'); // shares → the pair is a real advisory

      // Tick 1 — both subjects are un-watermarked, so both are matched.
      const tick1 = await sweep.drainBatch({ batchSize: 100 });
      expect(tick1.attempted).toBeGreaterThanOrEqual(2);
      expect(await advisoryCount(T)).toBeGreaterThan(0);

      // The gate no longer returns these subjects (watermark advanced past their
      // newest anchor).
      const afterTick1 = await repo.listSubjectsToMatch(100);
      expect(afterTick1.some((r) => r.subject_id === s1.subjectId)).toBe(false);

      // Tick 2 — no new anchors anywhere → nothing to re-match.
      const tick2 = await sweep.drainBatch({ batchSize: 100 });
      expect(tick2.attempted).toBe(0);

      // A NEW anchor on s1 re-queues exactly that subject.
      await seed(T, 'incr-a-second@x.com', s1.talentRecordId);
      const requeued = await repo.listSubjectsToMatch(100);
      expect(requeued.some((r) => r.subject_id === s1.subjectId)).toBe(true);
    });

    // ---- (iii) fan-out guard through the sweep ----------------------------

    it('(iii) a K>cap value drained by the sweep produces zero advisories + a log line', async () => {
      const T = '0c600000-0000-7000-8000-000000000001';
      const email = 'sweep-mailbox@x.com';
      for (let i = 0; i < 22; i++) {
        await seed(T, email);
      }
      expect(await advisoryCount(T)).toBe(0);

      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      await sweep.drainBatch({ batchSize: 100 });

      // The value is shared by 22 ACTIVE subjects (> cap) → no advisories minted.
      expect(await advisoryCount(T)).toBe(0);
      const fanOut = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('match_fan_out_capped'));
      expect(fanOut.length).toBeGreaterThan(0);
      expect(fanOut[0]).not.toContain(email);
    });

    // ---- (v) detection cron — reports each class, mutates nothing ----------

    it('(v) detection reports each seeded anomaly class and performs zero writes', async () => {
      const T = '0e600000-0000-7000-8000-000000000001';

      // Class 1 — two-live-record cluster: two promoted subjects, B merged into A,
      // both records still LIVE.
      const subA = await mkSubject(T);
      const subB = await mkSubject(T);
      const recA = await promote(T, subA);
      const recB = await promote(T, subB);
      await db.query(
        `UPDATE talent_trust."ResolutionSubject" SET status='MERGED', merged_into_subject_id=$1::uuid WHERE id=$2::uuid`,
        [subA, subB],
      );

      // Class 2 — crash-orphaned reconcile: a PENDING operation started 2 days ago.
      await db.query(
        `INSERT INTO talent_trust."SubjectMergeOperation"
           (id, tenant_id, kind, surviving_subject_id, merged_subject_id, status, started_at)
         VALUES ($1::uuid, $2::uuid, 'RECONCILE', $3::uuid, $4::uuid, 'PENDING', CURRENT_TIMESTAMP - INTERVAL '2 days')`,
        [uuidv7(), T, subA, subB],
      );

      // Class 3 — reviewer backlog: a PENDING_REVIEW advisory created 8 days ago.
      await db.query(
        `INSERT INTO talent_trust."SubjectMatchAdvisory"
           (id, tenant_id, subject_a_id, subject_b_id, advise_band, match_basis, status, created_by, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ADVISE_WEAK', '{}'::jsonb, 'PENDING_REVIEW', 'seed', CURRENT_TIMESTAMP - INTERVAL '8 days')`,
        [uuidv7(), T, subA, subB],
      );

      // Class 4 — husk still receiving writes: a MERGED subject with a COMPLETED
      // merge op, then an anchor created AFTER the merge moment.
      const huskSub = await mkSubject(T);
      const survSub = await mkSubject(T);
      await db.query(
        `UPDATE talent_trust."ResolutionSubject" SET status='MERGED', merged_into_subject_id=$1::uuid WHERE id=$2::uuid`,
        [survSub, huskSub],
      );
      await db.query(
        `INSERT INTO talent_trust."SubjectMergeOperation"
           (id, tenant_id, kind, surviving_subject_id, merged_subject_id, status, started_at, completed_at)
         VALUES ($1::uuid, $2::uuid, 'DIRECT_MERGE', $3::uuid, $4::uuid, 'COMPLETED', CURRENT_TIMESTAMP - INTERVAL '3 days', CURRENT_TIMESTAMP - INTERVAL '3 days')`,
        [uuidv7(), T, survSub, huskSub],
      );
      await db.query(
        `INSERT INTO talent_trust."SubjectAnchor"
           (id, subject_id, tenant_id, anchor_kind, normalized_value, source_evidence_id, source_class, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'EMAIL', 'post-merge@x.com', $4::uuid, 'THIRD_PARTY_UNVERIFIED', CURRENT_TIMESTAMP)`,
        [uuidv7(), huskSub, T, uuidv7()],
      );

      const before = await tableCounts();
      const report = await detection.runDetection();
      const after = await tableCounts();

      expect(report.two_live_record_clusters).toBeGreaterThanOrEqual(1);
      expect(report.stale_pending_operations).toBeGreaterThanOrEqual(1);
      expect(report.stale_pending_advisories).toBeGreaterThanOrEqual(1);
      expect(report.merged_subjects_receiving_writes).toBeGreaterThanOrEqual(1);

      // Read-only — detection mutates NOTHING.
      expect(after).toEqual(before);
    });

    // ---- D4 regression: reverse a BARE merge (the pact reverse-happy path) --

    it('reversing a bare (no-operation) merge does not fire reconcile.reverse and stays REVERSED', async () => {
      const T = '0f600000-0000-7000-8000-000000000001';
      const a = await mkSubject(T);
      const b = await mkSubject(T);
      // A merge with NO SubjectMergeOperation row (the pact "a merged advisory
      // exist" state seeds exactly this): b MERGED into a, plus a MERGED advisory.
      await db.query(
        `UPDATE talent_trust."ResolutionSubject" SET status='MERGED', merged_into_subject_id=$1::uuid WHERE id=$2::uuid`,
        [a, b],
      );
      const advisoryId = uuidv7();
      const [lo, hi] = a < b ? [a, b] : [b, a];
      await db.query(
        `INSERT INTO talent_trust."SubjectMatchAdvisory"
           (id, tenant_id, subject_a_id, subject_b_id, advise_band, match_basis, status,
            created_by, resolution_action, surviving_subject_id, merged_subject_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ADVISE_WEAK', '{}'::jsonb, 'MERGED',
                 'seed', 'MERGE', $5::uuid, $6::uuid)`,
        [advisoryId, T, lo, hi, a, b],
      );

      const reversed = await resolution.reverseMerge({
        tenant_id: T,
        advisory_id: advisoryId,
        actor: 'reviewer-x',
        justification: 'undo the bare merge',
      });
      expect(reversed.status).toBe('REVERSED');

      // The subject is ACTIVE again.
      const subB = await repo.findSubjectById(b);
      expect(subB?.status).toBe('ACTIVE');

      // The DIRECT_UNMERGE audit row exists, carries actor/reason, and is REVERSED —
      // so the controller's `if (op?.status === 'COMPLETED') reconcile.reverse(...)`
      // gate does NOT fire on it (there is no merge topology to reverse).
      const op = await repo.findMergeOperationBySubjects(T, a, b);
      expect(op).not.toBeNull();
      expect(op!.kind).toBe('DIRECT_UNMERGE');
      expect(op!.actor).toBe('reviewer-x');
      expect(op!.status).not.toBe('COMPLETED');
    });

    // ---- raw seed helpers (detection) -------------------------------------

    async function mkSubject(tenantId: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at)
         VALUES ($1::uuid, $2::uuid, 'ACTIVE', CURRENT_TIMESTAMP)`,
        [id, tenantId],
      );
      return id;
    }

    async function promote(tenantId: string, subjectId: string): Promise<string> {
      const recordId = uuidv7();
      await db.query(
        `INSERT INTO talent_record."TalentRecord" (id, tenant_id, first_name, last_name)
         VALUES ($1::uuid, $2::uuid, 'Two', 'Live')`,
        [recordId, tenantId],
      );
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source, linked_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATS_TALENT_RECORD', $4::uuid, 'seed', CURRENT_TIMESTAMP)`,
        [uuidv7(), subjectId, tenantId, recordId],
      );
      return recordId;
    }

    async function tableCounts(): Promise<Record<string, number>> {
      const tables: Array<[string, string]> = [
        ['ResolutionSubject', 'talent_trust'],
        ['SubjectAnchor', 'talent_trust'],
        ['SubjectMatchAdvisory', 'talent_trust'],
        ['SubjectMergeOperation', 'talent_trust'],
        ['ResolutionSubjectRef', 'talent_trust'],
        ['EvidenceRecord', 'talent_trust'],
        ['TalentRecord', 'talent_record'],
      ];
      const out: Record<string, number> = {};
      for (const [t, schema] of tables) {
        const r = await db.query(`SELECT count(*)::int AS n FROM ${schema}."${t}"`);
        out[t] = r.rows[0].n;
      }
      return out;
    }
  },
);
