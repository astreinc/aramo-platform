import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

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
// There is no tenant-specific data here (roles are global reference data); the
// endpoint is still auth-gated (tenant:admin:user-manage) so only an operator
// who manages users/roles reads it.

@Injectable()
export class RoleCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async getCatalog(): Promise<RoleCatalogView[]> {
    const roles = await this.prisma.role.findMany({
      include: { role_scopes: { include: { scope: true } } },
    });

    const views: RoleCatalogView[] = [];
    for (const role of roles) {
      const scopeKeys = role.role_scopes.map((rs) => rs.scope.key);
      // Exclude the platform tier (super_admin) — any platform:* scope marks a
      // non-tenant role; the tenant catalog never includes it.
      if (scopeKeys.some((k) => k.startsWith('platform:'))) continue;

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
