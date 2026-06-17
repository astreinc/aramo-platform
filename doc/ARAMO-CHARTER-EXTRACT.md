# ARAMO CHARTER EXTRACT — Verbatim source text

**Generated:** 2026-05-31
**Source folder:** `/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/locked`
**Extraction method:** `pandoc <file>.docx -t markdown`
**Read-only:** no source `.docx` files were modified.

---

## 0. Critical framing reads — before you trust anything below

### 0a. There is no "Charter §8 amendment process"

The handover prompt asked for "Charter Section 8 (the amendment / change-control process)." In the canonical Charter, **§8 is the Refusal Layer itself, not the amendment process.** The amendment / change-control process lives in **Charter §12 (Charter Stewardship)** — extracted in Section 1 below.

### 0b. The Refusal Layer is not numbered R1–R13 in the canonical text

The "R1 … R13" labels used across the repo (`doc/03-refusal-layer.md`, M0 sign-off, etc.) are a **derived numbering convention**, not Charter text. The Charter §8 presents the thirteen refusals as italic statements grouped into Scope / Behavior / Posture, with no per-rule numbers. The verbatim Charter text + the derived numbering are both shown in Section 2 below.

### 0c. The "R1–R13" sub-grouping (Scope R1–R3, Behavior R4–R10, Posture R11–R13) is repo-derived

Repo convention (e.g. M0-refusal-signoff.md): "*Refusal numbering follows the program's R1–R13 linear convention (Charter §8 grouping: Scope R1–R3, Behavior R4–R10, Posture R11–R13)*." The Charter itself names only the three groups, not the per-rule numbers.

### 0d. Charter v1.0 references `candidate_direct`; current canonical is `talent_direct`

After Charter v1.0 LOCKED (April 2026), the cross-spec vocabulary amendment `Aramo-Vocabulary-Amendment-candidate_direct-Rename-v1_0-LOCKED.docx` (May 2026) renamed the fourth adapter/source type from `candidate_direct` → `talent_direct` to clear a vocabulary-discipline collision with the `candidate` anti-vocabulary. The Charter and the v1.0 API Contracts (extracted below) still carry the pre-rename token. The current canonical token is `talent_direct` per the amendment; the live repo uses `talent_direct`. Quotes below are verbatim from the pre-rename docs; the amendment is summarized in Section 4.

### 0e. Source-document inventory used for this extract

| File | Modified | Role in this extract |
|---|---|---|
| `Aramo-Charter-v1.0-LOCKED.docx` | 2026-04-27 | Program Charter v1.0; sole Charter in the locked folder. Sections 1, 2 below. |
| `Aramo-v1-Group2-Consolidated-Baseline-v2.0-LOCKED.docx` | 2026-04-27 | Group 2 §2.3a Ingestion Pipeline. Section 3a below. |
| `Aramo-API-Contracts-v1.0-Phases-1-6-LOCKED.docx` | 2026-04-27 | Phase 4 Ingestion Adapter API Surface (four-layer LinkedIn refusal). Section 3b below. |
| `Aramo-Vocabulary-Amendment-candidate_direct-Rename-v1_0-LOCKED.docx` | 2026-05-16 | Post-Charter vocabulary amendment (`candidate_direct` → `talent_direct`). Section 4 below. |
| `Aramo-Charter-Review-R7-PR5-LOCKED.md` | 2026-05-19 | Bounded Charter-level review authorizing 3 PR-5 paths into R7_ALLOWLIST for `linkedin` as a Group 2 §2.2 enum-value provenance label. Section 5 below. |

**Not a Charter (do not confuse):** `Aramo-M5-Charter-v1_1-LOCKED.md`, `Aramo-M5-Charter-v1_2-LOCKED.md`, `Aramo-M6-Charter-v1_0-DRAFT.md`, `Aramo-M6-Charter-v1_1-LOCKED.md` are **milestone charters** (scope of a single milestone), not the program Charter. Only `Aramo-Charter-v1.0-LOCKED.docx` is the program Charter.

---

## 1. Charter Amendment / Change-Control Process — VERBATIM

Source: `Aramo-Charter-v1.0-LOCKED.docx` — extracted via pandoc to `/tmp/aramo-charter.md`.

### 1a. Document Control / Status (front matter, lines 32-38)

> "**LOCKED — Version 1.0.** This Charter has been approved through the
> Aramo program's three-way review process (Product Owner, Technical
> Architect, Business Analyst). Changes follow the stewardship process
> defined in Section 12. Refusal-layer changes require explicit
> re-justification of the original commitment."

### 1b. Section 12 — Charter Stewardship (verbatim, lines 397-406)

> "12. Charter Stewardship
>
> The Charter evolves deliberately.
>
> - Minor updates clarify language
>
> - Major updates require Product Owner, Architect, and Business Analyst
>   approval
>
> - Refusal-layer changes require explicit re-justification"

### 1c. Approvers (front matter table, lines 55-68)

> "**Role**              **Responsibility**    **Signature**   **Date**
> **Product Owner**     Program scope, vision, and refusal layer
> **Technical Architect**           Architectural posture and reference accuracy
> **Business Analyst**  Domain accuracy and operational grounding"

### 1d. Per the §12 stewardship rule, this is the entire formal amendment process in the canonical Charter

Three bullets in §12, plus the Status block in front matter ("**Refusal-layer changes require explicit re-justification of the original commitment**"). There is no longer-form workflow, no SLA, no review-gate sequence, no required artifact format spelled out in the Charter itself. The "PO directs → BA files to OneDrive canonical location → considered locked/amended" workflow described in the handover is the operational implementation of these three rules, not Charter text.

---

## 2. The Refusal Layer (Charter §8) — VERBATIM

Source: `Aramo-Charter-v1.0-LOCKED.docx` §8 (lines 301-337).

### 2a. Section header + framing sentence

> "8. What Aramo Is Not (Refusal Layer)
>
> Aramo defines itself through explicit refusals."

### 2b. The thirteen refusals — verbatim italicized statements, with derived R-numbering annotated

#### Scope Refusals (Charter §8 lines 305-311)

> "Scope Refusals
>
> *Will not function as a job marketplace or job board.*
>
> *Will not act as a sourcing engine as its primary function.*
>
> *Will not provide candidate-facing job discovery or feeds.*"

| Derived ID | Verbatim Charter text |
|---|---|
| **R1** | *Will not function as a job marketplace or job board.* |
| **R2** | *Will not act as a sourcing engine as its primary function.* |
| **R3** | *Will not provide candidate-facing job discovery or feeds.* |

#### Behavior Refusals (Charter §8 lines 313-327)

> "Behavior Refusals
>
> *Will not infer consent from behavior.*
>
> *Will not widen consent through aggregation.*
>
> *Will not act on stale consent for high-impact actions.*
>
> *Will not perform automated LinkedIn scraping.*
>
> *Will not allow recruiter judgment to override system classification.*
>
> *Will not permit submission of Stretch-tier candidates.*
>
> *Will not expose internal reasoning or evaluation outputs.*"

| Derived ID | Verbatim Charter text |
|---|---|
| **R4** | *Will not infer consent from behavior.* |
| **R5** | *Will not widen consent through aggregation.* |
| **R6** | *Will not act on stale consent for high-impact actions.* |
| **R7** | *Will not perform automated LinkedIn scraping.* |
| **R8** | *Will not allow recruiter judgment to override system classification.* |
| **R9** | *Will not permit submission of Stretch-tier candidates.* |
| **R10** | *Will not expose internal reasoning or evaluation outputs.* |

#### Posture Refusals (Charter §8 lines 329-335)

> "Posture Refusals
>
> *Will not optimize engagement metrics over consent integrity.*
>
> *Will not replace recruiter judgment with system autonomy.*
>
> *Will not compromise consent integrity for engagement velocity.*"

| Derived ID | Verbatim Charter text |
|---|---|
| **R11** | *Will not optimize engagement metrics over consent integrity.* |
| **R12** | *Will not replace recruiter judgment with system autonomy.* |
| **R13** | *Will not compromise consent integrity for engagement velocity.* |

#### §8 closing sentence (line 337)

> "These refusals are structural and remain in force under pressure."

### 2c. R7 — note on scope of the LinkedIn refusal beyond Charter §8

The Charter R7 sentence — "*Will not perform automated LinkedIn scraping.*" — is narrower than the four-layer enforcement described in Phase 4 (Section 3b below). The enforcement covers *all* LinkedIn automation paths (the prohibited list includes `linkedin`, `linkedin_scrape`, `linkedin_bulk`, `generic_web_scrape`). The wider read of R7 is also stated in the closing sentence of Group 2 §2.3a (Section 3a §3a.7 below): "*bulk or automated LinkedIn scraping is prohibited regardless of technical feasibility.*"

### 2d. R8/R12/R9 supporting Charter text outside §8

§4 Architectural Posture, line 174: "***Aramo is AI-assisted, not AI-autonomous.*** The system recommends; the recruiter decides." — the Charter-level statement underlying R8 / R12.

§4 Architectural Posture, lines 202-204: "Entrustability is computed, not assumed. Submission readiness is determined by explicit evidence-based rules." — the Charter-level commitment underlying R9.

§4 Architectural Posture, lines 188-191: "Consent is immutable and enforced at runtime. Consent is modeled as a ledger of events. Every action checks current consent state before execution." — underlying R4 / R11 / R13.

§3 The Aramo Approach, line 174 (boxquote): "**Aramo is AI-assisted, not AI-autonomous.** The system recommends; the recruiter decides." (duplicate of §4 box).

### 2e. R10 nuance — §3 "From opaque ranking to explainable reasoning"

§3 lines 169-172: "From opaque ranking to explainable reasoning. Candidates are presented with structured evidence, not black-box rankings." — note this says *candidates* see structured evidence; R10's *recruiter*-facing exposure is the explainable-reasoning surface (the `why_matched_sentence`, etc.), and R10 keeps it out of candidate (Portal) responses. The Charter does not separately number this — it appears alongside the four "fundamental shifts" in §3.

### 2f. §6 Specification Discipline — "Specification as refusal layer" (the meta-rule)

§6 lines 268-270: "Specification as refusal layer. Each spec defines what the system will not do." — i.e., the refusal-layer concept is a Charter-level meta-principle, not just §8.

---

## 3. Ingestion SourceType / AdapterType rules

The Charter itself does not enumerate `SourceType` / `AdapterType` values. The enumerations live in **Group 2 §2.3a Ingestion Pipeline Specification** (product-level) and **API Contracts Phase 4 Ingestion Adapter API Surface** (machine-readable enforcement). Both verbatim below.

### 3a. Group 2 v2.0 §2.3a — Ingestion Pipeline Specification — VERBATIM

Source: `Aramo-v1-Group2-Consolidated-Baseline-v2.0-LOCKED.docx`. Extracted to `/tmp/aramo-group2.md` lines 940-1087.

#### §3a.1 Purpose (lines 940-946)

> "Section 2.3a — Ingestion Pipeline Specification
>
> Purpose
>
> Define how Talents enter the Aramo Talent Graph from four v1 ingestion
> sources: Indeed, GitHub, Astre existing data, and candidate-direct
> intake."

The "four v1 ingestion sources" named in prose: **Indeed**, **GitHub**, **Astre existing data**, **candidate-direct intake**. (Per Section 4 below, the fourth was renamed to **Talent-Direct** post-lock; Charter and Group 2 v2.0 text still says candidate-direct.)

#### §3a.2 Source Pipeline: Indeed (lines 948-974)

> "Source Pipeline: Indeed
>
> Economic model — two-phase fetch
>
> **Critical constraint:** Indeed Resume API charges per-contact unlock,
> not per-search. The pipeline must operate as two-phase: search for
> shortlist (low cost), then unlock contact information selectively
> (paid). Aramo's matching engine runs against shortlist data; the
> recruiter or governed automation authorizes unlocks for top candidates
> only.
>
> Authentication and setup
>
> - Configure Indeed employer/recruiter access
> - Store API keys/OAuth credentials in Secrets Manager
> - Tenant-level configuration: enabled/disabled, budget cap, search regions, job families, allowed query templates, spend limits
>
> Consent handling
>
> Initial state: sourced / limited-use, not fully engaged. Allowed before
> active consent: store source evidence per Indeed terms, evaluate for
> matching eligibility. Not allowed until upgraded: direct outreach beyond
> permitted channel, long-term campaigns, cross-source enrichment beyond
> purpose."

#### §3a.3 Source Pipeline: GitHub (lines 976-987)

> "Source Pipeline: GitHub
>
> GitHub API credentials or app installation. Tokens in Secrets Manager.
> Configure query scopes by tenant: locations, languages, repositories,
> topics, activity recency, role families.
>
> Ingest: GitHub username/profile URL, public bio, public email if
> available, location text, repositories, languages, topics, recent
> activity summary, contribution evidence.
>
> Initial state: public-profile-discovered, limited use, not automatically
> contactable until contact channel and consent basis are valid."

#### §3a.4 Source Pipeline: Astre Existing Data (lines 989-1009)

> "Source Pipeline: Astre Existing Data
>
> Conservative scope (locked)
>
> **V1 scope is conservative.** Allowed: dedicated forwarding inboxes
> only (e.g., candidates@, applications@) and candidate-facing
> communications where Aramo is disclosed. Not allowed: retroactive
> mailbox mining, bulk ingestion of recruiter inboxes. Historical
> mailbox ingestion is deferred to Phase 2 pending legal review.
>
> Possible inputs
>
> - Resumes from OneDrive and shared folders
> - Recruiter spreadsheets (one-time import)
> - Prior ATS exports if available
> - VMS exports if available
> - Historical submittal and placement records"

#### §3a.5 Source Pipeline: Candidate-Direct (lines 1011-1028)

> "Source Pipeline: Candidate-Direct
>
> Cleanest source. Candidate provides data directly with explicit consent.
>
> Entry points
>
> - Public candidate profile/signup link
> - Recruiter-shared invite link
> - Referral link
> - Resume upload form
> - Profile completion form
>
> Candidate-direct is the primary path through which a limited-use Talent
> becomes active and engageable."

#### §3a.6 Unified Ingestion Architecture (lines 1030-1080)

> "Unified Ingestion Architecture
>
> Architecture style
>
> **Queue-based, event-driven, idempotent.** Source adapters emit
> events. Workers process stages asynchronously. Retries and backoff are
> queue-managed. Idempotency keys prevent duplicate Talent creation.
>
> Pipeline stages
>
> Source fetch/import → raw payload storage → validation → document
> handling → parsing → normalization → deduplication → consent state
> assignment → Talent entity creation/update → skill canonicalization →
> derived snapshot recomputation → event logging → monitoring
>
> Consent state mapping
>
> | **Source**         | **profile_storage**   | **resume_processing**   | **matching**   | **contacting**            |
> |---|---|---|---|---|
> | Indeed             | yes (per terms)       | yes                     | yes            | limited (Indeed channel)  |
> | GitHub             | yes (public)          | N/A                     | yes            | no                        |
> | Astre import       | yes (legitimate interest) | yes                 | yes            | limited until refreshed   |
> | Candidate-direct   | explicit consent      | explicit consent        | explicit       | explicit                  |
>
> Deduplication tiebreaker policy
>
> - Verified email match → auto-merge
> - Exact profile URL match → strong merge
> - Phone-only match → review queue
> - Name + location → review queue
> - Resume similarity → supporting signal only
> - Conflicts always preserved, surfaced, never silently overwritten
>
> Skills Taxonomy dependency
>
> **Hard dependency.** Ingestion pipeline requires Skills Taxonomy to be
> seeded before canonical skill evidence can be produced. If ingestion
> starts before taxonomy: store surface_form only and run
> canonicalization backfill later."

#### §3a.7 LinkedIn exclusion (lines 1082-1087) — the Group 2 statement of R7

> "LinkedIn exclusion
>
> **LinkedIn is explicitly excluded from automated ingestion in v1 and
> Phase 2.** Manual recruiter add is permitted as an audited exception
> with required attestation; bulk or automated LinkedIn scraping is
> prohibited regardless of technical feasibility."

**Note** — this is the source of the "manual recruiter add is permitted as audited exception with required attestation" carve-out. Charter §8 R7 alone does not contain it.

### 3b. API Contracts v1.0 Phase 4 — Ingestion Adapter API Surface — VERBATIM

Source: `Aramo-API-Contracts-v1.0-Phases-1-6-LOCKED.docx`. Extracted to `/tmp/aramo-api-contracts.md` lines 1146-1376.

#### §3b.1 Phase 4 Purpose & Invariants (lines 1146-1172)

> "Phase 4 — Ingestion Adapter API Surface
>
> Phase 4 Purpose
>
> Phase 4 defines how source-specific ingestion adapters submit candidate
> evidence into Aramo Core. Adapters covered: Indeed, GitHub, Astre
> Import, Candidate-Direct.
>
> Phase 4 enforces Aramo Core as single source of truth, evidence-only
> ingestion (no truth mutation), consent enforcement at the ingestion
> boundary, and structural refusal of prohibited sources (LinkedIn).
>
> Phase 4 Invariants
>
> - Aramo Core is the only Talent creation authority
> - Adapters submit evidence, not truth
> - Consent state is assigned and enforced by Core, not adapters
> - LinkedIn has no automated adapter path
> - Indeed unlock economics are explicit and auditable
> - All ingestion writes are idempotent
> - Raw payloads are stored by reference, not treated as Talent truth"

#### §3b.2 Adapter Registry — closed allowed list (lines 1174-1184)

> "Adapter Registry (Hard Enforced)
>
> Allowed Adapter Types
>
> > indeed
> >
> > github
> >
> > astre_import
> >
> > candidate_direct"

**(Post-amendment: `candidate_direct` → `talent_direct`. See Section 4.)**

#### §3b.3 Prohibited Adapter Types (lines 1186-1194)

> "Prohibited Adapter Types
>
> > linkedin
> >
> > linkedin_scrape
> >
> > linkedin_bulk
> >
> > generic_web_scrape"

These four tokens are the canonical machine-readable prohibition list. `generic_web_scrape` is the value that closes the "open-web scraping" door at the AdapterType layer.

#### §3b.4 Four-Layer LinkedIn Refusal Enforcement (lines 1196-1215)

> "Four-Layer LinkedIn Refusal Enforcement
>
> LinkedIn refusal is enforced through four structurally airtight
> mechanisms:
>
> > **Layer 1 — Closed AdapterType enum:** AdapterType allows only the
> > four named values; LinkedIn is not enumerable.
> >
> > **Layer 2 — Explicit prohibited list:** x-prohibited-values
> > extension on AdapterType and SourceType makes the refusal
> > machine-readable.
> >
> > **Layer 3 — No adapter registration endpoint:** There is no POST
> > /v1/adapters. Adding any new adapter requires repo creation,
> > deployment approval, ADR, and Charter-level approval if conflicting
> > with Charter Section 8.
> >
> > **Layer 4 — Schema-level const constraints:**
> > SourcePolicyResponse.linkedin_automation_allowed: type: boolean,
> > const: false. Any response saying 'true' fails OpenAPI validation."

**This is the canonical text of the rule for adding a new source/adapter:** Layer 3 — *"Adding any new adapter requires repo creation, deployment approval, ADR, and Charter-level approval if conflicting with Charter Section 8."* No Charter-level approval is required for sources that do NOT conflict with §8; Charter-level approval is conditional on §8 conflict.

#### §3b.5 Endpoint Coverage — 15 operations across 7 groups (lines 1217-1241)

> "Endpoint Coverage (15 operations across 7 groups)
>
> | **Group**                  | **Endpoints**                                                                  |
> |---|---|
> | 1. Adapter Context         | GET /ingestion/adapters/me; GET /ingestion/adapters/source-policy              |
> | 2. Generic Payload Submission | POST, GET /ingestion/payloads                                                |
> | 3. Indeed Two-Phase Ingestion | search-results, unlock-authorizations, unlocked-payloads, budget             |
> | 4. GitHub Ingestion        | POST /ingestion/github/profiles                                                |
> | 5. Astre Import            | batches POST/GET; batches/{batch_id}/records POST                              |
> | 6. Candidate-Direct Ingestion | POST /ingestion/candidate-direct/intakes                                    |
> | 7. Adapter Status          | POST /ingestion/adapters/status; GET /ingestion/jobs/{job_id}                  |"

#### §3b.6 Astre Import — Allowed Source Channels closed enum (lines 1291-1314)

> "Astre Import Conservative Scope
>
> Allowed Source Channels
>
> > forwarding_inbox
> >
> > shared_folder
> >
> > spreadsheet
> >
> > ats_export
> >
> > vms_export
>
> Prohibited Sources
>
> > *Retroactive recruiter mailbox mining is prohibited.*
> >
> > *Bulk recruiter inbox ingestion is prohibited.*
> >
> > *Undisclosed historical communication mining is prohibited.*
>
> AstreImportSourceChannel enum is closed. Submissions with prohibited
> channel values fail validation at the API layer."

#### §3b.7 Source Consent Mapping (Phase 4, lines 1316-1335)

> "Source Consent Mapping (Locked from Group 2 v2.3a)
>
> | **Source**     | **profile_storage**   | **resume_processing**   | **matching**   | **contacting**            |
> |---|---|---|---|---|
> | Indeed         | source_terms          | source_terms            | source_terms   | limited (Indeed channel)  |
> | GitHub         | public                | N/A                     | public         | none                      |
> | Astre Import   | legitimate_interest   | yes                     | yes            | limited until refreshed   |
> | Candidate Direct | explicit            | explicit                | explicit       | explicit                  |
>
> Adapters submit source context; Aramo Core assigns final consent state.
> Aramo Core never widens consent through source aggregation. Contacting
> always requires runtime Core consent check."

#### §3b.8 Phase 4 Refusal Enforcement Summary table (lines 1357-1376)

> "Phase 4 Refusal Enforcement Summary
>
> | **Refusal**                | **Enforcement Mechanism**                                                  |
> |---|---|
> | LinkedIn automation        | Four-layer block (enum + prohibited list + no registration + schema const) |
> | Adapter truth mutation     | Core-only Talent creation authority                                        |
> | Consent inference          | Core-only consent assignment                                               |
> | Raw payload misuse         | Reference-only schema; const true storage requirement                      |
> | Source overreach           | Per-adapter restricted operations enum                                     |
> | Indeed cost ambiguity      | Explicit authorization → unlock → cost audit chain                         |"

### 3c. Rules for adding a new source — summarized from the verbatim quotes above

Two stated mechanisms gate new-source additions:

1. **Layer 3 of the four-layer LinkedIn refusal (Phase 4, §3b.4 above):** "*Adding any new adapter requires repo creation, deployment approval, ADR, and Charter-level approval if conflicting with Charter Section 8.*" — Charter-level approval is conditional on §8 conflict, not unconditional.
2. **Charter §12 stewardship (§1b above):** "*Refusal-layer changes require explicit re-justification of the original commitment*" + the Document Control block: "*Refusal-layer changes require explicit re-justification of the original commitment.*"

A new `SourceType` / `AdapterType` value that does NOT conflict with §8 (e.g. a new sanctioned per-tenant adapter that does not enable LinkedIn-style scraping) is gated only by Layer 3's first three requirements (repo creation, deployment approval, ADR). One that DOES conflict (or even appears to) is also gated by Charter-level approval per §12.

---

## 4. Post-Charter Vocabulary Amendment — `candidate_direct` → `talent_direct`

Source: `Aramo-Vocabulary-Amendment-candidate_direct-Rename-v1_0-LOCKED.docx` (2026-05-16). Extracted to `/tmp/aramo-vocab-amend.md`.

### 4a. The rename (verbatim, lines 22-31)

> "Cross-Spec Vocabulary Amendment --- candidate_direct → talent_direct
>
> adapter token `candidate_direct` (and its surface variants --- the prose
> form \"Candidate-Direct\", the kebab-case path/directory form
> `candidate-direct`) contains the substring `candidate`, which the Aramo
> Rule 5 vocabulary gate forbids in product source. […]
>
> The token is renamed, across all five specs, to `talent_direct` (prose
> form \"Talent-Direct\", path/directory form `talent-direct`)."

### 4b. The four-form rename (verbatim, lines 101-114)

> "| snake_case enum      | `candidate_direct`   | `talent_direct`             |
> | prose / heading form | Candidate-Direct     | Talent-Direct               |
> | kebab-case path /    | `candidate-direct`   | `talent-direct`             |
> | deployable name      | Candidate-Direct     | Talent-Direct               |"

### 4c. Apply to Section 3 quotes

Every Charter / Group 2 / API Contracts quote in Section 3 above that mentions `candidate_direct`, `candidate-direct`, `Candidate-Direct`, or `Candidate Direct` reads as the original locked text **before** this amendment. Per the amendment text (line 125), the canonical reading is *"the original locked text with the §1 rename applied at the enumerated occurrences."* The current canonical source-type/adapter-type token is `talent_direct`.

---

## 5. R7 bounded extension — Charter-Level Review for PR-5 enum values

Source: `Aramo-Charter-Review-R7-PR5-LOCKED.md` (2026-05-19). Full text in Section 0e file inventory.

The review's §4 Ruling (verbatim, lines 108-114):

> "The `R7_ALLOWLIST` additions for the three PR-5 paths in §3 are **AUTHORIZED**.
> The PR-5 occurrences of `linkedin` are Group-2-§2.2-pinned data-model enum
> values recording provenance/type; they do not constitute LinkedIn scraping or
> integration; Charter R7's intent is not violated and remains fully in force
> for all runtime LinkedIn-integration paths."

The review is a worked example of how a Charter-level review is conducted under the §12 stewardship process — the only such review in the locked folder. It does NOT amend Charter §8 or the Phase 4 prohibited list; it bounds three repo paths into the `verify-vocabulary.sh` R7_ALLOWLIST.

---

## 6. What was NOT found in the locked folder

Per the "VERBATIM ONLY — do not reconstruct" rule:

- **There is no per-rule "R1" / "R2" / … numbering in the Charter itself.** The repo's R1–R13 numbering is derived, not Charter-canonical.
- **There is no longer-form Charter-level amendment workflow** (no SLA, gate sequence, required artifact format) beyond the three §12 bullets and the Status-block re-justification rule.
- **There is no Charter-level definition of "entrustment"** — the only Charter mention is §4 "Entrustability is computed, not assumed" and §7 "Entrustability Threshold" as one of the ten Group 2 specs.
- **There is no Charter-level definition of "Sourcing Service"** (a sibling sourcing service is not discussed in Charter v1.0). The Charter §11 Deferred (Phase 2+) list does NOT include open-web sourcing; it lists: "Cross-tenant graph features / Full-time hiring mode / External ATS integrations / Structural role-family differentiation."
- **There is no Charter §13+** — the Charter ends at §12 Stewardship + a Closing paragraph.

---

## Appendix — Source file paths

- Charter: `/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/locked/Aramo-Charter-v1.0-LOCKED.docx`
- Group 2 Baseline: `/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/locked/Aramo-v1-Group2-Consolidated-Baseline-v2.0-LOCKED.docx`
- API Contracts: `/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/locked/Aramo-API-Contracts-v1.0-Phases-1-6-LOCKED.docx`
- Vocabulary Amendment: `/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/locked/Aramo-Vocabulary-Amendment-candidate_direct-Rename-v1_0-LOCKED.docx`
- R7/PR-5 Charter-Level Review: `/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/locked/Aramo-Charter-Review-R7-PR5-LOCKED.md`

Intermediate pandoc markdown (do not treat as canonical — verify against source if quoting in another document):
`/tmp/aramo-charter.md` (423 lines), `/tmp/aramo-group2.md` (3150 lines), `/tmp/aramo-api-contracts.md` (1924 lines), `/tmp/aramo-vocab-amend.md` (420 lines).
