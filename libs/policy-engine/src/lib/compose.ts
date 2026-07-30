import {
  DECISION_PRECEDENCE,
  type Decision,
  type Effect,
  type PolicyDecision,
} from './types.js';

// -- Effect identity + conflict (ADR section D12) ----------------------------
// Canonical, key-sorted serialisation so effect equality is order-insensitive
// and deterministic. Effects are opaque data; this never interprets them.
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
}

function paramsSignature(effect: Effect): string {
  return stable(effect.params ?? null);
}

interface EffectUnion {
  readonly effects: readonly Effect[];
  readonly conflict: boolean;
}

// Union + dedupe (D12). Effects with the same kind AND deep-equal params
// collapse to one. The SAME kind with DIFFERING params is an irreconcilable
// conflict (only one such obligation can hold) -> fail closed. Distinct kinds
// coexist. Insertion order is preserved for determinism.
function unionEffects(effects: readonly Effect[]): EffectUnion {
  const acceptedSignatureByKind = new Map<string, string>();
  const out: Effect[] = [];
  for (const e of effects) {
    const sig = paramsSignature(e);
    const prior = acceptedSignatureByKind.get(e.kind);
    if (prior === undefined) {
      acceptedSignatureByKind.set(e.kind, sig);
      out.push(e);
      continue;
    }
    if (prior !== sig) return { effects: [], conflict: true };
    // same kind, same params: already emitted once -> dedupe (skip).
  }
  return { effects: out, conflict: false };
}

function hasEffect(effects: readonly Effect[], kind: Effect['kind']): boolean {
  return effects.some((e) => e.kind === kind);
}

// Derive the fenced boolean fields from the settled decision + effects (D9).
// Exported as the shared decision builder for the single-rule path in
// evaluate().
export function finalize(parts: {
  decision: Decision;
  reason_code: string;
  required_capabilities: readonly string[];
  effects: readonly Effect[];
  warnings: readonly string[];
  provenance: PolicyDecision['provenance'];
}): PolicyDecision {
  const override_required = parts.decision === 'REQUIRES_OVERRIDE';
  const audit_required =
    parts.decision === 'ALLOW_WITH_AUDIT' || hasEffect(parts.effects, 'WRITE_AUDIT');
  const reason_required =
    override_required || hasEffect(parts.effects, 'REQUIRE_REASON');
  return {
    decision: parts.decision,
    reason_code: parts.reason_code,
    required_capabilities: parts.required_capabilities,
    audit_required,
    override_required,
    reason_required,
    warnings: parts.warnings,
    effects: parts.effects,
    provenance: parts.provenance,
  };
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

// -- D12: multi-package (and multi-rule) composition -------------------------
// All applicable decisions compose monotonically -- MOST RESTRICTIVE WINS:
//   DENY > REQUIRES_OVERRIDE > ALLOW_WITH_AUDIT > ALLOW.
// Effects union + dedupe; a same-kind/different-params effect pair fails closed.
// Where several decisions REQUIRES_OVERRIDE, ALL their capabilities are needed.
//
// An empty input means no policy spoke -> ALLOW (policy adds no restriction; the
// upstream authorization verdict still governs via composeWithAuthorization).
export function composePolicyDecisions(
  decisions: readonly PolicyDecision[],
): PolicyDecision {
  if (decisions.length === 0) {
    return finalize({
      decision: 'ALLOW',
      reason_code: 'NO_POLICY',
      required_capabilities: [],
      effects: [],
      warnings: [],
      provenance: [],
    });
  }

  const provenance = decisions.flatMap((d) => d.provenance);
  const warnings = dedupeStrings(decisions.flatMap((d) => d.warnings));

  // Most-restrictive verdict; reason_code from the FIRST contributor at that
  // level (reduce keeps the earlier element on ties -> input order ->
  // deterministic). Safe without an initial value: decisions is non-empty here.
  const winner = decisions.reduce((a, b) =>
    DECISION_PRECEDENCE[b.decision] > DECISION_PRECEDENCE[a.decision] ? b : a,
  );
  const decision = winner.decision;

  // A refusal discharges no forward obligations: DENY drops effects and needs
  // no capability. (Conservative modelling choice; documented in the PR.)
  if (decision === 'DENY') {
    return finalize({
      decision: 'DENY',
      reason_code: winner.reason_code,
      required_capabilities: [],
      effects: [],
      warnings,
      provenance,
    });
  }

  const union = unionEffects(decisions.flatMap((d) => d.effects));
  if (union.conflict) {
    // Fail closed (D12): irreconcilable effects -> DENY, effects dropped.
    return finalize({
      decision: 'DENY',
      reason_code: 'POLICY_EFFECT_CONFLICT',
      required_capabilities: [],
      effects: [],
      warnings,
      provenance,
    });
  }

  // D12: ALL required capabilities from every REQUIRES_OVERRIDE contributor.
  const required_capabilities =
    decision === 'REQUIRES_OVERRIDE'
      ? dedupeStrings(
          decisions
            .filter((d) => d.decision === 'REQUIRES_OVERRIDE')
            .flatMap((d) => d.required_capabilities),
        )
      : [];

  return finalize({
    decision,
    reason_code: winner.reason_code,
    required_capabilities,
    effects: union.effects,
    warnings,
    provenance,
  });
}

// -- D10: Authorization first, policy second ---------------------------------
// The caller supplies the already-resolved authorization VERDICT (a verdict,
// never roles). Monotonic: an authorization DENY dominates any policy verdict --
// the engine must never grant authority the platform has not conferred. An
// authorization ALLOW defers to the policy decision unchanged (the D10 table:
// ALLOW x DENY -> DENY, ALLOW x REQUIRES_OVERRIDE -> REQUIRES_OVERRIDE,
// ALLOW x ALLOW_WITH_AUDIT -> ALLOW_WITH_AUDIT, ALLOW x ALLOW -> ALLOW).
export type AuthorizationVerdict = 'ALLOW' | 'DENY';

export function composeWithAuthorization(
  authorization: AuthorizationVerdict,
  policy: PolicyDecision,
): PolicyDecision {
  if (authorization === 'DENY') {
    return finalize({
      decision: 'DENY',
      reason_code: 'AUTHORIZATION_DENIED',
      required_capabilities: [],
      effects: [],
      warnings: policy.warnings,
      provenance: policy.provenance,
    });
  }
  return policy;
}
