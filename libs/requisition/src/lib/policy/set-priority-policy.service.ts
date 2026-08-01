import { Injectable } from '@nestjs/common';
import { evaluate, type Origin, type PolicyContext } from '@aramo/policy-engine';
import {
  PolicyStore,
  snapshotPolicyInputs,
  type InsertPolicyDecisionRecordInput,
} from '@aramo/policy-store';

// ADR-0024 PR-7 — the REQUISITION · SET_PRIORITY policy call. Governs WHEN the
// is_hot flag may be ASSERTED (set true), keyed on the requisition's declared
// status. It reads no is_hot value and it never writes: it retrieves the tenant's
// active package, evaluates the decision, and returns the verdict + the §D17a
// provenance record for the caller to persist (in the write transaction on
// ALLOW; standalone on DENY).
//
// The package name is duplicated as a literal: the canonical constant lives in
// @aramo/pipeline (scope:ats), but libs/pipeline already depends on
// libs/requisition (AddTalentPolicyService → RequisitionRepository), so importing
// it here would create an nx dependency CYCLE. A drift surfaces loudly as the
// NO_POLICY_PUBLISHED fail-closed refusal.
const REQUISITION_LIFECYCLE_PACKAGE_NAME = 'requisition-lifecycle';
export const NO_POLICY_PUBLISHED_REASON = 'NO_POLICY_PUBLISHED';
const NO_POLICY_VERSION = '__none__';
const NO_POLICY_RULE_ID = '__no_policy__';

export type SetPriorityDisposition = 'ALLOW' | 'DENY';

export interface SetPriorityPolicyInput {
  readonly tenant_id: string;
  /** The requisition's declared status the SET_PRIORITY rule keys on (§D13). */
  readonly status: string;
  readonly scopes: readonly string[];
  readonly actor_id: string;
  readonly origin: Origin;
  readonly correlation_id: string;
}

export interface SetPriorityPolicyOutcome {
  readonly disposition: SetPriorityDisposition;
  readonly reason_code: string;
  /** The §D17a record to persist — carries the REAL verdict + stored version. */
  readonly provenance: InsertPolicyDecisionRecordInput;
}

@Injectable()
export class SetPriorityPolicyService {
  constructor(private readonly policyStore: PolicyStore) {}

  async decide(input: SetPriorityPolicyInput): Promise<SetPriorityPolicyOutcome> {
    const capabilities: Record<string, boolean> = {};
    for (const s of input.scopes) capabilities[s] = true;

    const context: PolicyContext = {
      tenant_id: input.tenant_id,
      resource: 'REQUISITION',
      action: 'SET_PRIORITY',
      resource_state: { declared: { status: input.status }, derived: {} },
      principal_capabilities: capabilities,
      request_metadata: { correlation_id: input.correlation_id, origin: input.origin },
      environment: 'production',
      time: new Date().toISOString(),
      attributes: {},
    };

    const base = {
      tenant_id: input.tenant_id,
      resource: context.resource,
      action: context.action,
      inputs: snapshotPolicyInputs(context),
      actor_id: input.actor_id,
      origin: input.origin,
      correlation_id: input.correlation_id,
    };

    const resolved = await this.policyStore.getActiveVersion(
      input.tenant_id,
      REQUISITION_LIFECYCLE_PACKAGE_NAME,
    );

    if (resolved === null) {
      // FAIL CLOSED — no published package = DENY (consistent with the add-talent
      // consumer; a tenant with no package cannot function, PR-4a-2 seeds one).
      return {
        disposition: 'DENY',
        reason_code: NO_POLICY_PUBLISHED_REASON,
        provenance: {
          ...base,
          decision: 'DENY',
          policy_version: NO_POLICY_VERSION,
          rule_id: NO_POLICY_RULE_ID,
          reason_code: NO_POLICY_PUBLISHED_REASON,
        },
      };
    }

    const decision = evaluate(resolved.definition, context);
    const head = decision.provenance[0];
    const provenance: InsertPolicyDecisionRecordInput = {
      ...base,
      decision: decision.decision, // the engine's REAL verdict
      policy_version: resolved.version, // the STORED version (§D17b)
      rule_id: head?.rule_id ?? '__default__',
      reason_code: decision.reason_code,
    };
    // SET_PRIORITY rows are only ALLOW / DENY; map any non-DENY to ALLOW.
    const disposition: SetPriorityDisposition = decision.decision === 'DENY' ? 'DENY' : 'ALLOW';
    return { disposition, reason_code: decision.reason_code, provenance };
  }
}
