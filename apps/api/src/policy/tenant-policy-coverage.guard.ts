import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { TenantPolicyCoverageRepository } from './tenant-policy-coverage.repository.js';

// ADR-0024 PR-4a-2 — startup policy-coverage guard.
//
// At application bootstrap, scan for ACTIVE tenants with NO active
// requisition-lifecycle policy package — the gap that tenant provisioning is
// meant to close. Each such tenant's add-talent path fails closed (PR-4a: no
// package = DENY), so this surfaces a mis-provisioned or pre-PR-4a-2 tenant at
// BOOT rather than at a recruiter's first add. It LOGS LOUD at ERROR with the
// tenant ids.
//
// >>> NEVER FAIL-BOOT. <<< A config gap must not become a total outage: a
// package-less tenant must not stop the API from starting. Every path here logs
// and returns — nothing throws out of onApplicationBootstrap.
@Injectable()
export class TenantPolicyCoverageGuard implements OnApplicationBootstrap {
  private readonly logger = new Logger(TenantPolicyCoverageGuard.name);

  constructor(private readonly repo: TenantPolicyCoverageRepository) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const uncovered = await this.repo.findUncoveredTenants();
      if (uncovered.length === 0) {
        this.logger.log(
          'tenant policy coverage OK — every active tenant has an active requisition-lifecycle package.',
        );
        return;
      }
      // LOUD: one ERROR carrying the count + every uncovered tenant id. These
      // tenants cannot add talent until a package is published (a provisioning
      // gap, or a tenant created before PR-4a-2). NOT fatal — API still starts.
      this.logger.error(
        `tenant policy coverage GAP — ${uncovered.length} active tenant(s) have NO active requisition-lifecycle package and will fail closed on add-talent: ${uncovered
          .map((t) => `${t.tenant_id} (${t.tenant_name})`)
          .join(', ')}`,
      );
    } catch (err) {
      // The scan itself failed (e.g. DB not reachable at boot). Log and move on
      // — the guard is advisory and must never block startup.
      this.logger.error(
        `tenant policy coverage scan failed (non-fatal; startup continues): ${
          (err as Error).message
        }`,
      );
    }
  }
}
