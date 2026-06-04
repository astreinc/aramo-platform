// A8-3a — presigned-URL value types.
//
// The substrate returns short-lived signed URLs; the BROWSER (not the
// API) performs the actual PUT/GET against S3. The API never hosts the
// bytes — matches the libs/attachment A4 design comment (the
// storage_key is opaque to the API).

export interface CreateResumePresignedPutInput {
  tenant_id: string;
  talent_record_id: string;
  filename: string;
  content_type: string;
  expires_in_seconds?: number;
  requestId: string;
}

export interface CreatePresignedGetInput {
  storage_key: string;
  expires_in_seconds?: number;
  requestId: string;
}

export interface PresignedPutResult {
  /**
   * Tenant-scoped S3 key — store this in `Attachment.storage_key`
   * (libs/attachment) after the recruiter's client PUTs to the
   * presigned_url and the upload completes.
   */
  storage_key: string;

  /**
   * Short-lived signed URL the client PUTs the file bytes to. The
   * URL is a bearer credential — bounded by `expires_at`.
   */
  presigned_url: string;

  /** ISO 8601 UTC instant after which the presigned_url is invalid. */
  expires_at: string;
}

export interface PresignedGetResult {
  presigned_url: string;
  expires_at: string;
}

/**
 * A8-3b — input shape for ObjectStorageService.markResumeCommitted.
 * Called by AttachmentService after a successful is_resume=true
 * Attachment.create; clears the `lifecycle=orphan-pending` tag so the
 * S3 lifecycle Rule 5 does not sweep the committed object.
 */
export interface MarkResumeCommittedInput {
  storage_key: string;
  requestId: string;
}
