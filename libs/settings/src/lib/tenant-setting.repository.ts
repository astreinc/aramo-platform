import { Injectable } from '@nestjs/common';

import type { Prisma } from '../../prisma/generated/client/client.js';

import { PrismaService } from './prisma/prisma.service.js';

// TenantSettingRepository — the DB-access layer for the Settings
// foundation (S1 read + S2 write).
//
// Three operations after S2:
//   - findOne(tenant, key)              — single-key lookup (powers get<K>)
//   - findAllForTenant(t)               — full tenant snapshot (powers getAll)
//   - upsertOnTx(tx, tenant, key, ...)  — read-then-upsert primitive composed
//                                          by the service inside a $transaction
//                                          (S2 write path)
//
// Per-tenant isolation is the load-bearing invariant: every read/write
// carries `WHERE tenant_id = $1`. The S1 §4 foundation proof (e) — tenant
// A's rows invisible to tenant B's reads — is a property of these queries.
// S2's write path preserves this: the upsert targets the composite
// (tenant_id, key) primary key, so a setter for tenant A cannot write a
// row that any other tenant's read would see.
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

  // S2 write primitive — invoked inside the service's $transaction so the
  // read-then-upsert pair is atomic (the previous_value capture cannot
  // race against a concurrent setter). Composite-PK upsert: INSERT when no
  // row exists; UPDATE in place when it does (the @@id([tenant_id, key])
  // makes this a single-statement no-race operation at the database).
  //
  // last_modified_by is REQUIRED at the write path (the S2 directive
  // ruling — the column is nullable in S1 only because S1 had no writer).
  // The service surface accepts a UUID string; the repository passes it
  // through unchanged.
  async upsertOnTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    key: string,
    value: unknown,
    lastModifiedBy: string,
  ): Promise<{ value: unknown }> {
    const row = await tx.tenantSetting.upsert({
      where: { tenant_id_key: { tenant_id: tenantId, key } },
      create: {
        tenant_id: tenantId,
        key,
        value: value as Prisma.InputJsonValue,
        last_modified_by: lastModifiedBy,
      },
      update: {
        value: value as Prisma.InputJsonValue,
        last_modified_by: lastModifiedBy,
      },
      select: { value: true },
    });
    return { value: row.value };
  }

  // Read primitive on a tx handle (composes with upsertOnTx inside the
  // service's $transaction). Lets the service capture the previous_value
  // atomically with the write without round-tripping the connection pool.
  async findOneOnTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    key: string,
  ): Promise<{ value: unknown } | null> {
    const row = await tx.tenantSetting.findUnique({
      where: { tenant_id_key: { tenant_id: tenantId, key } },
      select: { value: true },
    });
    if (row === null) return null;
    return { value: row.value };
  }
}
