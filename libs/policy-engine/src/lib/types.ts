// ADR-0024 Business Policy Engine — the STATELESS evaluator's type surface.
//
// This library is DOMAIN-AGNOSTIC (ADR §D4/§D7): it knows nothing about any
// business object. Resources and actions are opaque REGISTERED IDENTIFIERS
// (§D5) carried as data; the evaluator never branches on their meaning. It
// holds no persistence, no publication, no tenant lookup (those are
// libs/policy-store, a separate library).

// ── §D9 — the four decision verdicts ────────────────────────────────────────
export type Decision =
  | 'ALLOW'
  | 'DENY'
  | 'REQUIRES_OVERRIDE'
  | 'ALLOW_WITH_AUDIT';

// Monotonic restrictiveness order (§D12): DENY > REQUIRES_OVERRIDE >
// ALLOW_WITH_AUDIT > ALLOW. Higher number = more restrictive = wins.
export const DECISION_PRECEDENCE: Readonly<Record<Decision, number>> = {
  ALLOW: 0,
  ALLOW_WITH_AUDIT: 1,
  REQUIRES_OVERRIDE: 2,
  DENY: 3,
};

// ── §D9 — the CLOSED effect vocabulary ──────────────────────────────────────
// Effect kinds are versioned WITH this engine implementation and are NOT
// tenant-configurable. An effect is a declarative OBLIGATION the caller must
// discharge — never a command the engine issues.
export const EFFECT_KINDS = [
  'WRITE_AUDIT',
  'REQUIRE_REASON',
  'NOTIFY_ROLE',
  'EMIT_EVENT',
  'SHOW_BANNER',
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export interface Effect {
  readonly kind: EffectKind;
  // Optional opaque parameters (e.g. a role name, an event name, banner text).
  // Two effects are equal iff kind AND params deep-equal. Composition treats a
  // same-kind / different-params pair as an irreconcilable conflict (§D12).
  readonly params?: Readonly<Record<string, unknown>>;
}

// ── §D8 — PolicyContext ─────────────────────────────────────────────────────
export type Origin = 'ui' | 'agent' | 'integration';

export interface RequestMetadata {
  readonly correlation_id: string;
  readonly origin: Origin;
}

// §D13/§D13b — declared vs derived state are carried SEPARATELY. A rule may key
// on a declared fact OR a derived fact, but the engine never assumes a declared
// label carries a derived meaning; both are opaque maps the engine reads
// generically via predicates.
export interface ResourceState {
  readonly declared: Readonly<Record<string, unknown>>;
  readonly derived: Readonly<Record<string, unknown>>;
}

export interface PolicyContext {
  readonly tenant_id: string;
  readonly resource: string; // registered identifier (§D5)
  readonly action: string; // registered identifier (§D5)
  readonly resource_state: ResourceState;
  // Already-RESOLVED booleans (§D10). NEVER roles — role→permission mapping
  // stays in the authorization model, upstream of the engine. Delegation /
  // break-glass materialise into this set before the engine runs.
  readonly principal_capabilities: Readonly<Record<string, boolean>>;
  readonly request_metadata: RequestMetadata;
  readonly environment: string;
  // ISO-8601 instant supplied by the caller. The engine reads NO clock — time
  // is an input so the evaluate pass stays pure and deterministic.
  readonly time: string;
  // Open extension map (§D8): business hours, region, account tier, feature
  // flags, AI confidence thresholds. Adding an input is a caller-side change.
  readonly attributes: Readonly<Record<string, unknown>>;
}

// ── The rule model — policies are DATA (§D2) ────────────────────────────────
export type PredicateSource =
  | 'declared'
  | 'derived'
  | 'attributes'
  | 'capabilities';

export type PredicateOp =
  | 'eq'
  | 'ne'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'in'
  | 'exists';

// A generic predicate over a context bucket. The engine applies the OPERATOR
// mechanically; it never interprets `key`. This is how the evaluator stays
// domain-agnostic while a data-authored rule keys on any declared or derived
// fact.
export interface Predicate {
  readonly source: PredicateSource;
  readonly key: string;
  readonly op: PredicateOp;
  readonly value?: unknown;
}

export interface Rule {
  readonly id: string;
  readonly resource: string; // must be a registered identifier of the package
  readonly action: string; // must be a registered identifier of the package
  // ALL predicates must hold (logical AND) for the rule to apply. Absent/empty
  // = the rule always applies to its (resource, action).
  readonly when?: readonly Predicate[];
  readonly decision: Decision;
  readonly reason_code: string;
  // Set IFF decision === 'REQUIRES_OVERRIDE' (§D9/§D11). The engine NAMES the
  // capability the caller must resolve upstream; it never resolves it itself.
  readonly required_capability?: string;
  readonly effects?: readonly Effect[];
}

// §D5 — the DECLARED, source-resident allowlist a package governs. Free-form
// resource/action strings are prohibited: a rule (and a context) may only
// reference identifiers declared here.
export interface PolicyRegistry {
  readonly resources: readonly string[];
  readonly actions: readonly string[];
}

export interface PolicyPackage {
  readonly name: string;
  readonly version: string;
  readonly registry: PolicyRegistry;
  readonly rules: readonly Rule[];
}

// ── §D9 — the decision object the engine returns ────────────────────────────
export interface DecisionProvenance {
  readonly policy_version: string;
  readonly rule_id: string;
}

export interface PolicyDecision {
  readonly decision: Decision;
  readonly reason_code: string;
  // The union of capabilities the caller must resolve (§D11). Exactly one for a
  // single REQUIRES_OVERRIDE rule; the union of ALL contributing packages'
  // required capabilities after multi-package composition (§D12). Empty
  // otherwise. Generalises §D9's singular `required_capability?` so §D12's
  // "ALL required capabilities are needed" is expressible.
  readonly required_capabilities: readonly string[];
  readonly audit_required: boolean;
  readonly override_required: boolean;
  readonly reason_required: boolean;
  readonly warnings: readonly string[];
  readonly effects: readonly Effect[];
  // Which rule(s)/version(s) produced this decision (§D9 policy_version +
  // rule_id, generalised to a list for composition).
  readonly provenance: readonly DecisionProvenance[];
}
