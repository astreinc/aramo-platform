import { Global, Module } from '@nestjs/common';
import { TEMPLATE_AUDIT, TEMPLATE_CAPABILITIES, type TemplateAuditPort } from '@aramo/documents';
import { IdentityAuditRepository, IdentityCoreModule } from '@aramo/identity';

import { RtrTemplateCapabilities } from './rtr-template-capabilities.service.js';

// DOC-TEMPLATE-ADMIN-RTR-1 — provides the RTR template-content capability (catalog +
// closed-binding validation + fixed-sample preview) under the generic TEMPLATE_CAPABILITIES
// token. @Global so the generic DocumentTemplatesController (declared in @aramo/documents'
// DocumentsModule) can resolve it by token without forRoot restructuring. The impl is pure
// (no repos/renderer).
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
  };
}

@Global()
@Module({
  imports: [IdentityCoreModule],
  providers: [
    RtrTemplateCapabilities,
    { provide: TEMPLATE_CAPABILITIES, useExisting: RtrTemplateCapabilities },
    { provide: TEMPLATE_AUDIT, useFactory: templateAuditFromIdentity, inject: [IdentityAuditRepository] },
  ],
  exports: [TEMPLATE_CAPABILITIES, TEMPLATE_AUDIT],
})
export class TemplateCapabilitiesModule {}
