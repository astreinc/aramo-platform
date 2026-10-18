import { v7 as uuidv7 } from 'uuid';

import type { PrismaService } from './prisma/prisma.service.js';

// Multi-Provider directive §B — the governed development/test entitlement path.
// It opens a DEVELOPMENT-source subscription for a local or test tenant so the
// allowance can be exercised end to end. It refuses to run anywhere that looks
// like production: commercial access is never granted silently.

export const AramoSignIncludedPlanKey = 'aramo-sign-included-v1';

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

/** Idempotent: an existing open subscription is left as it is. */
export async function openDevelopmentSubscription(
  prisma: PrismaService,
  input: { tenant_id: string; plan_key?: string; period_anchor?: Date; created_by: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ created: boolean; subscription_id: string }> {
  assertNotProduction(env);
  const open = await prisma.tenantSubscription.findFirst({ where: { tenant_id: input.tenant_id, ended_at: null } });
  if (open !== null) return { created: false, subscription_id: open.id };
  const plan = await prisma.plan.findUnique({ where: { key: input.plan_key ?? AramoSignIncludedPlanKey } });
  if (plan === null) throw new Error(`unknown plan ${input.plan_key ?? AramoSignIncludedPlanKey}`);
  const id = uuidv7();
  await prisma.tenantSubscription.create({
    data: {
      id,
      tenant_id: input.tenant_id,
      plan_id: plan.id,
      period_anchor: input.period_anchor ?? new Date(),
      source: 'DEVELOPMENT',
      created_by: input.created_by,
    },
  });
  return { created: true, subscription_id: id };
}
