import { PolicyEngineError } from './errors.js';
import {
  EFFECT_KINDS,
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

// §D5 + §D9 static validation of an authored package. The engine holds
// identifiers as DATA and never branches on their meaning; validation only
// checks membership + structural invariants:
//   - every rule's resource/action is in the package's declared allowlist,
//   - every effect kind is registered (closed set),
//   - required_capability is present IFF the rule's decision is
//     REQUIRES_OVERRIDE (§D9/§D11 — the engine NAMES the capability),
//   - no override rule leaves the capability blank, and no non-override rule
//     names one.
// Throws PolicyEngineError on the first violation. Pure; mutates nothing.
export function validatePackage(pkg: PolicyPackage): void {
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
    for (const effect of rule.effects ?? []) {
      if (!isRegisteredEffectKind(effect.kind)) {
        throw new PolicyEngineError(
          'UNREGISTERED_EFFECT',
          `Rule "${rule.id}" carries an unregistered effect kind "${effect.kind}"`,
          { rule_id: rule.id, effect_kind: effect.kind },
        );
      }
    }
    const isOverride = rule.decision === 'REQUIRES_OVERRIDE';
    const hasCapability =
      rule.required_capability !== undefined && rule.required_capability !== '';
    if (isOverride && !hasCapability) {
      throw new PolicyEngineError(
        'MALFORMED_RULE',
        `Rule "${rule.id}" is REQUIRES_OVERRIDE but names no required_capability (§D11)`,
        { rule_id: rule.id },
      );
    }
    if (!isOverride && hasCapability) {
      throw new PolicyEngineError(
        'MALFORMED_RULE',
        `Rule "${rule.id}" names a required_capability but its decision is not REQUIRES_OVERRIDE`,
        { rule_id: rule.id, decision: rule.decision },
      );
    }
  }
}
