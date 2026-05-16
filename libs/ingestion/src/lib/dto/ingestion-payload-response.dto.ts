// POST /ingestion/payloads response. The ingestion result reports the
// dedup outcome per directive §4.4: detection-and-flag only (PR-12
// does not merge, resolve, or canonicalize duplicates).
//
// `status` discriminates whether the submitted payload created a new
// row ("accepted") or matched an existing one ("duplicate"). For
// duplicates, `existing_payload_id` points at the first row carrying
// the matching dedup key.
//
// The response shape is Charter-R10-clean (no R10-forbidden output fields).

export type IngestionStatus = 'accepted' | 'duplicate';

export type DedupMatchSignal =
  | 'sha256'
  | 'verified_email'
  | 'profile_url';

export interface DedupOutcomeDto {
  // null when status='accepted' (no prior matching row).
  match_signal: DedupMatchSignal | null;
  existing_payload_id: string | null;
}

export interface IngestionPayloadResponseDto {
  id: string;
  tenant_id: string;
  source: string;
  status: IngestionStatus;
  dedup: DedupOutcomeDto;
  created_at: string;
}
