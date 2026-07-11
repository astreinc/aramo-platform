import { TalentErasureService, type PgExec, type ErasureScope } from './talent-erasure.service.js';

// TR-15 B2 (DDR §6 — D5, the DSAR assembly) — read-only per-talent data
// inventory. NO HTTP surface; admin CLI only. Assembles, in one JSON, the raw
// material a subject-access-request answers: the resolved scope (husk chain +
// trust cluster), the per-holder presence counts (from the SAME erasure
// inventory), the consent ledger, the trust bands (the dossier head), the
// evidence-event timeline (the dossier's timeline read), and the document /
// attachment refs. Every query is a SELECT — the CLI proves row counts are
// unchanged.

export interface TalentDataInventory {
  tenant_id: string;
  record_id: string;
  scope: ErasureScope;
  is_anonymized: boolean;
  per_holder_counts: Array<{ table: string; count: number }>;
  total_rows: number;
  consent_ledger: Record<string, unknown>[];
  trust_bands: Record<string, unknown>[];
  evidence_timeline: Record<string, unknown>[];
  document_refs: Record<string, unknown>[];
  attachment_refs: Record<string, unknown>[];
}

export class TalentDataInventoryService {
  // Reuse the erasure engine's read-only scope resolution + per-holder counts.
  private readonly erasure = new TalentErasureService();

  async assemble(pg: PgExec, tenantId: string, recordId: string): Promise<TalentDataInventory> {
    // dryRun is read-only: it resolves the scope and counts every holder.
    const dry = await this.erasure.dryRun(pg, tenantId, recordId);
    const { record_ids, subject_ids } = dry.scope;

    const consent_ledger = (
      await pg.query(
        `SELECT * FROM consent."TalentConsentEvent"
         WHERE talent_record_id = ANY($1::uuid[]) ORDER BY occurred_at ASC`,
        [record_ids],
      )
    ).rows;

    const trust_bands = (
      await pg.query(
        `SELECT * FROM talent_trust."TrustState" WHERE subject_id = ANY($1::uuid[])`,
        [subject_ids],
      )
    ).rows;

    const evidence_timeline = (
      await pg.query(
        `SELECT id, evidence_id, event_type, actor, reason, occurred_at
         FROM talent_trust."EvidenceEvent"
         WHERE evidence_id IN (SELECT id FROM talent_trust."EvidenceRecord" WHERE subject_id = ANY($1::uuid[]))
         ORDER BY occurred_at ASC`,
        [subject_ids],
      )
    ).rows;

    const attachment_refs = (
      await pg.query(
        `SELECT id, storage_key, file_name, is_resume, created_at
         FROM attachment."Attachment"
         WHERE owner_type = 'talent' AND owner_id = ANY($1::uuid[])`,
        [record_ids],
      )
    ).rows;

    const document_refs = (
      await pg.query(
        `SELECT id, file_storage_ref FROM talent_evidence."TalentDocument"
         WHERE talent_id = ANY($1::uuid[])`,
        [record_ids],
      )
    ).rows;

    const marker = (
      await pg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit."ConsentAuditEvent"
         WHERE tenant_id = $1::uuid AND subject_id = $2::uuid AND event_type = 'consent.erased'`,
        [tenantId, recordId],
      )
    ).rows[0];

    return {
      tenant_id: tenantId,
      record_id: recordId,
      scope: dry.scope,
      is_anonymized: Number(marker?.n ?? 0) > 0,
      per_holder_counts: dry.steps.map((s) => ({ table: s.table, count: s.count })),
      total_rows: dry.total_rows,
      consent_ledger,
      trust_bands,
      evidence_timeline,
      document_refs,
      attachment_refs,
    };
  }
}
