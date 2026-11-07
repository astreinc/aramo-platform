import { type PrismaService } from './prisma/prisma.service.js';

// Aramo-Sign-Mobile-Amendment-M-A13-Field-Test-Remediation-v1_0-LOCKED R-1b — the
// READ-ONLY inventory of executed documents produced with the typed-signature defect:
// a SIGNATURE or INITIALS field stored as signature_method TYPED whose value is an
// image data URL (Android vc2/vc3, older iOS builds), on a document that already has
// an ExecutedDocument. Counts and ids only: a field value is never selected or printed.

export const REISSUE_MARK_FIELD_TYPES: readonly string[] = ['SIGNATURE', 'INITIALS'];

export interface AffectedExecutedDocument {
  tenant_id: string;
  envelope_id: string;
  envelope_document_id: string;
  executed_document_id: string;
  affected_fields: number;
  purged: boolean;
  already_reissued: boolean;
}

export interface ReissueInventory {
  affected: AffectedExecutedDocument[];
  executed_documents: number;
  envelopes: number;
  tenants: number;
  affected_fields: number;
}

/** Read-only (a READ ONLY transaction). `tenant_id` / `envelope_ids` narrow the scan. */
export async function findReissueInventory(
  prisma: PrismaService,
  filter: { tenant_id?: string; envelope_ids?: readonly string[] } = {},
): Promise<ReissueInventory> {
  const params: unknown[] = [REISSUE_MARK_FIELD_TYPES];
  let where = '';
  if (filter.tenant_id !== undefined) {
    params.push(filter.tenant_id);
    where += ` AND ed.tenant_id = $${params.length}::uuid`;
  }
  if (filter.envelope_ids !== undefined && filter.envelope_ids.length > 0) {
    params.push(filter.envelope_ids);
    where += ` AND ed.envelope_id = ANY($${params.length}::uuid[])`;
  }
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return tx.$queryRawUnsafe<Array<{
      tenant_id: string;
      envelope_id: string;
      envelope_document_id: string;
      executed_document_id: string;
      affected_fields: number;
      purged: boolean;
      already_reissued: boolean;
    }>>(
      `SELECT ed.tenant_id::text AS tenant_id,
              ed.envelope_id::text AS envelope_id,
              ed.envelope_document_id::text AS envelope_document_id,
              ed.id::text AS executed_document_id,
              count(f.id)::int AS affected_fields,
              (ed.purged_at IS NOT NULL) AS purged,
              EXISTS (SELECT 1 FROM "sign"."ExecutedDocumentReissue" r WHERE r.original_executed_document_id = ed.id) AS already_reissued
         FROM "sign"."ExecutedDocument" ed
         JOIN "sign"."SignatureField" f
           ON f.envelope_document_id = ed.envelope_document_id AND f.tenant_id = ed.tenant_id
        WHERE f.signature_method = 'TYPED'
          AND f.field_type = ANY($1::text[])
          AND f.value LIKE 'data:image%'${where}
        GROUP BY ed.tenant_id, ed.envelope_id, ed.envelope_document_id, ed.id, ed.purged_at
        ORDER BY ed.tenant_id, ed.envelope_id, ed.envelope_document_id`,
      ...params,
    );
  });
  return {
    affected: rows,
    executed_documents: rows.length,
    envelopes: new Set(rows.map((r) => r.envelope_id)).size,
    tenants: new Set(rows.map((r) => r.tenant_id)).size,
    affected_fields: rows.reduce((n, r) => n + r.affected_fields, 0),
  };
}

export type ReissueRefusalReason =
  | 'envelope_not_completed'
  | 'not_executed'
  | 'purged'
  | 'source_changed'
  | 'reason_required';

export class ExecutedDocumentReissueRefusedError extends Error {
  readonly code = 'EXECUTED_DOCUMENT_REISSUE_REFUSED';
  constructor(public readonly envelope_id: string, public readonly reason: ReissueRefusalReason) {
    super(`Reissue refused for envelope ${envelope_id}: ${reason}`);
    this.name = 'ExecutedDocumentReissueRefusedError';
  }
}

export interface ReissuedDocument {
  envelope_document_id: string;
  original_artifact_id: string;
  original_sha256: string;
  artifact_id: string | null; // null in a dry run
  sha256: string;
  byte_size: number;
}

export interface ReissueOutcome {
  envelope_id: string;
  status: 'reissued' | 'dry_run' | 'already_reissued' | 'not_affected';
  documents: ReissuedDocument[];
  certificate: { original_artifact_id: string; original_sha256: string; artifact_id: string; sha256: string } | null;
}
