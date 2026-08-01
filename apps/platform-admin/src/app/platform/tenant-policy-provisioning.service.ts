import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import { PolicyStore } from '@aramo/policy-store';

// ADR-0024 PR-4a-2 — publish a newly-provisioned tenant's requisition-lifecycle
// policy package as a BYTE-IDENTICAL copy of the platform TEMPLATE.
//
// The template is the active requisition-lifecycle version published for the
// platform SENTINEL tenant (seeded by apps/api seed-lifecycle.ts / STAGE C).
// This service reads that version and re-publishes its definition verbatim under
// the new tenant's id, so every tenant gets the same rulebook Astre has —
// checksum-equal, named rule ids preserved (never a fresh __default__-only
// package). Without this, PR-4a's retrieval fails closed and the tenant cannot
// add talent at all.
//
// This app (scope:platform) may import @aramo/policy-store (scope:boundary) but
// NOT @aramo/pipeline (scope:ats), where the canonical package-name constant
// lives; the literal below is duplicated deliberately — the same hand-sync
// pattern as PLATFORM_TENANT_SENTINEL_ID (@aramo/auth). A drift surfaces LOUDLY
// as POLICY_TEMPLATE_MISSING at provision time, never silently.
const REQUISITION_LIFECYCLE_PACKAGE_NAME = 'requisition-lifecycle';

// A stable non-user actor for system-published policy (matches the seed
// publisher in apps/api/src/policy/seed-lifecycle.ts).
const SYSTEM_PUBLISHER = '00000000-0000-0000-0000-000000000000';

@Injectable()
export class TenantPolicyProvisioningService {
  private readonly logger = new Logger(TenantPolicyProvisioningService.name);

  constructor(private readonly policyStore: PolicyStore) {}

  // Copy the platform template package into `tenantId`. Idempotent: a tenant
  // that already holds an active version is a no-op (re-provisioning / retry
  // safe). Throws (loudly) if no template is published — the caller compensates.
  async publishDefaultLifecyclePackage(tenantId: string): Promise<void> {
    const existing = await this.policyStore.getActiveVersion(
      tenantId,
      REQUISITION_LIFECYCLE_PACKAGE_NAME,
    );
    if (existing !== null) {
      this.logger.log(
        `requisition-lifecycle@${existing.version} already active for tenant ${tenantId} — no-op.`,
      );
      return;
    }

    const template = await this.policyStore.getActiveVersion(
      PLATFORM_TENANT_SENTINEL_ID,
      REQUISITION_LIFECYCLE_PACKAGE_NAME,
    );
    if (template === null) {
      // Precondition failure: the seed (STAGE C) must publish the template for
      // the sentinel before any tenant is provisioned. Fail closed and loud.
      throw new AramoError(
        'INTERNAL_ERROR',
        'No active requisition-lifecycle template is published for the platform tenant; run the policy seed (deploy STAGE C) before provisioning tenants',
        500,
        {
          requestId: 'platform.provision',
          details: {
            reason: 'policy_template_missing',
            template_tenant_id: PLATFORM_TENANT_SENTINEL_ID,
            package: REQUISITION_LIFECYCLE_PACKAGE_NAME,
          },
        },
      );
    }

    // Re-publish the template's definition VERBATIM under the new tenant.
    // publish() recomputes the checksum from the definition (canonical
    // serialize → sha256), so a byte-identical definition yields a checksum
    // equal to the template's — asserted below as defense-in-depth.
    const published = await this.policyStore.publish({
      tenant_id: tenantId,
      definition: template.definition,
      published_by: SYSTEM_PUBLISHER,
    });

    if (published.checksum !== template.checksum) {
      throw new AramoError(
        'INTERNAL_ERROR',
        'Provisioned policy package is not a byte-identical copy of the template (checksum mismatch)',
        500,
        {
          requestId: 'platform.provision',
          details: {
            reason: 'policy_template_copy_mismatch',
            tenant_id: tenantId,
            template_checksum: template.checksum,
            copy_checksum: published.checksum,
          },
        },
      );
    }

    this.logger.log(
      `published requisition-lifecycle@${published.version} (checksum ${published.checksum.slice(0, 12)}…) for tenant ${tenantId} — template copy.`,
    );
  }
}
