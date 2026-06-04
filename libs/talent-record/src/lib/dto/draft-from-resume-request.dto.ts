// A8-3b — request DTO for POST /v1/talent-records/draft-from-resume (E2).
//
// Input: the storage_key returned by E1. The service fetches the object
// via presigned GET, parses it deterministically (NO LLM per ADR-0015
// Decision 10), and returns the prefill + parse_status.

export interface DraftFromResumeRequestDto {
  storage_key: string;
}
