import { composePolicyDecisions, finalize } from './compose.js';
import { PolicyEngineError } from './errors.js';
import { isRegisteredAction, isRegisteredResource } from './registry.js';
import { conditionHolds } from './predicate.js';
import type {
  PolicyContext,
  PolicyDecision,
  PolicyPackage,
  Rule,
} from './types.js';

// Turn one matched rule into a finalized single-rule decision (§D9). A
// REQUIRES_OVERRIDE rule names exactly one capability; every other verdict
// names none.
function ruleToDecision(pkg: PolicyPackage, rule: Rule): PolicyDecision {
  const required_capabilities =
    rule.decision === 'REQUIRES_OVERRIDE' && rule.required_capability
      ? [rule.required_capability]
      : [];
  return finalize({
    decision: rule.decision,
    reason_code: rule.reason_code,
    required_capabilities,
    effects: rule.effects ?? [],
    warnings: [],
    provenance: [{ policy_version: pkg.version, rule_id: rule.id }],
  });
}

// ── The single-package evaluator (ADR §D7) ──────────────────────────────────
// evaluate(package, context) → decision. STATELESS and PURE: it reads only its
// two arguments, mutates neither, and consults no clock, storage, or tenant
// lookup. Steps:
//   1. Reject a context whose resource/action is outside the package's declared
//      allowlist (§D5) — free-form identifiers are prohibited.
//   2. Select every rule matching (resource, action) whose condition holds
//      against the immutable context snapshot.
//   3. Compose the matched rules most-restrictive-wins (§D12). No match → the
//      package is silent → ALLOW (policy adds no restriction; authorization is
//      composed separately via composeWithAuthorization, §D10).
//
// The evaluator NEVER branches on the meaning of a resource, action, or key —
// they are opaque data. Package structural validity (registered effect kinds,
// well-formed override rules) is checked by validatePackage at authoring/publish
// time; evaluate guards the runtime CONTEXT.
export function evaluate(
  pkg: PolicyPackage,
  context: PolicyContext,
): PolicyDecision {
  if (!isRegisteredResource(pkg, context.resource)) {
    throw new PolicyEngineError(
      'UNREGISTERED_RESOURCE',
      `Context resource "${context.resource}" is not registered by package "${pkg.name}"`,
      { package: pkg.name, resource: context.resource },
    );
  }
  if (!isRegisteredAction(pkg, context.action)) {
    throw new PolicyEngineError(
      'UNREGISTERED_ACTION',
      `Context action "${context.action}" is not registered by package "${pkg.name}"`,
      { package: pkg.name, action: context.action },
    );
  }

  const matched: PolicyDecision[] = [];
  for (const rule of pkg.rules) {
    if (
      rule.resource === context.resource &&
      rule.action === context.action &&
      conditionHolds(context, rule.when)
    ) {
      matched.push(ruleToDecision(pkg, rule));
    }
  }

  return composePolicyDecisions(matched);
}
