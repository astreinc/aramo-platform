import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { currentPublishedVersion } from './plan-version.repository.js';
import { PrismaService } from './prisma/prisma.service.js';
import { BASE_COMPOSITION, assertProductKey, openBaseSubscription, type ProductKey } from './product-registry.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §4 — the FREE subscription
// of a Free Personal tenant.
//
//   plan    aramo-sign-free-personal-v1 (the catalog row stays INACTIVE and not
//           sellable: it is never offered or purchasable; FREE is a system act)
//   source  FREE — no billing provider, no provider objects, no charge, no trial,
//           no automatic paid conversion (a CHECK forbids billing linkage)
//   when    only for a PERSONAL tenant that is ACTIVE (federated binding done,
//           §3.6) and only while SIGN_PERSONAL_SIGNUP_MODE is not `off` (§10)
// Idempotent: a tenant that already has an open subscription keeps it.
// CCP-A4 (MP-A2 N-11) — the product is explicit (the FREE plan is a Sign plan; a plan of
// another product is refused) and only that product's open BASE subscription is read.

export const FreePersonalPlanKey = 'aramo-sign-free-personal-v1';
export const FREE_SUBSCRIPTION_SOURCE = 'FREE';
const SYSTEM_ACTOR = 'system:personal-free';

export type PersonalSignupMode = 'off' | 'invite' | 'open';

/** SIGN_PERSONAL_SIGNUP_MODE — unset or anything unrecognised is `off` (fail closed). */
export function personalSignupMode(env: NodeJS.ProcessEnv = process.env): PersonalSignupMode {
  const v = env['SIGN_PERSONAL_SIGNUP_MODE']?.trim().toLowerCase();
  return v === 'invite' || v === 'open' ? v : 'off';
}

export type FreeSubscriptionRefusal = 'personal_mode_off' | 'tenant_not_personal' | 'tenant_not_active' | 'plan_missing';

export type EnsureFreeResult =
  | { readonly ok: true; readonly opened: boolean; readonly subscription_id: string; readonly source: string }
  | { readonly ok: false; readonly reason: FreeSubscriptionRefusal };

@Injectable()
export class FreePersonalSubscriptionService {
  constructor(private readonly prisma: PrismaService) {}

  async ensure(input: {
    tenant_id: string;
    product_key: ProductKey;
    tenant_kind: string;
    tenant_status: string;
    mode: PersonalSignupMode;
    at?: Date;
  }): Promise<EnsureFreeResult> {
    if (input.mode === 'off') return { ok: false, reason: 'personal_mode_off' };
    if (input.tenant_kind !== 'PERSONAL') return { ok: false, reason: 'tenant_not_personal' };
    if (input.tenant_status !== 'ACTIVE') return { ok: false, reason: 'tenant_not_active' };
    const product_key = assertProductKey(input.product_key);
    const open = await this.prisma.tenantSubscription.findFirst({ where: openBaseSubscription(input.tenant_id, product_key) });
    if (open !== null) return { ok: true, opened: false, subscription_id: open.id, source: open.source };
    const plan = await this.prisma.plan.findUnique({ where: { key: FreePersonalPlanKey } });
    if (plan === null) return { ok: false, reason: 'plan_missing' };
    if (plan.product_key !== product_key) throw new Error(`plan ${plan.key} is not a ${product_key} plan`);
    // CCP-A5 (N-18) — pinned to the plan's current (PUBLISHED) version; none → nothing to open.
    const version = await currentPublishedVersion(this.prisma, plan.id);
    if (version === null) return { ok: false, reason: 'plan_missing' };
    const id = uuidv7();
    try {
      await this.prisma.tenantSubscription.create({
        data: {
          id,
          tenant_id: input.tenant_id,
          plan_id: plan.id,
          plan_version_id: version.id,
          product_key,
          composition_role: BASE_COMPOSITION,
          period_anchor: input.at ?? new Date(),
          source: FREE_SUBSCRIPTION_SOURCE,
          status: 'ACTIVE',
          created_by: SYSTEM_ACTOR,
        },
      });
    } catch (e) {
      // A concurrent first read opened it (one open BASE subscription per tenant and product).
      const again = await this.prisma.tenantSubscription.findFirst({ where: openBaseSubscription(input.tenant_id, product_key) });
      if (again !== null) return { ok: true, opened: false, subscription_id: again.id, source: again.source };
      throw e;
    }
    return { ok: true, opened: true, subscription_id: id, source: FREE_SUBSCRIPTION_SOURCE };
  }
}
