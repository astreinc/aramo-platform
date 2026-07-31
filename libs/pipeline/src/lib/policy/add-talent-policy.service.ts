import { Injectable } from '@nestjs/common';
import { evaluate, type Decision, type Origin, type PolicyContext } from '@aramo/policy-engine';
import { PolicyStore, snapshotPolicyInputs, type InsertPolicyDecisionRecordInput } from '@aramo/policy-store';
import { RequisitionRepository } from '@aramo/requisition';

import { scopesToCapabilities } from './capability-adapter.js';
import { isDecisionAllowed } from './decision-mapping.js';

// AddTalentPolicyService — the policy call for REQUISITION_TALENT · ADD, shared
// by both command boundaries (PipelineController + SourcingController).
//
// ADR-0024 §D2/§D7/§D17b — PR-4a: the governing package is DATA, RETRIEVED per
// tenant from policy-store at decision time (getActiveVersion — point-in-time,
// checksum-verified), NOT an in-code constant. A tenant needing different rules
// is a data operation (publish a new version), never a deploy. The PR-3
// in-code scaffold package + its DI token are DELETED.
//
// It reads the requisition's declared status (§D13b), builds the PolicyContext
// from the principal's resolved scopes (§D10 booleans, never roles), evaluates
// the retrieved package, and returns the verdict plus the full §D17a provenance
// record. It performs NO write and never mutates.

// The package identifier this consumer governs. One package per (tenant, name).
export const REQUISITION_LIFECYCLE_PACKAGE_NAME = 'requisition-lifecycle';

// FAIL-CLOSED sentinels (the no-published-package refusal). An unconfigured
// tenant must not be silently ungoverned — that is R3's fail-open in a new
// disguise — so no package resolves to DENY. The provenance still records the
// refusal, keyed by a distinct reason_code; the version/rule are marked
// explicitly as "no policy" rather than faked.
export const NO_POLICY_PUBLISHED_REASON = 'NO_POLICY_PUBLISHED';
const NO_POLICY_VERSION = '__none__';
const NO_POLICY_RULE_ID = '__no_policy__';

export interface AddTalentPolicyInput {
  readonly tenant_id: string;
  readonly requisition_id: string;
  readonly scopes: readonly string[];
  readonly actor_id: string;
  readonly origin: Origin;
  readonly correlation_id: string;
}

export interface AddTalentPolicyOutcome {
  /** true for ALLOW / ALLOW_WITH_AUDIT; false for DENY / REQUIRES_OVERRIDE / no-policy. */
  readonly allowed: boolean;
  /** Client-visible reason for a refusal (the ONLY engine detail exposed on 403). */
  readonly reason_code: string;
  /** The §D17a record to persist — carries the REAL verdict + stored version. */
  readonly provenance: InsertPolicyDecisionRecordInput;
}

@Injectable()
export class AddTalentPolicyService {
  constructor(
    private readonly requisitions: RequisitionRepository,
    private readonly policyStore: PolicyStore,
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
        declared: status === null ? {} : { status },
        derived: {},
      },
      principal_capabilities: scopesToCapabilities(input.scopes),
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

    // Retrieve the tenant's active package (checksum-verified inside the store).
    const resolved = await this.policyStore.getActiveVersion(
      input.tenant_id,
      REQUISITION_LIFECYCLE_PACKAGE_NAME,
    );

    if (resolved === null) {
      // FAIL CLOSED — no published package = DENY (§D10; R3 fail-open guard).
      const provenance: InsertPolicyDecisionRecordInput = {
        ...base,
        decision: 'DENY' as Decision,
        policy_version: NO_POLICY_VERSION,
        rule_id: NO_POLICY_RULE_ID,
        reason_code: NO_POLICY_PUBLISHED_REASON,
      };
      return { allowed: false, reason_code: NO_POLICY_PUBLISHED_REASON, provenance };
    }

    const decision = evaluate(resolved.definition, context);
    const head = decision.provenance[0];

    const provenance: InsertPolicyDecisionRecordInput = {
      ...base,
      decision: decision.decision, // the engine's REAL verdict, not the mapped allow/deny
      // The STORED version (§D17b) — a real published version string, not a
      // hardcoded one; the rule_id comes from the checksum-verified package.
      policy_version: resolved.version,
      rule_id: head?.rule_id ?? '__default__',
      reason_code: decision.reason_code,
    };

    return { allowed: isDecisionAllowed(decision.decision), reason_code: decision.reason_code, provenance };
  }
}
