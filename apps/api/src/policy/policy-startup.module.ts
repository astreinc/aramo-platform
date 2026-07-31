import { Module } from '@nestjs/common';

import { TenantPolicyCoverageGuard } from './tenant-policy-coverage.guard.js';
import { TenantPolicyCoverageRepository } from './tenant-policy-coverage.repository.js';

// ADR-0024 PR-4a-2 — the startup policy-coverage guard (apps/api). At bootstrap
// it logs loud on any active tenant missing its requisition-lifecycle package,
// and NEVER fail-boots. Follows the libs/common CrossSchemaConsistencyModule
// pg-Pool anti-join pattern, minus the BullMQ/Redis gating — this check must run
// on every boot, synchronously, regardless of Redis.
@Module({
  providers: [TenantPolicyCoverageRepository, TenantPolicyCoverageGuard],
})
export class PolicyStartupModule {}
