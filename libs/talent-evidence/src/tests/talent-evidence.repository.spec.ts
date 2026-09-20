import { describe, expect, it } from 'vitest';

import { TalentEvidenceRepository } from '../lib/talent-evidence.repository.js';

// Unit tests for TalentEvidenceRepository. M3 PR-5 §4.4 surface check:
//
//   - The repository exposes exactly 14 declared methods (create + find
//     pairs for each of the 7 entities).
//   - No update/delete/list method is exposed (closed surface per the
//     PR-1 / PR-4 entity-foundation precedent).
//   - TalentSelectionEvent has no method (deferred to M5 per directive
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
    // TALENT-INTEL-1 (TI-1C) — the declared work-authorization ledger read: the
    // RIGHT_TO_WORK routing consumes this bounded, tenant-scoped, single-purpose
    // read (same shape as the credential reads above).
    'listWorkAuthorizationForLedger',
  ];

  // SKILL-TAX-1G — the canonical reconciliation surface: bounded tenant/talent
  // -scoped reads of durable evidence + the two guarded canonical writes (the
  // additive evidence columns + the additive derived-snapshot projection). Each
  // is single-purpose; enumerated so the closed-surface guard treats them as a
  // conscious addition, not an open query surface.
  const SKILL_TAX_1G_RECON_METHODS = [
    'listSkillEvidenceForCanonicalization',
    'updateSkillEvidenceCanonical',
    'listCanonicalUsageForTalent',
    'findLatestDerivedSnapshot',
    'updateDerivedSnapshotCanonicalYears',
  ];

  it('exposes the 14 create/find methods + the Gate-1 by-talent reads + the TR-4 B2 ledger reads + the SKILL-TAX-1G reconciliation methods + the TI-1A/TI-1D-C résumé-edition methods', () => {
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
        // Talent-detail work-history read (LOCKED scope expansion — Add-Talent
        // Governed-LLM extraction; declared 'from résumé' rows for display).
        'findWorkHistoryByTalent',
        // Full-profile EDIT (LOCKED scope expansion) — the ONE sanctioned mutation
        // on the work-history surface: a bounded REPLACE-SET (atomic delete of the
        // talent's source='resume' rows + recreate of the reviewed set). A conscious
        // departure from create+find, named 'replace' (not update/delete) because it
        // is a whole-set swap, not an arbitrary column mutation.
        'replaceWorkHistoryForTalent',
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
        // HF2 R6 — TalentProjectExperience (first-class project child of a
        // WorkExperience): create + by-id find + a by-talent display read.
        'createTalentProjectExperience',
        'findTalentProjectExperienceById',
        'findProjectExperienceByTalent',
        // TALENT-INTEL-1 (TI-1A §5) — résumé-edition substrate: the edition
        // companion to TalentDocument (create + by-id + by-talent list) and the
        // separate default/presentation selection (upsert + find).
        'createTalentResumeEdition',
        'findTalentResumeEditionById',
        'findResumeEditionsByTalent',
        'setDefaultResumeEdition',
        'findDefaultResumeEdition',
        // TALENT-INTEL-1 (TI-1D-C) — the edition-ingestion idempotency lookup
        // (one edition per document) + the read-API projection (edition ⋈
        // TalentDocument metadata + default marker).
        'findResumeEditionByDocumentId',
        'findResumeEditionsWithDocumentByTalent',
        // TALENT-INTEL-1 (TI-1F-A) — the ResumeExtractionDraft governed-extraction
        // review substrate: an idempotent upsert (the polling-outbox work signal),
        // the by-source identity lookup (retry idempotency), the PROCESSING drain
        // read (worker poll), and the two terminal review-state writes. Each is
        // single-purpose; enumerated so the closed-surface guard treats them as a
        // conscious addition. None carry a forbidden update/delete/list/query name.
        'upsertResumeExtractionDraft',
        'findResumeExtractionDraftBySource',
        'findProcessingResumeExtractionDrafts',
        'markResumeExtractionDraftReadyForReview',
        'markResumeExtractionDraftFailed',
        ...TR4_B2_LEDGER_READS,
        ...SKILL_TAX_1G_RECON_METHODS,
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
        !TR4_B2_LEDGER_READS.includes(m) &&
        !SKILL_TAX_1G_RECON_METHODS.includes(m),
    );
    // Only the consciously-enumerated B2 ledger reads may carry a list-shaped name;
    // any NEW list/query method forces an explicit addition to the allowlist above.
    expect(offending).toEqual([]);
  });

  it('exposes no method for TalentSelectionEvent (deferred to M5 per directive §2 Ruling 1)', () => {
    const methods = Object.getOwnPropertyNames(TalentEvidenceRepository.prototype);
    const offending = methods.filter((m) => m.includes('SelectionEvent'));
    expect(offending).toEqual([]);
  });
});
