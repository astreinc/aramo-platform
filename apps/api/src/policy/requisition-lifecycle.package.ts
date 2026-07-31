import type { PolicyPackage } from '@aramo/policy-engine';
import { REQUISITION_LIFECYCLE_PACKAGE_NAME } from '@aramo/pipeline';

// The requisition-lifecycle policy package — DATA (ADR-0024 §D2). This is the
// SEED payload, not runtime code: it is published to policy-store (through
// PolicyStore.publish → validatePackage → real version + checksum) and the
// consumer retrieves it at decision time. It lives in the composition layer
// (apps/api) because authoring an ATS-domain policy is an ATS concern;
// libs/policy-store stays domain-agnostic and never imports it.
//
// PR-4a ships the SAME six-ALLOW matrix the PR-3 scaffold carried, unchanged —
// this PR only moves the source of truth (code → published data). The
// restrictive matrix (`full` → REQUIRES_OVERRIDE, `closed`/`canceled` → DENY)
// is PR-4c, published as a new version with no code change.

const ADD_RULE = (status: string): PolicyPackage['rules'][number] => ({
  id: `add-talent-${status}`,
  resource: 'REQUISITION_TALENT',
  action: 'ADD',
  when: [{ source: 'declared', key: 'status', op: 'eq', value: status }],
  decision: 'ALLOW',
  reason_code: 'LIFECYCLE_ADD_ALLOWED',
});

export const REQUISITION_LIFECYCLE_PACKAGE: PolicyPackage = {
  name: REQUISITION_LIFECYCLE_PACKAGE_NAME,
  version: '1.0.0',
  registry: {
    resources: ['REQUISITION_TALENT'],
    actions: ['ADD'],
  },
  // R3 — a package MUST declare its own no-match disposition; PR-4a stays permissive.
  default_disposition: {
    decision: 'ALLOW',
    reason_code: 'LIFECYCLE_ADD_ALLOWED_DEFAULT',
  },
  rules: ['active', 'on_hold', 'full', 'closed', 'canceled', 'lead'].map(ADD_RULE),
};
