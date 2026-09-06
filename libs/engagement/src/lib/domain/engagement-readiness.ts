import {
  meetsStrength,
  type EngagementChannel,
  type EngagementEvidenceStrength,
  type EngagementRequirement,
} from './engagement-vocab.js';

// COMM-C3 — the PURE engagement-readiness evaluator (directive C3-5/R6/R9/R14).
// It converts a resolved effective policy + provider-neutral evidence facts +
// availability into a typed readiness result. NO I/O, NO provider awareness: it
// consumes only channel + neutral facts (attempted / two_way_conversation /
// evidence_strength) + availability. It NEVER coerces an evidence-system failure
// into "no evidence" — `read_error` is a distinct, fail-closed status (R9).

/** Provider-neutral evidence facts the composition root gathered for one channel. */
export type EngagementEvidenceFact =
  | {
      readonly channel: 'voice';
      readonly availability: 'available';
      readonly two_way_conversation: boolean;
      readonly evidence_strength: EngagementEvidenceStrength | null;
    }
  | {
      // COMM-C2B — email has a real provider-neutral producer/read now. The only
      // fact email carries is whether a provider-accepted outbound send is on
      // record (`recorded_evidence`). This is deliberately NOT a response/contact
      // signal: "email sent" is not "Talent responded" (locked COMM boundary).
      readonly channel: 'email';
      readonly availability: 'available';
      readonly recorded_evidence: boolean;
    }
  | {
      // The channel's evidence read failed / cannot produce a trustworthy result.
      readonly channel: EngagementChannel;
      readonly availability: 'read_error';
    }
  | {
      // The channel has no real evidence producer at this baseline.
      readonly channel: EngagementChannel;
      readonly availability: 'no_producer';
    };

export type EngagementRequirementStatus =
  | 'satisfied'
  | 'not_required'
  | 'missing'
  | 'insufficient_strength'
  | 'unavailable'
  | 'no_producer';

export interface EngagementRequirementResult {
  readonly channel: EngagementChannel;
  readonly required: boolean;
  readonly status: EngagementRequirementStatus;
}

export interface EngagementReadiness {
  readonly satisfied: boolean;
  readonly results: readonly EngagementRequirementResult[];
  /** Channels that are required and NOT satisfied (bounded, non-sensitive). */
  readonly missing: readonly EngagementChannel[];
  /** True iff a required channel's evidence was UNAVAILABLE (distinct deny, R9). */
  readonly unavailable: boolean;
}

/** The effective policy the evaluator scores against (already merged/resolved). */
export interface ResolvedEngagementRequirements {
  readonly requirements: readonly EngagementRequirement[];
}

/**
 * Evaluate readiness against the resolved requirements. Fail-closed: any required
 * requirement that is missing / insufficient / unavailable / no-producer leaves
 * `satisfied=false`. `unavailable` (a read error) is tracked distinctly so the
 * caller can emit a different typed reason than plain incompleteness.
 */
export function evaluateEngagementReadiness(
  policy: ResolvedEngagementRequirements,
  facts: readonly EngagementEvidenceFact[],
): EngagementReadiness {
  const factByChannel = new Map<EngagementChannel, EngagementEvidenceFact>();
  for (const f of facts) factByChannel.set(f.channel, f);

  const results: EngagementRequirementResult[] = [];
  const missing: EngagementChannel[] = [];
  let unavailable = false;

  for (const req of policy.requirements) {
    if (!req.required) {
      results.push({ channel: req.channel, required: false, status: 'not_required' });
      continue;
    }
    const status = statusFor(req, factByChannel.get(req.channel));
    results.push({ channel: req.channel, required: true, status });
    if (status !== 'satisfied') {
      missing.push(req.channel);
      if (status === 'unavailable') unavailable = true;
    }
  }

  return { satisfied: missing.length === 0, results, missing, unavailable };
}

function statusFor(
  req: EngagementRequirement,
  fact: EngagementEvidenceFact | undefined,
): EngagementRequirementStatus {
  // No fact gathered for a required channel is treated as unavailable (fail-closed).
  if (fact === undefined) return 'unavailable';
  if (fact.availability === 'read_error') return 'unavailable';
  if (fact.availability === 'no_producer') return 'no_producer';

  // fact.availability === 'available'
  if (req.channel === 'voice' && fact.channel === 'voice') {
    if (!fact.two_way_conversation) return 'missing';
    if (!meetsStrength(fact.evidence_strength, req.minimum_strength)) return 'insufficient_strength';
    return 'satisfied';
  }
  // COMM-C2B — email 'recorded_evidence': a provider-accepted outbound send on
  // record satisfies the requirement; absence is plain incompleteness (missing).
  if (req.channel === 'email' && fact.channel === 'email') {
    return fact.recorded_evidence ? 'satisfied' : 'missing';
  }
  // Defensive: unknown channel/fact pairing is treated as missing, never a pass.
  return 'missing';
}
