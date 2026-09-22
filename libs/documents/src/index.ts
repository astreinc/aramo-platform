// @aramo/documents — canonical, workflow-neutral Documents domain (DOC-1a).
// Public surface grows per boundary.
export const DOCUMENTS_SCHEMA = 'documents' as const;

export { DocumentsModule } from './lib/documents.module.js';
export { DocumentsController, DocumentTypesController } from './lib/documents.controller.js';

export { PrismaService } from './lib/prisma/prisma.service.js';
export {
  DocumentsRepository,
  type CreateDocumentInput,
  type PrepareDocumentInput,
  type DocumentAssociationInput,
  type IdempotencyContext,
} from './lib/documents.repository.js';
export { DocumentIdempotencyService, type IdempotencyCheck } from './lib/idempotency.service.js';
export {
  DocumentNotFoundError,
  DocumentIllegalTransitionError,
  DocumentIdempotencyConflictError,
  DocumentStorageNotSupportedError,
} from './lib/domain/errors.js';
export {
  DOCUMENT_STORAGE_PORT,
  type DocumentStoragePort,
  type PutArtifactInput,
  type PutArtifactResult,
  type ReadAccess,
  type RetentionInput,
  type LegalHoldInput,
} from './lib/storage/document-storage.port.js';
