export { ObjectStorageModule } from './lib/object-storage.module.js';
export { ObjectStorageService } from './lib/object-storage.service.js';
// Exported for cross-lib integration tests (the A8-3b LocalStack spec
// in libs/resume-parse needs to construct the service manually). The
// module file still gates S3ClientFactory as internal (not in exports).
export { S3ClientFactory } from './lib/s3-client.factory.js';
export {
  buildResumeObjectKey,
  parseResumeObjectKey,
  RESUME_KEY_DOCUMENT_TYPE,
} from './lib/key-convention.js';
export type { ParsedResumeObjectKey } from './lib/key-convention.js';
export { hashIdentifierForLog } from './lib/log-redaction.js';
export type {
  PresignedPutResult,
  PresignedGetResult,
  CreateResumePresignedPutInput,
  CreatePresignedGetInput,
  MarkResumeCommittedInput,
} from './lib/types/presigned-url.types.js';
export {
  OBJECT_STORAGE_MAX_EXPIRY_SECONDS,
  OBJECT_STORAGE_DEFAULT_EXPIRY_SECONDS,
  ORPHAN_SWEEP_TAG_KEY,
  ORPHAN_SWEEP_TAG_VALUE_PENDING,
  ORPHAN_SWEEP_TAG_VALUE_COMMITTED,
} from './lib/object-storage.config.js';
