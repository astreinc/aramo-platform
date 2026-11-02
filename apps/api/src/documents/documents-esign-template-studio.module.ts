import { Module } from '@nestjs/common';
import {
  DocumentTemplateLibraryController,
  DocumentTemplatesController,
  PrismaService as DocumentsPrismaService,
  TEMPLATE_AUDIT,
  TEMPLATE_CAPABILITIES,
  TEMPLATE_TENANT_BRANDING,
  TEMPLATE_TENANT_LOGO,
  TemplatesRepository,
  type TemplateAuditPort,
  type TemplateCapabilitiesPort,
  type TemplateTenantBrandingPort,
  type TemplateTenantLogoPort,
} from '@aramo/documents';
import { EntitlementModule, EntitlementRepository } from '@aramo/entitlement';
import { IdentityCoreModule, RoleService, TenantRepository } from '@aramo/identity';

import { EsignServiceRequestGuard } from '../integrations/sign/esign-service-request.guard.js';

import { DocumentsEsignTemplateGalleryController, DocumentsEsignTemplateStudioController } from './documents-esign-template-studio.controller.js';
import { SignTemplateStudioService } from './sign-template-studio.service.js';

// Aramo-TEMPLATE-PRODUCT-1 Implementation Directive v1.0 (LOCKED) §8.3 / §8.5 — the Aramo Sign
// template Studio + "Use as it is" seam module. SELF-CONTAINED like DocumentsEsignTemplatesModule:
// its own documents Prisma + TemplatesRepository (STRING tokens, no bare-class collision with the
// root composition). The tenant template logic is NOT copied: the existing
// DocumentTemplatesController / DocumentTemplateLibraryController classes are constructed here
// as plain objects (not mounted as routes) with the same ports the Org Home routes receive —
// TEMPLATE_CAPABILITIES, TEMPLATE_AUDIT, TEMPLATE_TENANT_LOGO and TEMPLATE_TENANT_BRANDING from
// the @Global TemplateCapabilitiesModule — and driven by SignTemplateStudioService.
// TEMPLATE-PRODUCT-1 §6.3 (TP-5 × TP-7 integration) — the SAME entitlement store (E) the Org
// Home routes receive is passed in too, so the library / preview / adopt entitlement filter is
// enforced here exactly as in Org Home (never bypassed by direct construction). The Sign
// surface then narrows to defaults tagged `sign` (SignTemplateStudioService): one filter,
// products ∩ E ≠ ∅ AND tagged sign (a sign session already implies sign ∈ E).
const TP7_PRISMA = 'TP7_DOCS_PRISMA';
const TP7_TEMPLATES = 'TP7_TEMPLATES_REPO';

@Module({
  imports: [IdentityCoreModule, EntitlementModule],
  controllers: [DocumentsEsignTemplateGalleryController, DocumentsEsignTemplateStudioController],
  providers: [
    { provide: TP7_PRISMA, useFactory: (): DocumentsPrismaService => new DocumentsPrismaService() },
    {
      provide: TP7_TEMPLATES,
      useFactory: (prisma: DocumentsPrismaService): TemplatesRepository => new TemplatesRepository(prisma),
      inject: [TP7_PRISMA],
    },
    {
      provide: SignTemplateStudioService,
      useFactory: (
        templates: TemplatesRepository,
        tenants: TenantRepository,
        roles: RoleService,
        caps: TemplateCapabilitiesPort | undefined,
        audit: TemplateAuditPort | undefined,
        tenantLogo: TemplateTenantLogoPort | undefined,
        branding: TemplateTenantBrandingPort | undefined,
        entitlements: EntitlementRepository,
      ): SignTemplateStudioService =>
        new SignTemplateStudioService({
          templates,
          tenantTemplates: new DocumentTemplatesController(templates, caps ?? undefined, audit ?? undefined, tenantLogo ?? undefined, entitlements),
          library: new DocumentTemplateLibraryController(templates, caps ?? undefined, branding ?? undefined, audit ?? undefined, entitlements),
          tenants,
          roles,
        }),
      inject: [
        TP7_TEMPLATES,
        TenantRepository,
        RoleService,
        { token: TEMPLATE_CAPABILITIES, optional: true },
        { token: TEMPLATE_AUDIT, optional: true },
        { token: TEMPLATE_TENANT_LOGO, optional: true },
        { token: TEMPLATE_TENANT_BRANDING, optional: true },
        EntitlementRepository,
      ],
    },
    EsignServiceRequestGuard,
  ],
})
export class DocumentsEsignTemplateStudioModule {}
