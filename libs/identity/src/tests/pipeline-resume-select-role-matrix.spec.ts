import { describe, expect, it } from 'vitest';

import { RESUME_SELECT_SEED_BUNDLES } from '../../prisma/seed.js';
import { SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// TI-1D-D — the pipeline:resume:set role-matrix gate (unit tier).
//
// pipeline:resume:set is the DEDICATED mutation scope for setting a
// Requisition-context résumé selection (PUT /v1/pipelines/{id}/resume-edition).
// It is an EXPLICIT TI-1D-D grant decision (NOT auto-inherited from
// pipeline:change-status): the operating model grants active Pipeline work to
// recruiters + account managers, while tenant owners/admins retain full
// operational oversight and can intervene. So the four change-status holders
// receive it — but the architectural distinction is preserved (dedicated scope,
// dedicated bundle), never a silent reuse of pipeline:change-status.
//
// LOCKED matrix:
//   tenant_admin     → pipeline:resume:set
//   tenant_owner     → pipeline:resume:set   (Owner = Admin)
//   recruiter        → pipeline:resume:set
//   account_manager  → pipeline:resume:set
// super_admin and every other tenant role (sourcer / recruiting_manager /
// lead_recruiter / delivery_manager / back_office / finance / auditor / …)
// receive NOTHING — no prose-hierarchy inheritance, fail-closed.

const RESUME_SELECT_FOUR = ['account_manager', 'recruiter', 'tenant_admin', 'tenant_owner'];

function resumeSelectScopesFor(role: string): string[] {
  return RESUME_SELECT_SEED_BUNDLES.filter(([r]) => r === role)
    .flatMap(([, scopes]) => scopes)
    .sort();
}

describe('pipeline:resume:set role matrix — grant table (unit)', () => {
  it('grants pipeline:resume:set to EXACTLY the four change-status holders', () => {
    const roles = [...new Set(RESUME_SELECT_SEED_BUNDLES.map(([r]) => r))].sort();
    expect(roles).toEqual(RESUME_SELECT_FOUR);
  });

  it('grants ONLY pipeline:resume:set (no scope outside the dedicated subset)', () => {
    const granted = new Set(RESUME_SELECT_SEED_BUNDLES.flatMap(([, s]) => s));
    expect([...granted]).toEqual(['pipeline:resume:set']);
  });

  it('each of the four roles → exactly [pipeline:resume:set]', () => {
    for (const role of RESUME_SELECT_FOUR) {
      expect(resumeSelectScopesFor(role)).toEqual(['pipeline:resume:set']);
    }
  });

  it('tenant_owner mirrors tenant_admin (Owner = Admin scope set)', () => {
    expect(resumeSelectScopesFor('tenant_owner')).toEqual(
      resumeSelectScopesFor('tenant_admin'),
    );
  });

  it('the platform / SaaS-operator role (super_admin) receives NO resume-select scope', () => {
    expect(resumeSelectScopesFor('super_admin')).toEqual([]);
  });

  it('the operational roles NOT on the matrix receive nothing (fail-closed)', () => {
    for (const role of [
      'sourcer',
      'recruiting_manager',
      'lead_recruiter',
      'delivery_manager',
      'back_office',
      'finance',
    ]) {
      expect(resumeSelectScopesFor(role)).toEqual([]);
    }
  });
});

describe('pipeline:resume:set — scope-catalog parity (unit)', () => {
  it('SEED_SCOPE_KEYS contains pipeline:resume:set exactly once', () => {
    expect(SEED_SCOPE_KEYS).toContain('pipeline:resume:set');
    expect(
      SEED_SCOPE_KEYS.filter((k) => k === 'pipeline:resume:set'),
    ).toHaveLength(1);
  });
});
