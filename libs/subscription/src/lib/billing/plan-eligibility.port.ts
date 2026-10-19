// Commercial Plans Amendment A1 — plan eligibility (Standard Professional needs a
// qualifying Aramo ATS subscription). The authoritative ATS entitlement lives
// outside the subscription library; the composing service binds this port. With
// no binding every eligibility-bound plan is NOT eligible (fail closed).

export const PLAN_ELIGIBILITY_PORT = 'PLAN_ELIGIBILITY_PORT';

export type PlanEligibilityRule = 'ATS_SUBSCRIPTION';

export interface PlanEligibilityPort {
  isEligible(tenant_id: string, rule: PlanEligibilityRule): Promise<boolean>;
}
