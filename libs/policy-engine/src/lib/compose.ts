import { PolicyEngineError } from './errors.js';
import {
  DECISION_PRECEDENCE,
  type Decision,
  type Effect,
  type PolicyDecision,
} from './types.js';

// -- Effect identity + conflict (ADR section D12, amended R2) -----------------
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

// R2: effect kinds that CANNOT be satisfied more than once with differing
// params (a repeat with different params is genuinely irreconcilable). No kind
// in the current closed set is un-satisfiable twice -- NOTIFY_ROLE(manager) and
// NOTIFY_ROLE(compliance) both hold, a second WRITE_AUDIT is a dedupe, etc. So
// this set is EMPTY and the fail-closed branch in unionEffects is UNREACHABLE
// today. It exists so a future singleton-style kind can be marked exclusive
// without reworking composition.
export const EXCLUSIVE_EFFECT_KINDS: ReadonlySet<string> = new Set<string>();

// Union + dedupe (D12, amended R2). Identical (kind, params) pairs collapse to
// one. Distinct pairs -- including the SAME kind with DIFFERENT params -- all
// coexist (NOTIFY_ROLE(manager) + NOTIFY_ROLE(compliance) -> both). The only
// fail-closed path is a kind in `exclusiveKinds` appearing with two or more
// distinct param signatures. Insertion order is preserved for determinism.
export function unionEffects(
  effects: readonly Effect[],
  exclusiveKinds: ReadonlySet<string> = EXCLUSIVE_EFFECT_KINDS,
): EffectUnion {
  const emitted = new Set<string>(); // JSON([kind, sig]) already pushed
  const signaturesByKind = new Map<string, Set<string>>();
  const out: Effect[] = [];
  for (const e of effects) {
    const sig = paramsSignature(e);
    const id = JSON.stringify([e.kind, sig]);
    if (!emitted.has(id)) {
      emitted.add(id);
      out.push(e);
    }
    let sigs = signaturesByKind.get(e.kind);
    if (sigs === undefined) {
      sigs = new Set<string>();
      signaturesByKind.set(e.kind, sigs);
    }
    sigs.add(sig);
    if (exclusiveKinds.has(e.kind) && sigs.size > 1) {
      return { effects: [], conflict: true };
    }
  }
  return { effects: out, conflict: false };
}

function hasEffect(effects: readonly Effect[], kind: Effect['kind']): boolean {
  return effects.some((e) => e.kind === kind);
}

// Derive the fenced boolean fields from the settled decision + effects (D9).
// Exported as the shared decision builder for the single-rule / default path in
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
// Effects union + dedupe (R2). Where several decisions REQUIRES_OVERRIDE, ALL
// their capabilities are needed.
//
// R3: there is NO global default. An empty input is a caller error (a caller
// with no applicable package decision must not ask the engine to invent one) --
// it throws. evaluate() never reaches this: a no-match resolves to the
// package's own declared default_disposition, which is a single decision.
export function composePolicyDecisions(
  decisions: readonly PolicyDecision[],
): PolicyDecision {
  if (decisions.length === 0) {
    throw new PolicyEngineError(
      'EMPTY_COMPOSITION',
      'composePolicyDecisions requires at least one decision (R3 -- the engine has no global default)',
    );
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

  const union = unionEffects(decisions.flatMap((d) => d.effects));
  if (union.conflict) {
    // Fail closed -- irreconcilable obligations cannot be presented together.
    // UNREACHABLE today (EXCLUSIVE_EFFECT_KINDS is empty); kept for future kinds.
    return finalize({
      decision: 'DENY',
      reason_code: 'POLICY_EFFECT_CONFLICT',
      required_capabilities: [],
      effects: [],
      warnings,
      provenance,
    });
  }

  // R1: a DENY RETAINS its effects -- the domain service discharges WRITE_AUDIT
  // / NOTIFY_ROLE / etc. even when the mutation is refused (a denial is when
  // audit + notify matter most). Override capabilities are collected only for a
  // REQUIRES_OVERRIDE verdict; a hard DENY moots them.
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
// the engine must never grant authority the platform has not conferred. Per R1
// the resulting DENY still RETAINS the policy's effects (audit / notify the
// refused attempt). An authorization ALLOW defers to the policy decision
// unchanged (ALLOW x DENY -> DENY, ALLOW x REQUIRES_OVERRIDE ->
// REQUIRES_OVERRIDE, ALLOW x ALLOW_WITH_AUDIT -> ALLOW_WITH_AUDIT,
// ALLOW x ALLOW -> ALLOW).
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
      effects: policy.effects,
      warnings: policy.warnings,
      provenance: policy.provenance,
    });
  }
  return policy;
}
