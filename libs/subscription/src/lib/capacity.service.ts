import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { planVersionTerms } from './plan-version.js';
import { PrismaService } from './prisma/prisma.service.js';
import { assertMeteredKeyOf, openBaseSubscription, type ProductKey } from './product-registry.js';

// Commercial Plans Amendment A1 — per-tenant capacity limits (not periodic):
// storage bytes, template count. "Unlimited signing is not unlimited storage."
//
//   reserve → under a per-(tenant, capacity) advisory lock, sum the tenant's
//             ACTIVE rows; refuse when the new object would exceed the plan's
//             limit; else record it (keyed by a stable object ref — a retry of
//             the same object never counts twice).
//   record  → the same without the limit check: objects the service MUST keep
//             (signed copies, certificates) are measured but never refused.
//   release → the object was removed.
// The open subscription's plan decides the limit. No open subscription →
// NOT_SUBSCRIBED. A plan without a row for the capacity (the pre-catalog
// operator plan) is not limited; an unlimited row is not limited. Usage is
// always recorded.
// CCP-A4 (MP-A2 N-11) — the product is explicit (a required ProductKey); only that
// product's open BASE subscription decides the limit, and the capacity key must belong
// to that product (sign.storage_bytes → sign).
// CCP-A5 (MP-A2 N-18) — the limit comes from the subscription's PINNED plan version
// (grandfathering; checksum-verified, fail closed).

export type CapacityRefusal = 'NOT_SUBSCRIBED' | 'CAPACITY_EXCEEDED';

export interface CapacityStatus {
  capacity_key: string;
  limit: number | null;
  unlimited: boolean;
  used: number;
}

export type CapacityReserveResult =
  | { ok: true; already: boolean; status: CapacityStatus }
  | { ok: false; reason: CapacityRefusal; status: CapacityStatus | null };

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

@Injectable()
export class CapacityService {
  constructor(private readonly prisma: PrismaService) {}

  private async limitOf(db: Tx | PrismaService, tenant_id: string, product_key: ProductKey, capacity_key: string): Promise<{ subscribed: boolean; limit: number | null }> {
    assertMeteredKeyOf(product_key, capacity_key);
    const sub = await db.tenantSubscription.findFirst({
      where: openBaseSubscription(tenant_id, product_key),
      include: { plan_version: true },
    });
    if (sub === null) return { subscribed: false, limit: null };
    const row = planVersionTerms(sub.plan_version).capacities.find((c) => c.capacity_key === capacity_key);
    if (row === undefined || row.unlimited || row.limit_quantity === null) return { subscribed: true, limit: null };
    return { subscribed: true, limit: row.limit_quantity };
  }

  private async usedOf(db: Tx | PrismaService, tenant_id: string, capacity_key: string): Promise<number> {
    const agg = await db.capacityUsage.aggregate({ where: { tenant_id, capacity_key, state: 'ACTIVE' }, _sum: { quantity: true } });
    return Number(agg._sum.quantity ?? 0n);
  }

  async status(tenant_id: string, product_key: ProductKey, capacity_key: string): Promise<CapacityStatus & { subscribed: boolean }> {
    const { subscribed, limit } = await this.limitOf(this.prisma, tenant_id, product_key, capacity_key);
    return { capacity_key, limit, unlimited: limit === null, used: await this.usedOf(this.prisma, tenant_id, capacity_key), subscribed };
  }

  async reserve(input: { tenant_id: string; product_key: ProductKey; capacity_key: string; ref: string; quantity: number; enforce?: boolean; at?: Date }): Promise<CapacityReserveResult> {
    assertMeteredKeyOf(input.product_key, input.capacity_key);
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) throw new Error('capacity quantity must be a non-negative integer');
    const enforce = input.enforce ?? true;
    const at = input.at ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`capacity:${input.tenant_id}:${input.capacity_key}`}, 0))`;
      const key = { tenant_id: input.tenant_id, capacity_key: input.capacity_key, ref: input.ref };
      const existing = await tx.capacityUsage.findUnique({ where: { tenant_id_capacity_key_ref: key } });
      const { subscribed, limit } = await this.limitOf(tx, input.tenant_id, input.product_key, input.capacity_key);
      const used = await this.usedOf(tx, input.tenant_id, input.capacity_key);
      const status = (u: number): CapacityStatus => ({ capacity_key: input.capacity_key, limit, unlimited: limit === null, used: u });
      if (existing !== null && existing.state === 'ACTIVE') return { ok: true, already: true, status: status(used) } as const;
      if (enforce && !subscribed) return { ok: false, reason: 'NOT_SUBSCRIBED', status: null } as const;
      if (enforce && limit !== null && used + input.quantity > limit) return { ok: false, reason: 'CAPACITY_EXCEEDED', status: status(used) } as const;
      if (existing !== null) {
        await tx.capacityUsage.update({ where: { id: existing.id }, data: { state: 'ACTIVE', quantity: BigInt(input.quantity), released_at: null, created_at: at } });
      } else {
        await tx.capacityUsage.create({ data: { id: uuidv7(), ...key, quantity: BigInt(input.quantity), created_at: at } });
      }
      return { ok: true, already: false, status: status(used + input.quantity) } as const;
    });
  }

  async release(input: { tenant_id: string; product_key: ProductKey; capacity_key: string; ref: string; at?: Date }): Promise<boolean> {
    assertMeteredKeyOf(input.product_key, input.capacity_key);
    const n = await this.prisma.capacityUsage.updateMany({
      where: { tenant_id: input.tenant_id, capacity_key: input.capacity_key, ref: input.ref, state: 'ACTIVE' },
      data: { state: 'RELEASED', released_at: input.at ?? new Date() },
    });
    return n.count === 1;
  }
}
