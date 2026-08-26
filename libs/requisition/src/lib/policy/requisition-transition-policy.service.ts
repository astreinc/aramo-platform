import { Inject, Injectable } from '@nestjs/common';
import { evaluate, type Origin, type PolicyContext } from '@aramo/policy-engine';
import {
  PolicyStore,
  snapshotPolicyInputs,
  type InsertPolicyDecisionRecordInput,
} from '@aramo/policy-store';

import {
  REQUISITION_RESOURCE,
  type TransitionAction,
} from '../dto/requisition-transitions.js';

// L1-F2 — the DEDICATED DI token under which RequisitionModule provides the
// requisition PolicyStore. Two independent module-local PolicyStore singletons
// register at composition-root birth (pipeline's add-talent gate + requisition's
// transition/set-priority gates); a bare `PolicyStore` class-token provider would
// join the class-token instance list and shift what `app.get(PolicyStore,
// { strict: false })` resolves — the add-talent republish/version-pinning
// invariant reads through that lookup. Providing + @Inject-ing this string token
// keeps the requisition gates fully functional while leaving the shared
// class-token resolution deterministic (pipeline's add-talent store wins). String
// token: immune to dist/dual-package identity drift. Mirrors OFFER_POLICY_STORE.
export const REQUISITION_POLICY_STORE = 'REQUISITION_POLICY_STORE';

// Track 1 T1-e (§2.2 / §D14) — the REQUISITION governed-transition policy call.
// One of the four transition actions (CLOSE / REOPEN / PUT_ON_HOLD / CANCEL) is
// evaluated against the requisition's DECLARED (from) status. The engine is the
// EVALUATOR; it never executes the transition (§D14). This service reads no row
// and writes nothing: it retrieves the tenant's active package, evaluates, and
// returns the verdict + the §D17a provenance the CALLER persists inside the
// write transaction (so the decision record commits IFF the transition commits
// — and a stale-version CAS abort writes neither, R4).
//
// It is a sibling of SetPriorityPolicyService (PR-7): identical shape, keyed on
// the declared status, one predicate. The difference is the `action` varies
// per transition (SET_PRIORITY is a single fixed action). The package name is
// duplicated as a literal for the same nx-cycle reason SetPriorityPolicyService
// documents; a drift surfaces loudly as NO_POLICY_PUBLISHED fail-closed.
const REQUISITION_LIFECYCLE_PACKAGE_NAME = 'requisition-lifecycle';
export const NO_POLICY_PUBLISHED_REASON = 'NO_POLICY_PUBLISHED';
const NO_POLICY_VERSION = '__none__';
const NO_POLICY_RULE_ID = '__no_policy__';

export type TransitionDisposition = 'ALLOW' | 'DENY';

export interface TransitionPolicyInput {
  readonly tenant_id: string;
  /** The governed action being attempted (§2.2). */
  readonly action: TransitionAction;
  /** The requisition's declared FROM status the rule keys on (§4 Q3). */
  readonly from_status: string;
  readonly scopes: readonly string[];
  readonly actor_id: string;
  readonly origin: Origin;
  readonly correlation_id: string;
}

export interface TransitionPolicyOutcome {
  readonly disposition: TransitionDisposition;
  readonly reason_code: string;
  /** The §D17a record to persist — carries the REAL verdict + stored version. */
  readonly provenance: InsertPolicyDecisionRecordInput;
}

@Injectable()
export class RequisitionTransitionPolicyService {
  constructor(@Inject(REQUISITION_POLICY_STORE) private readonly policyStore: PolicyStore) {}

  async decide(input: TransitionPolicyInput): Promise<TransitionPolicyOutcome> {
    const capabilities: Record<string, boolean> = {};
    for (const s of input.scopes) capabilities[s] = true;

    const context: PolicyContext = {
      tenant_id: input.tenant_id,
      resource: REQUISITION_RESOURCE,
      action: input.action,
      resource_state: { declared: { status: input.from_status }, derived: {} },
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
      // FAIL CLOSED — no published package = DENY (consistent with the
      // SET_PRIORITY / add-talent consumers; a tenant with no package cannot
      // transition, PR-4a-2 seeds one).
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
    // Transition rows are ALLOW / DENY (no REQUIRES_OVERRIDE in the matrices);
    // map any non-DENY verdict to ALLOW defensively.
    const disposition: TransitionDisposition = decision.decision === 'DENY' ? 'DENY' : 'ALLOW';
    return { disposition, reason_code: decision.reason_code, provenance };
  }
}
