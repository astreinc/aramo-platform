import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import type { SiteRow } from './sites.view.js';

// Settings Rebuild Directive 4 — Site repository.
//
// Every read and write is TENANT-SCOPED: callers pass the tenant_id pinned
// from the JWT at the controller, and each query carries it in the WHERE.
// There is no cross-tenant path — a site id from tenant B simply does not
// match a `{ id, tenant_id: A }` filter (→ null → 404 at the service).

function toRow(row: {
  id: string;
  tenant_id: string;
  name: string;
  is_active: boolean;
  parent_site_id: string | null;
  created_at: Date;
  updated_at: Date;
}): SiteRow {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    is_active: row.is_active,
    parent_site_id: row.parent_site_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

@Injectable()
export class SiteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAllForTenant(tenantId: string): Promise<SiteRow[]> {
    const rows = await this.prisma.site.findMany({
      where: { tenant_id: tenantId },
      orderBy: [{ name: 'asc' }],
    });
    return rows.map(toRow);
  }

  async findByIdForTenant(
    tenantId: string,
    id: string,
  ): Promise<SiteRow | null> {
    const row = await this.prisma.site.findFirst({
      where: { id, tenant_id: tenantId },
    });
    return row === null ? null : toRow(row);
  }

  // Exact-match dup pre-check (aligned with the DB @@unique([tenant_id, name])).
  async findByNameForTenant(
    tenantId: string,
    name: string,
  ): Promise<SiteRow | null> {
    const row = await this.prisma.site.findFirst({
      where: { tenant_id: tenantId, name },
    });
    return row === null ? null : toRow(row);
  }

  async create(args: {
    tenantId: string;
    name: string;
    parentSiteId: string | null;
  }): Promise<SiteRow> {
    const row = await this.prisma.site.create({
      data: {
        id: uuidv7(),
        tenant_id: args.tenantId,
        name: args.name,
        parent_site_id: args.parentSiteId,
        is_active: true,
      },
    });
    return toRow(row);
  }

  // Writes are pinned to (id, tenant_id) via updateMany so a stale/cross-tenant
  // id can never write another tenant's row; the service re-reads the result.
  async update(
    tenantId: string,
    id: string,
    data: { name?: string; parent_site_id?: string | null },
  ): Promise<SiteRow> {
    await this.prisma.site.updateMany({
      where: { id, tenant_id: tenantId },
      data,
    });
    return this.requireReread(tenantId, id);
  }

  async setActive(
    tenantId: string,
    id: string,
    isActive: boolean,
  ): Promise<SiteRow> {
    await this.prisma.site.updateMany({
      where: { id, tenant_id: tenantId },
      data: { is_active: isActive },
    });
    return this.requireReread(tenantId, id);
  }

  // Re-read after a tenant-pinned updateMany. The service loaded the row
  // before writing, so a null here means a concurrent delete (a true 404).
  private async requireReread(
    tenantId: string,
    id: string,
  ): Promise<SiteRow> {
    const row = await this.prisma.site.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (row === null) {
      throw new AramoError('NOT_FOUND', 'Site not found', 404, {
        requestId: 'sites.write',
        details: { site_id: id },
      });
    }
    return toRow(row);
  }

  async hardDelete(tenantId: string, id: string): Promise<void> {
    await this.prisma.site.deleteMany({ where: { id, tenant_id: tenantId } });
  }

  // "In use" signals for the hard-delete guard.
  async countMemberships(tenantId: string, siteId: string): Promise<number> {
    return this.prisma.userTenantMembership.count({
      where: { tenant_id: tenantId, site_id: siteId },
    });
  }

  async countChildren(tenantId: string, parentSiteId: string): Promise<number> {
    return this.prisma.site.count({
      where: { tenant_id: tenantId, parent_site_id: parentSiteId },
    });
  }
}
