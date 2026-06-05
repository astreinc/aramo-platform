import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// TenantSettingRepository — the DB-access layer for the S1 read seam.
//
// Two operations only (S1 is READ-ONLY per Gate-5 Ruling 3 — the write
// surface lands with S2 alongside the first concrete known-key + its
// validator + its audit-event shape):
//   - findOne(tenant, key)   — single-key lookup (powers `get<K>`)
//   - findAllForTenant(t)    — full tenant snapshot (powers `getAll`)
//
// Per-tenant isolation is the load-bearing invariant: every query carries
// `WHERE tenant_id = $1`. The Gate-5 §4 foundation proof (e) — tenant A's
// rows invisible to tenant B's reads — is a property of these two queries.
@Injectable()
export class TenantSettingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findOne(tenantId: string, key: string): Promise<{ value: unknown } | null> {
    const row = await this.prisma.tenantSetting.findUnique({
      where: { tenant_id_key: { tenant_id: tenantId, key } },
      select: { value: true },
    });
    if (row === null) return null;
    return { value: row.value };
  }

  async findAllForTenant(tenantId: string): Promise<ReadonlyArray<{ key: string; value: unknown }>> {
    const rows = await this.prisma.tenantSetting.findMany({
      where: { tenant_id: tenantId },
      select: { key: true, value: true },
    });
    return rows.map((r) => ({ key: r.key, value: r.value }));
  }
}
