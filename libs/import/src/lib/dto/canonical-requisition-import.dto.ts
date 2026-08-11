// T8-P2 — the provider-neutral, transport-neutral canonical inbound requisition
// contract (VMS Integration Directive v1.0 §5). The future T8-CONNECTOR produces
// these records regardless of source (polling / webhook / file / SFTP / operator /
// provider SDK) — this contract carries NO transport, NO provider name, NO
// credential. The Aramo Requisition remains the canonical internal projection;
// there is NO second "VMS requisition" persistent aggregate.
//
// Field classification (directive §5/§6):
//   REQUIRED    — source_system, external_req_id, title, openings, company_id
//   OPTIONAL    — external_status, description, city, state, work_arrangement,
//                 start_date, end_date, job_type, contact_id, imported_at, and
//                 the requisition-LEVEL bill_rate_* trio (§7)
//   UNSUPPORTED — any other key (custom fields, provider extension blocks,
//                 attachments, supplier/program opaque metadata): rejected, NOT
//                 silently dropped (no JSONB escape hatch).
//   DEFERRED    — person/assignment-specific commercial terms (T5-owned): they
//                 are UNSUPPORTED keys here and are rejected, never coerced into
//                 requisition-level economics (§7).

export interface CanonicalRequisitionImportRecord {
  // External identity (T8-P1). Both required; canonicalized + conflict-checked
  // through the governed create path.
  source_system: string;
  external_req_id: string;

  // Required canonical fields.
  title: string;
  openings: number; // maps ONLY to the stored TOTAL openings authority (§8)
  company_id: string; // account resolution input (UUID; cross-schema ref)

  // Lifecycle — an adapter-supplied external status token, resolved to an
  // internal RecruitingStatus via the request's status_mapping (§9).
  external_status?: string;

  // Optional supported fields.
  description?: string;
  city?: string;
  state?: string;
  work_arrangement?: string;
  start_date?: string; // ISO 8601
  end_date?: string; // ISO 8601
  job_type?: string;
  contact_id?: string; // hiring-manager reference (UUID)
  imported_at?: string; // ISO 8601 provenance timestamp

  // Requisition-LEVEL commercial only (§7). These map to the existing gated
  // bill_rate_* fields; write is gated by compensation:* at createForImport.
  // Person/assignment-specific rates are NOT modeled here (T5-owned) — they land
  // as UNSUPPORTED keys and are rejected.
  bill_rate_amount?: string; // decimal string (Decimal-safe wire format)
  bill_rate_currency?: string;
  bill_rate_period?: string;
}

// The set of keys the canonical contract supports. Any key outside this set is
// UNSUPPORTED and rejected (directive §6 — no silent discard, no escape hatch).
export const CANONICAL_REQUISITION_IMPORT_KEYS: readonly string[] = [
  'source_system',
  'external_req_id',
  'title',
  'openings',
  'company_id',
  'external_status',
  'description',
  'city',
  'state',
  'work_arrangement',
  'start_date',
  'end_date',
  'job_type',
  'contact_id',
  'imported_at',
  'bill_rate_amount',
  'bill_rate_currency',
  'bill_rate_period',
];

// external status token (lowercased) → internal RecruitingStatus, or the literal
// 'ignore' to fall back to the default. Provider/transport-neutral.
export type RequisitionImportStatusMapping = Record<string, string>;

// POST /v1/requisition-imports request body.
export interface RunRequisitionImportRequestDto {
  // Audit label (the ImportBatch.source_filename analog). NEVER a credential.
  source_label: string;
  site_id?: string;
  status_mapping?: RequisitionImportStatusMapping;
  records: CanonicalRequisitionImportRecord[];
}
