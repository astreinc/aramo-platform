import type { PolicyContext } from '@aramo/policy-engine';

// The PII-free `inputs` snapshot of a PolicyContext AS EVALUATED (ADR-0024
// §D17a). Provenance must remain explainable months later WITHOUT retaining
// personal data, so this is an explicit WHITELIST, not a redaction pass:
// only the registered resource/action identifiers, the declared/derived
// state buckets, and the resolved capability booleans are kept. Everything
// else the context carries — the open `attributes` extension map, the
// environment, the wall-clock time, the request metadata — is DROPPED,
// because those are the fields that can carry PII (a region, an email, an
// account handle, a free-text attribute) and none of them is needed to trace
// a decision back to the rule that produced it.
//
// A whitelist is the safe default: a new context field is excluded until
// someone deliberately adds it here, so PII cannot leak in by accident.

export interface PolicyDecisionInputs {
  readonly resource: string;
  readonly action: string;
  readonly declared: Readonly<Record<string, unknown>>;
  readonly derived: Readonly<Record<string, unknown>>;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

/** Build the PII-free `inputs` snapshot from an evaluated PolicyContext. */
export function snapshotPolicyInputs(context: PolicyContext): PolicyDecisionInputs {
  return {
    resource: context.resource,
    action: context.action,
    declared: { ...context.resource_state.declared },
    derived: { ...context.resource_state.derived },
    capabilities: { ...context.principal_capabilities },
  };
}
