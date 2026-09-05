import { Inject, Injectable } from '@nestjs/common';
import {
  evaluateEngagementReadiness,
  EngagementPolicyService,
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

export interface EngagementAssessInput {
  readonly tenant_id: string;
  readonly talent_id: string;
  readonly requisition_id: string;
  readonly company_id: string | null;
  readonly actor_id: string;
  readonly correlation_id: string;
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
      if (readiness.satisfied) {
        result = { satisfied: true, deny: null };
      } else {
        result = {
          satisfied: false,
          deny: readiness.unavailable
            ? 'CLIENT_SUBMITTAL_ENGAGEMENT_EVIDENCE_UNAVAILABLE'
            : 'CLIENT_SUBMITTAL_ENGAGEMENT_INCOMPLETE',
          missing: readiness.missing,
        };
      }
    }

    await this.recordProvenance(input, policy, readiness, result);
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
    result: EngagementEligibilityInput,
  ): Promise<void> {
    // PII-free snapshot (R17): resolved layers/checksums, requirements evaluated,
    // and the high-level per-requirement result — never a raw provider payload.
    const inputs = {
      talent_id: input.talent_id,
      requisition_id: input.requisition_id,
      policy_layers: policy?.layers ?? [],
      requirements: policy?.requirements.map((r) => ({ channel: r.channel, required: r.required })) ?? [],
      results: readiness?.results ?? [],
      missing: result.missing ?? [],
    };
    try {
      await this.db.$executeRawUnsafe(
        `INSERT INTO "policy_store"."PolicyDecisionRecord"
           ("id","tenant_id","decision","policy_version","rule_id","reason_code","resource","action","inputs","actor_id","origin","correlation_id","occurred_at")
         VALUES (gen_random_uuid(),$1::uuid,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::uuid,$10,$11,NOW())`,
        input.tenant_id,
        result.satisfied ? 'ALLOW' : 'DENY',
        policy?.composite_version ?? '__no_policy__',
        '__engagement__',
        result.satisfied ? 'ENGAGEMENT_SATISFIED' : (result.deny ?? 'ENGAGEMENT_DENIED'),
        'CLIENT_SUBMITTAL',
        'ENGAGEMENT_GATE',
        JSON.stringify(inputs),
        input.actor_id,
        'ui',
        input.correlation_id,
      );
    } catch {
      // Provenance is best-effort audit; a write failure must not itself block or
      // mask the gate decision (the decision already stands on the returned verdict).
    }
  }
}
