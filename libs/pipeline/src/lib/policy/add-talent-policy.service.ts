import { Inject, Injectable } from '@nestjs/common';
import { evaluate, type Origin, type PolicyContext, type PolicyPackage } from '@aramo/policy-engine';
import { snapshotPolicyInputs, type InsertPolicyDecisionRecordInput } from '@aramo/policy-store';
import { RequisitionRepository } from '@aramo/requisition';

import { scopesToCapabilities } from './capability-adapter.js';
import { isDecisionAllowed } from './decision-mapping.js';

// AddTalentPolicyService — the PR-3 policy call for REQUISITION_TALENT · ADD.
// It reads the requisition's declared status (§D13b), builds the PolicyContext
// from the principal's resolved scopes (§D10 booleans, never roles), evaluates
// the lifecycle package, and returns the verdict plus the full §D17a
// provenance record the caller will persist. It performs NO write and never
// mutates — the engine participates in the decision; the controller/repository
// own the mutation.
//
// PR-3 RULING: REQUIRES_OVERRIDE is treated as DENY (the override framework is
// PR-4). Handled in decision-mapping.isDecisionAllowed, exhaustive over the
// closed Decision union.

// DI token for the governing policy package (the PR-4 per-tenant seam). Bound
// to the permissive REQUISITION_LIFECYCLE_PACKAGE in PipelineModule; a test
// overrides it to exercise DENY / REQUIRES_OVERRIDE (the shipped package is
// all-ALLOW).
export const REQUISITION_ADD_POLICY_PACKAGE = 'REQUISITION_ADD_POLICY_PACKAGE';

export interface AddTalentPolicyInput {
  readonly tenant_id: string;
  readonly requisition_id: string;
  readonly scopes: readonly string[];
  readonly actor_id: string;
  readonly origin: Origin;
  readonly correlation_id: string;
}

export interface AddTalentPolicyOutcome {
  /** true for ALLOW / ALLOW_WITH_AUDIT; false for DENY / REQUIRES_OVERRIDE. */
  readonly allowed: boolean;
  /** Client-visible reason for a refusal (the ONLY engine detail exposed on 403). */
  readonly reason_code: string;
  /** The §D17a record to persist — carries the engine's REAL verdict. */
  readonly provenance: InsertPolicyDecisionRecordInput;
}

@Injectable()
export class AddTalentPolicyService {
  constructor(
    private readonly requisitions: RequisitionRepository,
    @Inject(REQUISITION_ADD_POLICY_PACKAGE) private readonly pkg: PolicyPackage,
  ) {}

  async decide(input: AddTalentPolicyInput): Promise<AddTalentPolicyOutcome> {
    const status = await this.requisitions.findStatusById({
      tenant_id: input.tenant_id,
      id: input.requisition_id,
    });

    const context: PolicyContext = {
      tenant_id: input.tenant_id,
      resource: 'REQUISITION_TALENT',
      action: 'ADD',
      resource_state: {
        // Declared status (§D13b). A missing requisition contributes no status
        // (no rule matches → default_disposition); PR-3 is permissive so this
        // is ALLOW either way.
        declared: status === null ? {} : { status },
        derived: {},
      },
      principal_capabilities: scopesToCapabilities(input.scopes),
      request_metadata: { correlation_id: input.correlation_id, origin: input.origin },
      environment: 'production',
      time: new Date().toISOString(),
      attributes: {},
    };

    const decision = evaluate(this.pkg, context);
    const head = decision.provenance[0];

    const provenance: InsertPolicyDecisionRecordInput = {
      tenant_id: input.tenant_id,
      decision: decision.decision, // the engine's REAL verdict, not the mapped allow/deny
      policy_version: head?.policy_version ?? this.pkg.version,
      rule_id: head?.rule_id ?? '__default__',
      reason_code: decision.reason_code,
      resource: context.resource,
      action: context.action,
      inputs: snapshotPolicyInputs(context),
      actor_id: input.actor_id,
      origin: input.origin,
      correlation_id: input.correlation_id,
    };

    return { allowed: isDecisionAllowed(decision.decision), reason_code: decision.reason_code, provenance };
  }
}
