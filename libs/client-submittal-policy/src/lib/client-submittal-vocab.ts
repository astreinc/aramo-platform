import { createHash } from 'node:crypto';

// CSP PR-2 (Client-Scoped Business Policy directive §D3/§D10) — Client Submittal
// Policy vocabulary. v1 requirement facts are BOOLEAN facts the submit command
// supplies into resource_state.derived; the set is bounded to facts Aramo already
// owns (§D10). Numeric ceilings, screening questions and provider fields are
// DEFERRED (a bare fact key never introduces executable semantics — the engine
// only reads it).
export const CLIENT_SUBMITTAL_REQUIREMENT_KEYS = [
  'resume_selected',
  'engagement_satisfied',
  'work_authorization_present',
  'bill_rate_present',
  'rtr_present',
] as const;
export type ClientSubmittalRequirementKey = (typeof CLIENT_SUBMITTAL_REQUIREMENT_KEYS)[number];
export function isClientSubmittalRequirementKey(v: unknown): v is ClientSubmittalRequirementKey {
  return typeof v === 'string' && (CLIENT_SUBMITTAL_REQUIREMENT_KEYS as readonly string[]).includes(v);
}

// Disposition — REQUIRED gates the submit; NOT_REQUIRED does not (and emits NO
// compiled rule — the fact is never evaluated). A NOT_REQUIRED requirement still
// stays in the effective definition/provenance so an explicit client relaxation
// (where allowed) is explainable.
export const DISPOSITION_VALUES = ['REQUIRED', 'NOT_REQUIRED'] as const;
export type Disposition = (typeof DISPOSITION_VALUES)[number];
export function isDisposition(v: unknown): v is Disposition {
  return typeof v === 'string' && (DISPOSITION_VALUES as readonly string[]).includes(v);
}

// OverrideClass — the RUNTIME outcome a REQUIRED-but-unsatisfied requirement yields.
// The compiler maps it to a generic-engine Decision (HARD_DENY->DENY,
// OVERRIDABLE->REQUIRES_OVERRIDE, AUDIT_ONLY->ALLOW_WITH_AUDIT); the runtime result
// comes from the engine. Its strictness ORDER is used ONLY for FLOOR comparison
// (client-submittal-floor.ts) and must NOT leak into runtime semantics.
export const OVERRIDE_CLASS_VALUES = ['HARD_DENY', 'OVERRIDABLE', 'AUDIT_ONLY'] as const;
export type OverrideClass = (typeof OVERRIDE_CLASS_VALUES)[number];
export function isOverrideClass(v: unknown): v is OverrideClass {
  return typeof v === 'string' && (OVERRIDE_CLASS_VALUES as readonly string[]).includes(v);
}

// OverridePolicy — DEFAULT (a more-specific scope may relax) | FLOOR (non-relaxable;
// a more-specific scope may only STRENGTHEN it). §D4-A, submittal domain.
export const OVERRIDE_POLICY_VALUES = ['DEFAULT', 'FLOOR'] as const;
export type OverridePolicy = (typeof OVERRIDE_POLICY_VALUES)[number];
export function isOverridePolicy(v: unknown): v is OverridePolicy {
  return typeof v === 'string' && (OVERRIDE_POLICY_VALUES as readonly string[]).includes(v);
}
export const DEFAULT_OVERRIDE_POLICY: OverridePolicy = 'DEFAULT';

export interface ClientSubmittalRequirement {
  readonly key: ClientSubmittalRequirementKey;
  readonly disposition: Disposition;
  readonly override_class: OverrideClass;
  readonly override_policy: OverridePolicy;
}

export interface ClientSubmittalPolicyDefinition {
  readonly requirements: readonly ClientSubmittalRequirement[];
}

export function isClientSubmittalRequirement(v: unknown): v is ClientSubmittalRequirement {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    isClientSubmittalRequirementKey(e['key']) &&
    isDisposition(e['disposition']) &&
    isOverrideClass(e['override_class']) &&
    isOverridePolicy(e['override_policy'])
  );
}

export function isClientSubmittalPolicyDefinition(v: unknown): v is ClientSubmittalPolicyDefinition {
  if (typeof v !== 'object' || v === null) return false;
  const reqs = (v as Record<string, unknown>)['requirements'];
  if (!Array.isArray(reqs) || reqs.length === 0) return false;
  const seen = new Set<string>();
  for (const r of reqs) {
    if (!isClientSubmittalRequirement(r)) return false;
    if (seen.has(r.key)) return false; // a requirement_type appears at most once per layer
    seen.add(r.key);
  }
  return true;
}

// Canonical serialization -> SHA-256 checksum. Requirements are sorted by key and
// EVERY field participates, so a DEFAULT<->FLOOR flip, a disposition change or an
// override_class change all yield a distinct immutable identity.
export function canonicalizeDefinition(def: ClientSubmittalPolicyDefinition): string {
  const canonical = [...def.requirements]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => ({
      key: r.key,
      disposition: r.disposition,
      override_class: r.override_class,
      override_policy: r.override_policy,
    }));
  return JSON.stringify({ requirements: canonical });
}
export function checksumDefinition(def: ClientSubmittalPolicyDefinition): string {
  return createHash('sha256').update(canonicalizeDefinition(def)).digest('hex');
}
