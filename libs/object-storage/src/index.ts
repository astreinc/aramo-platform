export { ObjectStorageModule } from './lib/object-storage.module.js';
export { ObjectStorageService } from './lib/object-storage.service.js';
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
} from './lib/types/presigned-url.types.js';
export {
  OBJECT_STORAGE_MAX_EXPIRY_SECONDS,
  OBJECT_STORAGE_DEFAULT_EXPIRY_SECONDS,
} from './lib/object-storage.config.js';
