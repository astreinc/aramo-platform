import { Module } from '@nestjs/common';
import {
  DocumentIdempotencyService,
  DocumentsRepository,
  RenderService,
  TemplatesRepository,
  PrismaService as DocumentsPrismaService,
  type DocumentStoragePort,
} from '@aramo/documents';
import {
  PdfLibDocumentRenderingAdapter,
  type DocumentRenderingPort,
} from '@aramo/documents-rendering';
import { SIGNATURE_PROVIDER_PORT, type SignatureProviderPort } from '@aramo/documents-contracts';
import { ObjectStorageModule, ObjectStorageService } from '@aramo/object-storage';
import { TalentRecordModule, TalentRecordRepository } from '@aramo/talent-record';
// DOC-TEMPLATE-ADMIN-RTR-1 T2b — authoritative sources for the expanded RTR binding
// catalog (client.name / requisition.* / recruiting_company.name / recruiter.display_name).
// IdentityCoreModule is the SHARED read surface (exports IdentityRepository +
// TenantRepository) — NOT forRoot-only IdentityModule (apps/api-root exclusive).
import { RequisitionModule, RequisitionRepository } from '@aramo/requisition';
import { CompanyModule, CompanyRepository } from '@aramo/company';
import { IdentityCoreModule, IdentityRepository, TenantRepository } from '@aramo/identity';

import { AramoS3DocumentStorageAdapter } from '../documents/aramo-s3-document-storage.adapter.js';
import { GovernedDocumentSigningService } from '../document-signing/governed-document-signing.service.js';
import { EsignServiceHttpProvider } from '../esign/esign-service-http.provider.js';

import { RtrController } from './rtr.controller.js';
import { RtrOrchestratorService } from './rtr-orchestrator.service.js';
import { RtrTemplateResolverService } from './rtr-template-resolver.service.js';
import { RtrTemplateBindingService } from './rtr-template-binding.service.js';

// DOC-5 (R-5-5) — the RTR composition module. SELF-CONTAINED (own documents
// Prisma + storage + rendering via factories, mirroring DocumentsEsignModule) so
// it wires without disturbing the root composition. STRING tokens for the
// module-local documents repo + render service avoid the bare-class-token
// non-strict-lookup collision. Imports TalentRecordModule (scope:ats — legal in
// untagged apps/api) for authoritative signer resolution.
const RTR_DOCS_PRISMA = 'RTR_DOCS_PRISMA';
const RTR_DOCS_STORAGE = 'RTR_DOCS_STORAGE';
const RTR_DOCS_RENDERING = 'RTR_DOCS_RENDERING';
const RTR_DOCS_REPO = 'RTR_DOCS_REPO';
const RTR_RENDER_SERVICE = 'RTR_RENDER_SERVICE';
const RTR_TEMPLATES_REPO = 'RTR_TEMPLATES_REPO';
// Shared governed-document signing capability, wired module-locally from the SAME documents repo
// + render + signature instances (explicit STRING token — avoids the bare-class-token collision).
const RTR_SIGNING = 'RTR_SIGNING';

@Module({
  imports: [ObjectStorageModule, TalentRecordModule, RequisitionModule, CompanyModule, IdentityCoreModule],
  controllers: [RtrController],
  providers: [
    { provide: RTR_DOCS_PRISMA, useFactory: (): DocumentsPrismaService => new DocumentsPrismaService() },
    {
      provide: RTR_DOCS_STORAGE,
      useFactory: (storage: ObjectStorageService): DocumentStoragePort => new AramoS3DocumentStorageAdapter(storage),
      inject: [ObjectStorageService],
    },
    { provide: RTR_DOCS_RENDERING, useFactory: (): DocumentRenderingPort => new PdfLibDocumentRenderingAdapter() },
    { provide: SIGNATURE_PROVIDER_PORT, useClass: EsignServiceHttpProvider },
    {
      provide: RTR_DOCS_REPO,
      useFactory: (prisma: DocumentsPrismaService): DocumentsRepository =>
        new DocumentsRepository(prisma, new DocumentIdempotencyService(prisma)),
      inject: [RTR_DOCS_PRISMA],
    },
    {
      provide: RTR_RENDER_SERVICE,
      useFactory: (prisma: DocumentsPrismaService, rendering: DocumentRenderingPort, storage: DocumentStoragePort): RenderService =>
        new RenderService(prisma, rendering, storage),
      inject: [RTR_DOCS_PRISMA, RTR_DOCS_RENDERING, RTR_DOCS_STORAGE],
    },
    // RTR-TEMPLATE-1 — template resolution + binding. Templates repo is wired via
    // the same STRING-token factory pattern (avoids the bare-class-token
    // non-strict-lookup collision). The resolver reads templates; the binding
    // service resolves the closed catalog from TalentRecord (scope:ats, legal here).
    {
      provide: RTR_TEMPLATES_REPO,
      useFactory: (prisma: DocumentsPrismaService): TemplatesRepository => new TemplatesRepository(prisma),
      inject: [RTR_DOCS_PRISMA],
    },
    {
      provide: RtrTemplateResolverService,
      useFactory: (templates: TemplatesRepository): RtrTemplateResolverService =>
        new RtrTemplateResolverService(templates),
      inject: [RTR_TEMPLATES_REPO],
    },
    {
      provide: RtrTemplateBindingService,
      useFactory: (
        talent: TalentRecordRepository,
        requisitions: RequisitionRepository,
        companies: CompanyRepository,
        tenants: TenantRepository,
        identity: IdentityRepository,
      ): RtrTemplateBindingService =>
        new RtrTemplateBindingService(talent, requisitions, companies, tenants, identity),
      inject: [TalentRecordRepository, RequisitionRepository, CompanyRepository, TenantRepository, IdentityRepository],
    },
    {
      provide: RTR_SIGNING,
      useFactory: (
        documents: DocumentsRepository,
        render: RenderService,
        signature: SignatureProviderPort,
      ): GovernedDocumentSigningService => new GovernedDocumentSigningService(documents, render, signature),
      inject: [RTR_DOCS_REPO, RTR_RENDER_SERVICE, SIGNATURE_PROVIDER_PORT],
    },
    {
      provide: RtrOrchestratorService,
      useFactory: (
        documents: DocumentsRepository,
        signing: GovernedDocumentSigningService,
        talent: TalentRecordRepository,
        resolver: RtrTemplateResolverService,
        binding: RtrTemplateBindingService,
        templates: TemplatesRepository,
        storage: DocumentStoragePort,
        requisitions: RequisitionRepository,
      ): RtrOrchestratorService =>
        new RtrOrchestratorService(documents, signing, talent, resolver, binding, templates, storage, requisitions),
      inject: [
        RTR_DOCS_REPO,
        RTR_SIGNING,
        TalentRecordRepository,
        RtrTemplateResolverService,
        RtrTemplateBindingService,
        RTR_TEMPLATES_REPO,
        RTR_DOCS_STORAGE,
        RequisitionRepository,
      ],
    },
  ],
})
export class RtrModule {}
