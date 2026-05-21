import { describe, expect, it } from 'vitest';

import { JobDomainRepository } from '../lib/job-domain.repository.js';

// Unit tests for JobDomainRepository. M3 PR-4 §4.4 + M3 PR-8 §4.2 surface
// check:
//
//   - The repository exposes exactly the seven declared methods
//     (create / find pairs for Job, GoldenProfile, Requisition; plus the
//     PR-8 findActiveRequisitionByJobId bridge for the match-list endpoint).
//   - No update/delete/list method is exposed (closed surface per the
//     PR-1 entity-foundation precedent).
//
// Database round-trip behavior (create + read of each entity, cross-schema
// UUID references) is exercised by job-domain.integration.spec.ts against
// a real Postgres testcontainer under ARAMO_RUN_INTEGRATION=1.
describe('JobDomainRepository — surface', () => {
  it('exposes exactly the seven declared create/find methods', () => {
    const methods = Object.getOwnPropertyNames(JobDomainRepository.prototype)
      .filter((m) => m !== 'constructor')
      .sort();
    expect(methods).toEqual(
      [
        'createJob',
        'findJobById',
        'createGoldenProfile',
        'findGoldenProfileById',
        'createRequisition',
        'findRequisitionById',
        'findActiveRequisitionByJobId',
      ].sort(),
    );
  });

  it('exposes no update/delete/list/query method (closed surface per PR-1 precedent)', () => {
    const methods = Object.getOwnPropertyNames(JobDomainRepository.prototype);
    const forbiddenPrefixes = ['update', 'delete', 'remove', 'list', 'findAll', 'findMany', 'search', 'query'];
    const offending = methods.filter((m) =>
      forbiddenPrefixes.some((p) => m.toLowerCase().startsWith(p.toLowerCase())),
    );
    expect(offending).toEqual([]);
  });
});
