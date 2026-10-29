import { SignTalentErasureClient } from '../sign/sign-talent-erasure.client.js';

import type { SignErasurePort } from './sign-erasure.port.js';
import { TalentErasureService, type PgExec, type ErasureScope } from './talent-erasure.service.js';

// TR-15 B2 (DDR §6 — D5, the DSAR assembly) — read-only per-talent data
// inventory. NO HTTP surface; admin CLI only. Assembles, in one JSON, the raw
// material a subject-access-request answers: the resolved scope (husk chain +
// linked sourced arrivals), the per-holder presence counts (from the SAME
// erasure inventory), the consent ledger, the sourced arrivals + their raw
// payload refs, the within-tenant duplicate advisories, and the document /
// attachment refs. Every query is a SELECT — the CLI proves row counts are
// unchanged.
//
// ATI-SEP-1 T10 WP4 — the former trust bands + evidence-event timeline (trust
// ledger reads) are gone with that schema: verification / evidence facts now
// live in Talent Intelligence and are answered by its own DSAR surface.

export interface TalentDataInventory {
  tenant_id: string;
  record_id: string;
  scope: ErasureScope;
  is_anonymized: boolean;
  per_holder_counts: Array<{ table: string; count: number }>;
  total_rows: number;
  consent_ledger: Record<string, unknown>[];
  sourced_arrivals: Record<string, unknown>[];
  raw_payload_refs: Record<string, unknown>[];
  duplicate_advisories: Record<string, unknown>[];
  document_refs: Record<string, unknown>[];
  attachment_refs: Record<string, unknown>[];
}

export class TalentDataInventoryService {
  // Reuse the erasure engine's read-only scope resolution + per-holder counts. Aramo Sign's
  // holdings are counted by Sign through its contract (Domain Isolation V1).
  private readonly erasure: TalentErasureService;

  constructor(sign: SignErasurePort = new SignTalentErasureClient()) {
    this.erasure = new TalentErasureService(sign);
  }

  async assemble(pg: PgExec, tenantId: string, recordId: string): Promise<TalentDataInventory> {
    // dryRun is read-only: it resolves the scope and counts every holder.
    const dry = await this.erasure.dryRun(pg, tenantId, recordId);
    const { record_ids, sourced_talent_ids } = dry.scope;

    const consent_ledger = (
      await pg.query(
        `SELECT * FROM consent."TalentConsentEvent"
         WHERE talent_record_id = ANY($1::uuid[]) ORDER BY occurred_at ASC`,
        [record_ids],
      )
    ).rows;

    const sourced_arrivals = (
      await pg.query(
        `SELECT st.id, st.source_channel, st.external_source_id, st.created_at, sa.talent_record_id, sa.link_kind
           FROM talent_record."talent_record_sourced_arrival" sa
           JOIN sourced_talent."SourcedTalent" st ON st.id = sa.sourced_talent_id
          WHERE sa.sourced_talent_id = ANY($1::uuid[])
          ORDER BY st.created_at ASC`,
        [sourced_talent_ids],
      )
    ).rows;

    const raw_payload_refs = (
      await pg.query(
        `SELECT id, sourced_talent_id, storage_ref, created_at
           FROM ingestion."RawPayloadReference"
          WHERE sourced_talent_id = ANY($1::uuid[])
          ORDER BY created_at ASC`,
        [sourced_talent_ids],
      )
    ).rows;

    const duplicate_advisories = (
      await pg.query(
        `SELECT id, talent_record_a_id, talent_record_b_id, sourced_talent_id, basis, status, created_at
           FROM talent_record."talent_duplicate_advisory"
          WHERE talent_record_a_id = ANY($1::uuid[]) OR talent_record_b_id = ANY($1::uuid[])
             OR sourced_talent_id = ANY($2::uuid[])
          ORDER BY created_at ASC`,
        [record_ids, sourced_talent_ids],
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

    // DOC-1b cutover — the S3 ref for a talent document now lives on the
    // canonical documents.DocumentArtifact.storage_locator, reached via the
    // UUID-only TalentDocument.document_id link. Alias keeps the shape stable.
    const document_refs = (
      await pg.query(
        `SELECT td.id, a.storage_locator AS file_storage_ref
           FROM talent_evidence."TalentDocument" td
           JOIN documents."Document" doc ON doc.id = td.document_id
           JOIN documents."DocumentArtifact" a ON a.document_id = doc.id
          WHERE td.talent_id = ANY($1::uuid[])`,
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
      sourced_arrivals,
      raw_payload_refs,
      duplicate_advisories,
      document_refs,
      attachment_refs,
    };
  }
}
