import { randomUUID } from 'node:crypto';

import { AramoError } from '@aramo/common';

// A8-3a — tenant-scoped S3 key convention.
//
// Shape:
//   {tenant_id}/talent/{talent_record_id}/{document_type}/{uuid}-{sanitized_filename}
//
// Rationale:
//   - {tenant_id} at the root prefix → enables IAM-prefix-scoped least-
//     privilege (a tenant's role can be limited to its own prefix).
//   - `talent/` purpose prefix → the A4 AttachmentOwnerType enum has
//     four values (talent | requisition | company | contact). A8-3a
//     wires the `talent` path only; later batches add `requisition/`,
//     `company/`, `contact/` without colliding.
//   - {document_type} → mirrors talent_evidence.TalentDocumentType
//     (resume | cover_letter | certification | work_sample |
//     reference_letter | other). A8-3a uses 'resume' only.
//   - {uuid} prefix on the filename → collision-safe + non-guessable;
//     the user-facing original filename is preserved on
//     `Attachment.file_name` (libs/attachment), not the S3 key.
//   - Sanitized filename → strip path separators + control chars; cap
//     length. The filename in the key is for storage-side debuggability
//     only; the recruiter-facing name lives in the metadata column.

export const RESUME_KEY_DOCUMENT_TYPE = 'resume';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SANITIZED_FILENAME_MAX_LENGTH = 200;

export interface ParsedResumeObjectKey {
  tenant_id: string;
  talent_record_id: string;
  document_type: string;
  filename: string;
}

function assertUuid(value: string, field: string, requestId: string): void {
  if (!UUID_V4_REGEX.test(value)) {
    throw new AramoError(
      'VALIDATION_ERROR',
      `${field} must be a UUID`,
      400,
      { requestId, details: { field, value } },
    );
  }
}

export function sanitizeFilenameForKey(filename: string): string {
  // Strip the path components (everything up to the last separator)
  // and replace anything outside [A-Za-z0-9._-] with '_'. The
  // original filename is preserved on Attachment.file_name; the
  // sanitized one is for storage-side debuggability only.
  const lastSlash = Math.max(
    filename.lastIndexOf('/'),
    filename.lastIndexOf('\\'),
  );
  const base = lastSlash >= 0 ? filename.slice(lastSlash + 1) : filename;
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, '_');
  const truncated = sanitized.slice(0, SANITIZED_FILENAME_MAX_LENGTH);
  return truncated.length === 0 ? 'file' : truncated;
}

export function buildResumeObjectKey(input: {
  tenant_id: string;
  talent_record_id: string;
  filename: string;
  requestId: string;
}): string {
  assertUuid(input.tenant_id, 'tenant_id', input.requestId);
  assertUuid(input.talent_record_id, 'talent_record_id', input.requestId);
  if (input.filename.length === 0) {
    throw new AramoError(
      'VALIDATION_ERROR',
      'filename must be non-empty',
      400,
      { requestId: input.requestId, details: { field: 'filename' } },
    );
  }
  const uuid = randomUUID();
  const safe = sanitizeFilenameForKey(input.filename);
  return `${input.tenant_id}/talent/${input.talent_record_id}/${RESUME_KEY_DOCUMENT_TYPE}/${uuid}-${safe}`;
}

export function parseResumeObjectKey(
  storage_key: string,
): ParsedResumeObjectKey | null {
  // Split by '/'. Expected: [tenant_id, 'talent', talent_record_id,
  // document_type, '{uuid}-{filename}'] → 5 parts exactly. Anything
  // else returns null (the caller decides whether to treat that as a
  // validation refusal or a legacy / non-A8-3a key).
  const parts = storage_key.split('/');
  if (parts.length !== 5) return null;
  const [tenant_id, owner_label, talent_record_id, document_type, last] = parts;
  if (owner_label !== 'talent') return null;
  if (!UUID_V4_REGEX.test(tenant_id ?? '')) return null;
  if (!UUID_V4_REGEX.test(talent_record_id ?? '')) return null;

  // last = '{uuid}-{filename}'. Strip the leading uuid + hyphen.
  const m = (last ?? '').match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-7][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-(.+)$/i,
  );
  if (m === null) return null;

  return {
    tenant_id: tenant_id as string,
    talent_record_id: talent_record_id as string,
    document_type: document_type as string,
    filename: m[2] as string,
  };
}
