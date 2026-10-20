import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { TenantEntitlementReader } from '../tenant-entitlement-reader.service.js';

import {
  displayFromDescription,
  metaRank,
  ROLE_CATALOG_META,
  type RoleCatalogView,
} from './role-catalog.view.js';

// Settings Rebuild Directive 5 — roles-catalog read service.
//
// Reads the GLOBAL system roles (Role + RoleScope, seeded — the single source)
// and projects each to a RoleCatalogView. Platform roles (super_admin, which
// holds platform:* scopes) are EXCLUDED — the catalog is the tenant-tier role
// set the RolePicker assigns + the matrix displays. The result is sorted by
// presentation tier then display name (legible, deterministic).
//
// The role ROWS are global reference data; the ONE tenant-dependent input is
// the Sign partition (IC-3 PR-8): E-Sign product roles (any esign:* scope) are
// projected ONLY for a tenant that holds the `sign` capability (read LIVE —
// never cached), so an ATS-only tenant's picker never offers a role its
// administrators cannot assign (the assignability gate refuses it anyway —
// IdentityService.assertRoleKeysAssignable — this keeps the two surfaces
// coherent) and a Sign-only tenant's org_admin can work with Sign roles
// without any ATS role or UI assumption. The endpoint stays auth-gated
// (tenant:admin:user-manage) so only an operator who manages users/roles reads it.

@Injectable()
export class RoleCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: TenantEntitlementReader,
  ) {}

  // `tenant_id` — the caller's tenant (AuthContext). Omitted (legacy/internal
  // callers) → the Sign partition is excluded, exactly the pre-PR-8 projection.
  async getCatalog(args?: { tenant_id?: string }): Promise<RoleCatalogView[]> {
    const roles = await this.prisma.role.findMany({
      include: { role_scopes: { include: { scope: true } } },
    });
    const includeEsign =
      args?.tenant_id !== undefined &&
      (await this.entitlements.getCapabilities(args.tenant_id)).has('sign');

    const views: RoleCatalogView[] = [];
    for (const role of roles) {
      const scopeKeys = role.role_scopes.map((rs) => rs.scope.key);
      // Exclude the platform tier (super_admin) — any platform:* scope marks a
      // non-tenant role; the tenant catalog never includes it.
      if (scopeKeys.some((k) => k.startsWith('platform:'))) continue;
      // PX-V1 PX-3 / IC-3 PR-8 — the E-Sign product partition: any esign:* scope
      // marks an esign_* product role, projected only for an esign-entitled tenant.
      if (!includeEsign && scopeKeys.some((k) => k.startsWith('sign:'))) continue;

      const scopes = [...new Set(scopeKeys)].sort();
      const meta = ROLE_CATALOG_META[role.key];
      const view: RoleCatalogView = {
        key: role.key,
        display: displayFromDescription(role.description, role.key),
        description: role.description ?? '',
        tier: meta?.tier ?? 'Other',
        scopes,
        ...(meta?.requiresSetting ? { requires_setting: meta.requiresSetting } : {}),
      };
      views.push(view);
    }

    views.sort(
      (a, b) =>
        metaRank(a.key) - metaRank(b.key) || a.display.localeCompare(b.display),
    );
    return views;
  }
}
