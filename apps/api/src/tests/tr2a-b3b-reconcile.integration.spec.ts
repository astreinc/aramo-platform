import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Test, type TestingModule } from '@nestjs/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';

import { AppModule } from '../app.module.js';
import { RecordReconcileOrchestrator } from '../talent-identity/record-reconcile.orchestrator.js';

// TR-2a-B3b (DDR-3 §8) — the record-reconcile acceptance suite (real Postgres 17).
// Boots the AppModule to DI-wire the orchestrator + every domain repo, applies the
// full reconcile substrate, seeds promoted subjects/records/holder-rows directly,
// and drives the orchestrator. Covers §5 (a)-(g). Superseded rows are produced by
// the reconcile itself (this slice IS the writer).

const ROOT = resolve(__dirname, '../../../..');
const M = (p: string): string => resolve(ROOT, p);

const MIGRATIONS = [
  // Auth/entitlement (AppModule boot).
  'libs/identity/prisma/migrations/20260512000000_init_identity_model/migration.sql',
  'libs/identity/prisma/migrations/20260627000000_add_tenant_identity_provider/migration.sql',
  'libs/entitlement/prisma/migrations/20260601120000_init_entitlement_model/migration.sql',
  // talent_trust (full).
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
  'libs/talent-trust/prisma/migrations/20260712120000_tr8_b1_verified_control_stale/migration.sql',
  'libs/talent-trust/prisma/migrations/20260713120000_tr12_b1_verification_proposal/migration.sql',
  // talent_record (column-set the client projects + the B3a supersession axis).
  'libs/talent-record/prisma/migrations/20260602120000_init_talent_record_model/migration.sql',
  'libs/talent-record/prisma/migrations/20260603020000_add_core_talent_link_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260603140100_add_import_batch_id_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260615000000_talent_stated_fields/migration.sql',
  'libs/talent-record/prisma/migrations/20260630140000_overlay_fold_cluster_id/migration.sql',
  'libs/talent-record/prisma/migrations/20260701120000_drop_core_talent_id/migration.sql',
  'libs/talent-record/prisma/migrations/20260702120000_add_work_authorization_to_talent_record/migration.sql',
  'libs/talent-record/prisma/migrations/20260706210000_tr2a_b3a_talent_record_supersession/migration.sql',
  // consent (+ audit schema) full.
  'libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql',
  'libs/consent/prisma/migrations/20260630170000_rekey_consent_to_talent_record/migration.sql',
  // operational-holder schemas (init tables — the repoints are raw SQL over base cols).
  'libs/pipeline/prisma/migrations/20260602150000_init_pipeline_model/migration.sql',
  'libs/engagement/prisma/migrations/20260525120000_init_engagement_model/migration.sql',
  'libs/submittal/prisma/migrations/20260523120000_init_submittal_model/migration.sql',
  // + revoke columns + canonical 5-state rename (the current submittal trigger fn
  // the B3b amendment sits on references both).
  'libs/submittal/prisma/migrations/20260523200000_add_submittal_revoke/migration.sql',
  'libs/submittal/prisma/migrations/20260527000000_rename_submittal_state_canonical/migration.sql',
  'libs/evidence/prisma/migrations/20260522090000_init_evidence_model/migration.sql',
  'libs/examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
  'libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
  'libs/saved-list/prisma/migrations/20260602120000_init_saved_list_model/migration.sql',
  'libs/attachment/prisma/migrations/20260602120000_init_attachment_model/migration.sql',
  'libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  'libs/task/prisma/migrations/20260609140000_init_task_model/migration.sql',
  // TR-2a-B3b — the four Group-2 immutability reconcile-re-key trigger amendments
  // (GUC-gated exemption of the talent_id re-point). Applied AFTER each schema's
  // init so the CREATE OR REPLACE FUNCTION redefines the existing trigger fn.
  'libs/engagement/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
  'libs/examination/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
  'libs/submittal/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
  'libs/evidence/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
].map(M);

const TENANT = '01900000-0000-7000-8000-00000000b3b1';
const ACTOR = '00000000-0000-7000-8000-00000000a001';

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'TR-2a-B3b — record reconcile (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let app: TestingModule;
    let db: Client;
    let orchestrator: RecordReconcileOrchestrator;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      db = new Client({ connectionString: url });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
      process.env['DATABASE_URL'] = url;
      process.env['AUTH_AUDIENCE'] = 'b3b';
      process.env['AUTH_PUBLIC_KEY'] = 'unused-in-this-suite';

      app = await Test.createTestingModule({ imports: [AppModule] }).compile();
      orchestrator = app.get(RecordReconcileOrchestrator);
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      await db?.end();
      await container?.stop();
    });

    // ---- seed helpers --------------------------------------------------

    async function mkSubject(): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubject" (id, tenant_id, status, created_at)
         VALUES ($1::uuid, $2::uuid, 'ACTIVE', CURRENT_TIMESTAMP)`,
        [id, TENANT],
      );
      return id;
    }

    async function mkRecord(): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO talent_record."TalentRecord" (id, tenant_id, first_name, last_name)
         VALUES ($1::uuid, $2::uuid, 'Re', 'Concile')`,
        [id, TENANT],
      );
      return id;
    }

    // Promote a subject: attach an ATS_TALENT_RECORD ref to a fresh record.
    async function promote(subjectId: string): Promise<string> {
      const recordId = await mkRecord();
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source, linked_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATS_TALENT_RECORD', $4::uuid, 'seed', CURRENT_TIMESTAMP)`,
        [uuidv7(), subjectId, TENANT, recordId],
      );
      return recordId;
    }

    async function recordStatus(recordId: string): Promise<string | null> {
      const r = await db.query(
        `SELECT record_status FROM talent_record."TalentRecord" WHERE id = $1::uuid`,
        [recordId],
      );
      return r.rows[0]?.record_status ?? null;
    }

    async function mkEngagement(recordId: string, reqId: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO engagement."TalentJobEngagement" (id, tenant_id, talent_id, requisition_id, state, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'surfaced', CURRENT_TIMESTAMP)`,
        [id, TENANT, recordId, reqId],
      );
      return id;
    }

    async function engagementRecordOf(engId: string): Promise<string> {
      const r = await db.query(
        `SELECT talent_id FROM engagement."TalentJobEngagement" WHERE id = $1::uuid`,
        [engId],
      );
      return r.rows[0].talent_id;
    }

    async function mkPipeline(recordId: string, reqId: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'no_contact', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, TENANT, recordId, reqId],
      );
      return id;
    }

    async function mkTask(recordId: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO task."Task" (id, tenant_id, title, status, created_by_user_id, owner_type, owner_id, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, 'follow up', 'open', $3::uuid, 'talent_record', $4::uuid, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, TENANT, ACTOR, recordId],
      );
      return id;
    }

    async function taskOwnerOf(taskId: string): Promise<string> {
      const r = await db.query(`SELECT owner_id FROM task."Task" WHERE id = $1::uuid`, [taskId]);
      return r.rows[0].owner_id;
    }

    // The three DB-immutable holders (Group-2 amendment) — seeded to prove the
    // GUC-gated re-key works AND to drive the §3 negative controls.
    async function mkExamination(recordId: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO examination."TalentJobExamination"
           (id, tenant_id, talent_id, job_id, golden_profile_id, trigger, tier, rank_ordinal,
            why_matched_sentence, match_summary, expanded_reasoning, skill_match, experience_match,
            constraint_checks, strengths, gaps, risk_flags, confidence_indicators, freshness_indicator,
            examination_version, model_version, taxonomy_version, computed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, gen_random_uuid(), gen_random_uuid(),
                 'initial_match', 'WORTH_CONSIDERING', 1, 'x', 'x',
                 '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
                 '{}'::jsonb, '{}'::jsonb, 'v1', 'v1', 'v1', CURRENT_TIMESTAMP)`,
        [id, TENANT, recordId],
      );
      return id;
    }
    async function mkSubmittal(recordId: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO engagement."TalentSubmittalRecord"
           (id, tenant_id, talent_id, job_id, evidence_package_id, pinned_examination_id, state, created_by, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'created', $4::uuid, CURRENT_TIMESTAMP)`,
        [id, TENANT, recordId, ACTOR],
      );
      return id;
    }
    async function mkEvidence(recordId: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO evidence."TalentJobEvidencePackage"
           (id, tenant_id, talent_id, job_id, examination_id, talent_identity, contact_summary, capability_summary, match_justification, recruiter_contribution)
         VALUES ($1::uuid, $2::uuid, $3::uuid, gen_random_uuid(), gen_random_uuid(), '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)`,
        [id, TENANT, recordId],
      );
      return id;
    }
    async function talentIdOf(qualifiedTable: string, id: string): Promise<string> {
      const r = await db.query(`SELECT talent_id FROM ${qualifiedTable} WHERE id = $1::uuid`, [id]);
      return r.rows[0].talent_id;
    }

    async function grantConsent(recordId: string, scope: string): Promise<void> {
      await db.query(
        `INSERT INTO consent."TalentConsentEvent"
           (id, talent_record_id, tenant_id, scope, action, captured_method, consent_version, occurred_at, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'granted', 'recruiter_capture', 'v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [uuidv7(), recordId, TENANT, scope],
      );
    }

    async function effectiveGrantExists(recordId: string, scope: string): Promise<boolean> {
      const r = await db.query(
        `SELECT action FROM consent."TalentConsentEvent"
          WHERE talent_record_id = $1::uuid AND tenant_id = $2::uuid AND scope = $3
          ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
        [recordId, TENANT, scope],
      );
      return r.rows[0]?.action === 'granted';
    }

    // Merge direction: survivor = a (canonical-lower), merged = b. Point b's
    // merged_into at a to mirror phase 1 (mergeSubjects) BEFORE phase 2.
    async function mergePointer(surviving: string, merged: string): Promise<void> {
      await db.query(
        `UPDATE talent_trust."ResolutionSubject" SET status = 'MERGED', merged_into_subject_id = $1::uuid
          WHERE id = $2::uuid`,
        [surviving, merged],
      );
    }

    // ---- (a) both promoted → one live record, holders swept, consent via R_S -

    it('(a) both-promoted merge → R_L superseded, holders re-pointed to R_S, consent found via R_S, audit appended', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      const reqId = uuidv7();
      const recordS = await promote(survivor);
      const recordL = await promote(merged);
      const eng = await mkEngagement(recordL, reqId);
      const task = await mkTask(recordL);
      // The three DB-immutable holders — re-pointed only via the GUC exemption.
      const exam = await mkExamination(recordL);
      const sub = await mkSubmittal(recordL);
      const ev = await mkEvidence(recordL);
      await grantConsent(recordL, 'contacting');
      await mergePointer(survivor, merged);

      const op = await orchestrator.reconcile({
        tenant_id: TENANT,
        advisory_id: null,
        surviving_subject_id: survivor,
        merged_subject_id: merged,
        actor_id: ACTOR,
      });

      expect(op.status).toBe('COMPLETED');
      expect(op.superseded_record_id).toBe(recordL);
      // R_L superseded, R_S live.
      expect(await recordStatus(recordL)).toBe('superseded');
      expect(await recordStatus(recordS)).toBe('live');
      // Operational holders re-pointed to R_S — incl. the four DB-immutable ones,
      // which only the reconcile GUC exemption (Group-2 amendment) permits.
      expect(await engagementRecordOf(eng)).toBe(recordS);
      expect(await taskOwnerOf(task)).toBe(recordS);
      expect(await talentIdOf('examination."TalentJobExamination"', exam)).toBe(recordS);
      expect(await talentIdOf('engagement."TalentSubmittalRecord"', sub)).toBe(recordS);
      expect(await talentIdOf('evidence."TalentJobEvidencePackage"', ev)).toBe(recordS);
      // Consent made under R_L is now effective under R_S (send-gate visible).
      expect(await effectiveGrantExists(recordS, 'contacting')).toBe(true);
      // Audit reconcile event appended (never rewrites, never re-points).
      const audit = await db.query(
        `SELECT COUNT(*)::int AS n FROM audit."ConsentAuditEvent"
          WHERE event_type = 'consent.record_reconcile' AND subject_id = $1::uuid`,
        [recordS],
      );
      expect(audit.rows[0].n).toBe(1);
    });

    // ---- (c) collision rows removed-and-recorded --------------------------

    it('(c) collision (pipeline): survivor-side wins, loser removed with content recorded', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      const reqId = uuidv7();
      const recordS = await promote(survivor);
      const recordL = await promote(merged);
      // Both have a pipeline row for the SAME requisition → collision.
      await mkPipeline(recordS, reqId);
      const loser = await mkPipeline(recordL, reqId);
      await mergePointer(survivor, merged);

      const op = await orchestrator.reconcile({
        tenant_id: TENANT,
        advisory_id: null,
        surviving_subject_id: survivor,
        merged_subject_id: merged,
        actor_id: ACTOR,
      });

      // Loser row removed (survivor-side wins) + recorded in the operation.
      const stillThere = await db.query(`SELECT id FROM pipeline."Pipeline" WHERE id = $1::uuid`, [loser]);
      expect(stillThere.rowCount).toBe(0);
      const collisions = op.collision_records.filter((c) => c.domain === 'pipeline');
      expect(collisions.length).toBe(1);
      expect((collisions[0]!.row as { id: string }).id).toBe(loser);
    });

    // ---- (f) neither promoted → no phase 2 --------------------------------

    it('(f) neither-promoted merge → completed no-op operation (no record ids), recompute only', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      await mergePointer(survivor, merged);
      const op = await orchestrator.reconcile({
        tenant_id: TENANT,
        advisory_id: null,
        surviving_subject_id: survivor,
        merged_subject_id: merged,
        actor_id: ACTOR,
      });
      expect(op.status).toBe('COMPLETED');
      expect(op.surviving_record_id).toBeNull();
      expect(op.superseded_record_id).toBeNull();
      expect(op.sweep_steps.length).toBe(0);
    });

    // ---- (b) one promoted → ref re-homed, no double-mint ------------------

    it('(b) one-promoted merge (merged carries the record) → ATS ref re-homed to survivor', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      const record = await promote(merged); // only the merged subject is promoted
      await mergePointer(survivor, merged);
      const op = await orchestrator.reconcile({
        tenant_id: TENANT,
        advisory_id: null,
        surviving_subject_id: survivor,
        merged_subject_id: merged,
        actor_id: ACTOR,
      });
      expect(op.status).toBe('COMPLETED');
      expect(op.surviving_record_id).toBe(record);
      // The ATS ref now resolves to the SURVIVING subject (re-homed).
      const ref = await db.query(
        `SELECT subject_id FROM talent_trust."ResolutionSubjectRef"
          WHERE ref_type = 'ATS_TALENT_RECORD' AND ref_id = $1::uuid`,
        [record],
      );
      expect(ref.rows[0].subject_id).toBe(survivor);
      // Record NOT superseded (single record survives).
      expect(await recordStatus(record)).toBe('live');
    });

    // ---- (d) resume idempotency -------------------------------------------

    it('(d) reconcile is idempotent — a second run completes without double-effects', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      const reqId = uuidv7();
      const recordS = await promote(survivor);
      const recordL = await promote(merged);
      const eng = await mkEngagement(recordL, reqId);
      await mergePointer(survivor, merged);

      const first = await orchestrator.reconcile({
        tenant_id: TENANT, advisory_id: null,
        surviving_subject_id: survivor, merged_subject_id: merged, actor_id: ACTOR,
      });
      // Re-run (as the resume command would) — returns the same COMPLETED op, no re-move.
      const second = await orchestrator.reconcile({
        tenant_id: TENANT, advisory_id: null,
        surviving_subject_id: survivor, merged_subject_id: merged, actor_id: ACTOR,
      });
      expect(second.id).toBe(first.id);
      expect(second.status).toBe('COMPLETED');
      expect(await engagementRecordOf(eng)).toBe(recordS);
      // Exactly one engagement on R_S (not duplicated).
      const cnt = await db.query(
        `SELECT COUNT(*)::int AS n FROM engagement."TalentJobEngagement" WHERE talent_id = $1::uuid`,
        [recordS],
      );
      expect(cnt.rows[0].n).toBe(1);
    });

    // ---- (e) reversal ------------------------------------------------------

    it('(e) reversal restores R_L live, re-points recorded rows back, re-creates collision rows, lists accretions', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      const reqId = uuidv7();
      const recordS = await promote(survivor);
      const recordL = await promote(merged);
      const eng = await mkEngagement(recordL, reqId);
      await mkPipeline(recordS, reqId);
      const loserPipeline = await mkPipeline(recordL, reqId); // collides
      await grantConsent(recordL, 'contacting');
      await mergePointer(survivor, merged);

      const op = await orchestrator.reconcile({
        tenant_id: TENANT, advisory_id: null,
        surviving_subject_id: survivor, merged_subject_id: merged, actor_id: ACTOR,
      });
      // A post-merge accretion: a NEW engagement created against R_S after reconcile.
      const accretionEng = await mkEngagement(recordS, uuidv7());
      // Un-merge phase 1 (mirror reverseMerge) then reverse phase 2.
      await db.query(
        `UPDATE talent_trust."ResolutionSubject" SET status = 'ACTIVE', merged_into_subject_id = NULL WHERE id = $1::uuid`,
        [merged],
      );
      const result = await orchestrator.reverse({
        tenant_id: TENANT, operation_id: op.id, actor_id: ACTOR, justification: 'reviewer error',
      });

      expect(result.operation.status).toBe('REVERSED');
      // R_L back to live; the recorded engagement re-pointed back to R_L.
      expect(await recordStatus(recordL)).toBe('live');
      expect(await engagementRecordOf(eng)).toBe(recordL);
      // The removed collision pipeline row re-created (id restored).
      const restored = await db.query(`SELECT id FROM pipeline."Pipeline" WHERE id = $1::uuid`, [loserPipeline]);
      expect(restored.rowCount).toBe(1);
      // Consent reconcile grant removed from R_S.
      expect(await effectiveGrantExists(recordS, 'contacting')).toBe(false);
      // The post-merge accretion is LISTED (not moved) for human triage.
      const engAccretions = result.post_merge_accretions.find((x) => x.domain === 'engagement');
      expect(engAccretions?.ids).toContain(accretionEng);
    });

    // ---- (g) detection sweep ----------------------------------------------

    it('(g) detection sweep finds a pre-existing two-live-records cluster and reports it without acting', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      const recordS = await promote(survivor);
      const recordL = await promote(merged);
      // A pre-B3b merge: both promoted + merged pointer, but NEVER reconciled (both
      // records still live). The detection sweep must surface it.
      await mergePointer(survivor, merged);

      const clusters = await orchestrator.detectTwoLiveRecordClusters(TENANT);
      const found = clusters.find(
        (c) => c.merged_record_id === recordL && c.surviving_record_id === recordS,
      );
      expect(found).toBeDefined();
      // Read-only — both records still live (detection acts on nothing).
      expect(await recordStatus(recordL)).toBe('live');
      expect(await recordStatus(recordS)).toBe('live');
    });

    // ---- Amendment §3 negative controls (MANDATORY) -----------------------

    it('§3(i) — WITHOUT the reconcile GUC, a direct talent_id UPDATE on each of the four immutable ref columns still raises 23514', async () => {
      const rec = await mkRecord();
      const other = await mkRecord();
      const eng = await mkEngagement(rec, uuidv7());
      const exam = await mkExamination(rec);
      const sub = await mkSubmittal(rec);
      const ev = await mkEvidence(rec);
      const cases: Array<[string, string]> = [
        ['engagement."TalentJobEngagement"', eng],
        ['examination."TalentJobExamination"', exam],
        ['engagement."TalentSubmittalRecord"', sub],
        ['evidence."TalentJobEvidencePackage"', ev],
      ];
      for (const [tbl, id] of cases) {
        // No GUC set → user-edit immutability intact → the trigger raises.
        // Each of the four rejects a bare talent_id change (engagement/examination/
        // evidence: "immutable"; submittal: the state-machine fallthrough — a
        // no-state-change talent_id UPDATE matches no permitted transition). All
        // raise ERRCODE 23514 (check_violation). User-edit immutability intact.
        await expect(
          db.query(`UPDATE ${tbl} SET talent_id = $1::uuid WHERE id = $2::uuid`, [other, id]),
        ).rejects.toThrow(/immutable|rejected|state machine|permits/i);
      }
    });

    it('§3(ii) — WITH the GUC set, an UPDATE touching a NON-ref column on the evidence row still raises', async () => {
      const rec = await mkRecord();
      const ev = await mkEvidence(rec);
      await db.query('BEGIN');
      try {
        await db.query(`SET LOCAL app.reconcile = 'on'`);
        // GUC on, but the diff is NOT talent_id-only → whole-row immutability holds.
        await expect(
          db.query(
            `UPDATE evidence."TalentJobEvidencePackage" SET contact_summary = '{"x":1}'::jsonb WHERE id = $1::uuid`,
            [ev],
          ),
        ).rejects.toThrow(/immutable|rejected/i);
      } finally {
        await db.query('ROLLBACK');
      }
    });

    // §3(iii) — reversal's re-point-back runs under the SAME GUC (the repoint
    // method is the only place it is set) and the same controls: test (e) drives
    // the engagement re-point-back through repointTalentRecordRefs, proving the
    // reverse path is equally gated + equally exempt.
  },
);
