import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { evaluate, validatePackage, type Decision, type PolicyContext } from '@aramo/policy-engine';
import { REQUISITION_LIFECYCLE_PACKAGE_NAME } from '@aramo/pipeline';

import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';

const ROOT = resolve(__dirname, '../../../..');
const OVERRIDE_CAP = 'requisition.override.submittal_closed';

// ADR-0024 PR-4c — the RESTRICTIVE MATRIX v2.0.0, published as DATA. This spec
// re-declares the directive's matrix INDEPENDENTLY (it must not trust the table
// it is checking) and evaluates every cell through the engine against the
// package DATA — the fast, exhaustive DATA proof; the E2E proves it published +
// retrieved.

const ACTION: Readonly<Record<string, string>> = {
  REQUISITION_TALENT: 'ADD',
  REQUISITION_SUBMITTAL: 'CREATE',
  REQUISITION_NOTE: 'ADD',
  REQUISITION_DOCUMENT: 'ADD',
  REQUISITION: 'SET_PRIORITY', // PR-7
};

// Independent copy of the directive matrix (state × resource → decision).
// T1-d re-key: active→open, full→submittals_closed (inherits full's row incl
// the REQUIRES_OVERRIDE cells); lead unchanged; draft/pending_approval/archived
// are present-but-inert → DENY on everything except Note. The REQUISITION column
// is SET_PRIORITY: open/on_hold/submittals_closed/lead ALLOW, the rest DENY.
const EXPECTED: Readonly<Record<string, Readonly<Record<string, Decision>>>> = {
  open: { REQUISITION_TALENT: 'ALLOW', REQUISITION_SUBMITTAL: 'ALLOW', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'ALLOW', REQUISITION: 'ALLOW' },
  on_hold: { REQUISITION_TALENT: 'ALLOW', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'ALLOW', REQUISITION: 'ALLOW' },
  submittals_closed: { REQUISITION_TALENT: 'REQUIRES_OVERRIDE', REQUISITION_SUBMITTAL: 'REQUIRES_OVERRIDE', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'REQUIRES_OVERRIDE', REQUISITION: 'ALLOW' },
  closed: { REQUISITION_TALENT: 'DENY', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'DENY', REQUISITION: 'DENY' },
  canceled: { REQUISITION_TALENT: 'DENY', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'DENY', REQUISITION: 'DENY' },
  lead: { REQUISITION_TALENT: 'ALLOW', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'ALLOW', REQUISITION: 'ALLOW' },
  draft: { REQUISITION_TALENT: 'DENY', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'DENY', REQUISITION: 'DENY' },
  pending_approval: { REQUISITION_TALENT: 'DENY', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'DENY', REQUISITION: 'DENY' },
  archived: { REQUISITION_TALENT: 'DENY', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'DENY', REQUISITION: 'DENY' },
};

function contextFor(status: string, resource: string): PolicyContext {
  return {
    tenant_id: 't',
    resource,
    action: ACTION[resource]!,
    resource_state: { declared: { status }, derived: {} },
    principal_capabilities: {},
    request_metadata: { correlation_id: 'c', origin: 'ui' },
    environment: 'test',
    time: new Date('2026-01-01T00:00:00Z').toISOString(),
    attributes: {},
  };
}

describe('REQUISITION_LIFECYCLE_PACKAGE v4.0.0 — restrictive matrix DATA (RecruitingStatus)', () => {
  it('is a structurally valid package (as PolicyStore.publish will require), v4.0.0, named for the retrieval key, default ALLOW', () => {
    expect(() => validatePackage(REQUISITION_LIFECYCLE_PACKAGE)).not.toThrow();
    expect(REQUISITION_LIFECYCLE_PACKAGE.name).toBe(REQUISITION_LIFECYCLE_PACKAGE_NAME);
    expect(REQUISITION_LIFECYCLE_PACKAGE.version).toBe('4.0.0');
    expect(REQUISITION_LIFECYCLE_PACKAGE.default_disposition.decision).toBe('ALLOW');
  });

  it('governs the five resource·action pairs (Add / Submit / Note / Document / SetPriority)', () => {
    expect([...REQUISITION_LIFECYCLE_PACKAGE.registry.resources].sort()).toEqual([
      'REQUISITION',
      'REQUISITION_DOCUMENT',
      'REQUISITION_NOTE',
      'REQUISITION_SUBMITTAL',
      'REQUISITION_TALENT',
    ]);
    expect([...REQUISITION_LIFECYCLE_PACKAGE.registry.actions].sort()).toEqual(['ADD', 'CREATE', 'SET_PRIORITY']);
  });

  // EVERY cell (24), evaluated through the engine against the package DATA.
  for (const [status, row] of Object.entries(EXPECTED)) {
    for (const [resource, expected] of Object.entries(row)) {
      it(`cell ${status} · ${resource} -> ${expected}`, () => {
        const decision = evaluate(REQUISITION_LIFECYCLE_PACKAGE, contextFor(status, resource));
        expect(decision.decision).toBe(expected);
        if (expected === 'REQUIRES_OVERRIDE') {
          // §D11 — override rows name the capability and require a reason.
          expect(decision.required_capabilities).toEqual([OVERRIDE_CAP]);
          expect(decision.reason_required).toBe(true);
        }
      });
    }
  }

  it('Note is ALLOW in EVERY state, including the terminal closed/canceled (the ruling most likely to be "fixed" by mistake)', () => {
    for (const status of ['open', 'on_hold', 'submittals_closed', 'closed', 'canceled', 'lead', 'draft', 'pending_approval', 'archived']) {
      expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, contextFor(status, 'REQUISITION_NOTE')).decision, `note·${status}`).toBe('ALLOW');
    }
  });
});

describe('scaffold is GONE (PR-4a deleted the in-code package)', () => {
  it('libs/pipeline no longer defines or references the requisition-lifecycle package', () => {
    let matches = '';
    try {
      matches = execFileSync('git', ['grep', '-l', 'requisition-lifecycle.package', '--', 'libs/pipeline'], { cwd: ROOT, encoding: 'utf8' });
    } catch {
      matches = '';
    }
    expect(matches.trim()).toBe('');
  });

  it('the scaffold file no longer exists under libs/pipeline', () => {
    expect(existsSync(resolve(ROOT, 'libs/pipeline/src/lib/policy/requisition-lifecycle.package.ts'))).toBe(false);
  });
});
