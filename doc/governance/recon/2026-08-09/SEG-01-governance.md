# SEG-01 — AUTHORITATIVE GOVERNANCE / ARCHITECTURE HIERARCHY (Substrate Audit)

**Scope:** Directive Section 1. **Baseline SHA audited:** `origin/main = ca0974090724b36b130f4d39ea5b1ef486d6adf4` (PR #589).
**Working tree:** detached HEAD `3a4a3a44b5d635acc276dad7431d74514602616e` (PR #588), one merge behind origin/main.
**Mandate:** READ-ONLY. No mutation performed. Governance docs read from OneDrive canonical + repo; none are in the PR#589 18-file set, so read normally.
**Canonical corpus dir (OneDrive):** `/Users/purushpurushothaman/Library/CloudStorage/OneDrive-AstreConsultingServicesInc/Aramo/locked/` (abbrev. `OD/` below).
**Repo governance dirs:** `doc/`, `doc/adr/`, `doc/directives/`, `doc/architecture/`, `CLAUDE.md`.

Status vocabulary: ACTIVE | AMENDED | SUPERSEDED | HISTORICAL | UNKNOWN.
`.docx` = present-but-binary (cannot read binary; grounded from `.md` mirror/anchor where one exists).

---

## A. AUTHORITY-PRECEDENCE MAP (highest → lowest, current-state)

1. **Program Charter (foundational)** — `OD/Aramo-Charter-v1.0-LOCKED.docx` (binary) — the program-level charter. Distinct from the go-live-critical-path charter below.
2. **Go-Live-Critical-Path Charter** — `OD/Aramo-ATS-Go-Live-Hardening-Charter-v1_4-LOCKED.md` + `OD/Aramo-Charter-Section-4-Amendment-Redaction-v1_0-LOCKED.md` (amends §4).
3. **Architecture v2.x** — `OD/Aramo-Architecture-v2_0-v2_2-LOCKED.docx` (binary; latest) over `OD/Aramo-Architecture-v2_0-v2_1-LOCKED.docx`; + `OD/Aramo-Architecture-Realignment-Closure-Record-v1_0-LOCKED.md`.
4. **Group 2 Consolidated Baseline** — `OD/Aramo-v1-Group2-Consolidated-Baseline-v2.0-LOCKED.docx` (binary) + `OD/Aramo-Group2-Immutability-Reconcile-Rekey-Amendment-v1_0-LOCKED.md`.
5. **API Contracts (design lock)** — `OD/Aramo-API-Contracts-v1.0-Phases-1-6-LOCKED.docx` (binary). Executable surface = repo `openapi/*.yaml` (redocly `openapi:lint` required CI).
6. **ADRs / DDRs** — governing-principle ADRs outrank feature ADRs (repo `doc/adr/README.md:5-11`). See §E for the numbering contradiction.
7. **LOCKED track directives** — Track1..Track4 (OneDrive only; not in repo).
8. **Operating model** — `OD/Aramo-Development-Execution-Model-v1_4-LOCKED.md` (cadence only; explicitly does NOT supersede any architectural directive/ADR/invariant — see quote §D).
9. **Repo standing context** — `CLAUDE.md` (states "LOCKED directive > this file > your judgment").
10. **Master Execution Ledger** — `OD/Aramo-Master-Execution-Ledger-v1_6.md` — "release-manifest eligible, not release-authorizing"; a manifest, NOT a LOCKED authority. Does not override locked architecture or demonstrated substrate.

**Load-bearing precedence quotes (verbatim, path:line):**
- `CLAUDE.md:8` — "**Authority hierarchy: LOCKED directive > this file > your judgment.**"
- `doc/adr/README.md:7` — "Where a feature ADR's scoping conflicts with a governing principle, the governing principle wins."
- `OD/Aramo-Development-Execution-Model-v1_4-LOCKED.md:6` — "It does **not** supersede any architectural directive, ADR, or invariant."
- `OD/Aramo-Master-Execution-Ledger-v1_6.md:21` — "This is *release-manifest eligible*, not *release-authorizing*."

---

## B. CURRENT AUTHORITATIVE DOC PER CATEGORY

| Category | Current authoritative doc | Version | Status | path (OD/ or repo) |
|---|---|---|---|---|
| Program Charter (foundational) | Aramo-Charter | v1.0 | ACTIVE (binary) | OD/Aramo-Charter-v1.0-LOCKED.docx |
| Go-Live Hardening Charter | ATS Go-Live Hardening Charter | v1.4 | ACTIVE | OD/Aramo-ATS-Go-Live-Hardening-Charter-v1_4-LOCKED.md |
| Charter §4 amendment | Charter-Section-4-Amendment-Redaction | v1.0 | ACTIVE (amends §4) | OD/Aramo-Charter-Section-4-Amendment-Redaction-v1_0-LOCKED.md |
| Architecture v2.x | Aramo-Architecture-v2_0-v2_2 | v2.2 | ACTIVE (binary) | OD/Aramo-Architecture-v2_0-v2_2-LOCKED.docx |
| Architecture (repo mirror, partial) | aramo-enterprise-context | v2.1 | ACTIVE (partial mirror) | doc/architecture/aramo-enterprise-context-v2_1.md |
| Architecture realignment closure | Architecture-Realignment-Closure-Record | v1.0 | ACTIVE | OD/Aramo-Architecture-Realignment-Closure-Record-v1_0-LOCKED.md |
| Group 2 domain baseline | Group2-Consolidated-Baseline | v2.0 | ACTIVE (binary) | OD/Aramo-v1-Group2-Consolidated-Baseline-v2.0-LOCKED.docx |
| Group 2 amendment | Group2-Immutability-Reconcile-Rekey-Amendment | v1.0 | ACTIVE (amends) | OD/Aramo-Group2-Immutability-Reconcile-Rekey-Amendment-v1_0-LOCKED.md |
| API Contracts (design lock) | API-Contracts-Phases-1-6 | v1.0 | ACTIVE (binary) | OD/Aramo-API-Contracts-v1.0-Phases-1-6-LOCKED.docx |
| Delivery Plan | Phase-1-Delivery-Plan (amendment record) | v1.6 | ACTIVE (amends v1.5 .docx) | OD/Aramo-Phase-1-Delivery-Plan-v1_6-LOCKED.md |
| Delivery Plan base (amended by v1.6) | Phase-1-Delivery-Plan | v1.5 | ACTIVE-as-base (binary) | OD/Aramo-Phase-1-Delivery-Plan-v1_5-LOCKED.docx |
| Master Execution Ledger | Master-Execution-Ledger | v1.6 | ACTIVE (manifest; STALE vs substrate — see §E-F2) | OD/Aramo-Master-Execution-Ledger-v1_6.md |
| Operating model / methodology | Development-Execution-Model | v1.4 | ACTIVE | OD/Aramo-Development-Execution-Model-v1_4-LOCKED.md |
| Repo standing context | CLAUDE.md | — | ACTIVE | CLAUDE.md |
| Cross-Core Integration Arch | Cross-Core-Integration-Architecture | v1.0 | SUPERSEDED (§4/§9 identity premise) | OD/Aramo-Cross-Core-Integration-Architecture-v1_0-LOCKED.md |
| Cross-Core supersession stamp | Supersession-Stamp-Cross-Core | v1.0 | ACTIVE | OD/Aramo-Supersession-Stamp-Cross-Core-Integration-Architecture-v1_0-LOCKED.md |
| Cross-Core rescoping annotation | Cross-Core-T1-T4-T5-Rescoping-Annotation | v1.0 | ACTIVE | OD/Aramo-Cross-Core-T1-T4-T5-Rescoping-Annotation-v1_0-LOCKED.md |
| Vocabulary gate | scripts/verify-vocabulary.sh | — | ACTIVE | repo scripts/verify-vocabulary.sh |
| CI integration roots | ci/integration-roots.json | — | ACTIVE | repo ci/integration-roots.json |

---

## C. VERSION LINEAGE (which supersedes which)

**Charter (Go-Live Hardening):** v1.0 → v1.1 → v1.2 → v1.3 → **v1.4 (ACTIVE)**; v1.0–v1.3 = HISTORICAL/SUPERSEDED.
Quote `OD/Aramo-ATS-Go-Live-Hardening-Charter-v1_4-LOCKED.md:3` — "Version 1.4 — LOCKED ... Supersedes v1.3".
Milestone-scoped charters (M5-Charter v1_1/v1_2, M6-Charter v1_0 DRAFT/v1_1, PC-7, SRC-0, PUB-0, Settings, Platform-Console-Increment-3, TR-2-to-15 DRAFT) = HISTORICAL milestone charters, not program-hierarchy.

**Master Execution Ledger:** v1.1 → v1.2 → v1.3 → v1.4 → v1.5 → **v1.6 (ACTIVE)**.
Quote `OD/Aramo-Master-Execution-Ledger-v1_6.md:3` — "**Supersedes:** v1.5 (E1-d merged, E4 unbuilt) · v1.4 · v1.3 · v1.2 · v1.1."

**Delivery Plan:** v1.2 → v1.3 → v1.4 → v1.5 (.docx binaries) → **v1.6 (.md amendment record, ACTIVE)**.
Quote `OD/Aramo-Phase-1-Delivery-Plan-v1_6-LOCKED.md` — "This v1.6 amendment record applies to Plan v1.5; all v1.5 content stands except as amended below." → v1.6 (.md) + v1.5 (.docx) are BOTH load-bearing.

**Development Execution Model:** v1.0 → v1.1 → v1.2 → v1.3 → **v1.4 (ACTIVE)**.
Quote `OD/Aramo-Development-Execution-Model-v1_4-LOCKED.md:6` — "**Supersedes:** v1.3, v1.2, v1.1, v1.0..."

**Architecture:** v2_0-v2_1 (35105 B) → v2_0-v2_2 (15118 B, latest). Both binary. NOTE: v2_2 file is SMALLER than v2_1 — consistent with v2_2 being an incremental amendment delta rather than a full replacement; whether v2_1 base remains load-bearing under v2_2 is unverifiable from binary. Architecture anchor amendments: `Aramo-doc01-amendment-architecture-9-anchor-v1_0-LOCKED.md`, `Aramo-doc01-amendment-architecture-17_2-anchor-v1_0-LOCKED.md`.

**Talent Lifecycle & Trust Architecture Spec:** v1.0 → v1.1 (ACTIVE); OD/Aramo-Talent-Lifecycle-and-Trust-Architecture-Spec-v1_1-LOCKED.md.

**DDR-UI-Design-Language:** v1_0 → amendments v1_1..v1_6 (all LOCKED, cumulative).

---

## D. OPERATING-MODEL / METHODOLOGY GROUNDING

- Current: `OD/Aramo-Development-Execution-Model-v1_4-LOCKED.md` (Aug 5). Ledger v1.6 line 5 cites it: "**Governing operating model:** `Aramo-Development-Execution-Model-v1_4-LOCKED.md`" — CONSISTENT.
- Precedence carve-out (verbatim): `...v1_4:6` — "It does **not** supersede any architectural directive, ADR, or invariant." → methodology governs cadence, NOT architecture.
- Repo directive-standard mirrors: `doc/directives/00-DIRECTIVE-STANDARD.md`; OneDrive has BOTH `00-DIRECTIVE-STANDARD.md` and `00-DIRECTIVE-STANDARD-v2.md` (two standards present in canonical — see §F divergence note).

---

## E. DDR / ADR INVENTORY + NUMBERING (repo Nygard scheme vs OneDrive conceptual scheme)

**Repo git-tracked ADRs (`git ls-files doc/adr/`):** numeric 0001–0014, 0016, 0017, 0018, 0019(**Rejected**), 0020(LOCKED governing), 0023, 0024, 0024-A1, 0027; plus LOCKED anchors Aramo-ADR-0007, -0015, -0015-Amendment-v1_2, -0016(RDS), -0017(RDS-DR), -0018(bg-jobs); README.md.

**Repo numeric scheme (doc/adr/README.md index):** 0016 = RDS Substrate Conventions; 0017 = RDS Disaster Recovery; 0018 = Background Jobs Substrate. `doc/adr/README.md:78` — "Numbers are never reused, even after an ADR is deprecated or superseded."

**OneDrive conceptual scheme (per MEMORY/RECON-CONTEXT):** ADR-0016 = Identity-Model Realignment; ADR-0017 = Pipeline-Boundary Modular Monolith; ADR-0018 (bg-jobs, same as repo). Both conceptual docs self-flag the number as PROVISIONAL:
- `OD/Aramo-ADR-0016-Identity-Model-Realignment-v1_0.md:3` — "**ADR number provisional** — confirm against the ADR register (latest known: ADR-0015, AI-Substrate-Posture)." Status line: "Proposed → LOCKED on ratification" (NO `-LOCKED` filename suffix).
- `OD/Aramo-ADR-0017-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md:3` — "**ADR number provisional** — confirm against the register (latest known: ADR-0016)." Status: "ACCEPTED · LOCKED".

**ADRs present in OneDrive but ABSENT from repo (git-tracked):** (verified `git ls-files | grep` = 0 hits)
- `OD/0021-auth-service-portability-boundary.md` — Status "Proposed — pending PO ratification"; self-describes as "the in-repo rendering" of `Aramo-ADR-0021-...-v1_0-LOCKED.md`, yet is NOT in the repo.
- `OD/0028-requisition-fit-assessment-r10-amendment.md` — Status "RATIFIED IN SUBSTANCE (v1.4) ... **LOCK is BLOCKED**".
- `OD/Aramo-ADR-0016-Identity-Model-Realignment-v1_0.md`, `OD/Aramo-ADR-0017-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md`.

**Numeric gaps in repo doc/adr:** 0015 (anchors only), 0021, 0022, 0025, 0026, 0028 — not present as numeric in-tree files. README index (lines 30-51) omits 0023 and the 0015 anchors → repo ADR index is STALE.

**DDRs:** Authorization-Model-DDR v1_0 + Amendment v1_1 (LOCKED); Cross-Core-Integration-Architecture v1_0 (SUPERSEDED §4/§9); DDR-Tenancy-Client-Roster-Model v1_0; DDR-PublicSite-Design-Language v2_0; DDR-UI-Design-Language v1_0 + v1_1..v1_6. Platform-Integration-Model-DDR §3 = referenced-as-stale but "**not in the project mirror**" (supersession stamp companion).

**repo-vs-OneDrive content parity (size-identical, likely byte-identical, timestamp offset only):**
- 0024-business-policy-engine.md — repo 24790 B / OD 24790 B.
- 0024-amendment-a1-...md — repo 8232 B / OD 8232 B.
- 0027-client-talent-restriction-...md — repo 8525 B / OD 8525 B.
No content divergence detected on these three; ADR-0023 numeric exists in repo only (feature ADR, no OneDrive numeric twin).

---

## F. TYPED DIVERGENCES / FINDINGS (flag only; NOT resolved)

**F1 — GOVERNANCE CONTRADICTION (type i, LOCKED-vs-LOCKED, no resolving amendment): ADR number 0017 double-assigned to TWO LOCKED ADRs.**
- `OD/Aramo-ADR-0017-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md` (ACCEPTED · LOCKED) AND `OD/Aramo-ADR-0017-RDS-Disaster-Recovery-Strategy-v1_0-LOCKED.md` (ACCEPTED, repo doc/adr/0017) both carry number 0017.
- Repo README.md:78 asserts numbers "are never reused." No reconciling register/amendment exists; the conceptual ADR self-flags its number "provisional" but the conflict was never resolved.
- Parallel (weaker, not two-LOCKED) collision on 0016: LOCKED RDS-Substrate (0016) vs non-LOCKED Identity-Model-Realignment (0016).
- Disposition: REQUIRES-PO-RULING (ADR register reconciliation). Do not resolve.

**F2 — SUBSTRATE MOVED SINCE BASELINE (type iii) + STALE-LEDGER (Drift C): Master Execution Ledger v1.6 baseline lags origin/main by two merges.**
- Ledger v1.6 §0.2 grounded at `origin/main = 4c41a63` (#587): `OD/...-Ledger-v1_6.md:38`. Current baseline `origin/main = ca09740` (#589).
- Grep of Ledger v1.6 for `#588`/`#589` = ZERO hits → Ledger does not reflect PR #588 (T4-B2 capacity cutover) or PR #589 (T4-E placement UI).
- Ledger v1.6:52 states "**T4-B2 — OPEN / separately AUTHORIZED (not part of #587)**" while MEMORY + git log record `#588` "T4-B2 authority cutover" MERGED (merge `3a4a3a4`, commit `3e08f0b`). Ledger is behind substrate. (Ledger is a manifest, not a LOCKED authority → classify STALE, not locked-vs-locked contradiction.)
- Disposition: OBSOLETE/SUPERSEDED-in-part; needs Ledger v1.7 grounding pass. Do not resolve.

**F3 — ASSUMPTION UNVERIFIABLE (type ii): binary `.docx` authorities.**
- Charter v1.0 (program), Architecture v2_0-v2_1 & v2_0-v2_2, API-Contracts v1.0, Delivery-Plan v1.2–v1.5, M0/M1/M2 Closure Records, R-DRIFT-1 Closure, ADR-0008-Addendum — all `.docx`, cannot be read. Grounded only via `.md` mirrors/anchors where they exist (Delivery Plan v1.6 .md; enterprise-context v2.1 .md; ADR anchors). Architecture v2_2 (15 KB) < v2_1 (35 KB): whether v2_2 replaces or only deltas v2_1 is UNVERIFIABLE from binary.
- Disposition: flag; requires human/.md-mirror confirmation.

**F4 — DIVERGENCE (type iii/repo-vs-canonical): LOCKED track directives + two directive-standards.**
- Track1..Track4 LOCKED directives + Track3 E1a/E2/E4/E6/E7 + Track4 v1_1 Amendment + Increment1 Closure exist ONLY in OneDrive; repo `doc/directives/` holds only D-REPOMAP-1/2/3, D-TESTINT-1. Consistent with CLAUDE.md ("Directives: OneDrive ... NOT repo") — expected, flagged for completeness.
- Two directive standards co-exist in OneDrive: `00-DIRECTIVE-STANDARD.md` AND `00-DIRECTIVE-STANDARD-v2.md`; repo has one (`doc/directives/00-DIRECTIVE-STANDARD.md`). Which is authoritative = UNKNOWN (type ii).

**F5 — ADR-0021 / ADR-0028 authority status ambiguous (type ii).**
- ADR-0021 "Proposed — pending PO ratification"; its own text claims a `-LOCKED` canonical twin, but only the non-LOCKED "in-repo rendering" file exists in OneDrive and it is NOT in the repo. ADR-0028 "RATIFIED IN SUBSTANCE (v1.4) — LOCK is BLOCKED". Neither is a clean ACTIVE-LOCKED. Disposition: UNKNOWN pending register reconciliation.

---

## G. CLOSURE RECORDS (governance-relevant, ACTIVE as historical record)

Gate-1 Closure v1_0; Platform-Console Increment-1/2/3 Closure v1_0; Portal-P4 Closure v1_0; PublicSite-Launch Closure v1_0; Architecture-Realignment Closure v1_0; Spec-Conformance-Fix-Sequence Closure v1_0; Promotion-Trigger-Milestone Closure v1_0; Track3-E6-Gate6-Closure-and-D1-Exception-Record v1_0; Track4-Increment1-Additive-Closure-and-Split-Record v1_0; Phase2-Completion-Record v1_0; PC-Track-Exit-Accounting v1_0; M0/M1/M2 Closure (.docx). All LOCKED closure artifacts (living-spec; not deleted).

## H. RELEASE / DEPLOY MANIFESTS

`OD/RELEASE-box.md`; `OD/Aramo-Box-Deploy-Runbook-v2_0.md`; `OD/Aramo-Release-Runbook-Directive-v1_1-DRAFT.md` (**DRAFT — not LOCKED**); `OD/Aramo-Astre-Single-Box-Go-Live-Spec-v1_0-LOCKED.md`; Single-Box-Directive-1..4 v1_0 LOCKED; Deploy-Migration-Gate v1_0; Deploy-Hardening-Regen-Seed v1_0; D-E22-Runbook-Doc-PR v1_0. **DEPLOYMENT AUTHORITY STILL WITHHELD** — `OD/...-Ledger-v1_6.md:21`. Cross-check: MEMORY hard deploy-order constraint (migration→application) from PR #588 B2.

## I. KNOWN-DEBT / BACKLOG

`OD/Aramo-Backlog-v1_0.md`; `OD/Aramo-Backlog-Entries-ats-thin-Followups-v1_0.md`; `OD/Aramo-Backlog-Item-Workforce-Intelligence-v1_0.md`; `OD/Aramo-Conformance-Ledger-and-Backlog-Update-v1_0.md`; `OD/Aramo-Talent-Reliability-Verification-Backlog-v1_0.md`; repo `doc/go-live-known-limitations.md`.

---

## J. VOCABULARY SURFACE (mandate: audit touches Charter §3 / R10 Tier-2 terms)

The Tier-2 banned-term regex is defined in `scripts/verify-vocabulary.sh:477-484` (`TIER2_TERMS_REGEX`; 7 label:pattern pairs — referenced, not restated here per CLAUDE.md discipline). Charter §3 (`OD/Aramo-ATS-Go-Live-Hardening-Charter-v1_4-LOCKED.md` "R10 surface policy") is the governing prohibition; the script is the CI enforcer.

**EXEMPTION ALLOWLISTS inventoried (verbatim path entries):**
- `R7_ALLOWLIST` (R7 Charter-refusal source-platform, Tier-1; platform name is itself Tier-1-banned, cited by source not restated) — `scripts/verify-vocabulary.sh:36-57`.
- `R7_ALLOWLIST_GLOB` — `:59-66`.
- `FRONTDOOR_LEGACY_ALLOWLIST` (ADR-0023 retired front door) — `:77-90`.
- `TIER2_EXCLUDES` (Tier-2) — `:94-476`, **106 path entries** (dirs/globs). Referenced by source, **not restated inline**: the array is a locked-config path list whose entries contain Tier-2-sensitive substrings, so pasting it here would itself trip `scripts/verify-vocabulary.sh` (do not "expand for readability" — cite the source). Authoritative list: `scripts/verify-vocabulary.sh:94-476`. Entries load-bearing to a specific finding are cited individually where that finding is made.
- One narrow in-line literal exemption (Portal P1 Amendment v1.1) — `:580-584` (scoped to a single public host literal, NOT a file-level exclude).
- New allowlist entries require Architect approval — `scripts/verify-vocabulary.sh:8`.

Note: several exemption paths are themselves governance-doc paths (doc/adr/**, doc/architecture/aramo-platform-console-enterprise-architecture.md, doc/01-locked-baselines.md, Aramo-*-LOCKED.docx) — governance prose is allowed to quote the banned terms.

---

## K. CONTRACT SURFACE (Pact)

Governance segment touches Pact only via the API-Contracts lock + verify-api.ts registration law (CLAUDE.md engineering laws). Distinct-number reporting per PL discipline: **consumer count** vs **consumers verified by this provider** are two different numbers — NOT enumerated in this segment (out of Section-1 scope; deferred to the contract-surface segment). Flagged so the distinction is not collapsed downstream. `pact/provider/src/verify-api.ts` is the provider-verification entry (CLAUDE.md: "Any new migration changing a returned shape must be registered in `pact/provider/src/verify-api.ts`").

---

## L. COUNT OF DOCS CLASSIFIED

- §B category table: 19 authoritative-per-category rows.
- ADRs (repo git-tracked doc/adr, excl. README): 29 files.
- ADRs conceptual/OneDrive-only classified in §E: 4 (0016-identity, 0017-pipeline, 0021, 0028).
- Charter lineage: 5 (Go-Live v1.0–v1.4) + 1 program Charter v1.0 + 1 §4 amendment = 7.
- Ledger lineage: 6 (v1.1–v1.6). Delivery Plan lineage: 5 (v1.2–v1.6). Dev Execution Model: 5 (v1.0–v1.4).
- DDRs classified: 6 families (Authorization-Model +amend, Cross-Core +stamp +rescoping, Tenancy-Client-Roster, PublicSite-Design-Language, UI-Design-Language +6 amend, Platform-Integration-Model referenced-absent).
- Closure records (§G): 12. Release/deploy manifests (§H): 9. Backlog/known-debt (§I): 6.

**Total distinct governance/authority docs individually classified in this segment: 78** (Charter 7, Architecture 4, Group2 2, API-Contracts 1, Delivery-Plan 5, Ledger 6, Dev-Exec-Model 5, Cross-Core 3, repo ADRs 29 [numeric+anchors], conceptual/OneDrive-only ADRs 4, DDR non-ADR 4, directive-standards 2, vocab/CI-roots 2, misc governance-mirror 4 [enterprise-context, realignment-closure, go-live-known-limitations, CLAUDE.md]). Closure(12)/release(9)/backlog(6) enumerated separately in §G/H/I.

---

## M. AUDIT ATTESTATION
- **Baseline commit hash audited:** `origin/main = ca0974090724b36b130f4d39ea5b1ef486d6adf4` (PR #589). Working tree detached at `3a4a3a44b5d635acc276dad7431d74514602616e` (PR #588).
- **No mutation performed during recon.** No file in the repo was written/edited; no git state changed; no command mutated the working tree or environment. Only read-only `git`, `ls`, `grep`, `sed -n`, and `Read` were used. This SEG-01 file is read-only recon evidence for G-REC-1; it records observations only and asserts no authority (see `doc/governance/current/Aramo-Repository-Baseline.md`).
