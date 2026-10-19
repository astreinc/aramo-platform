import { Injectable } from '@nestjs/common';
import { EntitlementRepository } from '@aramo/entitlement';
import type { PlanEligibilityPort, PlanEligibilityRule } from '@aramo/subscription';

// Commercial Plans Amendment A1 — Standard Professional requires a qualifying
// Aramo ATS subscription. The authoritative ATS entitlement today is the tenant's
// live `ats` capability (backend-authoritative; read on every check, so a removed
// entitlement is seen at the next check). Unknown rules are never satisfied.
@Injectable()
export class AtsPlanEligibilityAdapter implements PlanEligibilityPort {
  constructor(private readonly entitlements: EntitlementRepository) {}

  async isEligible(tenant_id: string, rule: PlanEligibilityRule): Promise<boolean> {
    if (rule !== 'ATS_SUBSCRIPTION') return false;
    return (await this.entitlements.getCapabilities(tenant_id)).has('ats');
  }
}
