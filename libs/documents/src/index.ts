// @aramo/documents — canonical, workflow-neutral Documents domain (DOC-1a).
// Public surface grows per boundary.
export const DOCUMENTS_SCHEMA = 'documents' as const;

export { DocumentsModule } from './lib/documents.module.js';
export { DocumentsController, DocumentTypesController } from './lib/documents.controller.js';
export {
  DocumentTemplatesController,
  DocumentRequirementsController,
  DocumentPacketsController,
} from './lib/templates.controller.js';

export { PrismaService } from './lib/prisma/prisma.service.js';
export {
  DocumentsRepository,
  type CreateDocumentInput,
  type PrepareDocumentInput,
  type DocumentAssociationInput,
  type IdempotencyContext,
} from './lib/documents.repository.js';
export {
  TemplatesRepository,
  type CreateTemplateInput,
  type CreateVersionInput,
  type AddFieldInput,
} from './lib/templates.repository.js';
export {
  RequirementsRepository,
  type CreateRequirementInput,
  type RequirementVerdict,
} from './lib/requirements.repository.js';
export {
  RenderService,
  type GenerateRevisionInput,
  type GenerateRevisionResult,
} from './lib/render.service.js';
export { DocumentIdempotencyService, type IdempotencyCheck } from './lib/idempotency.service.js';
export {
  DocumentExecutedWriteBackService,
  type StoreExecutedInput,
  type StoreExecutedResult,
} from './lib/executed-write-back.service.js';
export { RevisionSourceService } from './lib/revision-source.service.js';
export {
  DocumentNotFoundError,
  DocumentIllegalTransitionError,
  DocumentIdempotencyConflictError,
  ExecutedArtifactHashMismatchError,
  DocumentStorageNotSupportedError,
  TemplateNotFoundError,
  TemplateVersionNotFoundError,
  TemplateVersionNotActiveError,
  TemplateImmutableError,
  DocumentRequirementNotFoundError,
  DocumentRequirementAlreadySatisfiedError,
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
