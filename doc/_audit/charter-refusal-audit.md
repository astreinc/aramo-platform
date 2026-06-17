# Charter Refusal Layer & Vocabulary Discipline — Audit

Audit date: 2026-05-31. Scope: narrow governance audit of (1) Refusal Layer R1–R13 and (2) locked / restricted vocabulary discipline. Verbatim quotes only; analysis is segregated to Section E.

---

## Provenance note (read first)

The **canonical** text of the thirteen Charter Refusals (R1–R13) lives in
`Aramo-Charter-v1.0-LOCKED.docx §8`, which is **not in the project working
tree** — it sits in OneDrive at the locked-directives folder. The in-repo
docs are derivative:

- The fullest in-repo enforcement-bearing text of each rule is in
  [doc/03-refusal-layer.md](../03-refusal-layer.md). The header at
  [doc/03-refusal-layer.md:26-28](../03-refusal-layer.md#L26-L28) reads
  "**The Thirteen Charter Refusals … From Charter Section 8. Each refusal
  is paired with its enforcement mechanism in this codebase.**" — i.e.
  this file paraphrases the Charter into rule names and pairs each with
  code-level enforcement.
- The closest in-repo *verbatim* italicized one-line statements of R1–R13
  are in the milestone sign-off
  [doc/milestone-signoffs/M0-refusal-signoff.md:44-117](../milestone-signoffs/M0-refusal-signoff.md#L44-L117),
  which states at lines 33-37:
  > "The 13 Charter v1.0 refusal commitments are enumerated below. Refusal
  > text quoted verbatim from `Aramo-Charter-v1.0-LOCKED.docx §8` (canonical
  > OneDrive location). Refusal numbering follows the program's R1–R13
  > linear convention (Charter §8 grouping: Scope R1–R3, Behavior R4–R10,
  > Posture R11–R13)."

For each rule below this audit quotes (a) the M0 sign-off's verbatim
italicized form (the closest-to-Charter text inside the repo), and (b)
the `doc/03-refusal-layer.md` rule heading + enforcement block (the
authoritative in-repo enforcement mapping). Direct citation of the
Charter docx itself is out of scope — the file is not in the working tree.

---

## Section A — Refusal Layer R1–R13

### R1 — Scope refusal

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:44](../milestone-signoffs/M0-refusal-signoff.md#L44)):**

> "### Refusal R1 — *Will not function as a job marketplace or job board.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:32](../03-refusal-layer.md#L32)):**

> "#### R1 — Aramo will not function as a job marketplace or job board"

**Enforcement ([doc/03-refusal-layer.md:34-36](../03-refusal-layer.md#L34-L36)):**

> "**Enforcement:**
> - Portal API (`openapi/portal.yaml`) has no job listing, search, application, or marketplace endpoints
> - No `JobListing` or `JobMarketplace` schemas exist anywhere"

Anti-pattern declared at [doc/03-refusal-layer.md:38-43](../03-refusal-layer.md#L38-L43); escalation rule at [doc/03-refusal-layer.md:45](../03-refusal-layer.md#L45) ("**If asked to add this:** Refuse and escalate. This is a Charter-level commitment.").

**Mechanism class:** API absence + schema absence. **Automation:** advisory (no CI gate literally checks "no /jobs path"); the rule is preserved by the fact that no code adds these endpoints, which is reviewed manually by Lead Engineer per [doc/03-refusal-layer.md:7](../03-refusal-layer.md#L7) ("**Hard rule:** If a PR touches a refusal surface, the prompt MUST reference this document, and the Lead Engineer MUST verify refusal preservation before merge.").

---

### R2 — Scope refusal

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:50](../milestone-signoffs/M0-refusal-signoff.md#L50)):**

> "### Refusal R2 — *Will not act as a sourcing engine as its primary function.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:47](../03-refusal-layer.md#L47)):**

> "#### R2 — Aramo will not act as a sourcing engine as primary function"

**Enforcement ([doc/03-refusal-layer.md:49-52](../03-refusal-layer.md#L49-L52)):**

> "**Enforcement:**
> - ATS API has no bulk-export endpoint
> - ATS API has no free-form Talent search endpoint
> - Constrained Talent access (Group 9) limits search to specific Talent retrieval and narrow manual-add"

Anti-patterns + allowed patterns at [doc/03-refusal-layer.md:54-67](../03-refusal-layer.md#L54-L67) (forbidden: `/talents` free search and `/talents/export`; allowed: `/talents/:talent_id` and `/jobs/:job_id/manual-add-search`).

**Mechanism class:** API absence (specific allowed shape stated). **Automation:** advisory (manual Lead review + the rule that future endpoints must pass `ats:refusal-check` which would block `score`/`override_*` leaks but does not directly assert "no bulk export").

---

### R3 — Scope refusal

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:56](../milestone-signoffs/M0-refusal-signoff.md#L56)):**

> "### Refusal R3 — *Will not provide candidate-facing job discovery or feeds.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:69](../03-refusal-layer.md#L69)):**

> "#### R3 — Aramo will not provide candidate-facing job discovery or feeds"

**Enforcement ([doc/03-refusal-layer.md:71-73](../03-refusal-layer.md#L71-L73)):**

> "**Enforcement:**
> - Portal API has no recommendation, feed, or discovery endpoints
> - No `recommendations` or `feed` table or model exists"

Forbidden anti-patterns at [doc/03-refusal-layer.md:75-82](../03-refusal-layer.md#L75-L82) (`/portal/recommendations`, `/portal/feed`).

**Mechanism class:** API absence + table/model absence. **Automation:** advisory; Portal surface itself is currently `paths: {}`-stubbed (per [doc/milestone-signoffs/M0-refusal-signoff.md:58-59](../milestone-signoffs/M0-refusal-signoff.md#L58-L59)).

---

### R4 — Behavior refusal

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:62](../milestone-signoffs/M0-refusal-signoff.md#L62)):**

> "### Refusal R4 — *Will not infer consent from behavior.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:88](../03-refusal-layer.md#L88)):**

> "#### R4 — Aramo will not infer consent from behavior"

**Enforcement ([doc/03-refusal-layer.md:90-92](../03-refusal-layer.md#L90-L92)):**

> "**Enforcement:**
> - Consent module reads only `TalentConsentEvent` ledger
> - No code path computes consent from behavior signals (response, click, opens)"

Concrete code-path enforcement per M0 sign-off ([doc/milestone-signoffs/M0-refusal-signoff.md:64-65](../milestone-signoffs/M0-refusal-signoff.md#L64-L65)): `libs/consent/src/lib/consent.repository.ts` reads exclusively from the `TalentConsentEvent` append-only ledger; `grep -rEn "behavior|infer|implicit" libs/consent/src/lib/` "returns zero matches against consent-resolution code."

**Mechanism class:** code-path constraint (ledger-only reads). **Automation:** advisory (no CI rule literally asserts ledger-only reads); Nx module-boundary rule prevents consent computation outside the Consent module ([doc/milestone-signoffs/M0-refusal-signoff.md:65](../milestone-signoffs/M0-refusal-signoff.md#L65)).

---

### R5 — Behavior refusal

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:67](../milestone-signoffs/M0-refusal-signoff.md#L67)):**

> "### Refusal R5 — *Will not widen consent through aggregation.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:114](../03-refusal-layer.md#L114)):**

> "#### R5 — Aramo will not widen consent through aggregation of sources"

**Enforcement ([doc/03-refusal-layer.md:116-118](../03-refusal-layer.md#L116-L118)):**

> "**Enforcement:**
> - Consent resolver applies *most restrictive applicable consent* across sources
> - Per-tenant per-scope state is stored separately; never merged into a global view"

The counterintuitive ALL-not-ANY case (anti-pattern uses `sources.some(...)`; correct uses `sources.every(...)`) at [doc/03-refusal-layer.md:120-132](../03-refusal-layer.md#L120-L132). Pact-test substrate evidence at [doc/milestone-signoffs/M0-refusal-signoff.md:70](../milestone-signoffs/M0-refusal-signoff.md#L70) (`pact/consumers/ats-thin/src/consent.consumer.test.ts:729-806`).

**Mechanism class:** code-path constraint (intersection semantics) + contract (per-tenant per-scope shape). **Automation:** advisory (pact-tested but no dedicated CI gate asserts "no union aggregation").

---

### R6 — Behavior refusal

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:72](../milestone-signoffs/M0-refusal-signoff.md#L72)):**

> "### Refusal R6 — *Will not act on stale consent for high-impact actions.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:134](../03-refusal-layer.md#L134)):**

> "#### R6 — Aramo will not act on stale consent for high-impact actions"

**Enforcement ([doc/03-refusal-layer.md:136-139](../03-refusal-layer.md#L136-L139)):**

> "**Enforcement:**
> - `is_stale` field on `ConsentScopeState` computed by daily background job
> - Runtime consent check returns denied with `reason: stale_consent` for stale contacting consent
> - Twelve-month threshold from Group 2 v2.7"

Pact evidence at [doc/milestone-signoffs/M0-refusal-signoff.md:75](../milestone-signoffs/M0-refusal-signoff.md#L75) (`pact/consumers/ats-thin/src/consent.consumer.test.ts:429-477` — `reason_code: 'stale_consent'`).

**Mechanism class:** runtime check + scheduled job. **Automation:** advisory + pact-asserted (the staleness denial shape is locked into the pact contract).

---

### R7 — Behavior refusal — the strictest enforced rule in the repo

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:77](../milestone-signoffs/M0-refusal-signoff.md#L77)):**

> "### Refusal R7 — *Will not perform automated LinkedIn scraping.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:161](../03-refusal-layer.md#L161)):**

> "#### R7 — Aramo will not perform automated LinkedIn scraping"

**Enforcement (four-layer, [doc/03-refusal-layer.md:163-167](../03-refusal-layer.md#L163-L167)):**

> "**Enforcement (four-layer):**
> 1. `SourceType` enum closed to four values (`indeed`, `github`, `astre_import`, `talent_direct`)
> 2. `AdapterType` enum same; `x-prohibited-values: [linkedin, linkedin_scrape, linkedin_bulk, generic_web_scrape]` documented
> 3. No adapter registration endpoint exists
> 4. `SourcePolicyResponse.linkedin_automation_allowed: const: false`"

**Charter-level escalation ([doc/03-refusal-layer.md:181](../03-refusal-layer.md#L181)):**

> "**This is a Charter-level commitment.** Adding LinkedIn is outside Architect or Lead authority. It requires Charter-level approval per Section 8."

**Concrete enforcement code:**

1. Repo-wide ripgrep gate: [scripts/verify-vocabulary.sh:36-51](../../scripts/verify-vocabulary.sh#L36-L51) (`R7_ALLOWLIST`, sealed) + [scripts/verify-vocabulary.sh:294-314](../../scripts/verify-vocabulary.sh#L294-L314) (the matcher) — "ERROR (R7 — Charter Refusal): 'linkedin' found at non-allowlisted location(s):". Allowlist addition rule at [scripts/verify-vocabulary.sh:309-312](../../scripts/verify-vocabulary.sh#L309-L312): "*Per Charter Refusal R7, 'linkedin' may appear only at allowlisted paths. If the path is legitimate, add it to R7_ALLOWLIST in this script with an explicit per-entry comment, AND escalate to Architect (Charter-level review).*"
2. Layer-4 schema invariant: [ci/scripts/verify-ingestion-refusal.ts:52-54](../../ci/scripts/verify-ingestion-refusal.ts#L52-L54) — `CONST_FALSE_INVARIANTS = ['linkedin_automation_allowed']`; enforced at [ci/scripts/verify-ingestion-refusal.ts:88-102](../../ci/scripts/verify-ingestion-refusal.ts#L88-L102) ("Phase 4 R7 Layer 4 invariant: when this name appears, its schema must pin const: false (any other shape weakens the refusal)").
3. CI wiring: [.github/workflows/ci.yml:124-131](../../.github/workflows/ci.yml#L124-L131) (`verify-vocabulary` job — `bash scripts/verify-vocabulary.sh`) and [.github/workflows/ci.yml:178-189](../../.github/workflows/ci.yml#L178-L189) (`ingestion-refusal-check`).

**Mechanism class:** four-layer (closed enum, prohibited-values annotation, endpoint absence, `const: false` invariant) — the most layered rule in the program. **Automation:** **fully automated** — `verify-vocabulary` and `ingestion-refusal-check` both block CI; both are wired into the `deployment-gate` aggregator at [.github/workflows/ci.yml:474](../../.github/workflows/ci.yml#L474).

---

### R8 — Behavior refusal

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:83](../milestone-signoffs/M0-refusal-signoff.md#L83)):**

> "### Refusal R8 — *Will not allow recruiter judgment to override system classification.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:183](../03-refusal-layer.md#L183)):**

> "#### R8 — Aramo will not allow recruiter judgment to override system classification"

**Enforcement ([doc/03-refusal-layer.md:185-188](../03-refusal-layer.md#L185-L188)):**

> "**Enforcement:**
> - `TalentJobExamination.tier` is set once at creation; immutable thereafter
> - Override mechanism writes to separate `ExaminationOverride` entity
> - `ExaminationOverrideResponse.examination_mutated: const: false`"

**Concrete enforcement code:**

- ATS schema invariant: [ci/scripts/verify-ats-refusal.ts:37-38](../../ci/scripts/verify-ats-refusal.ts#L37-L38) — `FORBIDDEN_PREFIXES: ['override_']`; `CONST_FALSE_INVARIANTS: ['examination_mutated']`. Enforced at [ci/scripts/verify-ats-refusal.ts:72-86](../../ci/scripts/verify-ats-refusal.ts#L72-L86): "*Phase 6 invariant: when this name appears, its schema must pin const: false (any other shape is a tier-mutation surface).*"
- Ingestion mirrors the same `override_*` prefix block: [ci/scripts/verify-ingestion-refusal.ts:46-50](../../ci/scripts/verify-ingestion-refusal.ts#L46-L50).
- Portal mirrors the same `override_*` prefix block: [ci/scripts/verify-portal-refusal.ts:39-42](../../ci/scripts/verify-portal-refusal.ts#L39-L42) ("override_*  (Charter R8 — no recruiter-judgment overrides of system classification, surfaced to talent)").
- DB-layer enforcement: per [libs/examination/prisma/generated/client/index.js:207](../../libs/examination/prisma/generated/client/index.js#L207) (Prisma inlineSchema mirror of [libs/examination/prisma/schema.prisma](../../libs/examination/prisma/schema.prisma)): "*Immutability of the analytical content is enforced at the database layer by a column-scoped BEFORE UPDATE trigger added in the same migration*" and "*WRITE-ISOLATION CONTRACT: an override write MUST NEVER mutate the referenced TalentJobExamination row.*"

**Mechanism class:** schema invariant (`const: false`) + prefix ban + DB-trigger immutability + repository surface omission. **Automation:** **fully automated** across all three refusal-check scripts; blocks CI via `portal-refusal-check`, `ats-refusal-check`, and `ingestion-refusal-check`.

---

### R9 — Behavior refusal

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:89](../milestone-signoffs/M0-refusal-signoff.md#L89)):**

> "### Refusal R9 — *Will not permit submission of Stretch-tier candidates.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:220](../03-refusal-layer.md#L220)):**

> "#### R9 — Aramo will not permit submission of Stretch-tier candidates"

**Enforcement ([doc/03-refusal-layer.md:222-224](../03-refusal-layer.md#L222-L224)):**

> "**Enforcement:**
> - `POST /submittals` rejects Stretch with 422 `SUBMITTAL_STRETCH_BLOCKED`
> - `POST /submittals/{id}/confirm` re-checks tier (Examination could in theory have changed; rare but possible)"

The closed `ExaminationTier` enum (`ENTRUSTABLE | WORTH_CONSIDERING | STRETCH`) is declared at [libs/examination/prisma/schema.prisma:55-58](../../libs/examination/prisma/schema.prisma#L55-L58).

**Mechanism class:** runtime error-code rejection (`SUBMITTAL_STRETCH_BLOCKED`) + closed enum on tier. **Automation:** error-code rejection is application-logic, not a CI gate; the closed enum is enforced by Prisma + `lint-nx-boundaries`. M0 sign-off notes ([doc/milestone-signoffs/M0-refusal-signoff.md:92](../milestone-signoffs/M0-refusal-signoff.md#L92)) "*the code path doesn't exist yet because the endpoint doesn't exist*" — re-evaluated at M4.

---

### R10 — Behavior refusal — the most heavily CI-policed rule

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:95](../milestone-signoffs/M0-refusal-signoff.md#L95)):**

> "### Refusal R10 — *Will not expose internal reasoning or evaluation outputs.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:252](../03-refusal-layer.md#L252)):**

> "#### R10 — Aramo will not expose internal reasoning or evaluation outputs to candidates"

**Enforcement ([doc/03-refusal-layer.md:254-257](../03-refusal-layer.md#L254-L257)):**

> "**Enforcement:**
> - `openapi/portal.yaml` schemas use `additionalProperties: false`
> - Portal response schemas have explicit `x-forbidden-fields` enumeration
> - `verify-portal-refusal.ts` CI script fails build on any forbidden field presence"

**Forbidden Portal-response fields (verbatim, [doc/03-refusal-layer.md:259-265](../03-refusal-layer.md#L259-L265)):**

> "tier, rank, rank_ordinal, score, examination_id,
> why_matched_sentence, strengths, gaps, risk_flags,
> recruiter_notes, override_id, action_queue_item_id,
> internal_engagement_state"

**Concrete enforcement code (Portal):** [ci/scripts/verify-portal-refusal.ts:34-42](../../ci/scripts/verify-portal-refusal.ts#L34-L42):

> "export const FORBIDDEN_EXACT: ReadonlyArray<string> = [
>   'internal_reasoning',
>   'entrustability_tier_raw',
> ];
>
> export const FORBIDDEN_PREFIXES: ReadonlyArray<string> = [
>   'override_',
>   'recruiter_',
> ];"

Note divergence: the Portal CI script's *exact*-match list contains only `internal_reasoning` and `entrustability_tier_raw`; the doc's 13-item field list (tier, rank, score, …) is enforced only when those names are *referenced* in Portal schemas — `score` is caught by the *ATS* refusal-check ([ci/scripts/verify-ats-refusal.ts:36](../../ci/scripts/verify-ats-refusal.ts#L36): `FORBIDDEN_EXACT = ['score']`) and *Ingestion* refusal-check ([ci/scripts/verify-ingestion-refusal.ts:40-44](../../ci/scripts/verify-ingestion-refusal.ts#L40-L44): `FORBIDDEN_EXACT = ['score', 'internal_reasoning', 'entrustability_tier_raw']`); the other 11 names in the doc list (tier, rank, rank_ordinal, examination_id, why_matched_sentence, strengths, gaps, risk_flags, recruiter_notes, override_id, action_queue_item_id, internal_engagement_state) are **not enforced as exact-match exclusions by name** in any of the three CI scripts. They are caught structurally by (a) `additionalProperties: false` (an undeclared field cannot leak) and (b) Portal schemas not declaring them as properties. The strict `recruiter_*` and `override_*` prefix bans plus the closed-envelope discipline prevent the structural anti-pattern, but the *literal property names* "tier"/"rank"/"strengths"/"gaps" would not trip the CI gate if a future PR added them as explicit Portal properties.

Deliberate-failure evidence at [doc/milestone-signoffs/M0-refusal-signoff.md:98](../milestone-signoffs/M0-refusal-signoff.md#L98): commit `51d1ae0` injected `internal_reasoning` into `openapi/portal.yaml`; CI failed `portal:refusal-check`; drift then reverted (M0R-2 v2, commit `3c1b9fd`).

**Mechanism class:** schema-walker CI script (exact + prefix + `additionalProperties: false`). **Automation:** **fully automated** — `portal-refusal-check`, `ats-refusal-check`, `ingestion-refusal-check` are all CI-blocking and wired into `deployment-gate` at [.github/workflows/ci.yml:472-474](../../.github/workflows/ci.yml#L472-L474).

---

### R11 — Posture refusal

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:101](../milestone-signoffs/M0-refusal-signoff.md#L101)):**

> "### Refusal R11 — *Will not optimize engagement metrics over consent integrity.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:305](../03-refusal-layer.md#L305)):**

> "#### R11 — Aramo will not optimize engagement metrics over consent integrity"

**Enforcement ([doc/03-refusal-layer.md:307-309](../03-refusal-layer.md#L307-L309)):**

> "**Enforcement:**
> - All engagement-related endpoints check consent before action
> - No fast-path bypasses consent"

Correct pattern stated as ([doc/03-refusal-layer.md:324](../03-refusal-layer.md#L324)): "**Correct pattern:** Consent check happens unconditionally, before any send."

**Mechanism class:** code-path pattern (mandatory consent precheck). **Automation:** advisory + pact-tested. There is no CI rule named "no fast-path send" — the rule is enforced by manual Lead review per [doc/03-refusal-layer.md:7](../03-refusal-layer.md#L7), and by the pact-locked consent-revoked refusal test at `apps/api/src/tests/outreach-send-consent-revoked.integration.spec.ts` (referenced in [scripts/verify-vocabulary.sh:206](../../scripts/verify-vocabulary.sh#L206)).

---

### R12 — Posture refusal

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:107](../milestone-signoffs/M0-refusal-signoff.md#L107)):**

> "### Refusal R12 — *Will not replace recruiter judgment with system autonomy.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:326](../03-refusal-layer.md#L326)):**

> "#### R12 — Aramo will not replace recruiter judgment with system autonomy"

**Enforcement ([doc/03-refusal-layer.md:328-330](../03-refusal-layer.md#L328-L330)):**

> "**Enforcement:**
> - No automated submittal path exists
> - `POST /submittals/{id}/confirm` requires recruiter attestations as `const: true`"

Closing line at [doc/03-refusal-layer.md:344](../03-refusal-layer.md#L344): "**This pattern must not exist.** Submission requires explicit recruiter action."

**Concrete enforcement code:** the three attestation fields on `RecruiterAttestations` are declared `const: true` in `openapi/common.yaml`:

- [openapi/common.yaml:2354-2356](../../openapi/common.yaml#L2354-L2356) — `talent_evidence_reviewed: const: true`
- [openapi/common.yaml:2360-2362](../../openapi/common.yaml#L2360-L2362) — `constraints_reviewed: const: true` (*"Recruiter affirms the §2.5 entrustability constraints (location, work mode, rate, work authorization) were reviewed against the requisition."*)
- [openapi/common.yaml:2367-2369](../../openapi/common.yaml#L2367-L2369) — `submittal_risk_acknowledged: const: true`

Note: there is a minor naming divergence: [doc/03-refusal-layer.md:405-407](../03-refusal-layer.md#L405-L407) lists the third attestation as `submission_risk_acknowledged`; the actual OpenAPI field is `submittal_risk_acknowledged` (the locked vocabulary uses "submittal"). The OpenAPI is canonical.

**Mechanism class:** schema invariant (`const: true` triple-attestation) + endpoint absence. **Automation:** semi-automated — OpenAPI validators reject any `const: true` violation at the contract layer; the "no automated submittal path" leg is advisory.

---

### R13 — Posture refusal

**Verbatim (M0 sign-off, [doc/milestone-signoffs/M0-refusal-signoff.md:113](../milestone-signoffs/M0-refusal-signoff.md#L113)):**

> "### Refusal R13 — *Will not compromise consent integrity for engagement velocity.*"

**Authoritative in-repo heading ([doc/03-refusal-layer.md:346](../03-refusal-layer.md#L346)):**

> "#### R13 — Aramo will not compromise consent integrity for engagement velocity"

**Enforcement ([doc/03-refusal-layer.md:348-350](../03-refusal-layer.md#L348-L350)):**

> "**Enforcement:**
> - Consent check timeout returns `denied`, not `allowed-by-default`
> - Stale consent blocks engagement regardless of business urgency"

Correct fail-safe pattern at [doc/03-refusal-layer.md:365-378](../03-refusal-layer.md#L365-L378) (denied with `reason_code: 'consent_state_unknown'`).

**Mechanism class:** runtime fail-safe pattern (fail-closed on timeout/error). **Automation:** advisory + sequencing-discipline (consent module sequenced before any dependent workflow per [doc/milestone-signoffs/M0-refusal-signoff.md:115-116](../milestone-signoffs/M0-refusal-signoff.md#L115-L116) and Plan v1.2 §1.2).

---

### Cross-cutting universal patterns ([doc/03-refusal-layer.md:382-417](../03-refusal-layer.md#L382-L417))

**Closed enums ([doc/03-refusal-layer.md:388-396](../03-refusal-layer.md#L388-L396)):**

> "- `ConsentScope` (5 values)
> - `ContactChannel` (6 values)
> - `ExaminationTier` (3 values)
> - `EvidenceEntityType` (8 values)
> - `SourceType` (4 values; LinkedIn variants are explicitly prohibited)
> - `AdapterType` (4 values)
> - `AstreImportSourceChannel` (5 values)
> - `RecruiterNoteVisibility` (3 values)
> - `EngagementState` (10 values per state machine)"

**`const` non-negotiables ([doc/03-refusal-layer.md:401-409](../03-refusal-layer.md#L401-L409)):**

> "- `RecruiterAttestations.candidate_evidence_reviewed: const: true`
> - `RecruiterAttestations.constraints_reviewed: const: true`
> - `RecruiterAttestations.submission_risk_acknowledged: const: true`
> - `ExaminationOverrideResponse.examination_mutated: const: false`
> - `SourcePolicyResponse.linkedin_automation_allowed: const: false`
> - `SourcePolicyResponse.raw_payload_storage_required: const: true`
> - `PortalRtbfConfirmRequest.confirmation_text: const: \"DELETE MY DATA\"`"

(Note again: doc says `candidate_evidence_reviewed`; OpenAPI uses `talent_evidence_reviewed` per [openapi/common.yaml:2354](../../openapi/common.yaml#L2354) — "candidate" is the anti-vocabulary; OpenAPI is canonical.)

**Universal envelope ([doc/03-refusal-layer.md:415](../03-refusal-layer.md#L415)):**

> "Every object schema in every OpenAPI file uses `additionalProperties: false`."

---

## Section B — Locked / restricted vocabulary

### B.1 The locked vocabulary table (canonical)

**Source — [doc/02-claude-code-discipline.md:54-69](../02-claude-code-discipline.md#L54-L69) Rule 5 — Vocabulary discipline:**

> "Use Aramo-locked vocabulary exclusively:
>
> | Use | Not |
> |---|---|
> | Talent | Candidate |
> | `talent_id` | `candidate_id` |
> | Engagement | Outreach (when referring to entity) |
> | Examination | Evaluation |
> | Submittal | Submission |
> | Tenant | Customer / Account / Org |
> | Entrustable / Worth Considering / Stretch | High / Medium / Low |
> | Recruiter | User (when referring to recruiter specifically) |
>
> **Anti-pattern:** Using \"candidate\" because it's familiar. Other systems use \"candidate.\" Aramo uses \"Talent.\""

### B.2 ESLint enforcement of vocabulary (Tier-2, identifier + literal scan)

**Source — [eslint.config.mjs:97-147](../../eslint.config.mjs#L97-L147), scoped to `apps/**` and `libs/**` only:**

Six pairs of `no-restricted-syntax` rules, each pair scanning identifiers and string literals (case-insensitive regex):

- [eslint.config.mjs:105-112](../../eslint.config.mjs#L105-L112) — `candidate`:
  > "selector: \"Identifier[name=/candidate/i]\", message: \"Use 'talent' (not 'candidate') — see doc/02-claude-code-discipline.md Rule 5.\""
  > "selector: \"Literal[value=/candidate/i]\", message: \"Use 'talent' (not 'candidate') in string literals — see doc/02-claude-code-discipline.md Rule 5.\""

- [eslint.config.mjs:113-120](../../eslint.config.mjs#L113-L120) — `customer`:
  > "Use 'tenant' (not 'customer')"

- [eslint.config.mjs:121-128](../../eslint.config.mjs#L121-L128) — `outreach`:
  > "Use 'engagement' (not 'outreach' as entity name)"

- [eslint.config.mjs:129-136](../../eslint.config.mjs#L129-L136) — `evaluation`:
  > "Use 'examination' (not 'evaluation' as entity name)"

- [eslint.config.mjs:137-144](../../eslint.config.mjs#L137-L144) — `submission`:
  > "Use 'submittal' (not 'submission' as entity name)"

Note that the header comment at [eslint.config.mjs:1-11](../../eslint.config.mjs#L1-L11) explicitly states:

> "`linkedin` deliberately does not appear in this file; it lives only in scripts/verify-vocabulary.sh and doc/03-refusal-layer.md (per R7)."

And the table-only items not enforced by ESLint: `Account / Org` (no rule), `High / Medium / Low` (no rule — too generic to flag at AST level), `User` (no rule — too generic).

### B.3 Ripgrep enforcement of vocabulary (Tier-2, repo-wide except excluded paths)

**Source — [scripts/verify-vocabulary.sh:260-268](../../scripts/verify-vocabulary.sh#L260-L268):**

> "TIER2_TERMS_REGEX=(
>   \"candidate:candidate\"
>   \"customer:customer\"
>   \"outreach:outreach\"
>   \"evaluation:evaluation\"
>   \"submission:submission\"
>   \"score:\\bscore\\b\"
>   \"rank:\\brank\\b\"
> )"

(`candidate`, `customer`, `outreach`, `evaluation`, `submission` are substring matches; `score` and `rank` are word-boundary matches.) The remediation message at [scripts/verify-vocabulary.sh:335-339](../../scripts/verify-vocabulary.sh#L335-L339):

> "Use locked Aramo vocabulary per doc/02-claude-code-discipline.md Rule 5:
>   candidate -> talent ; customer -> tenant ; outreach -> engagement
>   evaluation -> examination ; submission -> submittal
>   score / rank -> forbidden as Portal fields (R10)"

### B.4 Divergence between ESLint, ripgrep, and the doc table

| Term | doc/02 Rule 5 table | ESLint rule | ripgrep Tier-2 | Notes |
|---|---|---|---|---|
| `candidate` | banned | yes (id + literal) | yes (substring) | both gates |
| `customer` | banned | yes | yes | both gates |
| `outreach` | banned (as entity) | yes | yes | many per-PR exemptions for the canonical `outreach_sent` event |
| `evaluation` | banned (as entity) | yes | yes | both gates |
| `submission` | banned (as entity) | yes | yes | both gates |
| `score` | **not in Rule 5 table** | **no** | yes (`\bscore\b`) | added by R10 — discrepancy: doc 02 doesn't list it, doc 03 / ripgrep do |
| `rank` | **not in Rule 5 table** | **no** | yes (`\brank\b`) | same as above |
| Account / Org | banned (as customer-aliases) | no | no | **gap — listed in Rule 5 but unenforced** |
| High / Medium / Low (tier labels) | banned | no | no | **gap — too generic to enforce at AST/grep level** |
| User (recruiter-aliasing) | banned in that context | no | no | **gap — too generic to flag automatically** |
| `linkedin` | (governed by R7, not Rule 5) | deliberately absent | yes (Tier-1 sealed allowlist) | strictest gate in the program |

### B.5 Tier-1 R7 LinkedIn gate — the only sealed-allowlist gate

**Source — [scripts/verify-vocabulary.sh:36-51](../../scripts/verify-vocabulary.sh#L36-L51)** — `R7_ALLOWLIST` (13 literal paths at this version) and [scripts/verify-vocabulary.sh:55-61](../../scripts/verify-vocabulary.sh#L55-L61) — `R7_ALLOWLIST_GLOB` (5 glob entries). New allowlist additions require Architect approval per [scripts/verify-vocabulary.sh:8](../../scripts/verify-vocabulary.sh#L8) — "*New allowlist entries require Architect approval per Charter Refusal R7.*"

---

## Section C — The refusal-check gates (portal / ats / ingestion)

All three gates share the same skeleton (audit C4 cross-reference at [ci/scripts/verify-ingestion-refusal.ts:23-26](../../ci/scripts/verify-ingestion-refusal.ts#L23-L26)): parse YAML → walk `components.schemas` and `paths.*.responses.*.content.*.schema` (ingestion also walks `requestBody`) → for each object schema enforce `additionalProperties: false` → for each property check exact-forbidden, prefix-forbidden, and `const: false` invariants.

### C.1 `portal:refusal-check` — [ci/scripts/verify-portal-refusal.ts](../../ci/scripts/verify-portal-refusal.ts)

- npm script: `package.json` — `"portal:refusal-check": "node --import jiti/register ci/scripts/verify-portal-refusal.ts"`
- CI gate: [.github/workflows/ci.yml:152-163](../../.github/workflows/ci.yml#L152-L163)
- Target file: `openapi/portal.yaml` ([ci/scripts/verify-portal-refusal.ts:32](../../ci/scripts/verify-portal-refusal.ts#L32))
- **Exact-forbidden:** `internal_reasoning`, `entrustability_tier_raw` ([ci/scripts/verify-portal-refusal.ts:34-37](../../ci/scripts/verify-portal-refusal.ts#L34-L37))
- **Prefix-forbidden:** `override_`, `recruiter_` ([ci/scripts/verify-portal-refusal.ts:39-42](../../ci/scripts/verify-portal-refusal.ts#L39-L42))
- **`const:false` invariants:** none for Portal
- **Universal:** every object schema must set `additionalProperties: false` ([ci/scripts/verify-portal-refusal.ts:66-72](../../ci/scripts/verify-portal-refusal.ts#L66-L72)) — error: "`object schema must set additionalProperties: false (got ${JSON.stringify(addl)})`".
- **Pass/fail:** exits 0 with "`portal:refusal-check ok (${PORTAL_YAML})`" if `issues.length === 0`; else prints "`portal:refusal-check FAILED — ${issues.length} violation(s):`" with each `path: reason` and exits 1 ([ci/scripts/verify-portal-refusal.ts:220-227](../../ci/scripts/verify-portal-refusal.ts#L220-L227)).

### C.2 `ats:refusal-check` — [ci/scripts/verify-ats-refusal.ts](../../ci/scripts/verify-ats-refusal.ts)

- npm script: `"ats:refusal-check": "node --import jiti/register ci/scripts/verify-ats-refusal.ts"`
- CI gate: [.github/workflows/ci.yml:165-176](../../.github/workflows/ci.yml#L165-L176)
- Target file: `openapi/ats.yaml`
- **Exact-forbidden:** `score` ([ci/scripts/verify-ats-refusal.ts:36](../../ci/scripts/verify-ats-refusal.ts#L36)) — "*API Contracts v1.0 Phase 6 — \"ATS: no raw scores exposed; score field absent from any response schema\"*" ([ci/scripts/verify-ats-refusal.ts:15-17](../../ci/scripts/verify-ats-refusal.ts#L15-L17))
- **Prefix-forbidden:** `override_` ([ci/scripts/verify-ats-refusal.ts:37](../../ci/scripts/verify-ats-refusal.ts#L37))
- **`const:false` invariants:** `examination_mutated` ([ci/scripts/verify-ats-refusal.ts:38](../../ci/scripts/verify-ats-refusal.ts#L38)) — must be `const: false` or `enum: [false]`; reason on violation: "`${name} must be pinned const: false (Phase 6 — no tier mutation via override)`" ([ci/scripts/verify-ats-refusal.ts:81-84](../../ci/scripts/verify-ats-refusal.ts#L81-L84))
- **Universal:** `additionalProperties: false` (same as Portal)
- **Pass/fail:** identical pattern to Portal ([ci/scripts/verify-ats-refusal.ts:218-230](../../ci/scripts/verify-ats-refusal.ts#L218-L230))

### C.3 `ingestion:refusal-check` — [ci/scripts/verify-ingestion-refusal.ts](../../ci/scripts/verify-ingestion-refusal.ts)

- npm script: `"ingestion:refusal-check": "node --import jiti/register ci/scripts/verify-ingestion-refusal.ts"`
- CI gate: [.github/workflows/ci.yml:178-189](../../.github/workflows/ci.yml#L178-L189)
- Target file: `openapi/ingestion.yaml`
- **Exact-forbidden:** `score`, `internal_reasoning`, `entrustability_tier_raw` ([ci/scripts/verify-ingestion-refusal.ts:40-44](../../ci/scripts/verify-ingestion-refusal.ts#L40-L44))
- **Prefix-forbidden:** `override_`, `evaluation_`, `rank_` ([ci/scripts/verify-ingestion-refusal.ts:46-50](../../ci/scripts/verify-ingestion-refusal.ts#L46-L50))
- **`const:false` invariants:** `linkedin_automation_allowed` ([ci/scripts/verify-ingestion-refusal.ts:52-54](../../ci/scripts/verify-ingestion-refusal.ts#L52-L54)) — reason: "`${name} must be pinned const: false (Phase 4 R7 Layer 4 — no LinkedIn automation path)`" ([ci/scripts/verify-ingestion-refusal.ts:97-100](../../ci/scripts/verify-ingestion-refusal.ts#L97-L100))
- **Universal:** `additionalProperties: false`
- **Walk scope:** the only gate that also walks `requestBody.content.*.schema` (in addition to responses and components.schemas), per [ci/scripts/verify-ingestion-refusal.ts:125-163](../../ci/scripts/verify-ingestion-refusal.ts#L125-L163)
- **Pass/fail:** identical pattern ([ci/scripts/verify-ingestion-refusal.ts:288-296](../../ci/scripts/verify-ingestion-refusal.ts#L288-L296))

### C.4 All three gates are wired into the deployment-gate aggregator

[.github/workflows/ci.yml:464-486](../../.github/workflows/ci.yml#L464-L486) declares `deployment-gate` with `needs:` including `openapi-validate`, `openapi-lint`, `openapi-drift-check`, `portal-refusal-check`, `ats-refusal-check`, `ingestion-refusal-check`, `version-sync-check`, `error-codes-check`, `pact-consumer`, `pact-provider`, `test-unit`, `tests-integration`, `lint-nx-boundaries`, `terraform-fmt`, `terraform-validate`, `terraform-lint`, `terraform-sec`, `npm-audit`. The aggregator fails unless the override label `override:ok-to-merge` is present **and** a `Override-Justification: <≥40 chars>` line appears in the PR body ([.github/workflows/ci.yml:488-521](../../.github/workflows/ci.yml#L488-L521)).

---

## Section D — Entrustment / entrustability

### D.1 No in-repo prose definition of "entrustment"

A grep for "entrustment" across the entire `doc/`, `libs/`, `openapi/`, and `README.md` returns **only two hits**, both subtitles of milestone closure records:

- [doc/m0-closure-record-draft.md:5](../m0-closure-record-draft.md#L5) — "*Talent Intelligence and Entrustment Platform*"
- [doc/m1-closure-record-draft.md:5](../m1-closure-record-draft.md#L5) — "*Talent Intelligence and Entrustment Platform*"

Neither defines "entrustment." The Charter (which presumably does) is the `Aramo-Charter-v1.0-LOCKED.docx` outside the working tree.

### D.2 "Entrustability" — the term that *is* used in the repo

Authoritative pointer ([doc/01-locked-baselines.md:32](../01-locked-baselines.md#L32) and [doc/01-locked-baselines.md:40](../01-locked-baselines.md#L40)):

> "The product specification baseline. Ten locked specs covering the talent record, ingestion pipeline, recruiter workflow, examination output, **entrustability**, evidence package, …"
>
> "- Entrustability rule set with role-family thresholds — Section 2.5"

i.e. entrustability is defined in `Aramo-v1-Group2-Consolidated-Baseline-v2.0-LOCKED.docx §2.5` (out of tree). [doc/01-locked-baselines.md:36](../01-locked-baselines.md#L36) names the three thresholds: "*Threshold definitions (Graph Entry, Examinable, Entrustable) — Section 2.1*".

### D.3 The closed `ExaminationTier` enum — the only on-disk artifact

[libs/examination/prisma/schema.prisma:54-58](../../libs/examination/prisma/schema.prisma#L54-L58) (and Prisma-generated mirror [libs/examination/prisma/generated/client/schema.prisma:54-58](../../libs/examination/prisma/generated/client/schema.prisma#L54-L58)):

> "// ExaminationTier — closed enum from §2.4 (3 values). Tier assignment
> // logic (§2.5 Entrustability Rule Set) is a later PR; PR-1 stores the
> // field only.
> enum ExaminationTier {
>   ENTRUSTABLE
>   WORTH_CONSIDERING
>   STRETCH"

This enum is the operational embodiment of the entrustability classification. Recruiters cannot mutate it: see the `TalentJobExamination` doc string at [libs/examination/prisma/generated/client/index.js:207](../../libs/examination/prisma/generated/client/index.js#L207) (inlineSchema, mirrors source): "*Belt-and-suspenders enforcement: the repository surface … exposes no analytical-update method AND the database trigger rejects analytical-field UPDATEs.*"

`TalentJobExamination` also carries `delta_to_entrustable Json?` ([libs/examination/prisma/schema.prisma:122](../../libs/examination/prisma/schema.prisma#L122)) — the per-examination delta that would have to close before tier could move from `WORTH_CONSIDERING` toward `ENTRUSTABLE`.

### D.4 The `entrustability` library — empty scaffold

[libs/entrustability/src/lib/entrustability.module.ts](../../libs/entrustability/src/lib/entrustability.module.ts):

> "import { Module } from '@nestjs/common';
>
> @Module({})
> export class EntrustabilityModule {}"

[libs/entrustability/src/index.ts](../../libs/entrustability/src/index.ts):

> "export { EntrustabilityModule } from './lib/entrustability.module.js';"

The library exists, the public-API surface re-exports the module, and the Prisma `EntrustabilityModule` is wired — but there is no code in it. Per [doc/01-locked-baselines.md:114](../01-locked-baselines.md#L114), entrustability is an **M4 milestone deliverable** ("*M4 entrustability + IaC + observability + CVE*"). The entrustability *logic* (§2.5 Rule Set) is not yet implemented.

### D.5 Other in-repo mentions

- The forbidden field name `entrustability_tier_raw` appears in both Portal and Ingestion refusal-check scripts ([ci/scripts/verify-portal-refusal.ts:36](../../ci/scripts/verify-portal-refusal.ts#L36), [ci/scripts/verify-ingestion-refusal.ts:43](../../ci/scripts/verify-ingestion-refusal.ts#L43)) and is the R10 anti-leakage tripwire — implying that internally the system computes a *raw* entrustability score/signal that must never reach Portal or Ingestion responses.
- The `RecruiterAttestations.constraints_reviewed` field at [openapi/common.yaml:2360-2366](../../openapi/common.yaml#L2360-L2366) is described as "*Recruiter affirms the §2.5 entrustability constraints (location, work mode, rate, work authorization) were reviewed against the requisition.*" — i.e., the four operational entrustability constraint dimensions are **location, work mode, rate, and work authorization** (this is the closest in-repo enumeration of what entrustability *means*).
- `FailedCriterionAcknowledgment.criterion` at [openapi/common.yaml:2040-2044](../../openapi/common.yaml#L2040-L2044) gives example values: `"rate_within_band"` and `"work_authorization_match"` — these are the §2.5 entrustability criteria the system checks.

### D.6 Summary

**There is no in-repo verbatim definition of "entrustment" or "entrustability."** The closest in-repo operational meaning:
1. A **3-tier closed classification** of a (talent, job) pair: `ENTRUSTABLE`, `WORTH_CONSIDERING`, `STRETCH`.
2. Computed by the system based on §2.5 criteria including (at minimum) **location, work mode, rate, and work authorization** (per the `constraints_reviewed` attestation description).
3. **Recruiter-immutable** at the data layer (DB trigger + repository surface enforce this).
4. **Stretch-tier candidates may not be submitted** (R9).
5. Recruiters may *annotate* with an `ExaminationOverride` ([libs/examination/prisma/schema.prisma](../../libs/examination/prisma/schema.prisma) — `enum OverrideType { tier risk_flag gap constraint_check }`) but the underlying examination is never mutated (R8).

The full definitional text is at `Aramo-v1-Group2-Consolidated-Baseline-v2.0-LOCKED.docx §2.5` (OneDrive) — not auditable from this working tree.

---

## Section E — Plain-English implications (AUDITOR ANALYSIS — not Charter text)

The bullets below are my analysis of how the rules in A–D bear on four hypothetical product capabilities: (a) agentic open-web candidate sourcing, (b) AI ranking of applicants by "fit", (c) automated resume-fraud flagging, (d) automated multi-channel outreach. Every claim is anchored to a rule cited verbatim above.

1. **Agentic open-web candidate sourcing is structurally forbidden as a primary mode.** R2 forbids Aramo "as a sourcing engine as primary function" ([doc/03-refusal-layer.md:47](../03-refusal-layer.md#L47)). The four-value `SourceType` closed enum (`indeed`, `github`, `astre_import`, `talent_direct`) at [doc/03-refusal-layer.md:165](../03-refusal-layer.md#L165) caps the universe of sanctioned ingestion sources; a general "open-web scrape" adapter requires both Architect change-control on the enum (Rule 4 at [doc/02-claude-code-discipline.md:42-52](../02-claude-code-discipline.md#L42-L52)) and would collide with R7 layer 2 ("`AdapterType` enum same; `x-prohibited-values: [linkedin, linkedin_scrape, linkedin_bulk, generic_web_scrape]`" — *`generic_web_scrape` is named as a prohibited value*).

2. **LinkedIn specifically is the strictest blocked source.** R7 is the *only* rule with a sealed repo-wide ripgrep gate (Tier-1 in [scripts/verify-vocabulary.sh:36-51](../../scripts/verify-vocabulary.sh#L36-L51)) AND a `const: false` schema invariant on `linkedin_automation_allowed` ([ci/scripts/verify-ingestion-refusal.ts:52-54](../../ci/scripts/verify-ingestion-refusal.ts#L52-L54)). Per [doc/03-refusal-layer.md:181](../03-refusal-layer.md#L181), "*adding LinkedIn is outside Architect or Lead authority. It requires Charter-level approval per Section 8.*" Any agentic-sourcing prototype that touches LinkedIn data — even read-only inferred profiles — will fail CI and trigger Charter-level review.

3. **AI ranking outputs may exist internally, but may not be surfaced to candidates (Portal).** R10 ([doc/03-refusal-layer.md:252](../03-refusal-layer.md#L252)) plus the forbidden-fields list at [doc/03-refusal-layer.md:259-265](../03-refusal-layer.md#L259-L265) forbid `tier`, `rank`, `rank_ordinal`, `score`, `why_matched_sentence`, `strengths`, `gaps`, `risk_flags` from Portal responses. The CI gate enforces `internal_reasoning`, `entrustability_tier_raw`, plus `override_*` and `recruiter_*` prefix bans, plus the `additionalProperties: false` envelope. **Caveat (Section A R10):** literal property names like "tier" or "rank" themselves would not trip the current Portal CI gate by name — the structural defense is `additionalProperties: false` and "Portal schemas don't declare them." A new Portal schema declaring `rank` directly would pass Portal CI but violate the doc rule; manual Lead review is the load-bearing check there.

4. **AI ranking outputs *to recruiters* (ATS) are permitted in shape, but raw scores are not.** R10's ATS-side enforcement is the `score` exact-match ban ([ci/scripts/verify-ats-refusal.ts:36](../../ci/scripts/verify-ats-refusal.ts#L36)) — "*ATS: no raw scores exposed; score field absent from any response schema.*" The system computes rankings (`rank_ordinal Int` on `TalentJobExamination`) but exposes them only through the locked Examination shape; `score` as a literal field name is blocked. Calibration metrics, weights, and raw scores must stay server-side.

5. **System fit classification ≠ recruiter judgment, by deliberate design.** R8 ([doc/03-refusal-layer.md:183](../03-refusal-layer.md#L183)) — *"will not allow recruiter judgment to override system classification"* — is enforced four ways: (a) ATS schema invariant `examination_mutated: const: false` ([ci/scripts/verify-ats-refusal.ts:38](../../ci/scripts/verify-ats-refusal.ts#L38)), (b) `override_*` prefix banned across Portal/ATS/Ingestion, (c) DB BEFORE-UPDATE trigger rejects mutation, (d) repository surface exposes no analytical-update method. An "AI re-rank with recruiter weight" feature is structurally rejected: a recruiter override is a *separate `ExaminationOverride` annotation*, not a mutation of the system tier.

6. **No fit classification implies "ship now" — submission is recruiter-gated.** R12 ([doc/03-refusal-layer.md:326](../03-refusal-layer.md#L326)) — *"will not replace recruiter judgment with system autonomy"* — is enforced by three `const: true` attestations on `RecruiterAttestations` ([openapi/common.yaml:2354-2369](../../openapi/common.yaml#L2354-L2369)): `talent_evidence_reviewed`, `constraints_reviewed`, `submittal_risk_acknowledged`. **An automated "AI auto-submit high-fit candidate" cron is structurally rejected at the OpenAPI layer** — those attestations cannot be served by an automated caller without lying about a `const: true` value, which OpenAPI validation rejects.

7. **Stretch-tier candidates are non-submittable.** R9 + the `ExaminationTier` closed enum + `SUBMITTAL_STRETCH_BLOCKED` error code form a closed gate: anything the AI classifies as Stretch cannot be moved to a recruiter submission. Any AI-fit-ranking feature must respect this — it cannot "promote" a Stretch by re-scoring; only an `ExaminationOverride` of type `tier` may annotate, and the underlying examination cannot move.

8. **Resume-fraud flagging fits the existing risk_flags slot — but the surface is recruiter-only.** `TalentJobExamination` declares `risk_flags Json` ([libs/examination/prisma/schema.prisma:116](../../libs/examination/prisma/schema.prisma#L116)). The R10 forbidden-fields list explicitly names `risk_flags` as a *Portal-forbidden* field ([doc/03-refusal-layer.md:262](../03-refusal-layer.md#L262)). Fraud-flagging is therefore architecturally permitted as a recruiter-facing capability, **but the candidate (Portal) cannot see they were flagged or why.** R10 also forbids `internal_reasoning`: an automated explanation of why a fraud signal fired must not leak to the candidate.

9. **Automated outreach is consent-gated, not metrics-gated.** R11 ([doc/03-refusal-layer.md:305](../03-refusal-layer.md#L305)) — *"will not optimize engagement metrics over consent integrity"* — and R13 — *"will not compromise consent integrity for engagement velocity"* ([doc/03-refusal-layer.md:346](../03-refusal-layer.md#L346)) — together require a consent precheck on every send and a fail-closed posture on consent-check timeouts. A "send 100 messages in parallel, defer consent checks asynchronously" optimization is rejected; an "if consent service is down, default to allowed" fast-path is rejected.

10. **Behavioral consent inference is forbidden — opens/clicks/replies cannot be used to expand consent.** R4 ([doc/03-refusal-layer.md:88](../03-refusal-layer.md#L88)) — *"will not infer consent from behavior."* The only legitimate consent source is the `TalentConsentEvent` append-only ledger ([doc/03-refusal-layer.md:91](../03-refusal-layer.md#L91), [doc/milestone-signoffs/M0-refusal-signoff.md:64-65](../milestone-signoffs/M0-refusal-signoff.md#L64-L65)). A "talent replied → assume they consent to a follow-up channel" optimization is rejected.

11. **Multi-tenant outreach cannot widen consent via aggregation.** R5 ([doc/03-refusal-layer.md:114](../03-refusal-layer.md#L114)) requires *intersection*-not-union over consent sources (`sources.every` not `sources.some` per [doc/03-refusal-layer.md:124-129](../03-refusal-layer.md#L124-L129)). A multi-tenant agent that has consent in Tenant B cannot use it as a basis to message under Tenant A; the per-tenant per-scope state is stored separately and never merged.

12. **Stale consent (>12 months) blocks contacting actions regardless of business value.** R6 ([doc/03-refusal-layer.md:134](../03-refusal-layer.md#L134), 12-month threshold). An automated outreach pipeline cannot treat a "VIP" or "urgent" exception path that bypasses staleness — the doc explicitly anti-patterns `if (isStale && isVipCandidate) return { result: 'allowed' };` ([doc/03-refusal-layer.md:144-146](../03-refusal-layer.md#L144-L146)).

**Net read on the four hypothetical capabilities:**

- **(a) Agentic open-web sourcing as primary mode** — *forbidden* (R2 + R7 + closed `SourceType` enum + `generic_web_scrape` is explicitly named as a prohibited `AdapterType`). LinkedIn-flavored prototypes will fail CI.
- **(b) AI ranking of applicants by fit** — *permitted internally, structurally constrained on exposure*. Ranking exists (`rank_ordinal`, `ExaminationTier`), but `score` literal is banned ATS-side and the full ranking surface is banned Portal-side (R10). Recruiter cannot override the classification (R8); only annotate.
- **(c) Automated resume-fraud flagging** — *permitted recruiter-facing*. The `risk_flags Json` slot exists on `TalentJobExamination` and is meant to carry exactly this. *Forbidden* candidate-facing — the candidate cannot see the flag, the reasoning, or any `internal_reasoning` text (R10).
- **(d) Automated multi-channel outreach** — *permitted only behind the consent guard*. Every send must be preceded by a consent check that fails-closed (R11, R13), uses the ledger only (R4), applies most-restrictive across sources (R5), and respects the 12-month staleness threshold (R6). Auto-submission paths to ATS are independently blocked by `const: true` attestations (R12). The locked `EngagementState` machine (10 values per [doc/03-refusal-layer.md:396](../03-refusal-layer.md#L396)) constrains the allowed transitions.

---

## Appendix — files read in producing this audit

- [README.md](../../README.md) (full, 111 lines)
- [doc/03-refusal-layer.md](../03-refusal-layer.md) (full, 447 lines)
- [doc/02-claude-code-discipline.md](../02-claude-code-discipline.md) (full, 191 lines)
- [doc/01-locked-baselines.md](../01-locked-baselines.md) (lines 1-130 of 432)
- [doc/milestone-signoffs/M0-refusal-signoff.md](../milestone-signoffs/M0-refusal-signoff.md) (full, 175 lines)
- [scripts/verify-vocabulary.sh](../../scripts/verify-vocabulary.sh) (full, 350 lines)
- [eslint.config.mjs](../../eslint.config.mjs) (full, 232 lines)
- [.github/workflows/ci.yml](../../.github/workflows/ci.yml) (full, 534 lines)
- [ci/scripts/verify-portal-refusal.ts](../../ci/scripts/verify-portal-refusal.ts) (full, 230 lines)
- [ci/scripts/verify-ats-refusal.ts](../../ci/scripts/verify-ats-refusal.ts) (full, 233 lines)
- [ci/scripts/verify-ingestion-refusal.ts](../../ci/scripts/verify-ingestion-refusal.ts) (full, 298 lines)
- [libs/entrustability/src/lib/entrustability.module.ts](../../libs/entrustability/src/lib/entrustability.module.ts) (4 lines — empty stub)
- [libs/entrustability/src/index.ts](../../libs/entrustability/src/index.ts) (1 line)
- [openapi/common.yaml](../../openapi/common.yaml) (sections around `RecruiterAttestations` and `FailedCriterionAcknowledgment`)
- [openapi/portal.yaml](../../openapi/portal.yaml) (lines 1-120 of 120-ish)
- Spot-greps for "entrustment", "entrustability" across `doc/`, `libs/`, `openapi/`.
