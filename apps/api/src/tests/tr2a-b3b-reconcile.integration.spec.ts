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
  'libs/identity/prisma/migrations/20260709130000_add_tenant_lifecycle_status/migration.sql',
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
  // Track 3 E6 — total unique -> live-scoped partial unique (preserve-all reconcile).
  'libs/pipeline/prisma/migrations/20260807100000_e6_pipeline_live_episode_unique/migration.sql',
  'libs/pipeline/prisma/migrations/20260827120000_l2a_pipeline_version_column/migration.sql',
  // L2-B — append-only history trigger; nullable status_from + ended_at/ended_by_id; pipeline OutboxEvent.
  'libs/pipeline/prisma/migrations/20260828100000_l2b_pipeline_history_append_only/migration.sql',
  'libs/pipeline/prisma/migrations/20260828110000_l2b_pipeline_ended_at_nullable_status_from/migration.sql',
  'libs/pipeline/prisma/migrations/20260828120000_l2b_pipeline_outbox_event/migration.sql',
  'libs/selection/prisma/migrations/20260525120000_init_selection_model/migration.sql',
  'libs/submittal/prisma/migrations/20260523120000_init_submittal_model/migration.sql',
  // + revoke columns + canonical 5-state rename (the current submittal trigger fn
  // the B3b amendment sits on references both).
  'libs/submittal/prisma/migrations/20260523200000_add_submittal_revoke/migration.sql',
  'libs/submittal/prisma/migrations/20260527000000_rename_submittal_state_canonical/migration.sql',
  'libs/evidence/prisma/migrations/20260522090000_init_evidence_model/migration.sql',
  'libs/examination/prisma/migrations/20260517200000_init_examination_model/migration.sql',
  'libs/talent-evidence/prisma/migrations/20260519170000_init_talent_evidence_model/migration.sql',
  'libs/talent-evidence/prisma/migrations/20260714120000_tr7_b1_education_certification/migration.sql',
  'libs/saved-list/prisma/migrations/20260602120000_init_saved_list_model/migration.sql',
  'libs/attachment/prisma/migrations/20260602120000_init_attachment_model/migration.sql',
  'libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql',
  'libs/task/prisma/migrations/20260609140000_init_task_model/migration.sql',
  // TR-2a-B3b — the four Group-2 immutability reconcile-re-key trigger amendments
  // (GUC-gated exemption of the talent_id re-point). Applied AFTER each schema's
  // init so the CREATE OR REPLACE FUNCTION redefines the existing trigger fn.
  'libs/examination/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
  'libs/submittal/prisma/migrations/20260706240000_tr2a_b3b_reconcile_rekey_exemption/migration.sql',
  'libs/submittal/prisma/migrations/20260812120000_t2p1_relocate_submittal_to_submittal_schema/migration.sql',
  'libs/submittal/prisma/migrations/20260822130000_l8b1_submittal_pipeline_link/migration.sql',
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

    // TR-2b B1 PR-2 — attach a PERSON_CLUSTER ref (the identity_index pointer) to
    // a subject. ref_id is UUID-only, no FK (the cross-schema rule), so no
    // identity_index row is needed to exercise the reverse-linkage carry.
    async function attachClusterRef(subjectId: string, clusterId: string): Promise<void> {
      await db.query(
        `INSERT INTO talent_trust."ResolutionSubjectRef"
           (id, subject_id, tenant_id, ref_type, ref_id, link_source, linked_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'PERSON_CLUSTER', $4::uuid, 'seed', CURRENT_TIMESTAMP)`,
        [uuidv7(), subjectId, TENANT, clusterId],
      );
    }

    async function recordClusterId(recordId: string): Promise<string | null> {
      const r = await db.query(
        `SELECT cluster_id FROM talent_record."TalentRecord" WHERE id = $1::uuid`,
        [recordId],
      );
      return r.rows[0]?.cluster_id ?? null;
    }

    async function mkSelection(recordId: string, reqId: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO selection."TalentSelection" (id, tenant_id, talent_id, requisition_id, state, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'surfaced', CURRENT_TIMESTAMP)`,
        [id, TENANT, recordId, reqId],
      );
      return id;
    }

    async function selectionRecordOf(engId: string): Promise<string> {
      const r = await db.query(
        `SELECT talent_id FROM selection."TalentSelection" WHERE id = $1::uuid`,
        [engId],
      );
      return r.rows[0].talent_id;
    }

    async function mkPipeline(recordId: string, reqId: string, status = 'no_contact'): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO pipeline."Pipeline" (id, tenant_id, talent_record_id, requisition_id, status, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::"pipeline"."PipelineStatus", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, TENANT, recordId, reqId, status],
      );
      return id;
    }

    // Append a PipelineStatusHistory row (for byte-for-byte preservation proofs).
    async function mkPipelineHistory(pipelineId: string, from: string, to: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO pipeline."PipelineStatusHistory" (id, tenant_id, pipeline_id, status_from, status_to, changed_by_id, changed_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::"pipeline"."PipelineStatus", $5::"pipeline"."PipelineStatus", $6::uuid, CURRENT_TIMESTAMP)`,
        [id, TENANT, pipelineId, from, to, ACTOR],
      );
      return id;
    }

    async function pipelineTalentOf(pipelineId: string): Promise<string> {
      const r = await db.query(`SELECT talent_record_id FROM pipeline."Pipeline" WHERE id = $1::uuid`, [pipelineId]);
      return r.rows[0]?.talent_record_id as string;
    }

    async function pipelineHistoryRows(pipelineId: string): Promise<Array<{ id: string; status_from: string; status_to: string }>> {
      const r = await db.query(
        `SELECT id, status_from, status_to FROM pipeline."PipelineStatusHistory" WHERE pipeline_id = $1::uuid ORDER BY changed_at, id`,
        [pipelineId],
      );
      return r.rows as Array<{ id: string; status_from: string; status_to: string }>;
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
        `INSERT INTO submittal."TalentSubmittalRecord"
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
    // TR-15 B2R — the two TR-7 B1 credential holders (talent_id-keyed), added to
    // the reconcile repoint set so a merge re-points them like every other holder
    // (the defect the T15-B2 erasure inventory surfaced).
    async function mkEducation(recordId: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO talent_evidence."TalentEducationEntry"
           (id, talent_id, tenant_id, institution_name, degree_name, source, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'MIT', 'BSc', 'resume', CURRENT_TIMESTAMP)`,
        [id, recordId, TENANT],
      );
      return id;
    }
    async function mkCertification(recordId: string): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO talent_evidence."TalentCertificationEntry"
           (id, talent_id, tenant_id, certification_name, source, created_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'CKA', 'resume', CURRENT_TIMESTAMP)`,
        [id, recordId, TENANT],
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
      const eng = await mkSelection(recordL, reqId);
      const task = await mkTask(recordL);
      // The three DB-immutable holders — re-pointed only via the GUC exemption.
      const exam = await mkExamination(recordL);
      const sub = await mkSubmittal(recordL);
      const ev = await mkEvidence(recordL);
      // TR-15 B2R — the two credential holders must sweep like the rest.
      const edu = await mkEducation(recordL);
      const cert = await mkCertification(recordL);
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
      expect(await selectionRecordOf(eng)).toBe(recordS);
      expect(await taskOwnerOf(task)).toBe(recordS);
      expect(await talentIdOf('examination."TalentJobExamination"', exam)).toBe(recordS);
      expect(await talentIdOf('submittal."TalentSubmittalRecord"', sub)).toBe(recordS);
      expect(await talentIdOf('evidence."TalentJobEvidencePackage"', ev)).toBe(recordS);
      // TR-15 B2R — the credential holders re-point to R_S like every other holder.
      expect(await talentIdOf('talent_evidence."TalentEducationEntry"', edu)).toBe(recordS);
      expect(await talentIdOf('talent_evidence."TalentCertificationEntry"', cert)).toBe(recordS);
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

    // ---- (g) TR-2b B1 PR-2 — survivor carries the surviving subject's cluster -

    it('(g) TR-2b B1 PR-2 — both-promoted merge: survivor record carries the surviving subject PERSON_CLUSTER cluster_id (birth-certificate)', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      const recordS = await promote(survivor);
      const recordL = await promote(merged);
      const clusterId = uuidv7();
      // The surviving subject holds the cluster; recordS was promoted by the seed
      // helper WITHOUT a cluster_id (promote() sets none), so this proves the
      // reconcile carry, not a promotion-time write.
      await attachClusterRef(survivor, clusterId);
      await mergePointer(survivor, merged);
      expect(await recordClusterId(recordS)).toBeNull();

      const op = await orchestrator.reconcile({
        tenant_id: TENANT,
        advisory_id: null,
        surviving_subject_id: survivor,
        merged_subject_id: merged,
        actor_id: ACTOR,
      });

      expect(op.status).toBe('COMPLETED');
      expect(await recordStatus(recordL)).toBe('superseded');
      expect(await recordStatus(recordS)).toBe('live');
      // Birth-certificate: the survivor record now holds the surviving subject's
      // cluster id (own-column carry via the single cluster writer, not a repoint).
      expect(await recordClusterId(recordS)).toBe(clusterId);
    });

    // ---- (c) collision rows removed-and-recorded --------------------------

    // ==== E6 A4 PRESERVE-ALL reconciliation (Boundary 4) ====
    // The pre-E6 collision-DELETE ("survivor wins, loser removed") is RETIRED. Post-
    // E6 reconciliation preserves ALL pipeline episodes; a live/live collision is
    // refused PRE-FLIGHT (Q-2); the partial live index is the backstop.

    // ---- B-reconcile-terminal-terminal ----
    // Two TERMINAL episodes, same requisition, across records → reconcile SUCCEEDS,
    // BOTH ids survive under the survivor, BOTH histories survive.
    it('B-reconcile-terminal-terminal: both terminal episodes survive and repoint to the survivor', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      const reqId = uuidv7();
      const recordS = await promote(survivor);
      const recordL = await promote(merged);
      const pS = await mkPipeline(recordS, reqId, 'placed');
      const pL = await mkPipeline(recordL, reqId, 'client_declined');
      const hL = await mkPipelineHistory(pL, 'offered', 'client_declined');
      await mergePointer(survivor, merged);

      const op = await orchestrator.reconcile({
        tenant_id: TENANT, advisory_id: null,
        surviving_subject_id: survivor, merged_subject_id: merged, actor_id: ACTOR,
      });
      expect(op.status).toBe('COMPLETED');

      // BOTH rows survive by id; both now belong to the survivor record.
      expect(await pipelineTalentOf(pS)).toBe(recordS);
      expect(await pipelineTalentOf(pL)).toBe(recordS);
      // No pipeline collision was recorded — nothing was deleted (preserve-all).
      expect(op.collision_records.filter((c) => c.domain === 'pipeline').length).toBe(0);
      // The loser's history survived byte-for-byte.
      const hist = await pipelineHistoryRows(pL);
      expect(hist.map((h) => h.id)).toEqual([hL]);
      expect(hist[0]).toMatchObject({ status_from: 'offered', status_to: 'client_declined' });
    });

    // ---- B-reconcile-live-terminal ----
    // One LIVE + one TERMINAL episode → succeeds; both survive; exactly one live
    // remains (the partial index is satisfied — no live/live).
    it('B-reconcile-live-terminal: both survive; exactly one live episode remains', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      const reqId = uuidv7();
      const recordS = await promote(survivor);
      const recordL = await promote(merged);
      const pS = await mkPipeline(recordS, reqId, 'not_in_consideration'); // terminal
      const pL = await mkPipeline(recordL, reqId, 'submitted');            // live
      await mergePointer(survivor, merged);

      const op = await orchestrator.reconcile({
        tenant_id: TENANT, advisory_id: null,
        surviving_subject_id: survivor, merged_subject_id: merged, actor_id: ACTOR,
      });
      expect(op.status).toBe('COMPLETED');
      expect(await pipelineTalentOf(pS)).toBe(recordS);
      expect(await pipelineTalentOf(pL)).toBe(recordS);
      // Exactly one live episode for the triple after the merge.
      const live = await db.query(
        `SELECT count(*)::int n FROM pipeline."Pipeline"
           WHERE tenant_id=$1::uuid AND talent_record_id=$2::uuid AND requisition_id=$3::uuid
             AND status NOT IN ('placed','not_in_consideration','client_declined')`,
        [TENANT, recordS, reqId],
      );
      expect(live.rows[0].n).toBe(1);
    });

    // ---- B-reconcile-live-live ----
    // Two LIVE episodes, same requisition → reconciliation REFUSES pre-flight,
    // ATOMICALLY: no talent record superseded, no pipeline row/history changed, NO
    // OTHER DOMAIN mutated, and no operation record created.
    it('B-reconcile-live-live: refuses ATOMICALLY before the sweep — no domain mutates', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      const reqId = uuidv7();
      const recordS = await promote(survivor);
      const recordL = await promote(merged);
      const pS = await mkPipeline(recordS, reqId, 'submitted'); // live
      const pL = await mkPipeline(recordL, reqId, 'qualifying'); // live → conflict
      // A non-pipeline holder to prove NO OTHER DOMAIN mutates on refusal.
      const eng = await mkSelection(recordL, reqId);
      await mergePointer(survivor, merged);

      await expect(
        orchestrator.reconcile({
          tenant_id: TENANT, advisory_id: null,
          surviving_subject_id: survivor, merged_subject_id: merged, actor_id: ACTOR,
        }),
      ).rejects.toMatchObject({ code: 'PIPELINE_RECONCILE_LIVE_CONFLICT' });

      // NOTHING mutated: R_L still live, both pipeline rows unchanged, selection
      // still on R_L, and NO operation record was created.
      expect(await recordStatus(recordL)).toBe('live');
      expect(await pipelineTalentOf(pS)).toBe(recordS);
      expect(await pipelineTalentOf(pL)).toBe(recordL);
      expect(await selectionRecordOf(eng)).toBe(recordL);
      const ops = await db.query(
        `SELECT count(*)::int n FROM talent_trust."SubjectMergeOperation"
           WHERE surviving_subject_id=$1::uuid AND merged_subject_id=$2::uuid`,
        [survivor, merged],
      );
      expect(ops.rows[0].n).toBe(0);
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
      const eng = await mkSelection(recordL, reqId);
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
      expect(await selectionRecordOf(eng)).toBe(recordS);
      // Exactly one selection on R_S (not duplicated).
      const cnt = await db.query(
        `SELECT COUNT(*)::int AS n FROM selection."TalentSelection" WHERE talent_id = $1::uuid`,
        [recordS],
      );
      expect(cnt.rows[0].n).toBe(1);
    });

    // ---- (e) reversal ------------------------------------------------------

    it('(e) [B-reversal] reversal restores R_L live, re-points recorded rows back (preserve-all — no re-creation), lists accretions', async () => {
      const survivor = await mkSubject();
      const merged = await mkSubject();
      const reqId = uuidv7();
      const recordS = await promote(survivor);
      const recordL = await promote(merged);
      const eng = await mkSelection(recordL, reqId);
      // E6 preserve-all: TERMINAL episodes coexist and repoint (no live/live). The
      // loser row is PRESERVED on the forward sweep (never deleted) and repointed.
      await mkPipeline(recordS, reqId, 'placed');
      const loserPipeline = await mkPipeline(recordL, reqId, 'client_declined');
      const loserHist = await mkPipelineHistory(loserPipeline, 'offered', 'client_declined');
      // TR-15 B2R — a credential holder must re-point back on reversal too.
      const edu = await mkEducation(recordL);
      const cert = await mkCertification(recordL);
      await grantConsent(recordL, 'contacting');
      await mergePointer(survivor, merged);

      const op = await orchestrator.reconcile({
        tenant_id: TENANT, advisory_id: null,
        surviving_subject_id: survivor, merged_subject_id: merged, actor_id: ACTOR,
      });
      // After the merge they moved to R_S (proven in (a)); here we drive the reverse.
      expect(await talentIdOf('talent_evidence."TalentEducationEntry"', edu)).toBe(recordS);
      // A post-merge accretion: a NEW selection created against R_S after reconcile.
      const accretionEng = await mkSelection(recordS, uuidv7());
      // Un-merge phase 1 (mirror reverseMerge) then reverse phase 2.
      await db.query(
        `UPDATE talent_trust."ResolutionSubject" SET status = 'ACTIVE', merged_into_subject_id = NULL WHERE id = $1::uuid`,
        [merged],
      );
      const result = await orchestrator.reverse({
        tenant_id: TENANT, operation_id: op.id, actor_id: ACTOR, justification: 'reviewer error',
      });

      expect(result.operation.status).toBe('REVERSED');
      // R_L back to live; the recorded selection re-pointed back to R_L.
      expect(await recordStatus(recordL)).toBe('live');
      expect(await selectionRecordOf(eng)).toBe(recordL);
      // TR-15 B2R — the credential holders re-point BACK to R_L on reversal.
      expect(await talentIdOf('talent_evidence."TalentEducationEntry"', edu)).toBe(recordL);
      expect(await talentIdOf('talent_evidence."TalentCertificationEntry"', cert)).toBe(recordL);
      // B-no-collision-delete + B-history-preservation: preserve-all NEVER deleted
      // the loser row — reversal repoints it BACK to R_L (no re-creation), and its
      // PipelineStatusHistory survived byte-for-byte through forward + reverse.
      const restored = await db.query(
        `SELECT talent_record_id FROM pipeline."Pipeline" WHERE id = $1::uuid`,
        [loserPipeline],
      );
      expect(restored.rowCount).toBe(1);
      expect(restored.rows[0].talent_record_id).toBe(recordL);
      const histAfter = await pipelineHistoryRows(loserPipeline);
      expect(histAfter.map((h) => h.id)).toEqual([loserHist]);
      expect(histAfter[0]).toMatchObject({ status_from: 'offered', status_to: 'client_declined' });
      // Consent reconcile grant removed from R_S.
      expect(await effectiveGrantExists(recordS, 'contacting')).toBe(false);
      // The post-merge accretion is LISTED (not moved) for human triage.
      const engAccretions = result.post_merge_accretions.find((x) => x.domain === 'selection');
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
      const eng = await mkSelection(rec, uuidv7());
      const exam = await mkExamination(rec);
      const sub = await mkSubmittal(rec);
      const ev = await mkEvidence(rec);
      const cases: Array<[string, string]> = [
        ['selection."TalentSelection"', eng],
        ['examination."TalentJobExamination"', exam],
        ['submittal."TalentSubmittalRecord"', sub],
        ['evidence."TalentJobEvidencePackage"', ev],
      ];
      for (const [tbl, id] of cases) {
        // No GUC set → user-edit immutability intact → the trigger raises.
        // Each of the four rejects a bare talent_id change (selection/examination/
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
    // the selection re-point-back through repointTalentRecordRefs, proving the
    // reverse path is equally gated + equally exempt.
  },
);
