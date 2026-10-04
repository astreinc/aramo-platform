import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { TemplatesRepository } from '@aramo/documents';

// RTR-TEMPLATE-1 (§7) — publish a newly-provisioned tenant's default
// Right-to-Represent template as a BYTE-IDENTICAL copy of the platform TEMPLATE,
// mirroring TenantPolicyProvisioningService exactly. The template is the active
// tenant-wide RIGHT_TO_REPRESENT DocumentTemplate held by the platform SENTINEL
// tenant (seeded by the RTR-TEMPLATE-1 backfill migration). This reads that
// version and re-publishes its content verbatim under the new tenant so every
// tenant resolves the same governed RTR definition the sentinel holds. Without
// it, RTR request fails closed (INV-12, no inline fallback) and the tenant cannot
// produce an RTR — which gates submittal.
//
// This app (scope:platform) may import @aramo/documents (scope:boundary) — the
// same wall-legal path policy provisioning uses for @aramo/policy-store.
//
// HAND-SYNC BOUNDARY: the RIGHT_TO_REPRESENT DocumentType id below is duplicated
// deliberately (scope:platform must not import the scope:ats apps/api constant),
// the same pattern as PLATFORM_TENANT_SENTINEL_ID. A drift between this literal
// and the actually-seeded RIGHT_TO_REPRESENT DocumentType is asserted LOUDLY by
// tenant-document-template-provisioning drift test — it is a verified hand-sync
// boundary, never a second source of truth. Exported ONLY so that drift test can
// assert it against the seeded DocumentType; not for runtime reuse elsewhere.
export const RIGHT_TO_REPRESENT_TYPE_ID = 'd0c50005-0000-7000-8000-000000000001';

// A stable non-user actor for system-published templates (matches the backfill
// migration's created_by and the policy provisioning SYSTEM_PUBLISHER).
const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class TenantDocumentTemplateProvisioningService {
  private readonly logger = new Logger(TenantDocumentTemplateProvisioningService.name);

  constructor(private readonly templates: TemplatesRepository) {}

  // Copy the platform template's active RTR template into `tenantId`. Idempotent:
  // a tenant already holding an active tenant-wide RTR template is a no-op
  // (re-provisioning / retry safe). Throws (loudly) if the platform template is
  // missing — the caller compensates (soft-disable), exactly like policy.
  async publishDefaultRtrTemplate(tenantId: string): Promise<void> {
    const existing = await this.templates.findActiveTenantTemplateForType(
      tenantId,
      RIGHT_TO_REPRESENT_TYPE_ID,
    );
    if (existing !== null && existing.current_version_id !== null) {
      this.logger.log(`RTR template already active for tenant ${tenantId} — no-op.`);
      return;
    }

    const template = await this.templates.findActiveTenantTemplateForType(
      PLATFORM_TENANT_SENTINEL_ID,
      RIGHT_TO_REPRESENT_TYPE_ID,
    );
    if (template === null || template.current_version_id === null) {
      throw new AramoError(
        'INTERNAL_ERROR',
        'No active Right to Represent template is published for the platform tenant; run the documents RTR backfill/seed before provisioning tenants',
        500,
        {
          requestId: 'platform.provision',
          details: {
            reason: 'rtr_template_missing',
            template_tenant_id: PLATFORM_TENANT_SENTINEL_ID,
            document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
          },
        },
      );
    }

    const sourceVersion = await this.templates.findVersionById(
      PLATFORM_TENANT_SENTINEL_ID,
      template.current_version_id,
    );
    if (sourceVersion === null) {
      throw new AramoError(
        'INTERNAL_ERROR',
        'Platform Right to Represent template has no resolvable current version',
        500,
        {
          requestId: 'platform.provision',
          details: { reason: 'rtr_template_version_missing', template_tenant_id: PLATFORM_TENANT_SENTINEL_ID },
        },
      );
    }

    // Re-create under the new tenant: DRAFT template -> DRAFT version (content
    // copied verbatim) -> activate. activateVersion sets the template ACTIVE and
    // current_version_id, so the resolver finds exactly one ACTIVE tenant-wide
    // template whose current version carries the same content as the sentinel.
    const newTemplate = await this.templates.createTemplate({
      tenant_id: tenantId,
      document_type_id: RIGHT_TO_REPRESENT_TYPE_ID,
      name: template.name,
      description: template.description ?? undefined,
      template_kind: template.template_kind,
      created_by: SYSTEM_ACTOR,
    });
    const newVersion = await this.templates.createVersion({
      tenant_id: tenantId,
      template_id: newTemplate.id,
      render_schema_version: sourceVersion.render_schema_version,
      field_schema: sourceVersion.field_schema ?? undefined,
      binding_schema: sourceVersion.binding_schema ?? undefined,
      created_by: SYSTEM_ACTOR,
    });
    await this.templates.activateVersion({
      tenant_id: tenantId,
      version_id: newVersion.id,
      actor_id: SYSTEM_ACTOR,
    });

    this.logger.log(
      `published default RTR template (v${newVersion.version_number}) for tenant ${tenantId} — platform-template copy.`,
    );
  }
}
