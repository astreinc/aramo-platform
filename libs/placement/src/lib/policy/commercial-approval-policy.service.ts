import { Inject, Injectable } from '@nestjs/common';
import { evaluate, type Origin, type PolicyContext } from '@aramo/policy-engine';
import {
  PolicyStore,
  snapshotPolicyInputs,
  type InsertPolicyDecisionRecordInput,
} from '@aramo/policy-store';

import {
  COMMERCIAL_APPROVAL_RESOURCE,
  COMMERCIAL_APPROVAL_LIFECYCLE_PACKAGE_NAME,
  type CommercialApprovalAction,
} from '../lifecycle/commercial-approval-lifecycle.js';

// Commercial Approval (R-POLICY, ADR-0024 at the approval BOUNDARY) — the
// governed-authority-transition policy call. Mirrors OfferTransitionPolicyService:
// the engine EVALUATES may-this-authority-fire against the proposal's declared
// (from) state; it never executes and reads no row. FAIL-CLOSED: no published
// package = DENY. This governs ONLY the authority transitions (margin-approve /
// client-approve / apply / reject) — SUBMIT / WITHDRAW are proposer scope:write
// and never reach here (directive R-POLICY). ADR-0024 is NEVER pushed down into
// createCommercialRevision (the persistence primitive stays scope + DB-constraint).
export const COMMERCIAL_APPROVAL_NO_POLICY_PUBLISHED_REASON = 'NO_POLICY_PUBLISHED';

// The commercial-approval gate's PolicyStore is injected under a DEDICATED token,
// NOT the bare `PolicyStore` class (the Offer lesson): PolicyStore is a per-module
// singleton, and a bare provider would shift what `app.get(PolicyStore, {strict:
// false})` resolves — the pipeline add-talent republish/version-pinning invariant
// reads through that. A distinct STRING token keeps this gate functional while
// leaving the shared class-token resolution exactly as it was, and is immune to
// dist/ dual-package identity drift.
export const COMMERCIAL_APPROVAL_POLICY_STORE = 'COMMERCIAL_APPROVAL_POLICY_STORE';
const NO_POLICY_VERSION = '__none__';
const NO_POLICY_RULE_ID = '__no_policy__';

export type CommercialApprovalDisposition = 'ALLOW' | 'DENY';

export interface CommercialApprovalPolicyInput {
  readonly tenant_id: string;
  readonly action: CommercialApprovalAction;
  readonly from_state: string;
  readonly scopes: readonly string[];
  readonly actor_id: string;
  readonly origin: Origin;
  readonly correlation_id: string;
}

export interface CommercialApprovalPolicyOutcome {
  readonly disposition: CommercialApprovalDisposition;
  readonly reason_code: string;
  readonly provenance: InsertPolicyDecisionRecordInput;
}

@Injectable()
export class CommercialApprovalPolicyService {
  constructor(
    @Inject(COMMERCIAL_APPROVAL_POLICY_STORE) private readonly policyStore: PolicyStore,
  ) {}

  async decide(input: CommercialApprovalPolicyInput): Promise<CommercialApprovalPolicyOutcome> {
    const capabilities: Record<string, boolean> = {};
    for (const s of input.scopes) capabilities[s] = true;

    const context: PolicyContext = {
      tenant_id: input.tenant_id,
      resource: COMMERCIAL_APPROVAL_RESOURCE,
      action: input.action,
      resource_state: { declared: { state: input.from_state }, derived: {} },
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
      COMMERCIAL_APPROVAL_LIFECYCLE_PACKAGE_NAME,
    );

    if (resolved === null) {
      return {
        disposition: 'DENY',
        reason_code: COMMERCIAL_APPROVAL_NO_POLICY_PUBLISHED_REASON,
        provenance: {
          ...base,
          decision: 'DENY',
          policy_version: NO_POLICY_VERSION,
          rule_id: NO_POLICY_RULE_ID,
          reason_code: COMMERCIAL_APPROVAL_NO_POLICY_PUBLISHED_REASON,
        },
      };
    }

    const decision = evaluate(resolved.definition, context);
    const head = decision.provenance[0];
    const provenance: InsertPolicyDecisionRecordInput = {
      ...base,
      decision: decision.decision,
      policy_version: resolved.version,
      rule_id: head?.rule_id ?? '__default__',
      reason_code: decision.reason_code,
    };
    const disposition: CommercialApprovalDisposition =
      decision.decision === 'DENY' ? 'DENY' : 'ALLOW';
    return { disposition, reason_code: decision.reason_code, provenance };
  }
}
