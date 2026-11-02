import { Injectable, Optional, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';

// ADR-0024 PR-4a-2 — startup coverage repository.
//
// Read-only cross-schema anti-join: ACTIVE identity tenants that hold the ATS
// product (an unrevoked entitlement.TenantEntitlement 'ats' row — the same
// presence-as-entitled read EntitlementGuard gates every ATS route on) with NO
// active requisition-lifecycle policy package. A tenant without the ATS product
// (a Sign-only Business tenant, a Personal tenant) never reaches add-talent, so
// a missing package there is not a gap and is not reported. Implemented with `pg` directly (not a
// per-module Prisma client) because the query spans two schemas (identity +
// policy_store) and no single Prisma client owns both — the same rationale as
// libs/common/cross-schema-consistency.repository.ts. Read-only; never mutates.
//
// Lazy validation (mirrors cross-schema-consistency.repository + libs/consent's
// PrismaService): the constructor does NOT read process.env; the first query
// resolves DATABASE_URL, builds the Pool, and memoizes.

// The requisition-lifecycle package name. The canonical constant lives in
// @aramo/pipeline (the retrieval side); this raw-SQL predicate uses the literal.
const REQUISITION_LIFECYCLE_PACKAGE_NAME = 'requisition-lifecycle';
// The entitlement capability that marks a tenant as holding the ATS product
// (entitlement.Capability 'ats').
const ATS_CAPABILITY = 'ats';

// Active ATS tenants lacking an active requisition-lifecycle package. The
// active-window predicate mirrors libs/policy-store/src/lib/window.ts
// (effective_from <= now AND (effective_to IS NULL OR now < effective_to)).
const UNCOVERED_TENANTS_SQL =
  'SELECT t."id" AS tenant_id, t."name" AS tenant_name ' +
  'FROM "identity"."Tenant" t ' +
  'LEFT JOIN "policy_store"."StoredPolicyVersion" v ' +
  '  ON v."tenant_id" = t."id" ' +
  ' AND v."package_name" = $1 ' +
  ' AND v."effective_from" <= now() ' +
  ' AND (v."effective_to" IS NULL OR now() < v."effective_to") ' +
  'WHERE t."is_active" = true AND v."id" IS NULL ' +
  '  AND EXISTS (SELECT 1 FROM "entitlement"."TenantEntitlement" e ' +
  '              WHERE e."tenant_id" = t."id" AND e."capability"::text = $2 ' +
  '                AND e."revoked_at" IS NULL)';

export interface UncoveredTenant {
  tenant_id: string;
  tenant_name: string;
}

@Injectable()
export class TenantPolicyCoverageRepository implements OnModuleDestroy {
  private readonly explicitUrl?: string;
  private pool: Pool | undefined;

  constructor(@Optional() databaseUrl?: string) {
    this.explicitUrl = databaseUrl;
  }

  async findUncoveredTenants(): Promise<UncoveredTenant[]> {
    const client = await this.acquireClient();
    try {
      const { rows } = await client.query<UncoveredTenant>(
        UNCOVERED_TENANTS_SQL,
        [REQUISITION_LIFECYCLE_PACKAGE_NAME, ATS_CAPABILITY],
      );
      return rows;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool !== undefined) {
      await this.pool.end();
      this.pool = undefined;
    }
  }

  private async acquireClient(): Promise<PoolClient> {
    if (this.pool === undefined) {
      const url = this.explicitUrl ?? process.env['DATABASE_URL'];
      if (url === undefined || url.length === 0) {
        throw new Error('DATABASE_URL is not configured');
      }
      this.pool = new Pool({ connectionString: url });
    }
    return this.pool.connect();
  }
}
