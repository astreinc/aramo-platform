import { Module } from '@nestjs/common';
import {
  DocumentIdempotencyService,
  DocumentsRepository,
  PrismaService as DocumentsPrismaService,
  RenderService,
  TEMPLATE_CAPABILITIES,
  TEMPLATE_TENANT_LOGO,
  TemplatesRepository,
  type DocumentStoragePort,
  type TemplateCapabilitiesPort,
  type TemplateTenantLogoPort,
} from '@aramo/documents';
import { PdfLibDocumentRenderingAdapter, type DocumentRenderingPort } from '@aramo/documents-rendering';
import { ObjectStorageModule, ObjectStorageService } from '@aramo/object-storage';
import { TalentRecordModule, TalentRecordRepository } from '@aramo/talent-record';
import { RequisitionModule, RequisitionRepository } from '@aramo/requisition';
import { CompanyModule, CompanyRepository } from '@aramo/company';
import { IdentityCoreModule, IdentityRepository, TenantRepository } from '@aramo/identity';

import { EsignServiceRequestGuard } from '../integrations/sign/esign-service-request.guard.js';
import { RtrTemplateBindingService } from '../rtr/rtr-template-binding.service.js';
import { RtrTemplateResolverService } from '../rtr/rtr-template-resolver.service.js';

import { AramoS3DocumentStorageAdapter } from './aramo-s3-document-storage.adapter.js';
import { DocumentsEsignTemplatesController } from './documents-esign-templates.controller.js';
import { SignTemplateLibraryService } from './sign-template-library.service.js';

// DOC-TEMPLATE-LIB-1 T-5 (§7) — the Aramo Sign template-library seam module. SELF-CONTAINED
// like DocumentsEsignModule / RtrModule: its own documents Prisma, storage, rendering,
// repositories and the RTR content resolver + binding, wired by STRING-token factories (no
// bare-class-token collision with the root composition). TEMPLATE_CAPABILITIES and
// TEMPLATE_TENANT_LOGO come from the @Global TemplateCapabilitiesModule. The binding
// service's ATS repositories are constructed only because its constructor takes them —
// the Sign path (bindProvided) never reads ATS data.
const T5_PRISMA = 'DOCLIB_T5_DOCS_PRISMA';
const T5_STORAGE = 'DOCLIB_T5_DOCS_STORAGE';
const T5_TEMPLATES = 'DOCLIB_T5_TEMPLATES_REPO';

@Module({
  imports: [ObjectStorageModule, TalentRecordModule, RequisitionModule, CompanyModule, IdentityCoreModule],
  controllers: [DocumentsEsignTemplatesController],
  providers: [
    { provide: T5_PRISMA, useFactory: (): DocumentsPrismaService => new DocumentsPrismaService() },
    {
      provide: T5_STORAGE,
      useFactory: (storage: ObjectStorageService): DocumentStoragePort => new AramoS3DocumentStorageAdapter(storage),
      inject: [ObjectStorageService],
    },
    {
      provide: T5_TEMPLATES,
      useFactory: (prisma: DocumentsPrismaService): TemplatesRepository => new TemplatesRepository(prisma),
      inject: [T5_PRISMA],
    },
    {
      provide: SignTemplateLibraryService,
      useFactory: (
        prisma: DocumentsPrismaService,
        storage: DocumentStoragePort,
        templates: TemplatesRepository,
        talent: TalentRecordRepository,
        requisitions: RequisitionRepository,
        companies: CompanyRepository,
        tenants: TenantRepository,
        identity: IdentityRepository,
        caps: TemplateCapabilitiesPort | undefined,
        tenantLogo: TemplateTenantLogoPort | undefined,
      ): SignTemplateLibraryService => {
        const idempotency = new DocumentIdempotencyService(prisma);
        const rendering: DocumentRenderingPort = new PdfLibDocumentRenderingAdapter();
        return new SignTemplateLibraryService({
          templates,
          documents: new DocumentsRepository(prisma, idempotency),
          render: new RenderService(prisma, rendering, storage),
          idempotency,
          storage,
          resolver: new RtrTemplateResolverService(templates),
          binding: new RtrTemplateBindingService(talent, requisitions, companies, tenants, identity),
          tenants,
          ...(caps !== undefined && caps !== null ? { caps } : {}),
          ...(tenantLogo !== undefined && tenantLogo !== null ? { tenantLogo } : {}),
        });
      },
      inject: [
        T5_PRISMA,
        T5_STORAGE,
        T5_TEMPLATES,
        TalentRecordRepository,
        RequisitionRepository,
        CompanyRepository,
        TenantRepository,
        IdentityRepository,
        { token: TEMPLATE_CAPABILITIES, optional: true },
        { token: TEMPLATE_TENANT_LOGO, optional: true },
      ],
    },
    EsignServiceRequestGuard,
  ],
})
export class DocumentsEsignTemplatesModule {}
