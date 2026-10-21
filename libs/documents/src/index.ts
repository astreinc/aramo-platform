// @aramo/documents — canonical, workflow-neutral Documents domain (DOC-1a).
// Public surface grows per boundary.
export const DOCUMENTS_SCHEMA = 'documents' as const;

export { DocumentsModule } from './lib/documents.module.js';
export { DocumentsController, DocumentTypesController } from './lib/documents.controller.js';
export {
  DocumentTemplatesController,
  DocumentRequirementsController,
  DocumentPacketsController,
  templateErrorToHttp,
} from './lib/templates.controller.js';
// DOC-TEMPLATE-LIB-1 T-4 — Org Home template library (gallery, default preview, selection).
export { DocumentTemplateLibraryController, type TemplateLibraryItem } from './lib/template-library.controller.js';

export {
  TEMPLATE_CAPABILITIES,
  type TemplateCapabilitiesPort,
  type TemplateBindingDescriptor,
  type TemplateSamplePreview,
} from './lib/template-capabilities.port.js';
export {
  TEMPLATE_TENANT_LOGO,
  type TemplateTenantLogoPort,
  type TenantLogoInfo,
  type CapturedTenantLogo,
  type TemplateLogoRef,
  // DOC-TEMPLATE-LIB-1 T-4 — tenant branding for the Org Home Aramo-default preview.
  TEMPLATE_TENANT_BRANDING,
  type TemplateTenantBrandingPort,
  type TenantBrandingView,
} from './lib/template-capabilities.port.js';
export {
  TEMPLATE_AUDIT,
  type TemplateAuditPort,
  type TemplateDraftDiscardedAudit,
  type TemplatePlatformWithdrawalAudit,
} from './lib/template-audit.port.js';
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
  type CreatePlatformTemplateInput,
  type CreateVersionInput,
  type AddFieldInput,
} from './lib/templates.repository.js';
// DOC-TEMPLATE-LIB-1 T-2 — the Aramo template variable catalog.
export {
  TemplateVariablesRepository,
  TEMPLATE_VARIABLE_DATA_TYPES,
  type TemplateVariableDataType,
  type TemplateVariableRow,
  type TemplateVariableCatalogReader,
  type CreateTemplateVariableInput,
  type UpdateTemplateVariableInput,
} from './lib/template-variables.repository.js';
export {
  TemplateResolutionService,
  type TemplateResolution,
  type TemplateResolutionSource,
  type ResolveTemplateInput,
} from './lib/template-resolution.service.js';
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
  type StoreProviderExecutedInput,
  type StoreProviderExecutedResult,
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
  // DOC-TEMPLATE-LIB-1 T-2 — the preview gate / one-DRAFT refusals (platform routes + tests).
  TemplatePreviewRequiredError,
  TemplateDraftAlreadyExistsError,
  TemplateVariableNotFoundError,
  TemplateVariableKeyConflictError,
  TemplateSelectionInvalidError,
  // DOC-TEMPLATE-LIB-1 T-6 — Aramo default withdrawal / one-live-default refusals.
  TemplatePlatformDefaultConflictError,
  type TemplatePlatformDefaultConflictReason,
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
