import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { evaluate, validatePackage, type Decision, type PolicyContext } from '@aramo/policy-engine';
import { REQUISITION_LIFECYCLE_PACKAGE_NAME } from '@aramo/pipeline';

import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';

const ROOT = resolve(__dirname, '../../../..');
const OVERRIDE_CAP = 'requisition.override.submittal_closed';

// ADR-0024 / T1-d — the RecruitingStatus-keyed matrix v4.0.0, published as DATA.
// This spec re-declares the directive's matrix INDEPENDENTLY (it must not trust
// the table it is checking) and evaluates every cell through the engine against
// the package DATA — the fast, exhaustive DATA proof; the E2E proves it
// published + retrieved.

const ACTION: Readonly<Record<string, string>> = {
  REQUISITION_TALENT: 'ADD',
  REQUISITION_SUBMITTAL: 'CREATE',
  REQUISITION_NOTE: 'ADD',
  REQUISITION_DOCUMENT: 'ADD',
  REQUISITION: 'SET_PRIORITY', // PR-7
};

// Independent copy of the directive matrix (state × resource → decision).
// T1-d re-keys on RecruitingStatus: open (was active) / on_hold /
// submittals_closed (was full) / closed / canceled / lead. PR-7's REQUISITION ·
// SET_PRIORITY: open/on_hold/submittals_closed/lead ALLOW, closed/canceled DENY
// (priority on a terminal requisition is meaningless). Gated states carry no row.
const EXPECTED: Readonly<Record<string, Readonly<Record<string, Decision>>>> = {
  open: { REQUISITION_TALENT: 'ALLOW', REQUISITION_SUBMITTAL: 'ALLOW', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'ALLOW', REQUISITION: 'ALLOW' },
  on_hold: { REQUISITION_TALENT: 'ALLOW', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'ALLOW', REQUISITION: 'ALLOW' },
  submittals_closed: { REQUISITION_TALENT: 'REQUIRES_OVERRIDE', REQUISITION_SUBMITTAL: 'REQUIRES_OVERRIDE', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'REQUIRES_OVERRIDE', REQUISITION: 'ALLOW' },
  closed: { REQUISITION_TALENT: 'DENY', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'DENY', REQUISITION: 'DENY' },
  canceled: { REQUISITION_TALENT: 'DENY', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'DENY', REQUISITION: 'DENY' },
  lead: { REQUISITION_TALENT: 'ALLOW', REQUISITION_SUBMITTAL: 'DENY', REQUISITION_NOTE: 'ALLOW', REQUISITION_DOCUMENT: 'ALLOW', REQUISITION: 'ALLOW' },
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

describe('REQUISITION_LIFECYCLE_PACKAGE v6.0.0 — RecruitingStatus-keyed matrix DATA', () => {
  it('is a structurally valid package (as PolicyStore.publish will require), v6.0.0, named for the retrieval key, default ALLOW', () => {
    expect(() => validatePackage(REQUISITION_LIFECYCLE_PACKAGE)).not.toThrow();
    expect(REQUISITION_LIFECYCLE_PACKAGE.name).toBe(REQUISITION_LIFECYCLE_PACKAGE_NAME);
    // Amendment B — new MAJOR: the three approval-transition actions are a new surface.
    expect(REQUISITION_LIFECYCLE_PACKAGE.version).toBe('6.0.0');
    expect(REQUISITION_LIFECYCLE_PACKAGE.default_disposition.decision).toBe('ALLOW');
  });

  it('governs the five column resources + the seven transition actions', () => {
    expect([...REQUISITION_LIFECYCLE_PACKAGE.registry.resources].sort()).toEqual([
      'REQUISITION',
      'REQUISITION_DOCUMENT',
      'REQUISITION_NOTE',
      'REQUISITION_SUBMITTAL',
      'REQUISITION_TALENT',
    ]);
    // ADD/CREATE/SET_PRIORITY + T1-e CLOSE/REOPEN/PUT_ON_HOLD/CANCEL +
    // Amendment-B SUBMIT_FOR_APPROVAL/APPROVE/REJECT.
    expect([...REQUISITION_LIFECYCLE_PACKAGE.registry.actions].sort()).toEqual([
      'ADD', 'APPROVE', 'CANCEL', 'CLOSE', 'CREATE', 'PUT_ON_HOLD', 'REJECT',
      'REOPEN', 'SET_PRIORITY', 'SUBMIT_FOR_APPROVAL',
    ]);
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
    for (const status of ['open', 'on_hold', 'submittals_closed', 'closed', 'canceled', 'lead']) {
      expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, contextFor(status, 'REQUISITION_NOTE')).decision, `note·${status}`).toBe('ALLOW');
    }
  });

  // draft / pending_approval are now reachable (Approval sub-workflow) but
  // PRE-OPEN, and archived is still subsystem-gated: all three carry an EXPLICIT
  // DENY-everything-except-Note row — no talent/submittal/document work before a
  // requisition is open, and a permissive default here would be a foothold, so
  // we fail closed. Note stays ALLOW; SET_PRIORITY is DENY.
  it('the pre-open / gated states (draft / pending_approval / archived) DENY everything except Note', () => {
    for (const status of ['draft', 'pending_approval', 'archived']) {
      expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, contextFor(status, 'REQUISITION_TALENT')).decision, `add·${status}`).toBe('DENY');
      expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, contextFor(status, 'REQUISITION_SUBMITTAL')).decision, `submit·${status}`).toBe('DENY');
      expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, contextFor(status, 'REQUISITION_DOCUMENT')).decision, `document·${status}`).toBe('DENY');
      expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, contextFor(status, 'REQUISITION_NOTE')).decision, `note·${status}`).toBe('ALLOW');
      expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, contextFor(status, 'REQUISITION')).decision, `set-priority·${status}`).toBe('DENY');
    }
  });
});

// T1-e (§2.2) — the four governed-transition actions, keyed on the declared FROM
// status. Re-declared INDEPENDENTLY (the spec must not trust the table it checks)
// and evaluated through the engine against the package DATA.
const EXPECTED_TRANSITIONS: Readonly<Record<string, Readonly<Record<string, Decision>>>> = {
  CLOSE: { lead: 'ALLOW', open: 'ALLOW', on_hold: 'ALLOW', submittals_closed: 'ALLOW', canceled: 'DENY', closed: 'DENY', draft: 'DENY', pending_approval: 'DENY', archived: 'DENY' },
  REOPEN: { lead: 'ALLOW', on_hold: 'ALLOW', submittals_closed: 'ALLOW', closed: 'ALLOW', open: 'DENY', canceled: 'DENY', draft: 'DENY', pending_approval: 'DENY', archived: 'DENY' },
  PUT_ON_HOLD: { lead: 'ALLOW', open: 'ALLOW', submittals_closed: 'ALLOW', on_hold: 'DENY', closed: 'DENY', canceled: 'DENY', draft: 'DENY', pending_approval: 'DENY', archived: 'DENY' },
  CANCEL: { lead: 'ALLOW', open: 'ALLOW', on_hold: 'ALLOW', submittals_closed: 'ALLOW', canceled: 'DENY', closed: 'DENY', draft: 'DENY', pending_approval: 'DENY', archived: 'DENY' },
};

function transitionContext(status: string, action: string): PolicyContext {
  return {
    tenant_id: 't',
    resource: 'REQUISITION',
    action,
    resource_state: { declared: { status }, derived: {} },
    principal_capabilities: {},
    request_metadata: { correlation_id: 'c', origin: 'ui' },
    environment: 'test',
    time: new Date('2026-01-01T00:00:00Z').toISOString(),
    attributes: {},
  };
}

describe('REQUISITION_LIFECYCLE_PACKAGE v6.0.0 — governed transition matrices (T1-e)', () => {
  for (const [action, row] of Object.entries(EXPECTED_TRANSITIONS)) {
    for (const [status, expected] of Object.entries(row)) {
      it(`transition ${action} from ${status} -> ${expected}`, () => {
        const decision = evaluate(REQUISITION_LIFECYCLE_PACKAGE, transitionContext(status, action));
        expect(decision.decision).toBe(expected);
      });
    }
  }

  it('R5 — lead → open (REOPEN from lead) is ALLOW, an ordinary recruiter action', () => {
    expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, transitionContext('lead', 'REOPEN')).decision).toBe('ALLOW');
  });

  it('a closed requisition may be REOPENed but never re-CLOSEd or CANCELed', () => {
    expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, transitionContext('closed', 'REOPEN')).decision).toBe('ALLOW');
    expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, transitionContext('closed', 'CLOSE')).decision).toBe('DENY');
    expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, transitionContext('closed', 'CANCEL')).decision).toBe('DENY');
  });

  it('a canceled requisition is terminal — every transition out of it DENIES', () => {
    for (const action of ['CLOSE', 'REOPEN', 'PUT_ON_HOLD', 'CANCEL']) {
      expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, transitionContext('canceled', action)).decision, `canceled·${action}`).toBe('DENY');
    }
  });
});

// Approval sub-workflow (Amendment B) — the three governed approval actions,
// keyed on the declared FROM status. Re-declared INDEPENDENTLY. Each fires from
// exactly ONE from-status; every other from-status DENIES (fail-closed on the
// permissive default). draft → pending_approval = SUBMIT_FOR_APPROVAL;
// pending_approval → open = APPROVE; pending_approval → draft = REJECT.
const EXPECTED_APPROVAL_TRANSITIONS: Readonly<Record<string, Readonly<Record<string, Decision>>>> = {
  SUBMIT_FOR_APPROVAL: { draft: 'ALLOW', lead: 'DENY', open: 'DENY', on_hold: 'DENY', submittals_closed: 'DENY', closed: 'DENY', canceled: 'DENY', pending_approval: 'DENY', archived: 'DENY' },
  APPROVE: { pending_approval: 'ALLOW', draft: 'DENY', lead: 'DENY', open: 'DENY', on_hold: 'DENY', submittals_closed: 'DENY', closed: 'DENY', canceled: 'DENY', archived: 'DENY' },
  REJECT: { pending_approval: 'ALLOW', draft: 'DENY', lead: 'DENY', open: 'DENY', on_hold: 'DENY', submittals_closed: 'DENY', closed: 'DENY', canceled: 'DENY', archived: 'DENY' },
};

describe('REQUISITION_LIFECYCLE_PACKAGE — governed APPROVAL transitions (Amendment B)', () => {
  for (const [action, row] of Object.entries(EXPECTED_APPROVAL_TRANSITIONS)) {
    for (const [status, expected] of Object.entries(row)) {
      it(`approval ${action} from ${status} -> ${expected}`, () => {
        const decision = evaluate(REQUISITION_LIFECYCLE_PACKAGE, transitionContext(status, action));
        expect(decision.decision).toBe(expected);
      });
    }
  }

  it('the approval chain: draft → pending_approval → open, with REJECT back to draft', () => {
    expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, transitionContext('draft', 'SUBMIT_FOR_APPROVAL')).decision).toBe('ALLOW');
    expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, transitionContext('pending_approval', 'APPROVE')).decision).toBe('ALLOW');
    expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, transitionContext('pending_approval', 'REJECT')).decision).toBe('ALLOW');
  });

  it('APPROVE never fires from any state but pending_approval (fail-closed)', () => {
    for (const status of ['lead', 'draft', 'open', 'on_hold', 'submittals_closed', 'closed', 'canceled', 'archived']) {
      expect(evaluate(REQUISITION_LIFECYCLE_PACKAGE, transitionContext(status, 'APPROVE')).decision, `approve·${status}`).toBe('DENY');
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
