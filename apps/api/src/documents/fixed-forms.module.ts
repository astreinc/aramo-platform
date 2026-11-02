import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import {
  FixedFormsRepository,
  PrismaService as DocumentsPrismaService,
  TemplateVariablesRepository,
  TemplatesRepository,
  type DocumentStoragePort,
} from '@aramo/documents';
import { ObjectStorageModule, ObjectStorageService } from '@aramo/object-storage';

import { PlatformFixedFormsController } from '../document-templates-platform/platform-fixed-forms.controller.js';

import { AramoS3DocumentStorageAdapter } from './aramo-s3-document-storage.adapter.js';
import { FixedFormService } from './fixed-form.service.js';
import { TenantFixedFormsController } from './tenant-fixed-forms.controller.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7 — Aramo fixed legal forms:
// the Platform Admin authoring routes (§7.1, §7.2, under /platform/document-templates) and the
// tenant read-only + Hide / Show routes (§7.3, under /v1/document-templates/library/fixed-forms).
// SELF-CONTAINED like DocumentsEsignTemplatesModule: its own documents Prisma, storage adapter
// over the documents bucket and repositories, wired by STRING-token factories (no bare-class
// token collides with the root composition). TEMPLATE_AUDIT comes from the @Global
// TemplateCapabilitiesModule; the guards from Auth / Authorization / Entitlement modules (all
// already apps/api dependencies — zero new nx edges).
const FF_PRISMA = 'TP6_FIXED_FORMS_DOCS_PRISMA';
const FF_STORAGE = 'TP6_FIXED_FORMS_DOCS_STORAGE';

@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule, ObjectStorageModule],
  controllers: [PlatformFixedFormsController, TenantFixedFormsController],
  providers: [
    { provide: FF_PRISMA, useFactory: (): DocumentsPrismaService => new DocumentsPrismaService() },
    {
      provide: FF_STORAGE,
      useFactory: (storage: ObjectStorageService): DocumentStoragePort => new AramoS3DocumentStorageAdapter(storage),
      inject: [ObjectStorageService],
    },
    {
      provide: FixedFormsRepository,
      useFactory: (prisma: DocumentsPrismaService) => new FixedFormsRepository(prisma),
      inject: [FF_PRISMA],
    },
    {
      provide: FixedFormService,
      useFactory: (prisma: DocumentsPrismaService, forms: FixedFormsRepository, storage: DocumentStoragePort) =>
        new FixedFormService(forms, new TemplatesRepository(prisma), new TemplateVariablesRepository(prisma), storage),
      inject: [FF_PRISMA, FixedFormsRepository, FF_STORAGE],
    },
  ],
})
export class FixedFormsModule {}
