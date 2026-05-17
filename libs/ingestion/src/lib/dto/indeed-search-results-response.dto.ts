import type {
  DedupOutcomeDto,
} from './ingestion-payload-response.dto.js';

// POST /v1/ingestion/indeed/search-results response. The record is
// stored as `shortlisted_not_unlocked` (Phase 4 Group 3 Step 1
// semantics — the unlock flow is M7 scope). Source-derived consent
// is registered per Group 2 v2.3a (Indeed = partial; never all-yes).
//
// The response shape is Charter-R10-clean (no R10-forbidden output
// fields).

export type IndeedIngestionStatus = 'shortlisted_not_unlocked';

export interface IndeedSearchResultsResponseDto {
  id: string;
  tenant_id: string;
  source: 'indeed';
  status: IndeedIngestionStatus;
  dedup: DedupOutcomeDto;
  created_at: string;
}
