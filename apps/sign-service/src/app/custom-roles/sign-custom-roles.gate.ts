import { Inject, Injectable, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { ESIGN_ENVELOPE_ALLOWANCE, SIGN_PRODUCT_KEY, SubscriptionLifecycleService } from '@aramo/subscription';

import { SenderContextService } from '../sender/sender-context.service.js';
import { SIGN_CUSTOM_ROLES_FEATURE, SignFeatureGate } from '../sign-feature.gate.js';

// Aramo Sign Feature-Parity Program Directive v1.0 (LOCKED) §1.21 — the server-side gate in
// front of every custom-role route. A route runs only when ALL hold:
//   1. LAUNCH AVAILABILITY  `sign.custom_roles` is AVAILABLE (libs/subscription
//      feature-availability). Shipped NOT_AVAILABLE (R-8): every route refuses with
//      ESIGN_FEATURE_NOT_AVAILABLE until the PO authorizes the flip.
//   2. BUSINESS tenant      custom roles are an organization capability; a PERSONAL account
//      (one person) never has them.
//   3. PLAN ENTITLEMENT     the tenant's current Sign subscription (its pinned plan version)
//      lists `sign.custom_roles` enabled — Professional and Enterprise (§1.21 / D-1). Read
//      live; an unreadable subscription store fails closed.
// The scope check (sign:member:manage) is the route's EsignSenderBoundary; the anti-escalation
// rules are SignCustomRoleService's.

// Injectable plan-entitlement read (tests bind a fake); production reads the subscription.
export const SIGN_PLAN_FEATURE_READER = 'SIGN_PLAN_FEATURE_READER';
export interface SignPlanFeatureReader {
  planFeatureEnabled(tenant_id: string, feature_key: string): Promise<boolean>;
}

@Injectable()
export class SubscriptionPlanFeatureReader implements SignPlanFeatureReader {
  constructor(private readonly lifecycle: SubscriptionLifecycleService) {}

  async planFeatureEnabled(tenant_id: string, feature_key: string): Promise<boolean> {
    const account = await this.lifecycle.account(tenant_id, SIGN_PRODUCT_KEY, ESIGN_ENVELOPE_ALLOWANCE);
    const sub = account.subscription;
    if (sub === null || sub.ended_at !== null) return false;
    return sub.features.some((f) => f.feature_key === feature_key && f.enabled);
  }
}

@Injectable()
export class SignCustomRolesGate {
  constructor(
    private readonly features: SignFeatureGate,
    private readonly senders: SenderContextService,
    @Optional() @Inject(SIGN_PLAN_FEATURE_READER) private readonly plans?: SignPlanFeatureReader,
  ) {}

  async assertUsable(auth: AuthContextType, requestId: string): Promise<void> {
    this.features.assertAvailable(SIGN_CUSTOM_ROLES_FEATURE, requestId);
    const tenant = await this.senders.tenantOf(auth.tenant_id, requestId);
    if (tenant.kind !== 'BUSINESS') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Custom roles are available to organizations only', 403, {
        requestId,
        details: { reason: 'custom_roles_business_only' },
      });
    }
    let entitled = false;
    try {
      entitled = this.plans !== undefined && (await this.plans.planFeatureEnabled(auth.tenant_id, SIGN_CUSTOM_ROLES_FEATURE));
    } catch {
      entitled = false; // fail closed
    }
    if (!entitled) {
      throw new AramoError('ESIGN_FEATURE_NOT_AVAILABLE', 'Custom roles are not included in your organization’s plan', 403, {
        requestId,
        details: { feature_key: SIGN_CUSTOM_ROLES_FEATURE, reason: 'not_in_plan' },
      });
    }
  }
}
