import { Injectable } from '@nestjs/common';
import { EntitlementRepository } from '@aramo/entitlement';
import { TenantRepository } from '@aramo/identity';
import type { PlanEligibilityPort, PlanEligibilityRule } from '@aramo/subscription';

// Commercial Plans Amendment A1 — Standard Professional requires a QUALIFYING
// Aramo ATS subscription.
//
// What the platform can prove today: the tenant's live `ats` entitlement (the
// backend-authoritative ATS access) and that the tenant is ACTIVE. What it
// cannot prove: that the ATS relationship is PAID — ATS has no commercial
// subscription record in this platform. A1 review: entitlement alone must not
// silently stand in for "paid and qualifying", so the rule is OFF until the PO
// confirms which rule qualifies:
//   SIGN_PROFESSIONAL_ELIGIBILITY=ATS_ENTITLEMENT  → live `ats` + ACTIVE tenant
//   unset / anything else                          → nobody is eligible
// Unknown plan rules are never satisfied. Every check reads live state, so a
// removed entitlement or a suspended tenant is seen at the next check.
@Injectable()
export class AtsPlanEligibilityAdapter implements PlanEligibilityPort {
  constructor(
    private readonly entitlements: EntitlementRepository,
    private readonly tenants: TenantRepository,
  ) {}

  async isEligible(tenant_id: string, rule: PlanEligibilityRule, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
    if (rule !== 'ATS_SUBSCRIPTION') return false;
    if (env['SIGN_PROFESSIONAL_ELIGIBILITY']?.trim() !== 'ATS_ENTITLEMENT') return false;
    const tenant = await this.tenants.findById(tenant_id);
    if (tenant === null || tenant.status !== 'ACTIVE') return false;
    return (await this.entitlements.getCapabilities(tenant_id)).has('ats');
  }
}
