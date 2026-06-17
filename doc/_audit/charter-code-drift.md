# Charter ↔ M0 Sign-off ↔ Code — Three-Way Drift Check

**Audit date:** 2026-05-31
**Scope:** narrow diagnostic. For each Charter §8 refusal R1–R13: what does the canonical text say (col 1), how does the M0 milestone sign-off restate + scope it (col 2), and what does code actually enforce (col 3) — and where do the three differ.

**Sources used (read-only):**
1. **Canonical:** [doc/ARAMO-CHARTER-EXTRACT.md](../ARAMO-CHARTER-EXTRACT.md) §2b (Charter v1.0 §8 verbatim, extracted via pandoc from `Aramo-Charter-v1.0-LOCKED.docx` in OneDrive).
2. **Repo restatement:** [doc/milestone-signoffs/M0-refusal-signoff.md](../milestone-signoffs/M0-refusal-signoff.md) — the one-line italicized refusal headings + per-M0 enforcement narrative.
3. **Enforcement:** [doc/03-refusal-layer.md](../03-refusal-layer.md) prose tables + actual code at `eslint.config.mjs`, `scripts/verify-vocabulary.sh`, `ci/scripts/verify-*-refusal.ts`, OpenAPI `const` invariants, Prisma closed enums.

**Companion docs (different deliverables, different scope):**
- [charter-refusal-audit.md](charter-refusal-audit.md) — full enforcement-mapping audit (A→D + plain-English implications)
- [three-way-drift-check.md](three-way-drift-check.md) — earlier drift check (Charter ↔ doc/03 ↔ code). This file substitutes M0 sign-off for doc/03 as the middle column per the user's reframing.
- [ARAMO-SOURCING-SERVICE-ADR-DRAFT.md](ARAMO-SOURCING-SERVICE-ADR-DRAFT.md) — DRAFT ADR-0019 (Sourcing Service boundary)

---

## Executive summary

**No refusal is silently weakened in code.** All 13 Charter §8 italicized statements are reproduced verbatim, character-for-character, in M0-refusal-signoff.md headings.

**Three load-bearing findings:**

1. **R10 enforcement gap.** Charter R10 is universal ("will not expose internal reasoning or evaluation outputs" — no audience scope). M0 sign-off narrows it explicitly to *Portal* surfaces. CI catches only **2 of the 13** forbidden Portal-response field names from `doc/03-refusal-layer.md:259-265` by literal name (`internal_reasoning`, `entrustability_tier_raw`). The remaining 11 (`tier`, `rank`, `rank_ordinal`, `score`, `examination_id`, `why_matched_sentence`, `strengths`, `gaps`, `risk_flags`, `recruiter_notes`, `override_id`, `action_queue_item_id`, `internal_engagement_state`) are caught only structurally by `additionalProperties: false`. A future PR explicitly declaring `rank` as a Portal property would pass `portal:refusal-check`.

2. **R7 enforcement is broader than Charter R7 text.** Charter R7: "*Will not perform automated LinkedIn scraping.*" Code prohibits four tokens including `generic_web_scrape` — not in Charter R7 text; the broader scope derives from API Contracts v1.0 Phase 4 §3b.3 (verbatim in extract §3b.3). This is over-coverage, not drift, but it means CI is enforcing more than the Charter rule reads.

3. **Stale `candidate_direct` / `candidate-direct` vocabulary in 4 doc-tier files** despite the May 16, 2026 vocab amendment renaming `candidate_direct → talent_direct`. Live product code is fully migrated. The OneDrive Charter v1.0 + API Contracts v1.0 + Architecture v2.1/v2.2 `.docx` files still carry the pre-rename token (read-only locked artifacts; canonical patch is the amendment docx). See §C below.

---

## A. Per-rule three-way table

For each rule: **C** = canonical Charter §8 verbatim; **M0** = M0-refusal-signoff.md restatement + enforcement narrative; **Code** = the actual enforcement point(s) with file:line. **Drift** flags any divergence between the three.

### R1 — *Will not function as a job marketplace or job board.*

- **C:** "*Will not function as a job marketplace or job board.*" ([doc/ARAMO-CHARTER-EXTRACT.md §2b Scope Refusals](../ARAMO-CHARTER-EXTRACT.md))
- **M0:** "Refusal R1 — *Will not function as a job marketplace or job board.*" ([doc/milestone-signoffs/M0-refusal-signoff.md:44](../milestone-signoffs/M0-refusal-signoff.md#L44)); enforcement = **API absence**; substrate evidence = "`grep -rEn \"^\\s*/v1/jobs\" openapi/` returns no matches" ([M0:46-47](../milestone-signoffs/M0-refusal-signoff.md#L46-L47)).
- **Code:** No `/v1/jobs/*` path in any `openapi/*.yaml`; no `JobListing`/`JobMarketplace` schema. No CI gate literally checks "no jobs path exists" — enforcement is by absence + Lead review per [doc/03-refusal-layer.md:7](../03-refusal-layer.md#L7).
- **Drift:** **No.** Three sources aligned. Note: enforcement is advisory + by absence; no dedicated CI tripwire would catch a future PR that adds a `/v1/jobs` endpoint until openapi-lint review.

### R2 — *Will not act as a sourcing engine as its primary function.*

- **C:** "*Will not act as a sourcing engine as its primary function.*" — qualifier "**as its primary function**" is in canonical text.
- **M0:** "Refusal R2 — *Will not act as a sourcing engine as its primary function.*" ([M0:50](../milestone-signoffs/M0-refusal-signoff.md#L50)) — qualifier preserved verbatim. Enforcement = **API absence**; substrate evidence = "no free-form Talent search, no bulk export, no `/v1/talents/*` endpoints" ([M0:52](../milestone-signoffs/M0-refusal-signoff.md#L52)).
- **Code:** No bulk-export endpoint; the Constrained Talent Access group pattern (`GET /talents/:talent_id`, `GET /jobs/:job_id/manual-add-search`) is documented at [doc/03-refusal-layer.md:64-67](../03-refusal-layer.md#L64-L67) but no CI rule literally enforces "no bulk-export."
- **Drift:** **Mild.** doc/03-refusal-layer.md (not M0 sign-off) drops the "**as its primary function**" qualifier in its own R2 heading at [doc/03-refusal-layer.md:47](../03-refusal-layer.md#L47): "Aramo will not act as a sourcing engine as primary function" — Charter says "**as its** primary function," doc/03 drops "its." M0 sign-off matches Charter exactly; doc/03 has a one-word drift. Material to the Sourcing Service ADR draft (see [ARAMO-SOURCING-SERVICE-ADR-DRAFT.md](ARAMO-SOURCING-SERVICE-ADR-DRAFT.md)).

### R3 — *Will not provide candidate-facing job discovery or feeds.*

- **C:** "*Will not provide candidate-facing job discovery or feeds.*"
- **M0:** "Refusal R3 — *Will not provide candidate-facing job discovery or feeds.*" ([M0:56](../milestone-signoffs/M0-refusal-signoff.md#L56)). Enforcement = **API absence**; `openapi/portal.yaml` is `paths: {}` ([M0:58-59](../milestone-signoffs/M0-refusal-signoff.md#L58-L59)).
- **Code:** [openapi/portal.yaml](../../openapi/portal.yaml) declares only `/v1/portal/profile` + `/v1/portal/consent`; no recommendation/feed/discovery endpoints; no `recommendations`/`feed` model.
- **Drift:** **No.**

### R4 — *Will not infer consent from behavior.*

- **C:** "*Will not infer consent from behavior.*"
- **M0:** "Refusal R4 — *Will not infer consent from behavior.*" ([M0:62](../milestone-signoffs/M0-refusal-signoff.md#L62)). Enforcement = **Code path constraint**; `libs/consent/src/lib/consent.repository.ts` reads only from the `TalentConsentEvent` append-only ledger; "`grep -rEn \"behavior|infer|implicit\" libs/consent/src/lib/` returns zero matches" ([M0:64-65](../milestone-signoffs/M0-refusal-signoff.md#L64-L65)). Nx module-boundary rule isolates the consent module.
- **Code:** Consent module reads only `TalentConsentEvent`; preserved by module boundary + manual review. No dedicated CI gate.
- **Drift:** **No.** Three sources aligned; enforcement is advisory + module-boundary.

### R5 — *Will not widen consent through aggregation.*

- **C:** "*Will not widen consent through aggregation.*" (Charter has no "of sources" qualifier.)
- **M0:** "Refusal R5 — *Will not widen consent through aggregation.*" ([M0:67](../milestone-signoffs/M0-refusal-signoff.md#L67)) — verbatim Charter. Enforcement = **Code path + contract**; per-tenant per-scope state; pact test at `pact/consumers/ats-thin/src/consent.consumer.test.ts:729-806` ([M0:69-70](../milestone-signoffs/M0-refusal-signoff.md#L69-L70)).
- **Code:** Intersection-not-union semantics in consent resolver (anti-pattern `sources.some` → correct `sources.every` per [doc/03-refusal-layer.md:124-129](../03-refusal-layer.md#L124-L129)); pact-asserted.
- **Drift:** **Mild.** doc/03 (not M0) appends "**of sources**" to the heading at [doc/03-refusal-layer.md:114](../03-refusal-layer.md#L114): "Aramo will not widen consent through aggregation of sources." Charter and M0 sign-off do not include "of sources" — the rule applies to any aggregation (sources, tenants, time, scopes). Code's intersection semantics match Charter not doc/03's narrowing.

### R6 — *Will not act on stale consent for high-impact actions.*

- **C:** "*Will not act on stale consent for high-impact actions.*" (Charter does not specify the 12-month threshold; that comes from Group 2 §2.7.)
- **M0:** "Refusal R6 — *Will not act on stale consent for high-impact actions.*" ([M0:72](../milestone-signoffs/M0-refusal-signoff.md#L72)). Enforcement = **Runtime check at consent resolver** with 12-month threshold from Group 2 §2.7 ([M0:74](../milestone-signoffs/M0-refusal-signoff.md#L74)); pact-asserted at `pact/consumers/ats-thin/src/consent.consumer.test.ts:429-477` with `reason_code: 'stale_consent'` ([M0:75](../milestone-signoffs/M0-refusal-signoff.md#L75)).
- **Code:** Stale-consent BullMQ job + runtime check; threshold per Group 2 §2.7.
- **Drift:** **No.** M0 + doc/03 + code correctly cite the 12-month threshold as Group 2-derived, not Charter-derived.

### R7 — *Will not perform automated LinkedIn scraping.*

- **C:** "*Will not perform automated LinkedIn scraping.*" (Charter R7 text is narrow — names only LinkedIn, not generic web scrape.)
- **M0:** "Refusal R7 — *Will not perform automated LinkedIn scraping.*" ([M0:77](../milestone-signoffs/M0-refusal-signoff.md#L77)). Enforcement = **API absence + repo-wide CI vocabulary gate + future schema-layer constraints** ([M0:79](../milestone-signoffs/M0-refusal-signoff.md#L79)); cites `scripts/verify-vocabulary.sh` Tier 1 + future `AdapterType`/`SourceType` closed enums + `linkedin_automation_allowed: const: false` per API Contracts Phase 4 four-layer refusal.
- **Code:**
  1. Tier-1 ripgrep gate: [scripts/verify-vocabulary.sh:36-51](../../scripts/verify-vocabulary.sh#L36-L51) (`R7_ALLOWLIST`, sealed); matcher at [scripts/verify-vocabulary.sh:294-314](../../scripts/verify-vocabulary.sh#L294-L314); failure message names "Charter Refusal R7."
  2. Layer-4 const-false invariant: [ci/scripts/verify-ingestion-refusal.ts:52-54](../../ci/scripts/verify-ingestion-refusal.ts#L52-L54) — `CONST_FALSE_INVARIANTS = ['linkedin_automation_allowed']`.
  3. Closed `SourceType` enum to 4 values per [openapi/ingestion.yaml:180](../../openapi/ingestion.yaml#L180) (`talent_direct`) — full list at [openapi/ingestion.yaml:37](../../openapi/ingestion.yaml#L37): "talent_direct, indeed, github, astre_import."
  4. Prohibited adapter-types list `linkedin / linkedin_scrape / linkedin_bulk / generic_web_scrape` — derived from API Contracts Phase 4 §3b.3 ([doc/ARAMO-CHARTER-EXTRACT.md §3b.3](../ARAMO-CHARTER-EXTRACT.md)).
  5. CI-wired at [.github/workflows/ci.yml:124-131](../../.github/workflows/ci.yml#L124-L131) (`verify-vocabulary`) + 178-189 (`ingestion-refusal-check`); both block `deployment-gate` aggregator at [.github/workflows/ci.yml:474](../../.github/workflows/ci.yml#L474).
  6. Bounded extension authorized by `Aramo-Charter-Review-R7-PR5-LOCKED.md` (OneDrive) — 3 enum-value paths admitted to R7_ALLOWLIST as Group 2 §2.2 closed-list provenance labels.
- **Drift:** **Code is broader than canonical R7 text.** Charter R7 names only LinkedIn; the prohibited list adds `generic_web_scrape` (a generic open-web token) which Charter R7 does not name. The broader scope is derived from API Contracts v1.0 Phase 4 §3b.3 verbatim. ⚠ Also: Group 2 §2.3a carve-out — "*Manual recruiter add is permitted as an audited exception with required attestation*" ([doc/ARAMO-CHARTER-EXTRACT.md §3a.7](../ARAMO-CHARTER-EXTRACT.md)) — has no documented surface in the code; doc/03 omits it. A recruiter wanting to use the Charter-permitted exception has no code path for it today.

### R8 — *Will not allow recruiter judgment to override system classification.*

- **C:** "*Will not allow recruiter judgment to override system classification.*"
- **M0:** "Refusal R8 — *Will not allow recruiter judgment to override system classification.*" ([M0:83](../milestone-signoffs/M0-refusal-signoff.md#L83)). Enforcement = **API absence + future schema-layer constraint**; cites `override_*` prefix exclusion + `examination_mutated: const: false` invariant ([M0:85](../milestone-signoffs/M0-refusal-signoff.md#L85)).
- **Code:** Four-way enforcement:
  - ATS schema invariant: [ci/scripts/verify-ats-refusal.ts:38](../../ci/scripts/verify-ats-refusal.ts#L38) — `CONST_FALSE_INVARIANTS = ['examination_mutated']`; failure message "must be pinned const: false (Phase 6 — no tier mutation via override)" at [ci/scripts/verify-ats-refusal.ts:81-84](../../ci/scripts/verify-ats-refusal.ts#L81-L84).
  - `override_*` prefix banned in all 3 refusal-checks: Portal [ci/scripts/verify-portal-refusal.ts:39-42](../../ci/scripts/verify-portal-refusal.ts#L39-L42), ATS [ci/scripts/verify-ats-refusal.ts:37](../../ci/scripts/verify-ats-refusal.ts#L37), Ingestion [ci/scripts/verify-ingestion-refusal.ts:46-50](../../ci/scripts/verify-ingestion-refusal.ts#L46-L50).
  - Closed `ExaminationTier` enum: [libs/examination/prisma/schema.prisma:55-58](../../libs/examination/prisma/schema.prisma#L55-L58) (`ENTRUSTABLE / WORTH_CONSIDERING / STRETCH`).
  - DB BEFORE-UPDATE trigger rejects analytical-field mutation on `TalentJobExamination`; separate `ExaminationOverride` append-only entity for recruiter annotations (see schema doc-comment in Prisma).
- **Drift:** **No.** Strongest enforcement coverage in the program.

### R9 — *Will not permit submission of Stretch-tier candidates.*

- **C:** "*Will not permit submission of Stretch-tier candidates.*"
- **M0:** "Refusal R9 — *Will not permit submission of Stretch-tier candidates.*" ([M0:89](../milestone-signoffs/M0-refusal-signoff.md#L89)). Enforcement = **API absence + future error-code-based block**; cites `SUBMITTAL_STRETCH_BLOCKED` error code (Phase 5 registry, not yet shipped at M0 closure) ([M0:91](../milestone-signoffs/M0-refusal-signoff.md#L91)).
- **Code:** Closed `ExaminationTier` enum present ([libs/examination/prisma/schema.prisma:55-58](../../libs/examination/prisma/schema.prisma#L55-L58)). `SUBMITTAL_STRETCH_BLOCKED` shipping status: not verified by this audit; M0 sign-off explicitly notes M0 has no submittal endpoint.
- **Drift:** **No** at the Charter-text level. Note: M0 sign-off is honest about partial enforcement ("re-evaluated in M4 (Entrustability + Evidence Package)") — this is staged maturation, not drift.

### R10 — *Will not expose internal reasoning or evaluation outputs.*

- **C:** "*Will not expose internal reasoning or evaluation outputs.*" — Charter text has **no audience scope.**
- **M0:** "Refusal R10 — *Will not expose internal reasoning or evaluation outputs.*" ([M0:95](../milestone-signoffs/M0-refusal-signoff.md#L95)). Enforcement = **CI script with forbidden-field exclusion** ([M0:97](../milestone-signoffs/M0-refusal-signoff.md#L97)); cites `internal_reasoning`, `entrustability_tier_raw`, `override_*`, `recruiter_*`, `additionalProperties: false` "on **Portal schemas**." M0 sign-off narrates the rule as **Portal-scoped** enforcement.
- **Code:**
  - Portal exact-match: 2 names — `internal_reasoning`, `entrustability_tier_raw` ([ci/scripts/verify-portal-refusal.ts:34-37](../../ci/scripts/verify-portal-refusal.ts#L34-L37)).
  - Portal prefix: `override_`, `recruiter_` ([ci/scripts/verify-portal-refusal.ts:39-42](../../ci/scripts/verify-portal-refusal.ts#L39-L42)).
  - ATS exact-match: `score` ([ci/scripts/verify-ats-refusal.ts:36](../../ci/scripts/verify-ats-refusal.ts#L36)) — "ATS: no raw scores exposed; score field absent from any response schema."
  - Ingestion exact: `score`, `internal_reasoning`, `entrustability_tier_raw` ([ci/scripts/verify-ingestion-refusal.ts:40-44](../../ci/scripts/verify-ingestion-refusal.ts#L40-L44)).
  - Universal `additionalProperties: false` envelope on every object schema (all three CI scripts).
  - Deliberate-failure CI evidence: commit `51d1ae0` injected `internal_reasoning` into `openapi/portal.yaml`; CI failed `portal:refusal-check`; reverted ([M0:98](../milestone-signoffs/M0-refusal-signoff.md#L98)).
- **Drift:** **Yes — load-bearing.** Charter R10 is universal; M0 sign-off explicitly narrows to Portal ("on Portal schemas"); the broader doc/03 forbidden-fields list (13 names) at [doc/03-refusal-layer.md:259-265](../03-refusal-layer.md#L259-L265) — `tier, rank, rank_ordinal, score, examination_id, why_matched_sentence, strengths, gaps, risk_flags, recruiter_notes, override_id, action_queue_item_id, internal_engagement_state` — is caught by literal name in CI for only **2 of those 13** on Portal (`internal_reasoning` and `entrustability_tier_raw` — and `internal_reasoning` is not even in the 13-name list; it's the M0 sign-off addition). The other 11 names are caught only structurally by `additionalProperties: false` + the prefix bans. **A future Portal schema declaring `rank` or `tier` as an explicit property would pass Portal CI.** Manual Lead review is the load-bearing gate for those names.

### R11 — *Will not optimize engagement metrics over consent integrity.*

- **C:** "*Will not optimize engagement metrics over consent integrity.*"
- **M0:** "Refusal R11 — *Will not optimize engagement metrics over consent integrity.*" ([M0:101](../milestone-signoffs/M0-refusal-signoff.md#L101)). Enforcement = **API absence** at M0; future enforcement via "mandatory consent-check pattern at every engagement transition + message-send time" per Architecture §13.3 + Plan M5 Track B ([M0:103](../milestone-signoffs/M0-refusal-signoff.md#L103)).
- **Code:** No dedicated CI gate; consent-check pattern is documented anti-pattern → correct-pattern in [doc/03-refusal-layer.md:307-324](../03-refusal-layer.md#L307-L324); pact-locked refusal test at `apps/api/src/tests/outreach-send-consent-revoked.integration.spec.ts` (listed in [scripts/verify-vocabulary.sh:206](../../scripts/verify-vocabulary.sh#L206) TIER2_EXCLUDES).
- **Drift:** **No.** Enforcement is advisory + pact-asserted at the engagement boundary.

### R12 — *Will not replace recruiter judgment with system autonomy.*

- **C:** "*Will not replace recruiter judgment with system autonomy.*" + Charter §4 line 174 "***Aramo is AI-assisted, not AI-autonomous.***"
- **M0:** "Refusal R12 — *Will not replace recruiter judgment with system autonomy.*" ([M0:107](../milestone-signoffs/M0-refusal-signoff.md#L107)). Enforcement = **API absence + future schema-layer attestation constraints**; cites all three attestation fields as `const: true` ([M0:109](../milestone-signoffs/M0-refusal-signoff.md#L109)) — **M0 names them `candidate_evidence_reviewed, constraints_reviewed, submission_risk_acknowledged`**.
- **Code:** OpenAPI declares the three attestations with **locked-vocabulary names**:
  - [openapi/common.yaml:2354-2356](../../openapi/common.yaml#L2354-L2356) — `talent_evidence_reviewed: const: true` (NOT `candidate_evidence_reviewed`).
  - [openapi/common.yaml:2360-2362](../../openapi/common.yaml#L2360-L2362) — `constraints_reviewed: const: true`.
  - [openapi/common.yaml:2367-2369](../../openapi/common.yaml#L2367-L2369) — `submittal_risk_acknowledged: const: true` (NOT `submission_risk_acknowledged`).
- **Drift:** **Vocabulary drift in M0 sign-off and doc/03** — both use anti-vocabulary (`candidate_evidence_reviewed`, `submission_risk_acknowledged`) that the Rule 5 gate forbids. OpenAPI is canonical and uses the locked-vocabulary names (`talent_evidence_reviewed`, `submittal_risk_acknowledged`). M0 sign-off violates its own Rule 5; doc/03 at lines 405-407 has the same drift. The OpenAPI definitions are correct. No code-level R12 violation — only doc-tier stale naming.

### R13 — *Will not compromise consent integrity for engagement velocity.*

- **C:** "*Will not compromise consent integrity for engagement velocity.*"
- **M0:** "Refusal R13 — *Will not compromise consent integrity for engagement velocity.*" ([M0:113](../milestone-signoffs/M0-refusal-signoff.md#L113)). Enforcement = **Architectural sequencing** (Plan §1.2 Consent-First System Behavior) + **future runtime checks**; substrate evidence = `libs/consent` operational; `libs/engagement` was empty at M0 closure ([M0:115-116](../milestone-signoffs/M0-refusal-signoff.md#L115-L116)).
- **Code:** Fail-closed pattern documented; no dedicated CI gate; sequencing-discipline enforcement.
- **Drift:** **No.**

---

## B. Cross-cutting findings

### B.1 Statements enforced **more strictly** than canonical text implies

| Refusal | Charter text | What code enforces beyond Charter | Source of the broader scope |
|---|---|---|---|
| **R7** | "*Will not perform automated LinkedIn scraping.*" | Prohibits `linkedin / linkedin_scrape / linkedin_bulk / generic_web_scrape` ([doc/ARAMO-CHARTER-EXTRACT.md §3b.3](../ARAMO-CHARTER-EXTRACT.md)); ripgrep gate covers any `linkedin` substring not on sealed allowlist ([scripts/verify-vocabulary.sh:36-51](../../scripts/verify-vocabulary.sh#L36-L51)); 13 R7_ALLOWLIST paths + 5 globs control all legitimate occurrences. | API Contracts v1.0 Phase 4 §3b.3 (verbatim in extract) — the `generic_web_scrape` token is Phase 4-derived, not Charter-derived. |
| **R10** | "*Will not expose internal reasoning or evaluation outputs.*" | Adds `entrustability_tier_raw` exact-match exclusion to Portal + Ingestion ([ci/scripts/verify-portal-refusal.ts:34-37](../../ci/scripts/verify-portal-refusal.ts#L34-L37), [ci/scripts/verify-ingestion-refusal.ts:40-44](../../ci/scripts/verify-ingestion-refusal.ts#L40-L44)); `evaluation_` and `rank_` prefix exclusions on Ingestion ([ci/scripts/verify-ingestion-refusal.ts:46-50](../../ci/scripts/verify-ingestion-refusal.ts#L46-L50)). | PR-M0R-2 directive §4 + PR-14 §4.1 — names not in Charter text. |
| **R8** | "*Will not allow recruiter judgment to override system classification.*" | DB BEFORE-UPDATE trigger rejects analytical-field mutation at the database layer (belt-and-suspenders beyond schema-layer `const: false`). | M3 PR-1 directive §3.2 — Charter does not prescribe DB-trigger mechanism. |

These are over-coverage, not violations; they implement Charter intent more aggressively than Charter text reads. Worth documenting as derivation from downstream specs (Phase 4, M0R-2, M3 PR-1).

### B.2 Statements enforced **less strictly** than canonical text implies (load-bearing)

| Refusal | Charter implication | What code actually enforces | Gap |
|---|---|---|---|
| **R10** | Universal: "*will not expose internal reasoning or evaluation outputs*" — no audience scope. | Catches only 2 of the 13 doc/03-listed forbidden Portal-response names by literal match. | A future Portal schema explicitly declaring `tier`/`rank`/`strengths`/`gaps`/etc. would pass `portal:refusal-check`. Manual Lead review per [doc/03-refusal-layer.md:7](../03-refusal-layer.md#L7) is load-bearing. |
| **R7** | Group 2 §2.3a explicitly permits "*Manual recruiter add is permitted as an audited exception with required attestation*" ([doc/ARAMO-CHARTER-EXTRACT.md §3a.7](../ARAMO-CHARTER-EXTRACT.md)). | No documented surface for the carve-out in the code; doc/03 omits it entirely. | A recruiter cannot use the Charter+Group2-permitted exception; the ripgrep gate would fail any literal `linkedin` outside the sealed 13-path allowlist + 5 globs. If this carve-out is needed, an attestation surface + R7_ALLOWLIST extension would have to be designed. |
| **`const: true` attestations** | doc/03 lists 7 `const` invariants ([doc/03-refusal-layer.md:401-409](../03-refusal-layer.md#L401-L409)). | CI scripts enforce 2 of them as `CONST_FALSE_INVARIANTS` (`examination_mutated`, `linkedin_automation_allowed`). The other 5 — three `const: true` attestations, `raw_payload_storage_required: const: true`, `confirmation_text: const: "DELETE MY DATA"` — are enforced only by OpenAPI validators rejecting *missing* `const`, not by a refusal-check that asserts the `const` value is the expected one. | A writer who flips `const: true` → `const: false` on `submittal_risk_acknowledged` would not trip any of the three `verify-*-refusal.ts` scripts. OpenAPI validation accepts both `const: true` and `const: false` as schema-valid. |

### B.3 Enforcement with no canonical basis

None found. Every CI exclusion (`override_*`, `recruiter_*`, `score`, `evaluation_`, `rank_`, `internal_reasoning`, `entrustability_tier_raw`, `linkedin_automation_allowed`, `examination_mutated`) traces to either Charter §8 + Group 2 §2.3a/§2.5 + Architecture §4 (immutability/computed-entrustability), or to a derivative locked spec (Phase 4, API Contracts Phase 6, M0R-2 directive, M3 PR-1, PR-14 §4).

### B.4 Canonical rules with no code-level enforcement

| Rule | Canonical text | Code state |
|---|---|---|
| **R1** | "*Will not function as a job marketplace…*" | No CI gate literally checks "no /jobs path"; enforced by absence + Lead review. |
| **R2** | "*Will not act as a sourcing engine as its primary function.*" | No CI gate literally checks "no bulk-export"; the Constrained Talent Access shape (`GET /talents/:talent_id`, `GET /jobs/:job_id/manual-add-search`) is documented but not enforced by a refusal script. |
| **R3** | "*Will not provide candidate-facing job discovery or feeds.*" | No CI gate; enforced by absence. |
| **R4** | "*Will not infer consent from behavior.*" | No dedicated CI gate; preserved by module-boundary + manual review. |
| **R11** | "*Will not optimize engagement metrics over consent integrity.*" | No dedicated CI gate; pact-locked at one refusal test (`outreach-send-consent-revoked.integration.spec.ts`). |
| **R13** | "*Will not compromise consent integrity for engagement velocity.*" | No dedicated CI gate; sequencing-discipline (consent module first) is the structural defense. |

These are not violations — they are rules whose defense is architectural (absence, sequencing, module boundary) rather than a literal CI tripwire. The risk: a sufficiently confused future PR could plausibly slip past the absence-based defenses. Lead review and substrate audits are the load-bearing checks.

---

## C. `candidate_direct → talent_direct` rename — stale-vocab audit

**Canonical state.** The May 16, 2026 vocabulary amendment (`Aramo-Vocabulary-Amendment-candidate_direct-Rename-v1_0-LOCKED.docx`) renamed the fourth `SourceType`/`AdapterType` token across all five locked specs (snake_case enum, prose form, kebab-case path, OpenAPI x-display-name, deployable name). Per amendment §4c ([doc/ARAMO-CHARTER-EXTRACT.md §4c](../ARAMO-CHARTER-EXTRACT.md)): "*the original locked text with the §1 rename applied at the enumerated occurrences*" is the canonical reading. The current canonical token is `talent_direct`.

### C.1 OneDrive locked `.docx` files — pre-rename (read-only; canonical patch is the amendment)

| File | State | Note |
|---|---|---|
| `Aramo-Charter-v1.0-LOCKED.docx` | does not directly name `candidate_direct` in §8; Charter is abstract about sources | n/a |
| `Aramo-v1-Group2-Consolidated-Baseline-v2.0-LOCKED.docx` §2.3a | pre-rename text: "*four v1 ingestion sources: Indeed, GitHub, Astre existing data, and candidate-direct intake*" ([extract §3a.1](../ARAMO-CHARTER-EXTRACT.md)) | Locked artifact; canonical patch is the amendment. |
| `Aramo-API-Contracts-v1.0-Phases-1-6-LOCKED.docx` Phase 4 | pre-rename: allowed AdapterType `candidate_direct` ([extract §3b.2](../ARAMO-CHARTER-EXTRACT.md)); endpoint group "Candidate-Direct Ingestion" with path `POST /ingestion/candidate-direct/intakes` ([extract §3b.5](../ARAMO-CHARTER-EXTRACT.md)) | Locked artifact. |
| `Aramo-Architecture-v2_0-v2_1-LOCKED.docx` §9.2 | per [doc/aramo-handoff-m5-close.md:222](../aramo-handoff-m5-close.md#L222), still names "candidate-direct" in BullMQ-job list | Per [scripts/verify-vocabulary.sh:248](../../scripts/verify-vocabulary.sh#L248) comment, "*\"candidate-direct upload\" — the Architecture-locked adapter-job nomenclature*" was the rationale for excluding this handoff doc from the Tier-2 vocab gate. |
| `Aramo-Vocabulary-Amendment-candidate_direct-Rename-v1_0-LOCKED.docx` | the amendment itself | the canonical patch |

The OneDrive `.docx` files are read-only locked artifacts; the canonical interpretation is "*locked text + amendment applied.*" The pre-rename text in the source files is not drift.

### C.2 Live repo product code — fully migrated to `talent_direct`

Verified `talent_direct` usage (zero stale `candidate_direct` in product code):

- [openapi/ingestion.yaml:37](../../openapi/ingestion.yaml#L37) — "talent_direct, indeed, github, astre_import" (SourceType enum comment)
- [openapi/ingestion.yaml:180](../../openapi/ingestion.yaml#L180) — `- talent_direct` (enum value)
- [libs/ingestion/prisma/schema.prisma:47](../../libs/ingestion/prisma/schema.prisma#L47) — "values): talent_direct | indeed | github | astre_import"
- [libs/ingestion/src/lib/dto/ingestion-payload-request.dto.ts:19](../../libs/ingestion/src/lib/dto/ingestion-payload-request.dto.ts#L19) — `'talent_direct'`
- [libs/consent/src/lib/source-consent.service.ts:97,113,116](../../libs/consent/src/lib/source-consent.service.ts#L97) — `talent_direct: [...]` consent-mapping entry + comments
- [libs/consent/src/lib/dto/source-consent-source.ts:12](../../libs/consent/src/lib/dto/source-consent-source.ts#L12) — `'talent_direct'`
- [pact/consumers/prohibited-source-type/src/prohibited-source-type.consumer.test.ts:16](../../pact/consumers/prohibited-source-type/src/prohibited-source-type.consumer.test.ts#L16) — "allowlisted set ({talent_direct, indeed, github, astre_import})"
- [pact/consumers/ingestion-consumer/src/ingestion.consumer.test.ts:64-107](../../pact/consumers/ingestion-consumer/src/ingestion.consumer.test.ts#L64-L107) — multiple `source: 'talent_direct'` fixtures
- Test specs: [libs/ingestion/src/tests/ingestion.repository.spec.ts](../../libs/ingestion/src/tests/ingestion.repository.spec.ts), [libs/ingestion/src/tests/ingestion.service.spec.ts](../../libs/ingestion/src/tests/ingestion.service.spec.ts), [libs/ingestion/src/tests/ingestion.integration.spec.ts](../../libs/ingestion/src/tests/ingestion.integration.spec.ts), [libs/consent/src/tests/source-consent.service.spec.ts](../../libs/consent/src/tests/source-consent.service.spec.ts) — all use `talent_direct`

**No stale `candidate_direct` in any product source, schema, OpenAPI, DTO, or pact test.**

### C.3 Stale `candidate-direct` text in doc tier (4 occurrences)

| File:Line | Quote | Status |
|---|---|---|
| [doc/milestone-signoffs/M0-refusal-signoff.md:81](../milestone-signoffs/M0-refusal-signoff.md#L81) | "*Re-evaluated in M2 when Indeed + GitHub + Astre Import + Candidate-Direct adapter endpoints land.*" | Stale narrative; M0 sign-off pre-dates the rename (M0 closed 2026-05-16, amendment same day). |
| [doc/milestone-signoffs/M1-refusal-signoff.md:83](../milestone-signoffs/M1-refusal-signoff.md#L83) | "*Re-evaluated in M2 when Indeed + GitHub + Astre Import + Candidate-Direct adapter endpoints land.*" | Same stale narrative as M0 sign-off. |
| [doc/aramo-handoff-m5-close.md:222](../aramo-handoff-m5-close.md#L222) | "§9.2 Adapter BullMQ jobs (5: Indeed×2 + GitHub + Astre + **candidate-direct**)" | Cites the Architecture §9.2 BullMQ-job list; if the locked Architecture v2_2 docx still has "candidate-direct," this is faithful citation, not drift. Per [scripts/verify-vocabulary.sh:248](../../scripts/verify-vocabulary.sh#L248) comment, the verbatim "candidate-direct upload" is *"the Architecture-locked adapter-job nomenclature"* — i.e., the rename has not been applied to Architecture's BullMQ-job names. |
| [scripts/verify-vocabulary.sh:248](../../scripts/verify-vocabulary.sh#L248) | (comment-only) "*\"candidate-direct upload\" — the Architecture-locked adapter-job nomenclature*" | Comment justifying the exclusion of `doc/aramo-handoff-m5-close.md` from the Tier-2 vocab gate. The `candidate-direct upload` is named as Architecture-locked vocabulary. |

**Open question for review** (not resolvable from this audit alone): whether the rename amendment was applied to the Architecture `.docx`'s §9.2 BullMQ-job-name list, or whether Architecture-locked "candidate-direct upload" survives the amendment as a job-name (distinct from the adapter type). The 4 stale-vocab references in the repo defer to Architecture's nomenclature; if Architecture has been updated, these 4 references should be too.

Past-tense closure-record references (M0 and M1 sign-offs) describe the pre-rename M0/M1 state and are appropriately historical; updating them retroactively would falsify the sign-off-time substrate evidence. They are best left alone.

---

## D. Drift summary (what to fix and where)

### Load-bearing
1. **R10 Portal exact-match list (CI gap).** Either extend `verify-portal-refusal.ts FORBIDDEN_EXACT` to include the 11 names not currently caught by literal match (`tier`, `rank`, `rank_ordinal`, `score`, `examination_id`, `why_matched_sentence`, `strengths`, `gaps`, `risk_flags`, `recruiter_notes`, `override_id`, `action_queue_item_id`, `internal_engagement_state`), OR update doc/03-refusal-layer.md and the M0 sign-off narrative to explicitly state that the structural defense is `additionalProperties: false` and the literal-name list is advisory-not-CI-enforced.

### Mild (doc-tier reconciliation)
2. **R2 doc/03 wording.** Restore the Charter qualifier "**as its** primary function" verbatim at [doc/03-refusal-layer.md:47](../03-refusal-layer.md#L47).
3. **R5 doc/03 wording.** Strike "**of sources**" at [doc/03-refusal-layer.md:114](../03-refusal-layer.md#L114); Charter has no such qualifier.
4. **R7 manual-add carve-out.** Restore Group 2 §2.3a's "*Manual recruiter add is permitted as an audited exception with required attestation*" in doc/03 R7 enforcement section, OR record in this audit that the carve-out is not implemented and a future PR would design the surface.
5. **R12 attestation field names.** Update M0-refusal-signoff.md:109 + doc/03-refusal-layer.md:405-407 to use the locked-vocabulary field names (`talent_evidence_reviewed`, `constraints_reviewed`, `submittal_risk_acknowledged`) instead of the anti-vocabulary names that violate Rule 5.

### `candidate_direct → talent_direct` rename
6. **No live product code is stale.** Live code is fully migrated.
7. **4 doc-tier stale references**, all tracing back to whether Architecture v2.x §9.2 BullMQ-job-name list was updated by the May 16 amendment. If Architecture was updated → fix the 4 doc references. If Architecture preserves "candidate-direct" as Architecture-locked job nomenclature distinct from the adapter type → leave as-is.

### `const` invariants under-instrumentation
8. **3 `const: true` attestations + `raw_payload_storage_required` + `confirmation_text`** are enforced only by OpenAPI-spec validation (a writer flipping `const: true` → `const: false` would not trip any refusal-check). Recoverable by extending `verify-ats-refusal.ts` or adding a new gate that asserts each named field's `const` value matches the spec value.

---

## E. Citation index — file:line for every code-level enforcement claim

| Refusal / invariant | Enforcement | File:Line |
|---|---|---|
| R7 ripgrep gate | `R7_ALLOWLIST` (sealed) | [scripts/verify-vocabulary.sh:36-51](../../scripts/verify-vocabulary.sh#L36-L51) |
| R7 ripgrep matcher | failure-line "ERROR (R7 — Charter Refusal)" | [scripts/verify-vocabulary.sh:294-314](../../scripts/verify-vocabulary.sh#L294-L314) |
| R7 ingestion const-false | `CONST_FALSE_INVARIANTS = ['linkedin_automation_allowed']` | [ci/scripts/verify-ingestion-refusal.ts:52-54](../../ci/scripts/verify-ingestion-refusal.ts#L52-L54) |
| R7 SourceType enum | `talent_direct, indeed, github, astre_import` | [openapi/ingestion.yaml:37](../../openapi/ingestion.yaml#L37), [openapi/ingestion.yaml:180](../../openapi/ingestion.yaml#L180) |
| R7 CI wiring | `verify-vocabulary` + `ingestion-refusal-check` jobs | [.github/workflows/ci.yml:124-131](../../.github/workflows/ci.yml#L124-L131), [.github/workflows/ci.yml:178-189](../../.github/workflows/ci.yml#L178-L189) |
| R7 deployment-gate inclusion | aggregator `needs:` | [.github/workflows/ci.yml:474](../../.github/workflows/ci.yml#L474) |
| R8 ATS const-false | `CONST_FALSE_INVARIANTS = ['examination_mutated']` | [ci/scripts/verify-ats-refusal.ts:38](../../ci/scripts/verify-ats-refusal.ts#L38) |
| R8 ATS prefix ban | `FORBIDDEN_PREFIXES = ['override_']` | [ci/scripts/verify-ats-refusal.ts:37](../../ci/scripts/verify-ats-refusal.ts#L37) |
| R8 Portal prefix ban | `override_`, `recruiter_` | [ci/scripts/verify-portal-refusal.ts:39-42](../../ci/scripts/verify-portal-refusal.ts#L39-L42) |
| R8 Ingestion prefix ban | `override_`, `evaluation_`, `rank_` | [ci/scripts/verify-ingestion-refusal.ts:46-50](../../ci/scripts/verify-ingestion-refusal.ts#L46-L50) |
| R8 ExaminationTier enum | `ENTRUSTABLE / WORTH_CONSIDERING / STRETCH` | [libs/examination/prisma/schema.prisma:55-58](../../libs/examination/prisma/schema.prisma#L55-L58) |
| R10 Portal exact-match | `internal_reasoning`, `entrustability_tier_raw` | [ci/scripts/verify-portal-refusal.ts:34-37](../../ci/scripts/verify-portal-refusal.ts#L34-L37) |
| R10 ATS exact-match | `score` | [ci/scripts/verify-ats-refusal.ts:36](../../ci/scripts/verify-ats-refusal.ts#L36) |
| R10 Ingestion exact-match | `score`, `internal_reasoning`, `entrustability_tier_raw` | [ci/scripts/verify-ingestion-refusal.ts:40-44](../../ci/scripts/verify-ingestion-refusal.ts#L40-L44) |
| Universal envelope | `additionalProperties: false` checker | [ci/scripts/verify-portal-refusal.ts:66-72](../../ci/scripts/verify-portal-refusal.ts#L66-L72), [ci/scripts/verify-ats-refusal.ts:60-65](../../ci/scripts/verify-ats-refusal.ts#L60-L65), [ci/scripts/verify-ingestion-refusal.ts:76-81](../../ci/scripts/verify-ingestion-refusal.ts#L76-L81) |
| R12 attestations | `talent_evidence_reviewed: const: true` | [openapi/common.yaml:2354-2356](../../openapi/common.yaml#L2354-L2356) |
|  | `constraints_reviewed: const: true` | [openapi/common.yaml:2360-2362](../../openapi/common.yaml#L2360-L2362) |
|  | `submittal_risk_acknowledged: const: true` | [openapi/common.yaml:2367-2369](../../openapi/common.yaml#L2367-L2369) |
| Vocabulary (Rule 5) | ESLint `no-restricted-syntax` for `candidate`, `customer`, `outreach`, `evaluation`, `submission` | [eslint.config.mjs:97-145](../../eslint.config.mjs#L97-L145) |
| Vocabulary Tier-2 | ripgrep gate, 7 terms | [scripts/verify-vocabulary.sh:260-268](../../scripts/verify-vocabulary.sh#L260-L268) |
| Refusal-check CI jobs | `portal-refusal-check`, `ats-refusal-check`, `ingestion-refusal-check` | [.github/workflows/ci.yml:152-189](../../.github/workflows/ci.yml#L152-L189) |
