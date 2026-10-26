import { v7 as uuidv7 } from 'uuid';

import { currentPublishedVersion } from './plan-version.repository.js';
import type { PrismaService } from './prisma/prisma.service.js';
import { BASE_COMPOSITION, assertProductKey, openBaseSubscription, type ProductKey } from './product-registry.js';

// Multi-Provider directive §B — the governed development/test entitlement path.
// It opens a DEVELOPMENT-source subscription for a local or test tenant so the
// allowance can be exercised end to end. It refuses to run anywhere that looks
// like production: commercial access is never granted silently.

export const AramoSignIncludedPlanKey = 'aramo-sign-included-v1';
// Commercial Plans Amendment A1 — the self-service catalog plans.
export const AramoSignStandardBusinessPlanKey = 'aramo-sign-standard-business-v1';
export const AramoSignStandardProfessionalPlanKey = 'aramo-sign-standard-professional-v1';

export function assertNotProduction(env: NodeJS.ProcessEnv): void {
  const node = (env['NODE_ENV'] ?? '').toLowerCase();
  const aramo = (env['ARAMO_ENV'] ?? '').toLowerCase();
  if (node === 'production' || aramo === 'prod' || aramo === 'production') {
    throw new Error('development subscriptions are refused in production (NODE_ENV/ARAMO_ENV)');
  }
  if (aramo !== 'local' && aramo !== 'test') {
    throw new Error('development subscriptions need ARAMO_ENV=local or ARAMO_ENV=test');
  }
}

/**
 * Idempotent: an existing open subscription of the product is left as it is.
 * CCP-A4 (MP-A2 N-11) — the product is explicit; the plan must be that product's plan.
 */
export async function openDevelopmentSubscription(
  prisma: PrismaService,
  input: { tenant_id: string; product_key: ProductKey; plan_key?: string; period_anchor?: Date; created_by: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ created: boolean; subscription_id: string }> {
  assertNotProduction(env);
  const product_key = assertProductKey(input.product_key);
  const open = await prisma.tenantSubscription.findFirst({ where: openBaseSubscription(input.tenant_id, product_key) });
  if (open !== null) return { created: false, subscription_id: open.id };
  const plan = await prisma.plan.findUnique({ where: { key: input.plan_key ?? AramoSignIncludedPlanKey } });
  if (plan === null) throw new Error(`unknown plan ${input.plan_key ?? AramoSignIncludedPlanKey}`);
  if (plan.product_key !== product_key) throw new Error(`plan ${plan.key} is not a ${product_key} plan`);
  // CCP-A5 (N-18) — pinned to the plan's current (PUBLISHED) version.
  const version = await currentPublishedVersion(prisma, plan.id);
  if (version === null) throw new Error(`plan ${plan.key} has no published version`);
  const id = uuidv7();
  await prisma.tenantSubscription.create({
    data: {
      id,
      tenant_id: input.tenant_id,
      plan_id: plan.id,
      plan_version_id: version.id,
      product_key,
      composition_role: BASE_COMPOSITION,
      period_anchor: input.period_anchor ?? new Date(),
      source: 'DEVELOPMENT',
      created_by: input.created_by,
    },
  });
  return { created: true, subscription_id: id };
}
