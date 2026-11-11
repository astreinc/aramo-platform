import { v7 as uuidv7 } from 'uuid';

import type { PrismaService } from '../../prisma/prisma.service.js';

import type { BillingProductsPayload } from './billing-product.js';

// CCP Billing Products Directive v1.0 (LOCKED) BP-10 — the outbox write of the governed apply: one PENDING
// BillingProductSync job per billing product, inside the apply transaction. Nothing is sent to a provider
// here; the platform-admin worker (BillingProductsService.drain) sends after commit.

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export async function enqueueBillingProductSync(
  tx: Tx,
  input: { change_request_id: string; plan_id: string; plan_version_id: string; payload: BillingProductsPayload; at: Date },
): Promise<number> {
  for (const p of input.payload.products) {
    await tx.billingProductSync.create({
      data: {
        id: uuidv7(),
        change_request_id: input.change_request_id,
        plan_id: input.plan_id,
        plan_version_id: input.plan_version_id,
        provider: p.provider,
        interval: p.interval,
        product_id: p.product_id,
        status: 'PENDING',
        next_attempt_at: input.at,
        created_at: input.at,
        updated_at: input.at,
      },
    });
  }
  return input.payload.products.length;
}
