import { describe, expect, it } from 'vitest';

import { JobDomainRepository } from '../lib/job-domain.repository.js';

// Unit tests for JobDomainRepository. M3 PR-4 §4.4 + M3 PR-8 §4.2 surface
// check, EXTENDED at the Job-Module PR (LB-2):
//
//   - The repository exposes the seven original create/find methods PLUS
//     updateGoldenProfile (the Job-Module idempotent re-generation: a
//     re-confirmed brief overwrites the captured GoldenProfile content in
//     place rather than minting a duplicate). This is the ONE deliberate,
//     documented surface expansion — still closed otherwise (no delete /
//     list / query; updateGoldenProfile is the sole, tenant-scoped,
//     content-only mutation).
//
// Database round-trip behavior (create + read of each entity, cross-schema
// UUID references) is exercised by job-domain.integration.spec.ts against
// a real Postgres testcontainer under ARAMO_RUN_INTEGRATION=1.
describe('JobDomainRepository — surface', () => {
  it('exposes the seven create/find methods plus the Job-Module updateGoldenProfile', () => {
    const methods = Object.getOwnPropertyNames(JobDomainRepository.prototype)
      .filter((m) => m !== 'constructor')
      .sort();
    expect(methods).toEqual(
      [
        'createJob',
        'findJobById',
        'createGoldenProfile',
        'findGoldenProfileById',
        'updateGoldenProfile',
        'createRequisition',
        'findRequisitionById',
        'findActiveRequisitionByJobId',
      ].sort(),
    );
  });

  it('exposes no delete/list/query method, and update ONLY for the GoldenProfile seam', () => {
    const methods = Object.getOwnPropertyNames(JobDomainRepository.prototype);
    // delete/list/query remain forbidden; the only permitted mutation
    // beyond create is updateGoldenProfile (the Job-Module idempotent
    // re-generation seam).
    const forbiddenPrefixes = ['delete', 'remove', 'list', 'findAll', 'findMany', 'search', 'query'];
    const offending = methods.filter((m) =>
      forbiddenPrefixes.some((p) => m.toLowerCase().startsWith(p.toLowerCase())),
    );
    expect(offending).toEqual([]);
    const updates = methods.filter((m) => m.toLowerCase().startsWith('update'));
    expect(updates).toEqual(['updateGoldenProfile']);
  });
});
