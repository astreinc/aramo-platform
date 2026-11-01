import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { takeBillingLock } from './billing/governed-subscription.js';
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

  /** The tenant's open BASE subscription for the product (id, source, plan), or null. */
  async openBaseOf(tenant_id: string, product_key: ProductKey): Promise<OpenBaseSubscription | null> {
    const row = await this.prisma.tenantSubscription.findFirst({
      where: openBaseSubscription(tenant_id, assertProductKey(product_key)),
      select: { id: true, source: true, status: true, billing_provider: true, plan: { select: { key: true, tenant_kind: true } } },
    });
    return row === null
      ? null
      : { id: row.id, source: row.source, status: row.status, billing_provider: row.billing_provider, plan_key: row.plan.key, plan_tenant_kind: row.plan.tenant_kind };
  }

  /**
   * Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §5 — the Personal → Business
   * upgrade ends the FREE subscription (status CANCELED, ended_at now) under the tenant's
   * billing lock. Only a FREE row is ended here (never provider-billed: no billing
   * provider is called); any other open row is refused ('not_free') and left unchanged.
   * No open row → nothing to end. If the identity half of the upgrade then fails, the
   * tenant is still PERSONAL and ensure() reopens the FREE subscription on its next read.
   */
  async endForBusinessUpgrade(input: { tenant_id: string; product_key: ProductKey; at?: Date }): Promise<EndFreeResult> {
    const product_key = assertProductKey(input.product_key);
    const at = input.at ?? new Date();
    return this.prisma.$transaction(async (tx) => {
      await takeBillingLock(tx, input.tenant_id);
      const open = await tx.tenantSubscription.findFirst({
        where: openBaseSubscription(input.tenant_id, product_key),
        select: { id: true, source: true, plan: { select: { key: true } } },
      });
      if (open === null) return { ended: null } as const;
      if (open.source !== FREE_SUBSCRIPTION_SOURCE) return { refused: 'not_free', subscription_id: open.id, source: open.source } as const;
      await tx.tenantSubscription.update({ where: { id: open.id }, data: { ended_at: at, status: 'CANCELED' } });
      return { ended: { id: open.id, plan_key: open.plan.key, source: open.source } } as const;
    });
  }
}

export interface OpenBaseSubscription {
  id: string;
  source: string;
  status: string;
  billing_provider: string | null;
  plan_key: string;
  plan_tenant_kind: string | null;
}

export type EndFreeResult =
  | { readonly ended: { readonly id: string; readonly plan_key: string; readonly source: string } | null }
  | { readonly refused: 'not_free'; readonly subscription_id: string; readonly source: string };
