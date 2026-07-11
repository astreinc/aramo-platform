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
  // TR-4 B2 (DDR §3.4) — the ledger-routing reads: bounded, tenant-scoped,
  // purpose-specific reads the CLAIMS dual-write + backfill need (typed rows →
  // canonical ledger evidence). NOT an open query surface — each is a named,
  // single-purpose read. Enumerated here so they are a conscious surface addition.
  const TR4_B2_LEDGER_READS = [
    'listSkillEvidenceForLedger',
    'listWorkHistoryForLedger',
    'listTalentIdsWithEvidenceByTenant',
    'listTenantIdsWithEvidence',
    // TR-7 B1 (DDR §4.2) — the credential ledger reads: the CLAIMS dual-write +
    // backfill consume declared degree/certification typed rows. Same bounded,
    // tenant-scoped, single-purpose shape as the TR-4 B2 reads above.
    'listEducationForLedger',
    'listCertificationForLedger',
  ];

  it('exposes the 14 create/find methods + the Gate-1 by-talent reads + the TR-4 B2 ledger reads', () => {
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
        // TR-2a-B3b (DDR-3 §4) — the reconcile re-point of talent_id across all
        // seven talent_evidence holders (loser→survivor, idempotent).
        'repointTalentRecordRefs',
        // TR-7 B1 (DDR §4.2) — the two new credential typed-row homes (declared
        // academic degrees + professional certifications), create/find per the
        // TalentWorkHistoryEntry precedent.
        'createTalentEducationEntry',
        'findTalentEducationEntryById',
        'createTalentCertificationEntry',
        'findTalentCertificationEntryById',
        ...TR4_B2_LEDGER_READS,
      ].sort(),
    );
  });

  it('exposes no update/delete/list/query method beyond the enumerated TR-4 B2 ledger reads (closed surface)', () => {
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
    const offending = methods.filter(
      (m) =>
        forbiddenPrefixes.some((p) => m.toLowerCase().startsWith(p.toLowerCase())) &&
        !TR4_B2_LEDGER_READS.includes(m),
    );
    // Only the consciously-enumerated B2 ledger reads may carry a list-shaped name;
    // any NEW list/query method forces an explicit addition to the allowlist above.
    expect(offending).toEqual([]);
  });

  it('exposes no method for TalentEngagementEvent (deferred to M5 per directive §2 Ruling 1)', () => {
    const methods = Object.getOwnPropertyNames(TalentEvidenceRepository.prototype);
    const offending = methods.filter((m) => m.includes('EngagementEvent'));
    expect(offending).toEqual([]);
  });
});
