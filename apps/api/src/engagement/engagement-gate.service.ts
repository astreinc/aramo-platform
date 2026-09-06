import { Inject, Injectable } from '@nestjs/common';
import {
  decideEngagement,
  evaluateEngagementReadiness,
  EngagementPolicyService,
  type EngagementDecision,
  type EngagementReadiness,
  type ResolvedEngagementPolicy,
} from '@aramo/engagement';
import type { EngagementEligibilityInput } from '@aramo/submittal-eligibility';

import { ENGAGEMENT_POLICY_DB } from './engagement-policy-gateway.adapter.js';
import { VOICE_EVIDENCE_READER, type VoiceEvidenceReader } from './voice-evidence.adapter.js';

// COMM-C3 — the composition-root engagement gate (directive C3-7/R9/R13/R17). It
// resolves the effective policy, gathers provider-neutral evidence, runs the pure
// evaluator, and returns the minimal typed verdict the pure submittal-eligibility
// decision consumes. It ALSO writes append-only decision provenance — on the
// policy-store connection (NOT the submit transaction), so a deny (which aborts
// the submit tx) still leaves an auditable record. Fail-closed: a missing policy
// or unavailable evidence blocks, with distinct typed reasons (R9).

interface RawDb {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** The audit reason_code for a decision (PART A outcomes) or the dormant/missing fallback. */
function reasonCodeFor(decision: EngagementDecision | null, result: EngagementEligibilityInput): string {
  if (decision !== null) {
    switch (decision.outcome) {
      case 'ALLOW_SATISFIED':
        return 'ENGAGEMENT_SATISFIED';
      case 'ALLOW_ADVISORY':
        return 'ENGAGEMENT_ADVISORY_PROCEED';
      case 'ALLOW_OVERRIDDEN':
        return 'ENGAGEMENT_OVERRIDDEN';
      default:
        return result.deny ?? 'ENGAGEMENT_DENIED';
    }
  }
  return result.satisfied ? 'ENGAGEMENT_SATISFIED' : (result.deny ?? 'ENGAGEMENT_DENIED');
}

export interface EngagementAssessInput {
  readonly tenant_id: string;
  readonly talent_id: string;
  readonly requisition_id: string;
  readonly company_id: string | null;
  readonly actor_id: string;
  readonly correlation_id: string;
  /** The submittal being decided (audit provenance, A8). */
  readonly submittal_id?: string;
  /** The actor holds `engagement:policy:override` (resolved upstream from scopes). */
  readonly actor_can_override?: boolean;
  /** An explicit override with a human reason (PART A / A6-A8). */
  readonly override?: { readonly reason: string } | undefined;
}

@Injectable()
export class EngagementGateService {
  constructor(
    private readonly policy: EngagementPolicyService,
    @Inject(VOICE_EVIDENCE_READER) private readonly reader: VoiceEvidenceReader,
    @Inject(ENGAGEMENT_POLICY_DB) private readonly db: RawDb,
  ) {}

  /**
   * Assess engagement readiness for a Talent × Requisition submittal. Returns the
   * typed verdict for the pure eligibility decision, and durably records the
   * decision provenance (append-only). Never throws for a business deny — it
   * returns satisfied=false with a distinct typed reason.
   */
  async assess(input: EngagementAssessInput): Promise<EngagementEligibilityInput> {
    const policy = await this.policy.resolveEffective(input.tenant_id, {
      company_id: input.company_id,
      requisition_id: input.requisition_id,
    });

    let readiness: EngagementReadiness | null = null;
    let decision: EngagementDecision | null = null;
    let result: EngagementEligibilityInput;

    if (policy === null) {
      // COMM-C3 amendment — three-state default. never_configured ⇒ DORMANT (the
      // gate does not enforce; existing non-C3 gates continue). configured_but_
      // no_effective_policy ⇒ FAIL-CLOSED (the governed tenant cannot revert).
      const governed = await this.policy.isTenantGoverned(input.tenant_id);
      if (!governed) {
        // Dormant: not an engagement decision — return satisfied, write NO provenance.
        return { satisfied: true, deny: null };
      }
      result = { satisfied: false, deny: 'CLIENT_SUBMITTAL_ENGAGEMENT_POLICY_MISSING', missing: [] };
    } else {
      const facts = await this.reader.readFacts(
        input.tenant_id,
        input.talent_id,
        input.requisition_id,
      );
      readiness = evaluateEngagementReadiness(policy, facts);
      // PART A — apply the effective enforcement mode. ADVISORY proceeds-incomplete;
      // ENFORCING blocks; ENFORCING_WITH_OVERRIDE allows a scoped+reasoned override.
      decision = decideEngagement(readiness, policy.enforcement_mode, {
        requested: input.override !== undefined,
        actorHasOverrideScope: input.actor_can_override ?? false,
        reason: input.override?.reason ?? null,
      });
      if (decision.allow) {
        // ALLOW covers satisfied, advisory-proceed, and a valid override.
        result = { satisfied: true, deny: null };
      } else {
        result = {
          satisfied: false,
          deny: decision.outcome === 'BLOCK_UNAVAILABLE'
            ? 'CLIENT_SUBMITTAL_ENGAGEMENT_EVIDENCE_UNAVAILABLE'
            : 'CLIENT_SUBMITTAL_ENGAGEMENT_INCOMPLETE',
          missing: readiness.missing,
        };
      }
    }

    // Provenance is best-effort audit EXCEPT for an applied override: an override
    // that allows an otherwise-blocked submit MUST be durably recorded (A8), so a
    // provenance-write failure there is fail-closed (throws → aborts the submit).
    await this.recordProvenance(input, policy, readiness, decision, result);
    return result;
  }

  /**
   * COMM-C3 — the recruiter-facing READINESS read (R19). Same resolution +
   * evidence as the gate, but PURE (no provenance write, no mutation). Returns
   * the per-requirement status + capabilities for the drawer. `policy_present`
   * distinguishes "no effective policy" (gate would fail-closed) from a resolved
   * policy with satisfied/missing requirements.
   */
  async readReadiness(input: {
    tenant_id: string;
    talent_id: string;
    requisition_id: string;
    company_id: string | null;
  }): Promise<{
    governed: boolean;
    policy_present: boolean;
    satisfied: boolean;
    enforcement_mode: ResolvedEngagementPolicy['enforcement_mode'] | null;
    /** True iff the effective policy is ENFORCING_WITH_OVERRIDE (drives override UX). */
    override_available: boolean;
    results: EngagementReadiness['results'];
    missing: EngagementReadiness['missing'];
    unavailable: boolean;
    capabilities: ReturnType<EngagementPolicyService['capabilities']>;
  }> {
    const capabilities = this.policy.capabilities();
    const policy = await this.policy.resolveEffective(input.tenant_id, {
      company_id: input.company_id,
      requisition_id: input.requisition_id,
    });
    if (policy === null) {
      // Amendment three-state: dormant (never governed) satisfies; configured-but-
      // no-effective-policy is fail-closed (governed, blocked).
      const governed = await this.policy.isTenantGoverned(input.tenant_id);
      return {
        governed,
        policy_present: false,
        satisfied: !governed,
        enforcement_mode: null,
        override_available: false,
        results: [],
        missing: [],
        unavailable: false,
        capabilities,
      };
    }
    const facts = await this.reader.readFacts(input.tenant_id, input.talent_id, input.requisition_id);
    const readiness = evaluateEngagementReadiness(policy, facts);
    return {
      governed: true,
      policy_present: true,
      satisfied: readiness.satisfied,
      enforcement_mode: policy.enforcement_mode,
      // The override affordance is offered only when the policy permits it AND
      // there is something missing; whether the actor MAY override is a scope check.
      override_available: policy.enforcement_mode === 'ENFORCING_WITH_OVERRIDE' && !readiness.satisfied,
      results: readiness.results,
      missing: readiness.missing,
      unavailable: readiness.unavailable,
      capabilities,
    };
  }

  private async recordProvenance(
    input: EngagementAssessInput,
    policy: ResolvedEngagementPolicy | null,
    readiness: EngagementReadiness | null,
    decision: EngagementDecision | null,
    result: EngagementEligibilityInput,
  ): Promise<void> {
    // PII-free snapshot (R17/A8): resolved layers/checksums, enforcement mode,
    // requirements evaluated, per-requirement result, missing items, and — only on
    // an applied override — the human reason. Never a raw provider payload/secret.
    const overridden = decision?.overridden === true;
    const inputs = {
      talent_id: input.talent_id,
      requisition_id: input.requisition_id,
      submittal_id: input.submittal_id ?? null,
      enforcement_mode: policy?.enforcement_mode ?? null,
      decision_outcome: decision?.outcome ?? (result.satisfied ? 'ALLOW_DORMANT' : 'BLOCK_POLICY_MISSING'),
      overridden,
      // Advisory-proceed and override both proceed with requirements incomplete.
      proceeded_incomplete: decision?.proceededIncomplete ?? false,
      override_reason: overridden ? decision?.overrideReason ?? null : null,
      policy_layers: policy?.layers ?? [],
      requirements: policy?.requirements.map((r) => ({ channel: r.channel, required: r.required })) ?? [],
      results: readiness?.results ?? [],
      missing: result.missing ?? readiness?.missing ?? [],
    };
    const reasonCode = reasonCodeFor(decision, result);
    const write = async (): Promise<void> => {
      await this.db.$executeRawUnsafe(
        `INSERT INTO "policy_store"."PolicyDecisionRecord"
           ("id","tenant_id","decision","policy_version","rule_id","reason_code","resource","action","inputs","actor_id","origin","correlation_id","occurred_at")
         VALUES (gen_random_uuid(),$1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::uuid,$10,$11,NOW())`,
        input.tenant_id,
        result.satisfied ? 'ALLOW' : 'DENY',
        policy?.composite_version ?? '__no_policy__',
        '__engagement__',
        reasonCode,
        'CLIENT_SUBMITTAL',
        'ENGAGEMENT_GATE',
        JSON.stringify(inputs),
        input.actor_id,
        'ui',
        input.correlation_id,
      );
    };
    if (overridden) {
      // Authoritative: an override MUST leave a durable audit record. A write
      // failure here fails closed — it propagates and aborts the submit (A8).
      await write();
      return;
    }
    try {
      await write();
    } catch {
      // Non-override provenance is best-effort audit; a write failure must not
      // itself block or mask the gate decision (the verdict already stands).
    }
  }
}
