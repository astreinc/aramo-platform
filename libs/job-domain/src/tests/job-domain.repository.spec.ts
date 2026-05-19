import { describe, expect, it } from 'vitest';

import { JobDomainRepository } from '../lib/job-domain.repository.js';

// Unit tests for JobDomainRepository. M3 PR-4 §4.4 surface check:
//
//   - The repository exposes exactly the six declared methods
//     (create / find pairs for Job, GoldenProfile, Requisition).
//   - No update/delete/list method is exposed (closed surface per the
//     PR-1 entity-foundation precedent).
//
// Database round-trip behavior (create + read of each entity, cross-schema
// UUID references) is exercised by job-domain.integration.spec.ts against
// a real Postgres testcontainer under ARAMO_RUN_INTEGRATION=1.
describe('JobDomainRepository — surface', () => {
  it('exposes exactly the six declared create/find methods', () => {
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
