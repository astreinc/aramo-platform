# DRAFT Directive — Talent Skills & Work-History as evidence on Talent Detail

> STATUS: **DRAFT for Lead/PO ratification.** Not LOCKED, not filed to canonical.
> Implement on a dedicated branch off origin/main AFTER ratification — NOT inside
> the current Talent-Detail Backend Enablement PR.

## Goal
Populate the Talent-Detail **Skills** and **Work history** cards with real,
evidence-graded data (the prototype's "VERIFIED" chips are evidence states),
instead of the current free-text skills / empty work-history.

## Grounded substrate (recon 2026-09-10, HEAD 7c97158b)
- Tables ALREADY EXIST — **no migration / no new table**:
  - `libs/talent-evidence/prisma`: `TalentSkillEvidence`, `TalentWorkHistoryEntry`
    (+ Education, Certification, ContactMethod, RateExpectation, WorkAuthorization,
    Document, DerivedSnapshot).
  - `libs/talent-trust`: `EvidenceRecord` / `TrustState` ledger; assertion types
    include `SKILL`, `EMPLOYMENT`.
  - `TalentEvidenceModule` is app-wired (`apps/api/src/app.module.ts:55`);
    `TalentEvidenceRepository` used by examine / reconcile / erasure.
- GAPS today:
  - No writer from the ATS résumé-create flow → these evidence tables.
  - Talent-Detail Skills reads `TalentRecord.key_skills` (free text); Work history
    has no source → empty state.

## Hard constraints (LOCKED — do not violate)
- **ADR-0015 (no-LLM résumé parse):** `libs/resume-parse` MUST NOT import any LLM
  substrate (structural spec `no-llm-boundary.spec.ts`). Résumé extraction is
  DETERMINISTIC. Any LLM extraction must run through the governed
  Conversation-Intelligence path (consent-gated, dark-by-default) — a separate
  decision, not the résumé lib.
- **R7 sealed:** NO open-web / public social-profile scraping (the R7-sealed
  sources) as an evidence source. Allowed
  sources = the talent's own résumé (consented, ADR-0015), recruiter-held
  references (TR-9), issuer-verified credentials, talent-portal self-attestation,
  and consented/provenanced agency/partner feeds.
- **R10:** evidence is stated-fact + a named verification state, never a number.
- **Evidence provenance:** every skill/work-history evidence row needs a resolved
  subject + a source basis (which document/reference), per the talent-evidence /
  identity model — no anonymous claims.
- **Skills Taxonomy:** structured skill canonicalization is a deferred program;
  align with it (do not invent a parallel taxonomy).

## Design (recommended)
1. **Extraction (deterministic, ADR-0015):** extend the résumé parser to propose
   structured Skills + Work-History entries (role/company/dates for history; a
   skills list for skills) as PROPOSALS with source citations (résumé spans).
2. **Human-in-the-loop:** recruiter reviews/corrects the proposals (mirrors the
   existing résumé → prefill → review → commit create flow).
3. **Persist as evidence:** write reviewed entries to `TalentSkillEvidence` /
   `TalentWorkHistoryEntry` with provenance + a verification state that ties into
   the talent-trust evidence grading (the "VERIFIED"/"Supported"/"Contradicted"
   states already rendered on the Trust & Evidence tab).
4. **Re-verify on résumé replace:** re-run extraction on a new résumé version,
   diff against stored entries (no silent overwrite of verified values — TM-L4).
5. **FE projection:** Skills card renders structured skill evidence (✓ =
   evidence-backed vs self-reported); Work-history card renders the entries with
   VERIFIED chips. Both project the existing evidence model.
6. **No backfill:** one prod tenant — re-upload a résumé to populate (per PO).

## Touch points (implementation, dedicated branch)
- `libs/resume-parse`: deterministic Skills + Work-History extractors + prefill
  types (no LLM).
- `libs/talent-evidence`: writer/repository methods to upsert skill / work-history
  evidence with provenance (if not already present).
- `libs/talent-trust`: verification-state binding for the entries.
- apps/api: the résumé-review→commit seam that persists evidence; read projection
  onto the Talent-Detail read.
- apps/ats-web: Skills + Work-history cards read the evidence projection; review UI
  for proposed entries.
- Curated migration lists / verify-api: only if a returned shape changes (no new
  table, so likely a read-projection addition — confirm at implement time).

## Open decisions (for ratification)
- Deterministic-only extraction vs enabling the governed-CI LLM path for richer
  work-history extraction (consent + dark-default implications).
- Whether Skills evidence waits on the Skills Taxonomy program or ships with a
  free-text-backed interim.

## Sequencing
Ratify → dedicated branch off origin/main → implement (extraction → evidence
writer → verification binding → FE projection + review UI) → gates → PR → merge.
NOT part of the current Talent-Detail Backend Enablement PR.
