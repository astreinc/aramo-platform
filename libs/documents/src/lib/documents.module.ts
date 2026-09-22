import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';

import { DocumentsController, DocumentTypesController } from './documents.controller.js';
import { DocumentsRepository } from './documents.repository.js';
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
  controllers: [DocumentTypesController, DocumentsController],
  providers: [PrismaService, DocumentIdempotencyService, DocumentsRepository],
  exports: [DocumentsRepository, DocumentIdempotencyService],
})
export class DocumentsModule {}
