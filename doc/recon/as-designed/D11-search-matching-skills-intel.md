# D11 — Search, Matching, Skills & Intelligence (AS-DESIGNED)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED

AS-DESIGNED intent is sourced ONLY from ratified LOCKED directives / ADRs under
`doc/adr/*` (and the repo-copied LOCKED directives under `doc/directives/`), plus
LOCKED directives in the canonical OneDrive `Aramo/locked` store where named.
Where the governing specification lives only in the canonical store (not
in-repo), that is stated explicitly and NOT synthesized from code. Where an
amendment overrides its parent, the amendment governs and that is said.

## Conversation Intelligence — ADR-0031 (Accepted, LOCKED)

- **Source:** `doc/adr/0031-conversation-intelligence-architecture.md` (records
  `Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED`; repo copy
  `doc/directives/Aramo-CI-Conversation-Intelligence-Directive-v1_2-LOCKED.md`).
- **Ownership map (§Decision):** two new bounded contexts — `conversation-transcript`
  (provider-neutral transcript metadata + acquisition/normalization lifecycle,
  integrity hashes, retention classification) and `conversation-intelligence`
  (CI run, immutable Requisition analysis-context snapshot, model/prompt/output-schema
  versioning, AI claims, transcript-span citations, AI draft carrier,
  recruiter-review lifecycle, provenance) — `doc/adr/0031...:46-47`.
- **Grounding + human-in-loop:** every material AI claim traceable to a
  transcript span and an immutable Requisition snapshot; the mutable Requisition
  row is never historical proof (`doc/adr/0031...:51`, `:107-108`). AI draft may
  never become durable without human review; CI never autonomously performs
  qualification/submittal/selection/offer/placement/identity-merge/consent
  mutation (`doc/adr/0031...:53-54`, `:81-85`).
- **LLM substrate:** `libs/ai-draft` is the sole LLM substrate (single-vendor,
  draft-assist only, walled out of deterministic domains); no weakening of
  no-LLM guards (`doc/adr/0031...:48`). Amended for the screening profile by
  INC-3 A1 Part D.2 (below).
- **Async orchestration:** idempotent provider-event inbox + BullMQ + Redis
  gating + row-level attempt counters; NO real message-bus assumed
  (`doc/adr/0031...:50`, `:118`).
- **Provider strategy (§Provider strategy):** provider-neutral; Zoom Phone is
  TARGET V1 but gated on live-tenant transcript-without-recording validation
  (CI-A0 verdict NOT_SUPPORTED / NOT_PROVEN); Teams is the first executable
  proof; no provider summary substitutes for the full transcript
  (`doc/adr/0031...:58-73`).
- **Build authority (§Build authority):** build-start authorized; commit/push/PR
  each need separate Gate-6; merge, deploy, and production
  recording/transcription/AI-processing activation are NOT authorized
  (`doc/adr/0031...:94-100`). This grounds the AS-BUILT DARK posture
  (`CI_PROCESSING_ENABLED` off by default).
- **ARCHITECTURE_HALT:** 23 conditions in directive §30, including the
  R10-forbidden ordinal/ranking judgment semantics and a mutable Requisition
  used as proof (`doc/adr/0031...:76-90`).

### TIP-E2E INC-3 Amendment A1 — Part D (amends CI v1.2, CI-B6P, CI-B7; LOCKED 2026-10-15)
- **Source:** canonical `ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED.md` Part D (`:274-321`)
  and §9 (`:415-447`).
- **D.1 — screening analysis profile:** CI analysis is extended with a screening
  profile that reuses the B3/B4 transcript contracts, run state machine, claims,
  citations and validator (no second engine). For this profile only, the
  Requisition snapshot is **optional** and the context is the immutable
  talent-scoped screening context; implemented as an additive profile
  discriminator + nullable snapshot reference. **This amends** the CI v1.2 rule
  "every CI analysis must bind to immutable Requisition context" for screening
  runs; the mutable-requisition-never-proof rule is preserved. Output classes add
  `screening_question` and `screening_finding_draft`, which stay drafts until a
  recruiter acts.
- **D.1 — Teams path (CI-B5M):** post-meeting Graph transcripts of meetings created
  through the screening meeting path are authorized on the same canonical
  contract.
- **D.2 — CI-B6P:** for the screening profile and the G-1/G-4 assists, the model
  call resolves through the **tenant-selected provider** (TENANT-LLM-2), and
  provenance records the provider/model actually used — **amending** the
  Anthropic-sole-provider clause for these paths. `ai_processing` before every
  model call, no silent fallback, non-streaming and minimization are preserved.
- **D.3 — CI-B7:** recruiter review of AI-drafted screening findings happens in the
  screening domain, not in B7 tables.
- **§9 — provider-neutral external meeting capture:** one signed, idempotent
  capture contract; **no capture vendor is approved**; live assistance fails
  closed unless admission + transcription + ai_processing were confirmed before the
  join.
- **Production gates:** production recording, transcription and AI processing are
  still NOT granted (A1 §11).

## Pipeline-Intelligence ⊥ ATS boundary — ADR-0029 (Accepted, LOCKED)

- **Source:** `doc/adr/0029-pipeline-boundary-modular-monolith.md` /
  `doc/adr/Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md`.
- **Intent:** the intelligence pipeline is a modular monolith inside the
  platform; the Pipeline-Intelligence libs never hard-import ATS libs — cross
  by UUID ref + versioned Pact-tested connector contract only; nx boundary tags
  CI-enforce the wall. Grounds AS-BUILT `libs/examination` reading requisition
  state through the `RequisitionStateReader` port rather than importing
  `@aramo/job-domain`.
- **Superseded in part:** ADR-0029 :63 ("share a repo and a database instance …
  until a forcing function arrives") is superseded **for Talent Intelligence
  only** by ADR-0036 (below). It still governs the `scope:cip` matching /
  examination / skills-taxonomy / talent-embedding libs.

### ADR-0036 + ATI-SEP-1 — ATS / Talent Intelligence separation (Accepted 2026-10-23)
- **Sources:** `doc/adr/0036-talent-intelligence-service.md`; canonical
  `Aramo-ATS-TI-Separation-Program-Directive-v1_0-LOCKED.md` (ATI-SEP-1, PO-ratified
  2026-10-23) and its Addenda A1 (erasure), A2 (PO rulings), A3 (T10 rulings) and
  A4 (portal identity deferral), all LOCKED 2026-10-23.
- **Two products, one contract (ADR-0036 Decision 1):** ATS (`apps/api`) and TI
  (`apps/talent-intelligence-service`) with `scope:ats` ↛ `scope:intelligence`,
  `scope:intelligence` ↛ `scope:ats`/`scope:cip`, both → `scope:shared`; the only
  shared code is `libs/intelligence-contracts`.
- **Own database (Decision 2 / ATI-SEP-1 §3.2, G3):** `aramo_intelligence` with its
  own role and migration ledger; capability `intelligence` default OFF.
- **Integration (Decision 3 / ATI-SEP-1 §3.6):** ATS outbox events with
  business-fact names `talent.created`, `talent.profile_updated`, `talent.erased`
  (A2 E-1 **supersedes** ATI-SEP-1 §3.6's `talent.profile_changed`); TI →
  ATS change notification by HMAC webhook, then ATS reads the TI API and applies
  the per-tenant sync policy; recruiter-confirmed values never silently
  overwritten; `intelligence_link` recorded.
- **Admission classes (Decision 4 / §3.5):** Class A + B admitted, Class C never;
  ATS documents rejected structurally.
- **Golden identity (Decision 5 / §3.3):** deterministic linking only on VERIFIED
  anchors; unverified matches discovery-only; reversible audited merge/split.
- **Access (Decision 6 / §3.4, Legal L-1):** entitlement + ACTIVE external
  reference required; `TI_CROSS_TENANT_READ_ENABLED` default false. Erasure per
  A1 (**supersedes** the §5 L-2 default): the tenant's reference becomes `ERASED`;
  evidence is retained for audit and is not readable by that tenant.
- **Ownership split (A2 F-1, superseding the §4 F-1 row):** ATS keeps sourcing,
  screening, within-tenant advisories, **matching** and all recruiter decisions;
  TI owns evidence, verification, trust and enrichment only, and never gates an
  ATS decision. Screening findings are ATS-private (Class C).
- **Skills taxonomy + matching configuration (A2 A-c, superseding the §4 A-c row
  that made skills taxonomy `scope:shared`):** platform-owned reference data and
  configuration, governed **in `apps/platform-admin`** behind platform-operator
  authorization; tenants consume and cannot edit; ATS matching execution stays
  ATS-side.
- **Supersessions recorded by ATI-SEP-1 §2:** Talent-Lifecycle & Trust Spec v1.1
  items, TALENT-INTEL-1 Gate-5 Ruling 30, Security-S1 :11/:14, TIP-E2E :30 and
  DEF-7, and ADR-0029 :63 (TI only). TR-SCREEN-1 DDR's `SCREENING_FINDING`
  trust-ledger write is overtaken by A2 F-1 (screening findings ATS-private).
- **Authorization:** merge, deploy and PROD migration (including destructive legacy
  schema drops) are NOT authorized by the directive (§5).

## R10 boundary / no recruiter ordinal rating — ADR-0019 (REJECTED, retained)

- **Source:** `doc/adr/0019-manual-recruiter-rating-r10-boundary.md`
  (**Status: REJECTED**, PO-confirmed Lead ruling 2026-06-16).
- **Ruling (`doc/adr/0019...:7-30`):** Aramo deliberately does NOT let recruiters
  rate or ordinally sort talent — that refusal is a product moat. No
  `pipeline.rating` column, no ordinal-scale UI. The "this one matters" need is
  served by the existing non-ordinal `is_hot` flag + the activity/log-note feed.
- **R10 forbidden set (`doc/adr/0019...:60-72`):** Aramo Core automated judgment
  (tier, match output, examination output — `entrustability_tier_raw`,
  `examination_id`, `why_matched_sentence`, `strengths`, `gaps`, `risk_flags`,
  `confidence_indicators`, ordinal-ordering fields) must NEVER reach the
  talent-facing Portal. This grounds the AS-BUILT match-list Summary-only
  contract and the R10 negative-shape gates.
- **Caveat:** this ADR's *proposal* (a permitted manual rating) is REJECTED;
  only the R10 boundary restatement is ratified intent.

## Background-jobs substrate — ADR-0018 (Accepted, LOCKED)

- **Source:** `doc/adr/0018-background-jobs-substrate.md` /
  `doc/adr/Aramo-ADR-0018-Background-Jobs-Substrate-v1_0-LOCKED.md`.
- **Intent:** standardize the BullMQ pattern (manualRegistration + lazyConnect +
  Redis gating), Decision 8 (skill-canonicalization processor parked as NO-OP at
  its origin PR), Decision 1 (matching lib pattern reused). Grounds the AS-BUILT
  matching / skill-canonicalization / embedding / CI processor wiring and the
  Redis-gated `onApplicationBootstrap` registration.

## AI substrate posture — ADR-0015 (LOCKED)

- **Source:** `doc/adr/Aramo-ADR-0015-AI-Substrate-Posture-v1_0-LOCKED.md`
  (+ Amendment v1.2 for JD/Golden-Profile generation). Anthropic SDK + AWS
  Secrets Manager + `libs/ai-draft` as the single declared AI-draft substrate;
  grounds the CI Anthropic model-provider adapter and the embedding provider
  custody model.
- For the CI screening profile and the screening question-plan / follow-up
  assists, INC-3 A1 Part D.2 routes the model call through the tenant-selected
  provider (canonical `Aramo-TENANT-LLM-2-Multi-Provider-BYO-Model-Directive-v1_0-LOCKED.md`);
  on those paths that amendment governs over the single-vendor posture.

## NO in-repo ADR anchor (governed by OneDrive LOCKED directives only)

The detailed functional specifications for the following D11 capabilities are
NOT present as ratified ADRs in `doc/adr/`; their governing directives live only
in the canonical OneDrive `Aramo/locked` store and are referenced by name in
code comments. AS-DESIGNED intent for these is therefore recorded as "anchor
absent in repo" — it is NOT synthesized from the implementation:

- **Matching / entrustability engine** — Group 2 Baseline v2.0 §2.4–§2.5
  ("Examination Output Specification" + "Entrustability Rule Set") and the M3
  PR-1/PR-2/PR-3 directives (cited in `libs/matching/src/lib/engine.ts:12`, `:20` and
  `libs/examination/prisma/schema.prisma:8`). No `doc/adr/*` file. The §2.5
  Threshold Calibration knobs are now platform-owned configuration per ATI-SEP-1
  A2 A-c (above); the Rule Set itself is not policy-editable (code comment only;
  no ratified text read beyond A2).
- **Examination in the end-to-end journey** — canonical
  `Aramo-Talent-Intelligence-Enterprise-Architecture-Delivery-Directive-v1_0-LOCKED.md`
  (ARAMO-TIP-E2E-ARCH-DELIVERY, LOCKED 2026-10-12) §0 and §1.1–§1.2: the journey
  uses the existing deterministic engine to mint the mandatory
  `TalentJobExamination`; `POST /v1/examinations` is retained, not dark-flagged;
  no matching-policy revision, trust→matching bridge, or screening-driven tier
  change is authorized by that directive. Its §1.3 (Talent Trust as the single
  evidence authority) is superseded by ATI-SEP-1 §2 / §3.
- **TIP-E2E INC-2 read seam** — canonical `ARAMO-TIP-E2E-INC-2-v1.0-LOCKED.md`
  (LOCKED 2026-10-13) §3 and §7: three read ports
  (`REQUISITION_CONTEXT_READ_PORT`, `AUTHORIZED_TALENT_RETRIEVAL_READ_PORT`,
  `TALENT_DOSSIER_READ_PORT`) as interfaces + DI tokens in a thin `scope:ats`
  contract lib; adapters in apps/api composing owner repositories (no new
  cross-schema raw SQL); requisition context under actor visibility (never
  `findByIdAdmin`); adapter-enforced contact-PII suppression; dossier port
  "presents, never computes"; mandatory adapters by required constructor DI; the
  real consumer is Talent-360 (§7A). Its §3.3 backing by `talent_trust` is
  superseded by ATI-SEP-1 (dossier outcomes now come from TI's tenant view).
- **Technical screening (INC-3 + A1)** — canonical
  `ARAMO-TIP-E2E-INC-3-v1.0-LOCKED.md` and `ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED.md`
  (LOCKED 2026-10-15): a separate `technical_screening` producer domain with
  session / findings / confirmation / publication, AI-assisted question plan and
  follow-ups (ai_processing-gated), and no production activation by either
  document. Companion `Aramo-TR-SCREEN-1-DDR-v1_0-LOCKED.md` (trust-ledger
  `SCREENING_FINDING`) is overtaken by ATI-SEP-1 A2 F-1 (above).
- **Enterprise Search (GS-1 / GS-2A–2C)** — the Enterprise Search directives
  (cited throughout `apps/api/src/search/*` and `libs/talent-embedding/*`).
  No `doc/adr/*` file.
- **Skills taxonomy (SKILL-TAX-1A–1H)** — the SKILL-TAX-1 directive set (cited
  in `libs/skills-taxonomy/*` and `apps/api/src/skill-governance/*`), including
  the dual-`deriveSkillId` DO-NOT-TOUCH invariant. No `doc/adr/*` file. Governance
  placement is now constrained by ATI-SEP-1 A2 A-c (platform-owned, platform-admin).
- **Reporting / dashboard (PR-A7, T9-B1..B5, T7-P4, L2-I)** — the reporting
  directives (cited in `libs/reporting/src/lib/reporting.controller.ts`). No
  `doc/adr/*` file.
- **Metering (PR-A1c)** — the metering directive (cited in
  `libs/metering/src/lib/record-usage.ts:3`). No `doc/adr/*` file.
