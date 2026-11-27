import { Inject, Injectable, Optional } from '@nestjs/common';
import { TenantRepository } from '@aramo/identity';

// Type-only: the custom-roles gate imports SenderContextService, which imports this gate (no runtime cycle).
import type { SignPlanFeatureReader } from '../custom-roles/sign-custom-roles.gate.js';
import { SIGN_WHATSAPP_DELIVERY_FEATURE } from '../sign-feature.gate.js';

// SIGN-FREE-PARITY-1 S5 (LOCKED 2026-11-27, ruling FP-R3) — WhatsApp delivery is a per-plan feature:
// Aramo pays per message, so it is off on Free and on for Business. The plan's explicit entitlement
// (`sign.whatsapp_delivery` in the pinned plan version, set in the CCP console) wins; a version that
// does not name the key falls back to the account kind (typed divergence D-6): BUSINESS on, PERSONAL
// off. The launch switch (feature-availability.ts) is separate and checked by the caller: nothing is
// sent while it is NOT_AVAILABLE. An unreadable subscription store fails closed (not entitled).

/** The SIGN_PLAN_FEATURE_READER token (sign-custom-roles.gate.ts), repeated as a literal to keep the import type-only. */
const PLAN_FEATURE_READER_TOKEN = 'SIGN_PLAN_FEATURE_READER';

export function whatsappEntitlementOf(setting: boolean | null, tenantKind: string | null): boolean {
  return setting ?? tenantKind === 'BUSINESS';
}

@Injectable()
export class SignWhatsappPlanGate {
  constructor(
    private readonly tenants: TenantRepository,
    @Optional() @Inject(PLAN_FEATURE_READER_TOKEN) private readonly plans?: SignPlanFeatureReader,
  ) {}

  async entitled(tenant_id: string): Promise<boolean> {
    try {
      const setting = this.plans?.planFeatureSetting === undefined ? null : await this.plans.planFeatureSetting(tenant_id, SIGN_WHATSAPP_DELIVERY_FEATURE);
      if (setting !== null) return setting;
      const tenant = await this.tenants.findById(tenant_id);
      return whatsappEntitlementOf(null, tenant?.kind ?? null);
    } catch {
      return false;
    }
  }
}
