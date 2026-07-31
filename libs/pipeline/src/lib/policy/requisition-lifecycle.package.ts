import type { PolicyPackage } from '@aramo/policy-engine';

// ⚠️ PR-3 SCAFFOLD — TEMPORARY. This is an in-CODE policy package, but ADR-0024
// §D2 requires policies to be DATA, not code. PR-4 REPLACES this with runtime
// retrieval of the tenant's active version from libs/policy-store (the
// versioned, publishable source of truth) and DELETES this file. It exists
// only so PR-3 has one real, enforceable package to evaluate before per-tenant
// authoring lands. Do not build on it as if it were permanent — without this
// note it becomes permanent by inertia.
//
// The requisition-lifecycle policy package (ADR-0024 §D2 — policies are DATA).
// PR-3 governs exactly one command: REQUISITION_TALENT · ADD, across the six
// declared requisition states.
//
// >>> PERMISSIVE BY RULING (PR-3). Every state resolves to ALLOW, and the
// package's own default_disposition is ALLOW. The real matrix — `full` →
// REQUIRES_OVERRIDE, `closed`/`canceled` → DENY — publishes in PR-4, AFTER
// PR-3b gates the second caller (sourcing.service). Shipping a restrictive row
// now would enforce on one caller and be bypassed on the other. This package
// is REAL and ENFORCED — the engine evaluates it on every add — it is simply
// permissive; there is no shadow / non-enforcing mode.
//
// The six rows are declared explicitly (one per state) rather than collapsed
// into the default, so each add traces to a concrete rule_id in its decision
// provenance and PR-4 flips outcomes in place without re-authoring structure.

const ADD_RULE = (status: string): PolicyPackage['rules'][number] => ({
  id: `add-talent-${status}`,
  resource: 'REQUISITION_TALENT',
  action: 'ADD',
  when: [{ source: 'declared', key: 'status', op: 'eq', value: status }],
  decision: 'ALLOW',
  reason_code: 'LIFECYCLE_ADD_ALLOWED',
});

export const REQUISITION_LIFECYCLE_PACKAGE: PolicyPackage = {
  name: 'requisition-lifecycle',
  version: '1.0.0',
  registry: {
    resources: ['REQUISITION_TALENT'],
    actions: ['ADD'],
  },
  // R3 — a package MUST declare its own no-match disposition; PR-3 is permissive.
  default_disposition: {
    decision: 'ALLOW',
    reason_code: 'LIFECYCLE_ADD_ALLOWED_DEFAULT',
  },
  rules: ['active', 'on_hold', 'full', 'closed', 'canceled', 'lead'].map(ADD_RULE),
};
