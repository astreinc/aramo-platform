import { Global, Module } from '@nestjs/common';
import {
  DocumentsModule,
  TEMPLATE_AUDIT,
  TEMPLATE_CAPABILITIES,
  TEMPLATE_TENANT_LOGO,
  type TemplateAuditPort,
} from '@aramo/documents';
import { IdentityAuditRepository, IdentityCoreModule, TenantRepository } from '@aramo/identity';
import { ObjectStorageModule, ObjectStorageService } from '@aramo/object-storage';

import { AramoS3DocumentStorageAdapter } from '../documents/aramo-s3-document-storage.adapter.js';

import { RtrTemplateCapabilities } from './rtr-template-capabilities.service.js';
import { RtrTemplateTenantLogoService } from './rtr-template-tenant-logo.service.js';

// DOC-TEMPLATE-ADMIN-RTR-1 — provides the RTR template-content capability (catalog +
// closed-binding validation + fixed-sample preview) under the generic TEMPLATE_CAPABILITIES
// token. @Global so the generic DocumentTemplatesController (declared in @aramo/documents'
// DocumentsModule) can resolve it by token without forRoot restructuring. No renderer;
// DOC-TEMPLATE-LIB-1 T-2: reads the TemplateVariable catalog (one read-only repository).
//
// Amendment A1 §1 — also binds TEMPLATE_AUDIT (Discard draft MUST write a template audit
// event) to the tenant audit ledger via IdentityAuditRepository — the NON-swallowing
// writer, so a failed audit write fails the discard (the swallowing IdentityAuditService
// would let a discard proceed un-audited). apps/api already depends on @aramo/identity
// (IdentityCoreModule is imported by RtrModule); zero new nx edges.
export function templateAuditFromIdentity(repo: IdentityAuditRepository): TemplateAuditPort {
  return {
    async recordDraftDiscarded(e) {
      await repo.writeEvent({
        event_type: 'identity.document_template.draft_discarded',
        actor_type: 'user',
        actor_id: e.actor_id,
        tenant_id: e.tenant_id,
        subject_id: e.version_id,
        event_payload: { template_id: e.template_id, version_id: e.version_id, version_number: e.version_number },
        requestId: e.requestId,
      });
    },
    // DOC-TEMPLATE-LIB-1 T-6 (§9) — Aramo default withdrawal published / cancelled. GLOBAL
    // event (tenant_id NULL — a PLATFORM template belongs to no tenant); actor = the
    // platform operator. Non-swallowing: a failed write fails the withdrawal.
    async recordPlatformWithdrawal(e) {
      await repo.writeEvent({
        event_type:
          e.action === 'published'
            ? 'identity.document_template.withdrawal_published'
            : 'identity.document_template.withdrawal_cancelled',
        actor_type: 'user',
        actor_id: e.actor_id,
        tenant_id: null,
        subject_id: e.template_id,
        event_payload: {
          template_id: e.template_id,
          document_type_id: e.document_type_id,
          withdraw_notice_at: e.withdraw_notice_at,
          withdraw_effective_at: e.withdraw_effective_at,
          ...(e.notice_days !== undefined ? { notice_days: e.notice_days } : {}),
          ...(e.reason !== undefined && e.reason !== null ? { reason: e.reason } : {}),
        },
        requestId: e.requestId,
      });
    },
  };
}

@Global()
@Module({
  // DOC-TEMPLATE-LIB-1 T-2 — DocumentsModule exports TemplateVariablesRepository (the
  // Aramo variable catalog the capability reads its allowed bindings from).
  imports: [IdentityCoreModule, ObjectStorageModule, DocumentsModule],
  providers: [
    RtrTemplateCapabilities,
    { provide: TEMPLATE_CAPABILITIES, useExisting: RtrTemplateCapabilities },
    { provide: TEMPLATE_AUDIT, useFactory: templateAuditFromIdentity, inject: [IdentityAuditRepository] },
    // A1 §2.4 — tenant-profile logo capture/read over the documents object storage.
    {
      provide: TEMPLATE_TENANT_LOGO,
      useFactory: (tenants: TenantRepository, storage: ObjectStorageService) =>
        new RtrTemplateTenantLogoService(tenants, new AramoS3DocumentStorageAdapter(storage)),
      inject: [TenantRepository, ObjectStorageService],
    },
  ],
  exports: [TEMPLATE_CAPABILITIES, TEMPLATE_AUDIT, TEMPLATE_TENANT_LOGO],
})
export class TemplateCapabilitiesModule {}
