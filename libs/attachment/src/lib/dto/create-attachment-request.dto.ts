import type { AttachmentOwnerType } from './attachment-owner-type.js';

// CreateAttachmentRequestDto — POST /v1/attachments payload.
//
// owner_type + owner_id form the discriminated pointer to the owner.
// At A4 the only validated owner_type is `talent` — the service
// rejects any other owner_type with VALIDATION_ERROR (the discriminator
// is defined for all 4 but the validation wiring lands per batch).
//
// storage_key is opaque to this API at A4: a presigned-URL endpoint
// (M6 PR-6) or the upload step owns its format. The API records what
// the caller supplies.
export interface CreateAttachmentRequestDto {
  owner_type: AttachmentOwnerType;
  owner_id: string;
  file_name: string;
  mime: string;
  size_bytes: number;
  storage_key: string;
  site_id?: string;
  is_resume?: boolean;
}
