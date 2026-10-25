import { Injectable } from '@nestjs/common';

import type { Capability } from './capability.js';
import { isCapability } from './capability.js';
import { type EntitlementGrantOutcome, type UngovernedGrantSource, upsertEntitlements } from './entitlement-provenance.js';
import { PrismaService } from './prisma/prisma.service.js';

// EntitlementRepository — read surface for the EntitlementGuard +, since
// AUTHZ-2, the provisioning grant surface.
//
// Looks up the set of capabilities entitled to a tenant. Presence-as-
// entitled (no `enabled` flag at PR-A1b — see schema.prisma comment).
// Soft-disable can be added later via an `enabled` column without
// breaking the read shape.
//
// AUTHZ-2: grantCapabilities writes the (tenant_id, capability) rows the
// platform-tier TenantService.provisionTenant emits as the entitlement-tx
// step of the cross-schema saga (Cognito → identity-tx → entitlement-tx;
// Lead ruling 7 — soft-disable on entitlement failure rather than 2PC). The
// composite PK (@@id([tenant_id, capability])) makes the grant idempotent
// at the row level.
//
// CCP-A7 (Charter D1) — the two READERS count only ACTIVE rows (revoked_at = null): a governed
// revoke stops the capability on the very next request, mint and refresh, and drops the tenant
// from the Intelligence REPLACE sync. The former `createMany … skipDuplicates` grant is the
// shared provenance UPSERT (entitlement-provenance.ts): this ungoverned path (provisioning,
// signup, the seed reconcile) names its non-commercial source and NEVER clears a governed revoke
// (the resurrection guard); each withheld capability is recorded as RESURRECTION_REFUSED.
@Injectable()
export class EntitlementRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getCapabilities(tenantId: string): Promise<Set<Capability>> {
    const rows = await this.prisma.tenantEntitlement.findMany({
      where: { tenant_id: tenantId, revoked_at: null },
      select: { capability: true },
    });
    const result = new Set<Capability>();
    for (const row of rows) {
      if (isCapability(row.capability)) {
        result.add(row.capability);
      }
    }
    return result;
  }

  // ATI-SEP-1 T8 — every tenant holding `capability` (the periodic full REPLACE
  // entitlement sync to Talent Intelligence). Ordered for a stable payload.
  async listTenantIdsWithCapability(capability: Capability): Promise<string[]> {
    const rows = await this.prisma.tenantEntitlement.findMany({
      where: { capability, revoked_at: null },
      select: { tenant_id: true },
      orderBy: { tenant_id: 'asc' },
    });
    return rows.map((r) => r.tenant_id);
  }

  async grantCapabilities(args: {
    tenant_id: string;
    capabilities: readonly Capability[];
    /** C-20 / D4: a non-commercial source (PROVISIONING or SIGNUP). */
    granted_source: UngovernedGrantSource;
    granted_by?: string | null;
  }): Promise<EntitlementGrantOutcome> {
    if (args.capabilities.length === 0) return { granted: [], already_held: [], withheld_revoked: [] };
    return this.prisma.$transaction((tx) =>
      upsertEntitlements(tx, {
        tenant_id: args.tenant_id,
        capabilities: args.capabilities,
        granted_source: args.granted_source,
        granted_by: args.granted_by ?? null,
        change_request_id: null,
      }),
    );
  }
}
