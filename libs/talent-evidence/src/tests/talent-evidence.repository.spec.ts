import { describe, expect, it } from 'vitest';

import { TalentEvidenceRepository } from '../lib/talent-evidence.repository.js';

// Unit tests for TalentEvidenceRepository. M3 PR-5 §4.4 surface check:
//
//   - The repository exposes exactly 14 declared methods (create + find
//     pairs for each of the 7 entities).
//   - No update/delete/list method is exposed (closed surface per the
//     PR-1 / PR-4 entity-foundation precedent).
//   - TalentEngagementEvent has no method (deferred to M5 per directive
//     §2 Ruling 1; the 8th EvidenceReference target is intentionally
//     unbuilt).
//
// Database round-trip behavior (create + read of each entity, enum
// fidelity including the "1099" @map case, cross-schema UUID references)
// is exercised by talent-evidence.integration.spec.ts against a real
// Postgres testcontainer under ARAMO_RUN_INTEGRATION=1.
describe('TalentEvidenceRepository — surface', () => {
  it('exposes the 14 create/find methods + the 2 Gate-1 G1-B by-talent reads', () => {
    const methods = Object.getOwnPropertyNames(TalentEvidenceRepository.prototype)
      .filter((m) => m !== 'constructor')
      .sort();
    expect(methods).toEqual(
      [
        'createTalentSkillEvidence',
        'findTalentSkillEvidenceById',
        'createTalentWorkHistoryEntry',
        'findTalentWorkHistoryEntryById',
        'createTalentContactMethod',
        'findTalentContactMethodById',
        'createTalentRateExpectation',
        'findTalentRateExpectationById',
        'createTalentWorkAuthorization',
        'findTalentWorkAuthorizationById',
        'createTalentDocument',
        'findTalentDocumentById',
        'createTalentDerivedSnapshot',
        'findTalentDerivedSnapshotById',
        // Gate-1 G1-B — deterministic-derivation by-talent reads (the matching
        // engine consumes a talent's declared skill evidence; the examine
        // endpoint's exists-check gates lazy extraction).
        'findTalentSkillEvidenceByTalent',
        'countTalentSkillEvidenceByTalent',
      ].sort(),
    );
  });

  it('exposes no update/delete/list/query method (closed surface per PR-1 / PR-4 precedent)', () => {
    const methods = Object.getOwnPropertyNames(TalentEvidenceRepository.prototype);
    const forbiddenPrefixes = [
      'update',
      'delete',
      'remove',
      'list',
      'findAll',
      'findMany',
      'search',
      'query',
    ];
    const offending = methods.filter((m) =>
      forbiddenPrefixes.some((p) => m.toLowerCase().startsWith(p.toLowerCase())),
    );
    expect(offending).toEqual([]);
  });

  it('exposes no method for TalentEngagementEvent (deferred to M5 per directive §2 Ruling 1)', () => {
    const methods = Object.getOwnPropertyNames(TalentEvidenceRepository.prototype);
    const offending = methods.filter((m) => m.includes('EngagementEvent'));
    expect(offending).toEqual([]);
  });
});
