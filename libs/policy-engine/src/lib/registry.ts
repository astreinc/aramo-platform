import { PolicyEngineError } from './errors.js';
import {
  EFFECT_KINDS,
  type Decision,
  type Effect,
  type EffectKind,
  type PolicyPackage,
} from './types.js';

// §D9 — the effect registry is the CLOSED set of effect kinds, versioned with
// this engine. Membership is the only question the engine asks of an effect
// kind; it is never tenant-configurable.
const EFFECT_KIND_SET: ReadonlySet<string> = new Set(EFFECT_KINDS);

export function isRegisteredEffectKind(kind: string): kind is EffectKind {
  return EFFECT_KIND_SET.has(kind);
}

export function isRegisteredResource(
  pkg: PolicyPackage,
  resource: string,
): boolean {
  return pkg.registry.resources.includes(resource);
}

export function isRegisteredAction(
  pkg: PolicyPackage,
  action: string,
): boolean {
  return pkg.registry.actions.includes(action);
}

// Shared outcome invariants (§D9/§D11), applied to every rule AND to the
// package's default disposition: effect kinds are registered, and
// required_capability is present IFF the decision is REQUIRES_OVERRIDE.
function assertOutcomeValid(
  label: string,
  outcome: {
    decision: Decision;
    required_capability?: string;
    effects?: readonly Effect[];
  },
): void {
  for (const effect of outcome.effects ?? []) {
    if (!isRegisteredEffectKind(effect.kind)) {
      throw new PolicyEngineError(
        'UNREGISTERED_EFFECT',
        `${label} carries an unregistered effect kind "${effect.kind}"`,
        { where: label, effect_kind: effect.kind },
      );
    }
  }
  const isOverride = outcome.decision === 'REQUIRES_OVERRIDE';
  const hasCapability =
    outcome.required_capability !== undefined && outcome.required_capability !== '';
  if (isOverride && !hasCapability) {
    throw new PolicyEngineError(
      'MALFORMED_RULE',
      `${label} is REQUIRES_OVERRIDE but names no required_capability (§D11)`,
      { where: label },
    );
  }
  if (!isOverride && hasCapability) {
    throw new PolicyEngineError(
      'MALFORMED_RULE',
      `${label} names a required_capability but its decision is not REQUIRES_OVERRIDE`,
      { where: label, decision: outcome.decision },
    );
  }
}

// §D5 + §D9 + R3 static validation of an authored package. The engine holds
// identifiers as DATA and never branches on their meaning; validation only
// checks membership + structural invariants:
//   - the package DECLARES a no-match default disposition (R3 — no global
//     default exists; a package that omits it is rejected here),
//   - every rule's resource/action is in the package's declared allowlist,
//   - every effect kind (rules AND default) is registered (closed set),
//   - required_capability is present IFF the decision is REQUIRES_OVERRIDE
//     (§D9/§D11 — the engine NAMES the capability), for rules AND the default.
// Throws PolicyEngineError on the first violation. Pure; mutates nothing.
export function validatePackage(pkg: PolicyPackage): void {
  if (
    pkg.default_disposition === undefined ||
    pkg.default_disposition === null
  ) {
    throw new PolicyEngineError(
      'MISSING_DEFAULT_DISPOSITION',
      `Package "${pkg.name}" declares no default_disposition (R3 — the engine has no global default)`,
      { package: pkg.name },
    );
  }
  assertOutcomeValid('default_disposition', pkg.default_disposition);

  const resources = new Set(pkg.registry.resources);
  const actions = new Set(pkg.registry.actions);

  for (const rule of pkg.rules) {
    if (!resources.has(rule.resource)) {
      throw new PolicyEngineError(
        'UNREGISTERED_RESOURCE',
        `Rule "${rule.id}" references resource "${rule.resource}" not in the package allowlist`,
        { rule_id: rule.id, resource: rule.resource },
      );
    }
    if (!actions.has(rule.action)) {
      throw new PolicyEngineError(
        'UNREGISTERED_ACTION',
        `Rule "${rule.id}" references action "${rule.action}" not in the package allowlist`,
        { rule_id: rule.id, action: rule.action },
      );
    }
    assertOutcomeValid(`rule "${rule.id}"`, rule);
  }
}
