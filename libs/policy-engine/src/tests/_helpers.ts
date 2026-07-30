// Shared test builders. Identifiers are deliberately DOMAIN-NEUTRAL (DOC,
// WIDGET, CREATE, …) — the engine knows no business object, and neither do its
// tests.
import { finalize } from '../lib/compose.js';
import type {
  Decision,
  Effect,
  PolicyContext,
  PolicyDecision,
  PolicyPackage,
  Rule,
} from '../lib/types.js';

export function ctx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tenant_id: 't1',
    resource: 'DOC',
    action: 'CREATE',
    resource_state: { declared: {}, derived: {} },
    principal_capabilities: {},
    request_metadata: { correlation_id: 'c1', origin: 'ui' },
    environment: 'test',
    time: '2026-07-30T00:00:00Z',
    attributes: {},
    ...overrides,
  };
}

export function pkg(
  rules: readonly Rule[],
  overrides: Partial<PolicyPackage> = {},
): PolicyPackage {
  return {
    name: 'test-pkg',
    version: 'v1',
    registry: {
      resources: ['DOC', 'WIDGET'],
      actions: ['CREATE', 'DELETE', 'PUBLISH'],
    },
    // R3 — every package declares its own no-match default; tests override it
    // where they need DENY.
    default_disposition: { decision: 'ALLOW', reason_code: 'DEFAULT_ALLOW' },
    rules,
    ...overrides,
  };
}

// Build a finalized single decision for composition tests, without going
// through a package.
export function mkDecision(
  decision: Decision,
  opts: {
    reason_code?: string;
    required_capabilities?: readonly string[];
    effects?: readonly Effect[];
    warnings?: readonly string[];
    rule_id?: string;
    policy_version?: string;
  } = {},
): PolicyDecision {
  return finalize({
    decision,
    reason_code: opts.reason_code ?? 'R',
    required_capabilities: opts.required_capabilities ?? [],
    effects: opts.effects ?? [],
    warnings: opts.warnings ?? [],
    provenance: [
      {
        policy_version: opts.policy_version ?? 'v1',
        rule_id: opts.rule_id ?? 'rule',
      },
    ],
  });
}

// Deep-freeze so any mutation attempt throws in strict mode — used to prove
// statelessness.
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
