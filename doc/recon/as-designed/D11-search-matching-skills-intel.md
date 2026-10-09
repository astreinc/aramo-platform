# D11 — Search, Matching, Skills & Intelligence (AS-DESIGNED)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED

AS-DESIGNED intent is sourced ONLY from ratified LOCKED directives / ADRs under
`doc/adr/*` (and the one repo-copied LOCKED directive under `doc/directives/`).
Where the governing specification lives only in the canonical OneDrive `locked`
store (not in-repo), that is stated explicitly and NOT synthesized from code.

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
  no-LLM guards (`doc/adr/0031...:48`).
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

## Pipeline-Intelligence ⊥ ATS boundary — ADR-0029 (Accepted, LOCKED)

- **Source:** `doc/adr/0029-pipeline-boundary-modular-monolith.md` /
  `doc/adr/Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md`.
- **Intent:** the intelligence pipeline is a modular monolith inside the
  platform; the Pipeline-Intelligence libs never hard-import ATS libs — cross
  by UUID ref + versioned Pact-tested connector contract only; nx boundary tags
  CI-enforce the wall. Grounds AS-BUILT `libs/examination` reading requisition
  state through the `RequisitionStateReader` port rather than importing
  `@aramo/job-domain`.

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

## NO in-repo ADR anchor (governed by OneDrive LOCKED directives only)

The detailed functional specifications for the following D11 capabilities are
NOT present as ratified ADRs in `doc/adr/`; their governing directives live only
in the canonical OneDrive `Aramo/locked` store and are referenced by name in
code comments. AS-DESIGNED intent for these is therefore recorded as "anchor
absent in repo" — it is NOT synthesized from the implementation:

- **Matching / entrustability engine** — Group 2 Baseline v2.0 §2.4–§2.5
  ("Examination Output Specification" + "Entrustability Rule Set") and the M3
  PR-1/PR-2/PR-3 directives (cited in `libs/matching/src/lib/engine.ts:9` and
  `libs/examination/prisma/schema.prisma:8`). No `doc/adr/*` file.
- **Enterprise Search (GS-1 / GS-2A–2C)** — the Enterprise Search directives
  (cited throughout `apps/api/src/search/*` and `libs/talent-embedding/*`).
  No `doc/adr/*` file.
- **Skills taxonomy (SKILL-TAX-1A–1H)** — the SKILL-TAX-1 directive set (cited
  in `libs/skills-taxonomy/*` and `apps/api/src/skill-governance/*`), including
  the dual-`deriveSkillId` DO-NOT-TOUCH invariant. No `doc/adr/*` file.
- **Reporting / dashboard (PR-A7, T9-B1..B5, T7-P4, L2-I)** — the reporting
  directives (cited in `libs/reporting/src/lib/reporting.controller.ts`). No
  `doc/adr/*` file.
- **Metering (PR-A1c)** — the metering directive (cited in
  `libs/metering/src/lib/record-usage.ts:3`). No `doc/adr/*` file.
