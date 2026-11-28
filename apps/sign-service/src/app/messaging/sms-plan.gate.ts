import { Inject, Injectable, Optional } from '@nestjs/common';
import { TenantRepository } from '@aramo/identity';

// Type-only: the custom-roles gate imports SenderContextService, which imports this gate (no runtime cycle).
import type { SignPlanFeatureReader } from '../custom-roles/sign-custom-roles.gate.js';

// SMS-CONSENT-1 R-4 (LOCKED 2026-11-28) — signer SMS (delivery by text, sign.sms_delivery, and the
// SMS code before signing, sign.sms_otp) is a per-plan feature, the SIGN-FREE-PARITY-1 S5 WhatsApp
// rule: the plan's explicit entitlement (the key in the pinned plan version, set in the CCP
// console) wins; a version that does not name the key falls back to the account kind: BUSINESS
// on, PERSONAL off. The launch switch (feature-availability.ts) is separate and checked by the
// caller. An unreadable subscription store fails closed (not entitled).

/** The SIGN_PLAN_FEATURE_READER token (sign-custom-roles.gate.ts), repeated as a literal to keep the import type-only. */
const PLAN_FEATURE_READER_TOKEN = 'SIGN_PLAN_FEATURE_READER';

export function smsEntitlementOf(setting: boolean | null, tenantKind: string | null): boolean {
  return setting ?? tenantKind === 'BUSINESS';
}

@Injectable()
export class SignSmsPlanGate {
  constructor(
    private readonly tenants: TenantRepository,
    @Optional() @Inject(PLAN_FEATURE_READER_TOKEN) private readonly plans?: SignPlanFeatureReader,
  ) {}

  async entitled(tenant_id: string, feature_key: string): Promise<boolean> {
    try {
      const setting = this.plans?.planFeatureSetting === undefined ? null : await this.plans.planFeatureSetting(tenant_id, feature_key);
      if (setting !== null) return setting;
      const tenant = await this.tenants.findById(tenant_id);
      return smsEntitlementOf(null, tenant?.kind ?? null);
    } catch {
      return false;
    }
  }
}
