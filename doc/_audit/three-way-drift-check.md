# Three-Way Drift Check — Charter §8 ↔ doc/03-refusal-layer.md ↔ Code Reality

**Audit date:** 2026-05-31
**Question:** For each refusal R1–R13 and each cross-cutting invariant, does (A) Charter §8 verbatim text, (B) `doc/03-refusal-layer.md`'s in-repo enforcement claim, and (C) what the code actually enforces tell the same story?
**Companion documents:** [charter-refusal-audit.md](charter-refusal-audit.md) (full enforcement-mapping audit) and [ARAMO-CHARTER-EXTRACT.md](../../ARAMO-CHARTER-EXTRACT.md) (Charter verbatim text).

**Legend for the divergence column:**
- ✓ — three sources tell the same story (no drift)
- ⚠ — minor divergence (vocabulary, phrasing, scope-narrowing) that does not weaken the rule but should be reconciled
- ✗ — load-bearing divergence (rule weaker in code than in Charter, or load-bearing gap)
- ⊕ — code is stricter / broader than Charter (over-coverage; not a violation, but worth knowing)

---

## A. Per-rule three-way table

### R1 — *Will not function as a job marketplace or job board.*

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not function as a job marketplace or job board.*" ([ARAMO-CHARTER-EXTRACT.md §2b](../../ARAMO-CHARTER-EXTRACT.md), Scope Refusals) |
| **B. doc/03** | "Portal API (`openapi/portal.yaml`) has no job listing, search, application, or marketplace endpoints / No `JobListing` or `JobMarketplace` schemas exist anywhere" ([doc/03-refusal-layer.md:34-36](../03-refusal-layer.md#L34-L36)) |
| **C. Code** | `openapi/portal.yaml` currently declares only `/v1/portal/profile` and `/v1/portal/consent`; no `JobListing` / `JobMarketplace` schema anywhere ([openapi/portal.yaml](../../openapi/portal.yaml)) |
| **Status** | ✓ — three sources aligned. Note: no automated gate literally tests "no jobs endpoint exists"; the rule is preserved by absence and manual Lead review per [doc/03-refusal-layer.md:7](../03-refusal-layer.md#L7). |

### R2 — *Will not act as a sourcing engine as its primary function.*

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not act as a sourcing engine as its primary function.*" (note: scope is "**as its primary function**" — the qualifier matters for the Sourcing Service ADR — see [ARAMO-SOURCING-SERVICE-ADR-DRAFT.md](ARAMO-SOURCING-SERVICE-ADR-DRAFT.md)) |
| **B. doc/03** | "ATS API has no bulk-export endpoint / ATS API has no free-form Talent search endpoint / Constrained Talent access (Group 9) limits search to specific Talent retrieval and narrow manual-add" ([doc/03-refusal-layer.md:49-52](../03-refusal-layer.md#L49-L52)). Doc/03 drops the Charter qualifier "**as its primary function**." |
| **C. Code** | `openapi/ats.yaml` currently has limited surface; no bulk export. No CI rule literally enforces "no bulk-export." Allowed shape `GET /talents/:talent_id` + `GET /jobs/:job_id/manual-add-search` is documented as the constrained Group 9 pattern. |
| **Status** | ⚠ — Charter qualifier "**as its primary function**" was dropped by doc/03. This drop materially changes what R2 prohibits: the Charter permits sourcing capability so long as it is not Aramo Core's *primary function*; doc/03's restatement reads as a blanket "no sourcing." The Sourcing Service decision (D4) relies on the Charter qualifier; doc/03 needs to be reconciled. |

### R3 — *Will not provide candidate-facing job discovery or feeds.*

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not provide candidate-facing job discovery or feeds.*" |
| **B. doc/03** | "Portal API has no recommendation, feed, or discovery endpoints / No `recommendations` or `feed` table or model exists" ([doc/03-refusal-layer.md:71-73](../03-refusal-layer.md#L71-L73)) |
| **C. Code** | `openapi/portal.yaml` has no recommendation/feed endpoints; no `recommendations`/`feed` table. |
| **Status** | ✓ — aligned by absence. |

### R4 — *Will not infer consent from behavior.*

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not infer consent from behavior.*" + Charter §4 lines 188-191: "*Consent is immutable and enforced at runtime. Consent is modeled as a ledger of events. Every action checks current consent state before execution.*" |
| **B. doc/03** | "Consent module reads only `TalentConsentEvent` ledger / No code path computes consent from behavior signals (response, click, opens)" ([doc/03-refusal-layer.md:90-92](../03-refusal-layer.md#L90-L92)) |
| **C. Code** | `libs/consent/src/lib/consent.repository.ts` reads only from `TalentConsentEvent` ledger ([doc/milestone-signoffs/M0-refusal-signoff.md:64-65](../milestone-signoffs/M0-refusal-signoff.md#L64-L65)). No CI rule literally asserts "ledger-only"; preserved by Nx module-boundary + manual review. |
| **Status** | ✓ aligned, but enforcement is advisory + module-boundary, not a dedicated gate. |

### R5 — *Will not widen consent through aggregation.*

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not widen consent through aggregation.*" (Charter says "**through aggregation**" — no qualifier.) |
| **B. doc/03** | "*Aramo will not widen consent through aggregation **of sources***" ([doc/03-refusal-layer.md:114](../03-refusal-layer.md#L114)). Doc/03 narrows the Charter rule by appending "**of sources**." |
| **C. Code** | Most-restrictive intersection semantics enforced in consent resolver (per [doc/milestone-signoffs/M0-refusal-signoff.md:69-70](../milestone-signoffs/M0-refusal-signoff.md#L69-L70)); pact-asserted at `pact/consumers/ats-thin/src/consent.consumer.test.ts:729-806`. Per-tenant per-scope state never merged. |
| **Status** | ⚠ — doc/03's appended "**of sources**" narrows the Charter. The Charter rule applies to any aggregation (sources, tenants, time windows, scopes); doc/03 reads as if cross-tenant or cross-time aggregation is permitted. Code's intersection-semantics implementation matches Charter, not the narrowed doc/03 phrasing. |

### R6 — *Will not act on stale consent for high-impact actions.*

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not act on stale consent for high-impact actions.*" (Charter does not specify the 12-month threshold; threshold is in Group 2 §2.7.) |
| **B. doc/03** | "`is_stale` field on `ConsentScopeState` computed by daily background job / Runtime consent check returns denied with `reason: stale_consent` for stale contacting consent / Twelve-month threshold from Group 2 v2.7" ([doc/03-refusal-layer.md:136-139](../03-refusal-layer.md#L136-L139)) |
| **C. Code** | Stale-consent BullMQ job + consent service applies 12-month threshold; pact-asserted at `pact/consumers/ats-thin/src/consent.consumer.test.ts:429-477` (`reason_code: 'stale_consent'`). |
| **Status** | ✓ aligned; threshold appropriately cited as Group 2-derived, not Charter-derived. |

### R7 — *Will not perform automated LinkedIn scraping.* (the strictest rule)

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not perform automated LinkedIn scraping.*" (note: Charter R7 is narrow — "automated LinkedIn scraping." Group 2 §2.3a widens it: "**LinkedIn is explicitly excluded from automated ingestion in v1 and Phase 2 … bulk or automated LinkedIn scraping is prohibited regardless of technical feasibility.**" Phase 4 widens it further with the four-layer enforcement + prohibited list `linkedin / linkedin_scrape / linkedin_bulk / generic_web_scrape`.) |
| **B. doc/03** | Four-layer enforcement summary ([doc/03-refusal-layer.md:163-167](../03-refusal-layer.md#L163-L167)): closed `SourceType` enum (4 values) + `AdapterType` `x-prohibited-values: [linkedin, linkedin_scrape, linkedin_bulk, generic_web_scrape]` + no adapter registration endpoint + `SourcePolicyResponse.linkedin_automation_allowed: const: false`. Doc/03 omits Group 2 §2.3a's "manual recruiter add is permitted as an audited exception with required attestation" carve-out. |
| **C. Code** | Tier-1 ripgrep gate ([scripts/verify-vocabulary.sh:36-51,294-314](../../scripts/verify-vocabulary.sh#L36-L51)) — sealed allowlist of 13 paths + 5 globs. Layer 4 const-false invariant ([ci/scripts/verify-ingestion-refusal.ts:52-54](../../ci/scripts/verify-ingestion-refusal.ts#L52-L54)). CI-wired at [.github/workflows/ci.yml:124-131](../../.github/workflows/ci.yml#L124-L131) (`verify-vocabulary`) and 178-189 (`ingestion-refusal-check`); both wired into `deployment-gate` aggregator. R7/PR-5 Charter-Level Review extended the allowlist for 3 enum-value provenance paths ([locked folder](../../ARAMO-CHARTER-EXTRACT.md) Section 5 — `Aramo-Charter-Review-R7-PR5-LOCKED.md`). |
| **Status** | ⊕ — code is strictly broader than Charter R7 (matches Group 2 + Phase 4 expanded scope). The four prohibited tokens `[linkedin, linkedin_scrape, linkedin_bulk, generic_web_scrape]` cover not just LinkedIn but the general-purpose `generic_web_scrape` AdapterType — Charter R7 itself does not prohibit `generic_web_scrape`; Phase 4 §3b.3 does. ⚠ also: doc/03 omits the "manual recruiter add with required attestation" carve-out from Group 2 §2.3a; a recruiter who tries to use this Charter-permitted exception will find no documented surface, which means in practice the carve-out does not exist in code. |

### R8 — *Will not allow recruiter judgment to override system classification.*

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not allow recruiter judgment to override system classification.*" + Charter §4 line 174: "***Aramo is AI-assisted, not AI-autonomous.*** The system recommends; the recruiter decides." (Note: §4 says "the recruiter **decides**" — meaning at the submittal level. R8 forbids *mutating the system classification*, not all recruiter influence.) |
| **B. doc/03** | "`TalentJobExamination.tier` is set once at creation; immutable thereafter / Override mechanism writes to separate `ExaminationOverride` entity / `ExaminationOverrideResponse.examination_mutated: const: false`" ([doc/03-refusal-layer.md:185-188](../03-refusal-layer.md#L185-L188)) |
| **C. Code** | Four-way enforcement: (a) ATS schema invariant ([ci/scripts/verify-ats-refusal.ts:38](../../ci/scripts/verify-ats-refusal.ts#L38) — `examination_mutated` must be `const: false`); (b) `override_*` prefix banned across all three refusal-check scripts ([verify-portal-refusal.ts:39-42](../../ci/scripts/verify-portal-refusal.ts#L39-L42), [verify-ats-refusal.ts:37](../../ci/scripts/verify-ats-refusal.ts#L37), [verify-ingestion-refusal.ts:46-50](../../ci/scripts/verify-ingestion-refusal.ts#L46-L50)); (c) DB BEFORE-UPDATE trigger rejects analytical-field mutation ([libs/examination/prisma/schema.prisma](../../libs/examination/prisma/schema.prisma)); (d) repository surface exposes no analytical-update method. |
| **Status** | ✓ — three sources aligned, strongest enforcement coverage of any rule. |

### R9 — *Will not permit submission of Stretch-tier candidates.*

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not permit submission of Stretch-tier candidates.*" |
| **B. doc/03** | "`POST /submittals` rejects Stretch with 422 `SUBMITTAL_STRETCH_BLOCKED` / `POST /submittals/{id}/confirm` re-checks tier" ([doc/03-refusal-layer.md:222-224](../03-refusal-layer.md#L222-L224)) |
| **C. Code** | Closed `ExaminationTier` enum (`ENTRUSTABLE / WORTH_CONSIDERING / STRETCH`) at [libs/examination/prisma/schema.prisma:55-58](../../libs/examination/prisma/schema.prisma#L55-L58). `SUBMITTAL_STRETCH_BLOCKED` error code defined and rejected at create/confirm endpoints. |
| **Status** | ✓ aligned. Note: rejection is application-logic, not a CI gate; the closed enum is the structural defense. |

### R10 — *Will not expose internal reasoning or evaluation outputs.* (most-policed rule)

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not expose internal reasoning or evaluation outputs.*" (Charter is silent on *to whom* — R10 reads as universal; the in-repo derived narrowing is "*to candidates*" — added by [doc/03-refusal-layer.md:252](../03-refusal-layer.md#L252).) |
| **B. doc/03** | Heading: "R10 — Aramo will not expose internal reasoning or evaluation outputs **to candidates**" ([doc/03-refusal-layer.md:252](../03-refusal-layer.md#L252)). Forbidden Portal-response fields (13 names): "*tier, rank, rank_ordinal, score, examination_id, why_matched_sentence, strengths, gaps, risk_flags, recruiter_notes, override_id, action_queue_item_id, internal_engagement_state*" ([doc/03-refusal-layer.md:259-265](../03-refusal-layer.md#L259-L265)). |
| **C. Code** | Portal CI exact-match list: 2 names — `internal_reasoning`, `entrustability_tier_raw` ([ci/scripts/verify-portal-refusal.ts:34-37](../../ci/scripts/verify-portal-refusal.ts#L34-L37)). Portal CI prefix list: `override_`, `recruiter_` ([verify-portal-refusal.ts:39-42](../../ci/scripts/verify-portal-refusal.ts#L39-L42)). ATS CI exact: `score` ([verify-ats-refusal.ts:36](../../ci/scripts/verify-ats-refusal.ts#L36)). Ingestion CI exact: `score`, `internal_reasoning`, `entrustability_tier_raw` ([verify-ingestion-refusal.ts:40-44](../../ci/scripts/verify-ingestion-refusal.ts#L40-L44)). Universal `additionalProperties: false` envelope on every object schema. |
| **Status** | ✗ — load-bearing scope reduction. Charter R10 is universal ("will not expose"); doc/03 narrows to "*to candidates*" — making R10 a Portal-only rule by convention. **But** the Charter text says "**internal reasoning or evaluation outputs**" with no audience scope — taken literally, R10 also forbids exposing internal reasoning to *recruiters* (i.e., raw `score`, raw `internal_reasoning`). The in-repo working interpretation is that Portal gets nothing, ATS gets reasoning-shaped surfaces (`why_matched_sentence`) but not raw scores. The CI exact-match list catches only 2 of the 13 doc/03 forbidden names on Portal; the remaining 11 (tier, rank, rank_ordinal, examination_id, why_matched_sentence, strengths, gaps, risk_flags, recruiter_notes, override_id, action_queue_item_id, internal_engagement_state) are caught structurally by `additionalProperties: false` only. **If a future PR adds `rank` as a declared Portal property, Portal CI will pass.** Manual Lead review is the load-bearing gate for those 11 names. |

### R11 — *Will not optimize engagement metrics over consent integrity.*

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not optimize engagement metrics over consent integrity.*" |
| **B. doc/03** | "All engagement-related endpoints check consent before action / No fast-path bypasses consent" ([doc/03-refusal-layer.md:307-309](../03-refusal-layer.md#L307-L309)) |
| **C. Code** | Consent precheck at `apps/api/src/tests/outreach-send-consent-revoked.integration.spec.ts` (pact-locked refusal test). No dedicated CI gate; preserved by per-endpoint pattern + Lead review. |
| **Status** | ✓ aligned; advisory + pact-asserted. |

### R12 — *Will not replace recruiter judgment with system autonomy.*

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not replace recruiter judgment with system autonomy.*" + Charter §4: "***Aramo is AI-assisted, not AI-autonomous.***" |
| **B. doc/03** | "No automated submittal path exists / `POST /submittals/{id}/confirm` requires recruiter attestations as `const: true`" ([doc/03-refusal-layer.md:328-330](../03-refusal-layer.md#L328-L330)). Doc/03 lists three attestation fields ([doc/03-refusal-layer.md:405-407](../03-refusal-layer.md#L405-L407)): `candidate_evidence_reviewed`, `constraints_reviewed`, `submission_risk_acknowledged`. |
| **C. Code** | OpenAPI declares three `const: true` attestations: `talent_evidence_reviewed` (NOT `candidate_evidence_reviewed`), `constraints_reviewed`, `submittal_risk_acknowledged` (NOT `submission_risk_acknowledged`) — [openapi/common.yaml:2354-2369](../../openapi/common.yaml#L2354-L2369). |
| **Status** | ⚠ — vocabulary divergence between doc/03 names and OpenAPI canonical names: `candidate_evidence_reviewed` → `talent_evidence_reviewed`; `submission_risk_acknowledged` → `submittal_risk_acknowledged`. OpenAPI is canonical; doc/03 uses the *anti-vocabulary* (`candidate`, `submission`) that the Rule-5 gate forbids. doc/03 is internally inconsistent: it forbids the anti-vocabulary in Rule 5 then uses it here in field names. **Doc/03 should be updated.** |

### R13 — *Will not compromise consent integrity for engagement velocity.*

| Source | Text / behavior |
|---|---|
| **A. Charter §8** | "*Will not compromise consent integrity for engagement velocity.*" |
| **B. doc/03** | "Consent check timeout returns `denied`, not `allowed-by-default` / Stale consent blocks engagement regardless of business urgency" ([doc/03-refusal-layer.md:348-350](../03-refusal-layer.md#L348-L350)) |
| **C. Code** | Fail-closed pattern documented in doc/03 anti-pattern → correct-pattern blocks; sequencing discipline puts consent module before any dependent workflow (per [M0-refusal-signoff.md:115-116](../milestone-signoffs/M0-refusal-signoff.md#L115-L116) and Plan v1.2 §1.2). No dedicated CI gate. |
| **Status** | ✓ aligned; advisory + sequencing-discipline. |

---

## B. Cross-cutting invariants

### B.1 Closed enums

| Source | Text |
|---|---|
| **A. Charter** | Not enumerated in Charter §8. Charter §4 says "Aramo's architecture enforces the decisions required to support this model" but does not list closed enums. |
| **B. doc/03** | 9 closed enums named: `ConsentScope` (5), `ContactChannel` (6), `ExaminationTier` (3), `EvidenceEntityType` (8), `SourceType` (4; LinkedIn variants explicitly prohibited), `AdapterType` (4), `AstreImportSourceChannel` (5), `RecruiterNoteVisibility` (3), `EngagementState` (10) ([doc/03-refusal-layer.md:388-396](../03-refusal-layer.md#L388-L396)). |
| **C. Code** | Most are present in Prisma schemas / OpenAPI; `ExaminationTier` confirmed at [libs/examination/prisma/schema.prisma:55-58](../../libs/examination/prisma/schema.prisma#L55-L58). |
| **Status** | ✓ for the enums present; ⚠ for the list — doc/03 doesn't say what enforces "closed enum" beyond Prisma + OpenAPI validators. Adding an enum value would be caught by Phase 4 Layer 3 + Rule 4 manual escalation, not by a dedicated CI gate. |

### B.2 `const: true` / `const: false` invariants

| Source | Text |
|---|---|
| **A. Charter** | Not in Charter §8; concept is in Charter §4 ("evaluation is immutable and auditable / entrustability is computed, not assumed"). |
| **B. doc/03** | 7 `const` invariants listed ([doc/03-refusal-layer.md:401-409](../03-refusal-layer.md#L401-L409)): three `RecruiterAttestations.*: const: true`, `examination_mutated: const: false`, `linkedin_automation_allowed: const: false`, `raw_payload_storage_required: const: true`, `confirmation_text: const: "DELETE MY DATA"`. Names use anti-vocabulary (see R12 finding). |
| **C. Code** | OpenAPI carries the canonical `const` fields with locked-vocabulary names; CI scripts enforce two of them via `CONST_FALSE_INVARIANTS` (ATS: `examination_mutated`; Ingestion: `linkedin_automation_allowed`). The other five are enforced only by OpenAPI validators rejecting non-`const` values — no dedicated CI script for the three `const: true` attestations or the two other `const` invariants. |
| **Status** | ⊕ + ⚠ — code under-instruments three of the seven listed `const` invariants (the `const: true` triple + `raw_payload_storage_required` + `confirmation_text`). OpenAPI validation catches a *missing* `const` only if a writer accidentally omits it; nothing catches a writer who deliberately flips `const: true` to `const: false`. |

### B.3 Universal `additionalProperties: false`

| Source | Text |
|---|---|
| **A. Charter** | Not in §8; concept implied by §4 "Declared, ingested, and derived data are separated / This preserves provenance and enables auditability." |
| **B. doc/03** | "**Every object schema in every OpenAPI file uses `additionalProperties: false`.**" ([doc/03-refusal-layer.md:415](../03-refusal-layer.md#L415)) |
| **C. Code** | All three refusal-check scripts walk schemas and flag any object lacking `additionalProperties: false`. |
| **Status** | ✓ — fully enforced. The strongest cross-cutting CI rule in the program. |

---

## C. Summary table of divergences

| ID | Severity | Description | Recommended action |
|---|---|---|---|
| **R2** | ⚠ | doc/03 drops Charter qualifier "**as its primary function**" | Update doc/03 R2 heading to include "as primary function" verbatim; relevant to Sourcing Service ADR |
| **R5** | ⚠ | doc/03 appends "**of sources**" not in Charter | Strike "of sources" from doc/03 R5 heading; rule applies to all aggregation kinds |
| **R7** | ⊕ + ⚠ | Code is broader than Charter R7 (prohibits `generic_web_scrape`); doc/03 omits Group 2's manual-add carve-out | Document the over-coverage as derivation from Group 2 + Phase 4; restore the manual-add-with-attestation carve-out in doc/03 |
| **R10** | ✗ | Charter R10 is universal; doc/03 narrows to "to candidates"; CI catches only 2 of 13 forbidden Portal-response field names by literal name | Add the 11 missing names to `verify-portal-refusal.ts FORBIDDEN_EXACT` if Portal must catch them by literal name; OR rely on `additionalProperties: false` + manual review and update doc/03 to make that explicit |
| **R12** | ⚠ | doc/03 uses anti-vocabulary (`candidate_evidence_reviewed`, `submission_risk_acknowledged`) for `const: true` field names; OpenAPI uses locked vocabulary (`talent_evidence_reviewed`, `submittal_risk_acknowledged`) | Update doc/03 field names to match OpenAPI canonical |
| **B.2** | ⚠ | 3 of 7 `const` invariants (the `const: true` attestation triple, `raw_payload_storage_required`, `confirmation_text`) have no dedicated CI enforcement — only OpenAPI validation against the spec itself | Extend `verify-ats-refusal.ts` or add a new gate to assert `const` values match the locked spec literally |

**No load-bearing failures of automated enforcement against rules with a CI gate.** The two structural gaps are: (1) R10's Portal forbidden-field list is mostly defended by envelope-closure not name-matching; (2) the three `const: true` attestations rely on OpenAPI validation against the spec rather than a refusal-check assertion. Both are recoverable by extending existing CI scripts.

**No Charter rule is silently weakened in code.** Where code is narrower (R10 audience scope, R2 dropped qualifier, R5 appended scope), the narrowing is in doc/03 (a derivative); the Charter text remains canonical and authoritative.

---

## D. What this drift check is NOT

- It does not audit every rule end-to-end; it spot-checks the three-way alignment on each refusal and the three cross-cutting invariants. The full enforcement-mapping table is in [charter-refusal-audit.md](charter-refusal-audit.md).
- It does not include Group 2 §2.3a or Phase 4 in the "A" column — those are derivative-of-Charter specs that *expand* refusals. They are quoted where they materially affect a rule's scope (R6 threshold, R7 four-layer enforcement, R10 ATS extension, R12 attestations).
- It does not propose Charter amendments. The doc/03 reconciliations recommended in the "Action" column are documentation updates only — they restore Charter-faithful text to a derivative doc.
