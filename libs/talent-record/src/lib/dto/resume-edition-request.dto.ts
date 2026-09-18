// TALENT-INTEL-1 TI-1D-C — the résumé-edition mutation request bodies.

export type ResumeEditionPurposeInput =
  | 'GENERAL'
  | 'ROLE_FAMILY'
  | 'REQUISITION'
  | 'CLIENT_SUBMITTAL'
  | 'USER_DEFINED';

// POST /v1/talent-records/{id}/resume-editions — ingest a NEW edition from an
// OWNED résumé attachment. The server owns authorization, extraction, hashing,
// TalentDocument creation, and edition creation. NO raw storage_key is accepted.
export interface CreateResumeEditionRequestDto {
  attachment_id: string;
  purpose?: ResumeEditionPurposeInput;
  label?: string;
  requisition_id?: string;
  client_context_id?: string;
  derived_from_edition_id?: string;
}

// PUT /v1/talent-records/{id}/resume-editions/default — explicit default change
// (never automatic). Body names the edition to make default.
export interface SetDefaultResumeEditionRequestDto {
  resume_edition_id: string;
}
