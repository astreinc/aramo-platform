import type { Decision, PolicyPackage } from '@aramo/policy-engine';

import type { ClientSubmittalPolicyDefinition, OverrideClass } from './client-submittal-vocab.js';

export const CLIENT_SUBMITTAL_PACKAGE_NAME = 'client-submittal-policy';
export const CLIENT_SUBMITTAL_RESOURCE = 'CLIENT_SUBMITTAL';
export const CLIENT_SUBMITTAL_ACTION = 'SUBMIT';
// The single override capability a REQUIRES_OVERRIDE requirement names; the submit
// command tests it against the actor's JWT-frozen scopes (PR-3). §5-Q3 scope.
export const CLIENT_SUBMITTAL_OVERRIDE_CAPABILITY = 'client-submittal-policy:override';
export const CLIENT_SUBMITTAL_ALLOWED_DEFAULT_REASON = 'CLIENT_SUBMITTAL_ALLOWED_DEFAULT';

// The ONLY place override_class becomes a runtime engine Decision. The FLOOR
// strictness ordering plays no part here (§ caution — the ordering must not leak
// into runtime semantics).
const OVERRIDE_CLASS_TO_DECISION: Readonly<Record<OverrideClass, Decision>> = {
  HARD_DENY: 'DENY',
  OVERRIDABLE: 'REQUIRES_OVERRIDE',
  AUDIT_ONLY: 'ALLOW_WITH_AUDIT',
};

type CompiledRule = PolicyPackage['rules'][number];

// Compile the merged EFFECTIVE definition into one generic-engine PolicyPackage.
// Each REQUIRED requirement becomes a rule that FIRES (with its override_class'
// Decision) when the derived fact is not satisfied (`derived.<key> ne true`).
// NOT_REQUIRED requirements emit NO rule — the fact is never evaluated — even though
// they remain in the effective definition/provenance. No rule matches -> the
// package's own default ALLOW.
export function compileEffectivePackage(def: ClientSubmittalPolicyDefinition, version: string): PolicyPackage {
  const rules: CompiledRule[] = [];
  for (const req of def.requirements) {
    if (req.disposition !== 'REQUIRED') continue;
    const decision = OVERRIDE_CLASS_TO_DECISION[req.override_class];
    const rule: CompiledRule = {
      id: `require-${req.key}`,
      resource: CLIENT_SUBMITTAL_RESOURCE,
      action: CLIENT_SUBMITTAL_ACTION,
      when: [{ source: 'derived', key: req.key, op: 'ne', value: true }],
      decision,
      reason_code: `CLIENT_SUBMITTAL_${req.key.toUpperCase()}_REQUIRED`,
      ...(decision === 'REQUIRES_OVERRIDE' ? { required_capability: CLIENT_SUBMITTAL_OVERRIDE_CAPABILITY } : {}),
    };
    rules.push(rule);
  }
  return {
    name: CLIENT_SUBMITTAL_PACKAGE_NAME,
    version,
    registry: { resources: [CLIENT_SUBMITTAL_RESOURCE], actions: [CLIENT_SUBMITTAL_ACTION] },
    default_disposition: { decision: 'ALLOW', reason_code: CLIENT_SUBMITTAL_ALLOWED_DEFAULT_REASON },
    rules,
  };
}
