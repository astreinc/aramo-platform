import { Inject, Injectable } from '@nestjs/common';
import { evaluate, type Origin, type PolicyContext } from '@aramo/policy-engine';
import {
  PolicyStore,
  snapshotPolicyInputs,
  type InsertPolicyDecisionRecordInput,
} from '@aramo/policy-store';

import {
  OFFER_RESOURCE,
  OFFER_LIFECYCLE_PACKAGE_NAME,
  type OfferTransitionAction,
} from '../lifecycle/offer-lifecycle.js';

// Offer Lifecycle (R-GOVERNED) — the offer governed-transition policy call.
// Mirrors RequisitionTransitionPolicyService: the engine EVALUATES may-this-fire
// against the offer's declared (from) state; it never executes. Reads no row and
// writes nothing — retrieves the tenant's active offer-lifecycle package,
// evaluates, and returns the verdict + the provenance the caller persists inside
// the write transaction. FAIL-CLOSED: no published package = DENY.
export const OFFER_NO_POLICY_PUBLISHED_REASON = 'NO_POLICY_PUBLISHED';

// Offer Lifecycle — the offer gate's PolicyStore is injected under a DEDICATED
// token, NOT the bare `PolicyStore` class. PolicyStore is a per-module singleton
// (pipeline's add-talent gate + requisition's transition gate each declare their
// own); a THIRD bare `PolicyStore` provider would join the class-token instance
// list and shift what `app.get(PolicyStore, { strict: false })` resolves — the
// add-talent republish/version-pinning invariant reads through that. A distinct
// token keeps the offer gate fully functional while leaving the shared
// class-token resolution exactly as it was. String token: immune to dist/
// dual-package identity drift.
export const OFFER_POLICY_STORE = 'OFFER_POLICY_STORE';
const NO_POLICY_VERSION = '__none__';
const NO_POLICY_RULE_ID = '__no_policy__';

export type OfferTransitionDisposition = 'ALLOW' | 'DENY';

export interface OfferTransitionPolicyInput {
  readonly tenant_id: string;
  readonly action: OfferTransitionAction;
  readonly from_state: string;
  readonly scopes: readonly string[];
  readonly actor_id: string;
  readonly origin: Origin;
  readonly correlation_id: string;
}

export interface OfferTransitionPolicyOutcome {
  readonly disposition: OfferTransitionDisposition;
  readonly reason_code: string;
  readonly provenance: InsertPolicyDecisionRecordInput;
}

@Injectable()
export class OfferTransitionPolicyService {
  constructor(@Inject(OFFER_POLICY_STORE) private readonly policyStore: PolicyStore) {}

  async decide(input: OfferTransitionPolicyInput): Promise<OfferTransitionPolicyOutcome> {
    const capabilities: Record<string, boolean> = {};
    for (const s of input.scopes) capabilities[s] = true;

    const context: PolicyContext = {
      tenant_id: input.tenant_id,
      resource: OFFER_RESOURCE,
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
      OFFER_LIFECYCLE_PACKAGE_NAME,
    );

    if (resolved === null) {
      return {
        disposition: 'DENY',
        reason_code: OFFER_NO_POLICY_PUBLISHED_REASON,
        provenance: {
          ...base,
          decision: 'DENY',
          policy_version: NO_POLICY_VERSION,
          rule_id: NO_POLICY_RULE_ID,
          reason_code: OFFER_NO_POLICY_PUBLISHED_REASON,
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
    const disposition: OfferTransitionDisposition = decision.decision === 'DENY' ? 'DENY' : 'ALLOW';
    return { disposition, reason_code: decision.reason_code, provenance };
  }
}
