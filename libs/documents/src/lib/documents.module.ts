import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';

import { DocumentsController, DocumentTypesController } from './documents.controller.js';
import {
  DocumentPacketsController,
  DocumentRequirementsController,
  DocumentTemplatesController,
} from './templates.controller.js';
import { DocumentsRepository } from './documents.repository.js';
import { TemplatesRepository } from './templates.repository.js';
import { RequirementsRepository } from './requirements.repository.js';
import { DocumentIdempotencyService } from './idempotency.service.js';
import { PrismaService } from './prisma/prisma.service.js';

// DOC-1a — Documents domain module. Imports the guard-dependency modules
// (mirrors AttachmentModule): AuthModule → JwtAuthGuard, AuthorizationModule →
// RolesGuard, EntitlementModule → EntitlementGuard. All three are scope:shared,
// so a scope:boundary lib may depend on them. The storage-port binding
// (DOCUMENT_STORAGE_PORT -> AramoS3DocumentStorageAdapter) is provided at the
// apps/api composition root, keeping this lib free of any object-storage / AWS
// dependency (scope:boundary neutrality).
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule],
  controllers: [
    DocumentTypesController,
    DocumentsController,
    DocumentTemplatesController,
    DocumentRequirementsController,
    DocumentPacketsController,
  ],
  providers: [
    PrismaService,
    DocumentIdempotencyService,
    DocumentsRepository,
    TemplatesRepository,
    RequirementsRepository,
  ],
  exports: [DocumentsRepository, DocumentIdempotencyService, TemplatesRepository, RequirementsRepository],
  // NOTE (DOC-2): the rendering capability (DocumentRenderingPort +
  // PdfLibDocumentRenderingAdapter + SafePdfPipeline + RenderService) is
  // implemented in @aramo/documents-rendering + render.service.ts and proven by
  // direct-instantiation integration tests. Its apps/api composition-root wiring
  // (which needs DOCUMENT_STORAGE_PORT, bound at the root) lands with the render
  // HTTP endpoint in DOC-3 — deferred here to avoid an unrouted eager provider
  // depending cross-scope on DOCUMENT_STORAGE_PORT.
})
export class DocumentsModule {}
