import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { validatePackage } from '@aramo/policy-engine';
import { REQUISITION_LIFECYCLE_PACKAGE_NAME } from '@aramo/pipeline';

import { REQUISITION_LIFECYCLE_PACKAGE } from '../policy/requisition-lifecycle.package.js';

const ROOT = resolve(__dirname, '../../../..');

// PR-4a — the lifecycle package is now DATA (apps/api), published to
// policy-store. Same six-ALLOW matrix the PR-3 scaffold carried (no behaviour
// change); the restrictive matrix is PR-4c.

describe('REQUISITION_LIFECYCLE_PACKAGE (seed DATA) — permissive, structurally valid', () => {
  it('passes the engine shape validation (as PolicyStore.publish will)', () => {
    expect(() => validatePackage(REQUISITION_LIFECYCLE_PACKAGE)).not.toThrow();
  });

  it('is named for the package the consumer retrieves', () => {
    expect(REQUISITION_LIFECYCLE_PACKAGE.name).toBe(REQUISITION_LIFECYCLE_PACKAGE_NAME);
  });

  it('declares one ALLOW row for each of the six requisition states', () => {
    const states = REQUISITION_LIFECYCLE_PACKAGE.rules.map((r) => r.when?.[0]?.value);
    expect(states.sort()).toEqual(['active', 'canceled', 'closed', 'full', 'lead', 'on_hold']);
    expect(REQUISITION_LIFECYCLE_PACKAGE.rules.every((r) => r.decision === 'ALLOW')).toBe(true);
    expect(REQUISITION_LIFECYCLE_PACKAGE.default_disposition.decision).toBe('ALLOW');
  });

  it('governs exactly REQUISITION_TALENT · ADD', () => {
    expect(REQUISITION_LIFECYCLE_PACKAGE.registry.resources).toEqual(['REQUISITION_TALENT']);
    expect(REQUISITION_LIFECYCLE_PACKAGE.registry.actions).toEqual(['ADD']);
  });
});

describe('scaffold is GONE (PR-4a deleted the in-code package)', () => {
  // The load-bearing half is "nothing imports it" — a live import of a deleted
  // file would not compile anyway. The existence check is a cheap corroboration.
  it('libs/pipeline no longer defines or references the requisition-lifecycle package', () => {
    // git grep exits 1 (no matches) — that is the pass. Any hit is a stray ref.
    let matches = '';
    try {
      matches = execFileSync('git', ['grep', '-l', 'requisition-lifecycle.package', '--', 'libs/pipeline'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
    } catch {
      matches = ''; // exit 1 = zero matches
    }
    expect(matches.trim()).toBe('');
  });

  it('the scaffold file no longer exists under libs/pipeline', () => {
    expect(existsSync(resolve(ROOT, 'libs/pipeline/src/lib/policy/requisition-lifecycle.package.ts'))).toBe(false);
  });
});
