import { Logger } from '@nestjs/common';
import {
  purgeClusterViaExec,
  type ClusterPurgeExec,
  type PurgeClusterResult,
} from '@aramo/identity-index';

// TR-15 B2 (DDR §5 — erasure made real) — the delete-pass engine behind the
// `erase-talent` CLI. NO HTTP surface. It automates doc/runbooks/talent-rtbf-
// erasure.md: given a tenant + an ATS TalentRecord id, it resolves the WHOLE
// human (the husk chain of records + the merged cluster of trust subjects),
// then deletes every PII holder child-before-parent, deletes the S3 blobs
// (stubbed — the app has no DeleteObject IAM; the operator/injected deleter
// does it), appends a retained consent erasure marker, and flips is_anonymized.
//
// Two keyspaces: GROUP A/C holders key on the RECORD id(s); GROUP B trust
// surfaces key on the SUBJECT id(s). The ordering below is load-bearing and,
// for GROUP B, DB-enforced (real FKs, no cascades). RETAINED (never deleted):
// the audit streams — audit."ConsentAuditEvent" and talent_trust."Subject-
// MergeOperation" — the append-only record of process (PII scope enumerated in
// the runbook). ⚠ INVENTORY ADDITION beyond the reconcile repoint set (the
// 19-holder map): talent_evidence."TalentEducationEntry" +
// "TalentCertificationEntry" (TR-7 B1 PII, never wired into repoint) — included
// so the erase reaches every holder (DDR §5); HALT-noted at Gate-6.

// A minimal raw-SQL executor (pg.Client-shaped). Injected so the CLI points it
// at DATABASE_URL and the acceptance spec points it at its testcontainer.
export interface PgExec {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

// An S3 object deleter. Defaults to a log-only stub (the app path has no
// DeleteObject; the operator runbook deletes versions+markers). The live CLI
// may inject a real deleter later; the spec injects a recording stub.
export type S3Deleter = (keys: string[]) => Promise<void>;

// One erasure target: a table + the WHERE that scopes it to this human, built
// from the resolved record-id and subject-id sets. `s3RefColumn`, when set,
// names a column whose values are S3 object keys to collect before the delete.
interface ErasureStep {
  label: string; // schema."Table"
  keyspace: 'record' | 'subject' | 'record-child' | 'evidence-set';
  where: string; // SQL WHERE body; uses $1 (record ids) / $2 (subject ids) per keyspace
  s3RefColumn?: string;
}

// The frozen inventory, in delete order (child-before-parent). $1 = record-id
// array, $2 = subject-id array (both uuid[]). GROUP-B trust rows use $2.
// Same-schema cascades that fall away automatically are NOT listed (pipeline
// PipelineStatusHistory → Pipeline; talent_record children → TalentRecord).
const INVENTORY: ErasureStep[] = [
  // ---- GROUP A operational non-cascade EVENT children (delete before parents) ----
  { label: 'engagement."TalentSubmittalEvent"', keyspace: 'record-child', where: `submittal_id IN (SELECT id FROM engagement."TalentSubmittalRecord" WHERE talent_id = ANY($1::uuid[]))` },
  { label: 'engagement."TalentEngagementEvent"', keyspace: 'record-child', where: `engagement_id IN (SELECT id FROM engagement."TalentJobEngagement" WHERE talent_id = ANY($1::uuid[]))` },
  { label: 'examination."ExaminationOverride"', keyspace: 'record-child', where: `examination_id IN (SELECT id FROM examination."TalentJobExamination" WHERE talent_id = ANY($1::uuid[]))` },
  // ---- GROUP A operational holders (record keyspace) ----
  { label: 'pipeline."Pipeline"', keyspace: 'record', where: `talent_record_id = ANY($1::uuid[])` }, // cascades PipelineStatusHistory
  { label: 'engagement."TalentSubmittalRecord"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'evidence."TalentJobEvidencePackage"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'engagement."TalentJobEngagement"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'examination."TalentJobExamination"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentSkillEvidence"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentWorkHistoryEntry"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentContactMethod"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentRateExpectation"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentWorkAuthorization"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentDocument"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])`, s3RefColumn: 'file_storage_ref' },
  { label: 'talent_evidence."TalentDerivedSnapshot"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  // ⚠ INVENTORY ADDITION (TR-7 B1 PII; absent from the reconcile repoint set — HALT-noted):
  { label: 'talent_evidence."TalentEducationEntry"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  { label: 'talent_evidence."TalentCertificationEntry"', keyspace: 'record', where: `talent_id = ANY($1::uuid[])` },
  // ---- GROUP A polymorphic holders (discriminator MANDATORY — shared id space) ----
  { label: 'saved_list."SavedListEntry"', keyspace: 'record', where: `item_type = 'talent_record' AND item_id = ANY($1::uuid[])` },
  { label: 'attachment."Attachment"', keyspace: 'record', where: `owner_type = 'talent' AND owner_id = ANY($1::uuid[])`, s3RefColumn: 'storage_key' },
  { label: 'activity."Activity"', keyspace: 'record', where: `subject_type = 'talent_record' AND subject_id = ANY($1::uuid[])` },
  { label: 'task."Task"', keyspace: 'record', where: `owner_type = 'talent_record' AND owner_id = ANY($1::uuid[])` },
  // ---- GROUP A consent LEDGER (record keyspace; audit is RETAINED, not here) ----
  { label: 'consent."TalentConsentEvent"', keyspace: 'record', where: `talent_record_id = ANY($1::uuid[])` },
  // ---- GROUP B trust-side PII (subject keyspace; real FKs, NO cascade → order enforced) ----
  { label: 'talent_trust."EvidenceEvent"', keyspace: 'evidence-set', where: `evidence_id IN (SELECT id FROM talent_trust."EvidenceRecord" WHERE subject_id = ANY($1::uuid[]))` },
  { label: 'talent_trust."EvidenceLink"', keyspace: 'evidence-set', where: `from_evidence_id IN (SELECT id FROM talent_trust."EvidenceRecord" WHERE subject_id = ANY($1::uuid[])) OR to_evidence_id IN (SELECT id FROM talent_trust."EvidenceRecord" WHERE subject_id = ANY($1::uuid[]))` },
  { label: 'talent_trust."EvidenceRecord"', keyspace: 'subject', where: `subject_id = ANY($1::uuid[])` },
  { label: 'talent_trust."SubjectAnchor"', keyspace: 'subject', where: `subject_id = ANY($1::uuid[])` },
  { label: 'talent_trust."TrustState"', keyspace: 'subject', where: `subject_id = ANY($1::uuid[])` },
  { label: 'talent_trust."SubjectMatchAdvisory"', keyspace: 'subject', where: `subject_a_id = ANY($1::uuid[]) OR subject_b_id = ANY($1::uuid[])` },
  { label: 'talent_trust."VerificationRequest"', keyspace: 'subject', where: `subject_id = ANY($1::uuid[])` },
  { label: 'talent_trust."VerificationProposal"', keyspace: 'subject', where: `subject_id = ANY($1::uuid[])` },
  // Portal P3a (F-1 ruling: subject-keyed ⇒ erasure INVENTORY only). ONE parent
  // entry — PortalDisputeWorkItem + PortalDisputeStatement CASCADE from it. Reached
  // via the subject-keyed work items (a dispute of an erased subject dies whole).
  { label: 'talent_trust."PortalDispute"', keyspace: 'evidence-set', where: `id IN (SELECT dispute_id FROM talent_trust."PortalDisputeWorkItem" WHERE subject_id = ANY($1::uuid[]))` },
  { label: 'talent_trust."ResolutionSubjectRef"', keyspace: 'subject', where: `subject_id = ANY($1::uuid[])` },
  { label: 'talent_trust."ResolutionSubject"', keyspace: 'subject', where: `id = ANY($1::uuid[])` }, // LAST trust row (parent)
  // ---- GROUP C the husk records (record keyspace) — cascades resume_text (S3) + provenance + contradiction ----
  { label: 'talent_record."TalentRecord"', keyspace: 'record', where: `id = ANY($1::uuid[])` },
];

// Same-schema S3-bearing cascade child collected separately (falls away with
// TalentRecord, but its S3 object must be enumerated first).
const RESUME_TEXT_S3 = {
  label: 'talent_record."talent_resume_text"',
  s3RefColumn: 'storage_key',
  where: `talent_record_id = ANY($1::uuid[])`,
};

export interface ErasureScope {
  record_ids: string[]; // the husk chain (every record of the human)
  subject_ids: string[]; // the merged cluster (every trust subject)
  s3_keys: string[]; // every S3 object to delete
}

export interface ErasureStepResult {
  table: string;
  count: number; // rows counted (dry-run) or deleted (execute)
  status: 'counted' | 'deleted' | 'skipped' | 'failed';
  error?: string;
}

// TR-2b B2b (Directive §PR-2.1) — the cluster last-reference section. The erased
// subjects' PERSON_CLUSTER ref_ids are captured BEFORE the delete pass (they die
// in the generic ResolutionSubjectRef delete). After the inventory, each captured
// cluster is R4-liveness-checked EXCLUDING the erased subjects; an orphaned
// cluster is purged (purgeCluster, caller 'erasure', NO grace — RTBF intent is
// explicit, D11). Dry-run reports would_purge without purging.
export interface ErasureClusterPurge {
  captured_cluster_ids: string[]; // PERSON_CLUSTER refs of the erased subjects
  orphaned_cluster_ids: string[]; // of those, orphaned post-erasure (would-purge)
  purged: PurgeClusterResult[]; // execute only — the actual purge results
}

export interface ErasureReport {
  tenant_id: string;
  record_id: string;
  mode: 'dry-run' | 'execute';
  scope: ErasureScope;
  steps: ErasureStepResult[];
  retained: string[]; // audit tables deliberately NOT deleted
  s3_deleted: number;
  erasure_marker_appended: boolean;
  is_anonymized_flipped: boolean;
  total_rows: number;
  cluster_purge: ErasureClusterPurge;
}

export class TalentErasureService {
  private readonly logger = new Logger(TalentErasureService.name);

  // Resolve the WHOLE human from one record id: the husk chain (records linked
  // by supersession, both directions) + the merged trust cluster (subjects) +
  // the S3 keys. Read-only.
  async resolveScope(pg: PgExec, tenantId: string, recordId: string): Promise<ErasureScope> {
    // Husk chain: walk superseded_by_record_id both ways (a record may be the
    // survivor others point at, or a husk pointing at its survivor). Bounded
    // recursive CTE over the same-schema self-reference.
    const recRows = await pg.query<{ id: string }>(
      `WITH RECURSIVE chain(id, sby) AS (
         SELECT id, superseded_by_record_id FROM talent_record."TalentRecord"
         WHERE tenant_id = $1::uuid AND id = $2::uuid
         UNION
         SELECT t.id, t.superseded_by_record_id FROM talent_record."TalentRecord" t
           JOIN chain c ON (t.superseded_by_record_id = c.id OR t.id = c.sby)
         WHERE t.tenant_id = $1::uuid
       )
       SELECT DISTINCT id FROM chain`,
      [tenantId, recordId],
    );
    const record_ids = recRows.rows.map((r) => r.id);
    if (record_ids.length === 0) record_ids.push(recordId); // never resolves empty

    // Trust cluster: the subjects whose ATS_TALENT_RECORD ref points at any husk
    // record, unioned with their merged-cluster members (merged_into_subject_id
    // both directions).
    const subjRows = await pg.query<{ id: string }>(
      `WITH RECURSIVE cluster(id, mib) AS (
         SELECT rs.id, rs.merged_into_subject_id
         FROM talent_trust."ResolutionSubject" rs
         WHERE rs.tenant_id = $1::uuid AND rs.id IN (
           SELECT subject_id FROM talent_trust."ResolutionSubjectRef"
           WHERE tenant_id = $1::uuid AND ref_type = 'ATS_TALENT_RECORD' AND ref_id = ANY($2::uuid[])
         )
         UNION
         SELECT s.id, s.merged_into_subject_id FROM talent_trust."ResolutionSubject" s
           JOIN cluster c ON (s.merged_into_subject_id = c.id OR s.id = c.mib)
         WHERE s.tenant_id = $1::uuid
       )
       SELECT DISTINCT id FROM cluster`,
      [tenantId, record_ids],
    );
    const subject_ids = subjRows.rows.map((r) => r.id);

    // S3 keys: the attachment/document/résumé blobs across the husk records.
    // Every s3-bearing INVENTORY step plus the résumé-text cascade child.
    const s3Sources: Array<{ label: string; col: string; where: string }> = [
      ...INVENTORY.filter((s) => s.s3RefColumn !== undefined).map((s) => ({
        label: s.label,
        col: s.s3RefColumn as string,
        where: s.where,
      })),
      { label: RESUME_TEXT_S3.label, col: RESUME_TEXT_S3.s3RefColumn, where: RESUME_TEXT_S3.where },
    ];
    const s3_keys: string[] = [];
    for (const src of s3Sources) {
      // Every s3-bearing source is record-keyspace (its WHERE references $1 only).
      const rows = await pg.query<{ k: string | null }>(
        `SELECT "${src.col}" AS k FROM ${src.label} WHERE ${src.where}`,
        [record_ids],
      );
      for (const r of rows.rows) if (r.k !== null && r.k !== undefined) s3_keys.push(r.k);
    }
    return { record_ids, subject_ids, s3_keys };
  }

  // Each INVENTORY WHERE references exactly one id-array as $1 — the record set
  // (record / record-child) or the subject set (subject / evidence-set).
  private keyParams(step: ErasureStep, scope: ErasureScope): unknown[] {
    return step.keyspace === 'subject' || step.keyspace === 'evidence-set'
      ? [scope.subject_ids]
      : [scope.record_ids];
  }

  // TR-2b B2b — the distinct PERSON_CLUSTER ref_ids the erased subjects hold.
  // Captured BEFORE the delete pass (they die in the generic ResolutionSubjectRef
  // delete). PII-free (a cluster id is an opaque index key).
  private async capturePersonClusterRefs(
    pg: PgExec,
    subjectIds: string[],
  ): Promise<string[]> {
    if (subjectIds.length === 0) return [];
    const rows = await pg.query<{ ref_id: string }>(
      `SELECT DISTINCT ref_id FROM talent_trust."ResolutionSubjectRef"
        WHERE ref_type = 'PERSON_CLUSTER' AND subject_id = ANY($1::uuid[])`,
      [subjectIds],
    );
    return rows.rows.map((r) => r.ref_id);
  }

  // TR-2b B2b — the R4 liveness rule as a husk-aware raw SQL, EXCLUDING the erased
  // subjects (so a dry-run predicts the POST-erasure state, and execute is correct
  // whether run before or after the delete). Mirrors the DI lifecycle-sweep
  // liveTenants: a cluster is live iff some NON-erased holder of a PERSON_CLUSTER
  // ref resolves (following merged_into_subject_id) to an ACTIVE survivor that
  // still holds an ATS_TALENT_RECORD ref.
  private async isClusterLiveExcluding(
    pg: PgExec,
    clusterId: string,
    excludedSubjectIds: string[],
  ): Promise<boolean> {
    const rows = await pg.query<{ live: boolean }>(
      `WITH RECURSIVE follow(id, merged_into, status) AS (
         SELECT s.id, s.merged_into_subject_id, s.status
           FROM talent_trust."ResolutionSubject" s
          WHERE s.id IN (
            SELECT subject_id FROM talent_trust."ResolutionSubjectRef"
             WHERE ref_type = 'PERSON_CLUSTER' AND ref_id = $1::uuid
               AND subject_id <> ALL($2::uuid[])
          )
         UNION
         SELECT s2.id, s2.merged_into_subject_id, s2.status
           FROM talent_trust."ResolutionSubject" s2
           JOIN follow f ON s2.id = f.merged_into
       )
       SELECT EXISTS (
         SELECT 1 FROM follow f
          WHERE f.status = 'ACTIVE'
            AND EXISTS (
              SELECT 1 FROM talent_trust."ResolutionSubjectRef" ats
               WHERE ats.subject_id = f.id AND ats.ref_type = 'ATS_TALENT_RECORD'
            )
       ) AS live`,
      [clusterId, excludedSubjectIds],
    );
    return rows.rows[0]?.live ?? false;
  }

  // TR-2b B2b — per captured cluster: R4 liveness (excluding the erased subjects);
  // orphaned → purgeCluster (caller 'erasure', NO grace). Dry-run reports the
  // would-purge ids without purging. The purge reuses the ONE shared primitive
  // (purgeClusterViaExec over the erase pass's PgExec — the same statement array
  // the DI ClusterPurgeService runs, pinned by the tripwire).
  private async purgeOrphanedClusters(
    pg: PgExec,
    clusterIds: string[],
    excludedSubjectIds: string[],
    dryRun: boolean,
  ): Promise<ErasureClusterPurge> {
    const orphaned: string[] = [];
    const purged: PurgeClusterResult[] = [];
    for (const clusterId of clusterIds) {
      const live = await this.isClusterLiveExcluding(pg, clusterId, excludedSubjectIds);
      if (live) continue;
      orphaned.push(clusterId);
      if (!dryRun) {
        const exec: ClusterPurgeExec = pg;
        purged.push(
          await purgeClusterViaExec(exec, clusterId, 'erasure', (e) =>
            this.logger.log(JSON.stringify(e)),
          ),
        );
      }
    }
    return {
      captured_cluster_ids: clusterIds,
      orphaned_cluster_ids: orphaned,
      purged,
    };
  }

  async dryRun(pg: PgExec, tenantId: string, recordId: string): Promise<ErasureReport> {
    const scope = await this.resolveScope(pg, tenantId, recordId);
    // Capture the PERSON_CLUSTER refs while they still exist (dry-run deletes
    // nothing, but the preview must show which clusters WOULD be purged).
    const capturedClusters = await this.capturePersonClusterRefs(pg, scope.subject_ids);
    const steps: ErasureStepResult[] = [];
    let total = 0;
    for (const step of INVENTORY) {
      try {
        const rows = await pg.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM ${step.label} WHERE ${step.where}`,
          this.keyParams(step, scope),
        );
        const n = Number(rows.rows[0]?.n ?? 0);
        total += n;
        steps.push({ table: step.label, count: n, status: 'counted' });
      } catch (err) {
        steps.push({ table: step.label, count: 0, status: 'failed', error: msg(err) });
      }
    }
    // Would-purge preview: liveness EXCLUDING the erased subjects predicts the
    // post-erasure orphan state. dryRun=true → report ids, purge nothing.
    const clusterPurge = await this.purgeOrphanedClusters(
      pg,
      capturedClusters,
      scope.subject_ids,
      true,
    );
    return {
      tenant_id: tenantId,
      record_id: recordId,
      mode: 'dry-run',
      scope,
      steps,
      retained: ['audit."ConsentAuditEvent"', 'talent_trust."SubjectMergeOperation"'],
      s3_deleted: 0, // dry-run: nothing deleted, but scope.s3_keys lists what would go
      erasure_marker_appended: false,
      is_anonymized_flipped: false,
      total_rows: total,
      cluster_purge: clusterPurge,
    };
  }

  // The live pass. Per-step isolation (one failure does not abort the rest —
  // recorded and reported). Idempotent: a re-run over an erased human counts
  // zero everywhere and re-appends nothing (the marker is exists-guarded).
  async execute(
    pg: PgExec,
    tenantId: string,
    recordId: string,
    s3Delete: S3Deleter,
  ): Promise<ErasureReport> {
    const scope = await this.resolveScope(pg, tenantId, recordId);
    // Capture the PERSON_CLUSTER refs BEFORE the delete pass — they die in the
    // generic ResolutionSubjectRef delete (INVENTORY, subject keyspace).
    const capturedClusters = await this.capturePersonClusterRefs(pg, scope.subject_ids);
    const steps: ErasureStepResult[] = [];
    let total = 0;
    for (const step of INVENTORY) {
      try {
        const res = await pg.query(
          `DELETE FROM ${step.label} WHERE ${step.where}`,
          this.keyParams(step, scope),
        );
        const n = res.rowCount ?? 0;
        total += n;
        steps.push({ table: step.label, count: n, status: 'deleted' });
      } catch (err) {
        steps.push({ table: step.label, count: 0, status: 'failed', error: msg(err) });
      }
    }

    // S3: delete the collected blobs (stubbed deleter per conventions).
    if (scope.s3_keys.length > 0) {
      try {
        await s3Delete(scope.s3_keys);
      } catch (err) {
        this.logger.warn(`erase-talent: S3 delete failed for ${scope.s3_keys.length} key(s): ${msg(err)}`);
      }
    }

    // The retained consent erasure marker (audit stream). Exists-guarded so a
    // re-run appends nothing (idempotent). This is what is_anonymized reads.
    const already = await pg.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM audit."ConsentAuditEvent"
       WHERE tenant_id = $1::uuid AND subject_id = $2::uuid AND event_type = 'consent.erased'`,
      [tenantId, recordId],
    );
    let markerAppended = false;
    if (Number(already.rows[0]?.n ?? 0) === 0) {
      await pg.query(
        `INSERT INTO audit."ConsentAuditEvent" (id, tenant_id, actor_id, actor_type, event_type, subject_id, event_payload, created_at)
         VALUES (gen_random_uuid(), $1::uuid, NULL, 'system', 'consent.erased', $2::uuid, $3::jsonb, now())`,
        [
          tenantId,
          recordId,
          JSON.stringify({
            record_ids: scope.record_ids,
            subject_ids: scope.subject_ids,
            tables_cleared: steps.filter((s) => s.status === 'deleted').map((s) => s.table),
            s3_keys_deleted: scope.s3_keys.length,
          }),
        ],
      );
      markerAppended = true;
    }

    // AFTER the inventory: per captured cluster, R4 liveness (excluding the now-
    // erased subjects) → orphaned → purgeCluster (caller 'erasure', NO grace).
    const clusterPurge = await this.purgeOrphanedClusters(
      pg,
      capturedClusters,
      scope.subject_ids,
      false,
    );

    return {
      tenant_id: tenantId,
      record_id: recordId,
      mode: 'execute',
      scope,
      steps,
      retained: ['audit."ConsentAuditEvent"', 'talent_trust."SubjectMergeOperation"'],
      s3_deleted: scope.s3_keys.length,
      erasure_marker_appended: markerAppended,
      // is_anonymized is a derived read (consent reads compute it from the
      // marker) — the flip is effective the moment the marker exists.
      is_anonymized_flipped: true,
      total_rows: total,
      cluster_purge: clusterPurge,
    };
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
