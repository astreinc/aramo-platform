// A8-3b — request DTO for POST /v1/talent-records/resume-upload-url (E1).
//
// The recruiter initiates a résumé upload BEFORE the TalentRecord exists
// (Option A: parse-first, attach-on-create). The service generates a
// draft partition UUID internally and embeds it in the storage_key; the
// client receives the storage_key as an opaque token to thread through
// the parse-to-prefill (E2) and create-attach (E3) calls.

export interface ResumeUploadUrlRequestDto {
  /** The résumé file name as the recruiter selected it -- used in the S3 object key for human-readable provenance. */
  filename: string;

  /** The browser-reported content type; e.g. 'application/pdf' or 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'. */
  content_type: string;
}
