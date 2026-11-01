import { Injectable } from '@nestjs/common';

import { subscriptionSends } from './allowance.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { SIGN_PRODUCT_KEY, openBaseSubscription } from './product-registry.js';

// Aramo Sign Feature-Parity 1.1 — the PLAN side of templates in Aramo Sign
// (Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.1, §5 D-1; parent Catalog v2
// directive P-6: the Free plan never gets templates).
//
// Templates are authored ONLY at the platform level (Aramo defaults) and adopted, edited and
// approved by the tenant in the shared Template Studio (TEMPLATE-STUDIO-1 / ORG-UX-1). Aramo
// Sign never creates a template: it lists the tenant's usable templates, previews one and
// starts an envelope from it (DOC-TEMPLATE-LIB-1 T-5). This service answers only whether the
// tenant's Sign plan includes that use.
//
// It is kept apart from the launch availability (feature-availability.ts, `sign.templates`
// NOT_AVAILABLE until the PO authorizes the flip, R-8): sign-service refuses every template
// route while the feature is not available, and only then asks this service.
//
//   NOT_SUBSCRIBED  no open Sign subscription.
//   NONE            the Free plan (P-6: never templates, whatever its capacity row says) or a
//                   subscription that does not send (cancelled, incomplete, past its grace).
//   INCLUDED        every paid plan (Standard, Standard Business, Standard Professional,
//                   Enterprise) and the pre-catalog operator plan.

export type SignTemplateEntitlement =
  | { kind: 'NOT_SUBSCRIBED' }
  | { kind: 'NONE'; plan_key: string; reason: 'free_plan' | 'subscription_inactive' }
  | { kind: 'INCLUDED'; plan_key: string };

@Injectable()
export class SignTemplateEntitlementService {
  constructor(private readonly prisma: PrismaService) {}

  async of(tenant_id: string, at: Date = new Date()): Promise<SignTemplateEntitlement> {
    const sub = await this.prisma.tenantSubscription.findFirst({
      where: openBaseSubscription(tenant_id, SIGN_PRODUCT_KEY),
      select: { status: true, grace_until: true, plan: { select: { key: true, sales_model: true } } },
    });
    if (sub === null) return { kind: 'NOT_SUBSCRIBED' };
    // P-6 — the Free plan never has templates.
    if (sub.plan.sales_model === 'FREE') return { kind: 'NONE', plan_key: sub.plan.key, reason: 'free_plan' };
    if (!subscriptionSends(sub, at)) return { kind: 'NONE', plan_key: sub.plan.key, reason: 'subscription_inactive' };
    return { kind: 'INCLUDED', plan_key: sub.plan.key };
  }
}
