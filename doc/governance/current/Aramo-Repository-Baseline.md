# Aramo — Repository Baseline (Current State)

> **Type:** Durable CURRENT-STATE index. This is a grounded navigation document —
> it tells a future Architect / Lead / Claude / Claude-Code session what is actually
> built today, what remains open, and where governance and substrate differ.
>
> **This file does NOT replace** the Charter, Architecture, Group 2, API Contracts,
> ADRs/DDRs, locked directives, or closure records. Those remain the authorities.
> When a fact here becomes false, **replace it in place** — this is not a history log.
> Do not append CI counts, branch names, transient test totals, or merge narrative.

## 1. Authority SHA & recon date

- **Authority:** `origin/main = ca0974090724b36b130f4d39ea5b1ef486d6adf4` (PR #589 — placement lifecycle product surface)
- **Recon date:** 2026-08-09 (SHA-bound; origin/main verified stable across the recon window)
- **Evidence:** full SHA-bound recon `SEG-01…SEG-08` under [`doc/governance/recon/2026-08-09/`](../recon/2026-08-09/) (see §14)

## 2. Repository shape

| Dimension | Current value |
|---|---|
| Apps | **6** — `api` (aramo-core monolith), `ats-web`, `auth-service`, `platform-admin` (API deployable, no web surface), `platform-web`, `portal-web` |
| Libs | **60** |
| Live PostgreSQL schemas | **38** (39 `CREATE SCHEMA`, `talent` dropped) |
| HTTP routes | **242** across 55 controllers |
| OpenAPI-documented operations | **70** (ats 28, portal 15, platform 12, auth 7, common 6, ingestion 2) |
| Undocumented routes | **172** (route↔handler parity not gate-checked — see §8) |
| Seeded scope keys | **111** (`SEED_SCOPE_KEYS`) + **4** platform scopes (`PLATFORM_SCOPE_KEYS`); id-map bijection **holds** (guard-enforced) |
| Roles | 14 |
| Error codes | **75**; triple-parity holds (tuple == HTTP map == OpenAPI enum) |
| Outbox tables | 5 (canonicalization, consent, selection, placement, submittal); single drainer `libs/outbox-publisher` |
| Reset inventory | DELETE **20** targets · PRESERVE 7 · freeze 19 · **restore paths 0** (reset is one-way) |

**Pact roots / provider relationships:** consumer roots present **6** · tracked/executed **5**
(auth-service-consumer, prohibited-source-type, ingestion-consumer, portal-thin, ats-web).
Provider **`aramo-core`** verifies **4** (ats-web, ingestion-consumer, portal-thin, prohibited-source-type).
Provider **`aramo-auth-service`** verifies **1** (auth-service-consumer, a separate provider).
`tenant-console-consumer` is a phantom root (dir present, untracked, retired).

## 3. Architectural spine — capability-complete (built & merged)

- **Identity model — ATS-as-Heart (ADR-0016):** `libs/talent-record` = person SOR; `identity_index` is PII-free (no `tenant_id`, no PII; CI-guarded); consent keyed to TalentRecord.
- **Pipeline ⊥ ATS wall (ADR-0029 Pipeline-Boundary / I15):** nx boundary tags enforce; cross-L3 by UUID ref + versioned Pact connector only. *(Identifier corrected from provisional ADR-0017 under G-REC-1; ADR-0017 is RDS-DR.)*
- **Requisition lifecycle (Track 1):** `RecruitingStatus` enum (9 values), action-per-transition, `REQUISITION_STATUS_GATED`.
- **Placement core seams (Track 3, E1–E7):** placement spine, pre-start requirements, fall-through reason registry, offer outbox, client-talent restriction, replacement authorization, pipeline-uniqueness removal.
- **Capacity truth (Track 4):** see §4.
- **Policy engine (ADR-0024):** `PolicyDecisionRecord` append-only, fail-closed, seed=DATA.
- **Auth decoupling (ADR-0021):** auth-owned ports + app-local adapters, zero nx edges (only open item = batched 5a/5b post-deploy login proof).
- **Supporting complete:** sourcing (SRC-1/2, Indeed webhook dark), portal P1–P4, settings, platform-console INC-3, front-door PR-0/1/2.

## 4. Track 4 — Contract Assignment & Capacity Truth (durable state)

- **Increment 1 MERGED:** `ContractAssignment` authority + persistence; ACTIVE→ENDED lifecycle with ending-reason taxonomy (COMPLETED / WORKER_ENDED / CLIENT_ENDED); assignment-aware one-live guard; `assignment:end` live op + behavioral RBAC.
- **B2 MERGED (#588):** **capacity authority = placement / ContractAssignment only.** Public `openings_available` is **DERIVED** = `max(capacity_balance, 0)`; the **stored column was DROPPED**; the Pipeline decrement/restore path and `REQUISITION_NO_OPENINGS` 409 are retired.
- **E MERGED (#589):** **placement product surface** — Placements nav + `/placements` board + `/placements/:id` detail composing PlacementCard + PlacementEventTimeline + AssignmentLifecyclePanel. Safe END = ACTIVE-only + `assignment:end` (**`placement:*` never satisfies**). No capacity UI.
- **Deferred seams (by authority, not defects):** placement lifecycle **transition-write** (affordances render only with an `onAction` handler; detail mounts without one); `assignment:create` / `assignment:update` (catalog + seed present, **no live producer**); `REQUISITION_NO_OPENINGS` FE dead-handler cleanup (`apps/ats-web/src/pipeline/error-messages.ts`).
- **DEPLOYMENT-ORDER CONSTRAINT (hard):** B2 requisition reads now depend on the `placement.ContractAssignment` chain, and the B2 migration DROPs the stored column. **Migration MUST precede application rollout** (app-before-migration makes requisition reads fail). Enforced generically by `deploy/migrate-prod.sh`. *(Not yet reflected in `doc/go-live-known-limitations.md`.)*

**Track 4 is NOT complete** (create/update ops + transition-write UI + full deploy remain).

## 5. Track 2 — Selection / Submittal (IMPLEMENTATION / GOVERNANCE CLOSED; MERGED; production reconciliation separate)

- **Track 2 implementation is CLOSED on `main`.** T2-P1 (Submittal schema relocation), T2-P2 (Selection domain canonicalization), T2-P3 (public contract flip), and T2-P3B (pre-GA naming completion + Selection-native migration rebaseline, PR #617, merge `743769243e96a1919ae6be874bd742ca2c42bb5f`) are all **MERGED / NOT DEPLOYED**. Governance close-out = T2-P4 (see `doc/t2-closure-record-draft.md`). Full Track-2 detail, correction lineage, and the production-divergence boundary live in that closure record. Architecture authority: `Aramo-T2-ARCH-Selection-Submittal-Architecture-Ruling-v1_0-LOCKED` (v2.3). The canonical Master Execution Ledger is a LOCKED OneDrive artifact (latest v1.13); the T2 MERGED/close-out status carries there under separate Architect authority.
- **Selection is canonical; `libs/engagement` and `@aramo/engagement` are ABSENT.** The domain lives in `libs/selection` (`TalentSelection`, `TalentSelectionEvent`, `SelectionState`, `SelectionEventType`, PrismaService, the DeliveryProvider / AI-draft message-delivery port, closed-list state/event tuples). Canonical roots: `/v1/selections*`, the three `selection:*` scopes (read, write, message-delivery — tenant-staff family). `ats-web` consumes `/v1/selections` (feature at `apps/ats-web/src/selection`). No live `/v1/engagements` route remains.
- **Physical topology:** `selection` schema owns Selection (`TalentSelection` / `TalentSelectionEvent`, column `selection_id`, plus the Selection `OutboxEvent`); `submittal` schema owns Submittal (`TalentSubmittalRecord` / `TalentSubmittalEvent` + its own `OutboxEvent`); the invalid hybrid `selection."TalentSubmittal*"` was foreclosed. Evidence owns `selection_event_refs` (`ENGAGEMENT_EVENT_REF_NOT_FOUND` was normalized to `SELECTION_EVENT_REF_NOT_FOUND`).
- **Migration baseline:** REPOSITORY = Selection-native (`20260525120000_init_selection_model`); a fresh DB bootstraps Selection directly (no `engagement` schema, no create-then-rename). **PRODUCTION migration state is temporally separate — it AWAITS a separate governed reconciliation** (`doc/runbooks/t2p3b-selection-rebaseline-prod-reconciliation.md`); `tools/db-sync-local.sh` carries a read-only fail-closed guard that blocks (never auto-repairs) a Selection-native apply against the unreconciled Engagement-era production ledger. **Merge ≠ production promotion.**

## 6. Remaining Track 5–T10 (grounded status & dependencies)

> These belong to the **Requisition Enterprise Program (Track 0–10)** scheme (Planning-Package + Ledger v1.1). The **current authoritative Ledger v1.6 carries only Tracks 1–4**; T5–T10 are not fully carried forward (see §7).

| Track | What it is | Grounded status | Key dependency |
|---|---|---|---|
| **T5** | Commercial terms / person-specific effective-dated rates | NOT-STARTED / new product (no rate columns on ContractAssignment; `rate_card_id` stub at `libs/requisition/prisma/schema.prisma:264`) | Dependency **root** for T6/T7/T9-margin |
| **T6** | Assignment revisions / extensions | NOT-STARTED; Planning enum **superseded** by Track 4 binary ACTIVE/ENDED (model shape needs re-derivation) | Builds on T4 + T5 |
| **T7** | Permanent placement + guarantee | NOT-STARTED (no `PermanentPlacement` model) | T5 |
| **T8** | Connector program — provider-neutral integration foundation (formerly scoped "VMS ingestion") | **Connector-A MERGED / CLOSED / NOT DEPLOYED** (PR #628, merge `3aba5ff`); **Connector-B DEFERRED / NOT STARTED** — requires separate activation governance; **first provider NOT SELECTED**; **requisition update/upsert NOT AUTHORIZED** (T8-P2 CREATE-only). Carry-forward record: [`doc/t8-connector-a-closure-and-connector-b-deferment.md`](../../t8-connector-a-closure-and-connector-b-deferment.md) | Most parallelizable (ownership boundary) |
| **T9** | Reporting / operational analytics | PARTIALLY-BUILT (reporting/export/visibility infra exists; named analytics — fill rate, time-to-fill, fallthrough, margin — absent) | Margin analytics depends on T5 |
| **T10** | Cross-module UX polish | ONGOING by design (placement nav is the latest increment) | Shared FE client |

## 7. Governance issues (open)

- **Ledger reconciled to v1.7 (G-REC-1, 2026-08-09):** v1.7 supersedes v1.6, carries #588/#589 (T4-B2 COMPLETE, T4-E COMPLETE, Track 4 OPEN), and canonicalizes T5–T10. v1.6 preserved historical.
- **ADR-0017 double-assignment — RESOLVED:** Pipeline-Boundary-Modular-Monolith re-homed to **ADR-0029** (identifier corrected, decision unchanged); **ADR-0017 remains RDS Disaster Recovery Strategy**. (Weaker parallel 0016 collision: LOCKED RDS vs non-LOCKED Identity-Realignment — remains OPEN governance hygiene, not fixed this increment.)
- **T5–T10 canonicalized into the current ledger (v1.7 §5)** as ACTIVE REMAINING PROGRAM; they previously survived only in Ledger v1.1 as unreconned `[S]`.
- **Binary-authority inspection blind spots:** Charter, Architecture v2_1/v2_2, API-Contracts, Delivery-Plan v1.2–1.5, and M0–M2 closures are `.docx` — unverifiable beyond `.md` mirrors; Architecture v2_2 (15 KB) is smaller than v2_1 (35 KB), so replace-vs-delta is unknown. ADR-0021/0028 + conceptual 0016/0017 exist in OneDrive but are absent from the git-tracked repo.

## 8. OpenAPI route ↔ handler drift gap

`openapi:drift-check` (`ci/scripts/compare-spec-to-openapi.ts`) verifies **`$ref` integrity only** — it walks `openapi/*.yaml` and confirms every JSON-pointer target resolves. **It never reads a controller/handler.** There is no route→OpenAPI check and no OpenAPI→route check in either direction. Consequently the **172 undocumented routes are invisible** to the gate, and a GREEN drift-check does **not** establish public-route contract parity. A bidirectional route/spec coverage gate is an open follow-up.

## 9. Auth / error / event — durable posture

- **Scopes:** 111 seeded + 4 platform; strict catalog↔id-map bijection holds (guard `scope-catalog-parity.spec.ts`); creation-parity guarded (D-SEED-SCOPES-1). No SERVICE or EXTERNAL scope family exists. Rename-sensitive scopes: `compensation:*` (8), the 3 `pre_start_requirement` PROTECTED_ZERO_GRANT scopes, `talent:search`, `platform:tenant:lifecycle:manage`, `assignment:end`, `placement:replace`.
- **Errors:** 75 codes, triple-parity holds. `REQUISITION_NO_OPENINGS` is retired (no producer) but retained in all three registries plus a live FE dead-handler — deferred cleanup.
- **Events:** 5 identical-shape `OutboxEvent` tables; `event_type` is a String (not an enum); `published_at` NULL = unpublished. Append-only event logs (TalentSelectionEvent, TalentSubmittalEvent, PlacementProcessEvent, PipelineStatusHistory, RequisitionLifecycleEvent, consent/identity/evidence/ai-draft/usage/policy records) are **historical evidence** — never infer an event rename from a code/module rename (the Engagement→Selection event/enum rename in Track 2 was an explicit, separately-authorized pre-GA normalization, not an inferred one). Frozen wire/history enums: SelectionState, SubmittalState, PlacementState, PipelineStatus, RecruitingStatus.

## 10. Frontend / product — durable posture

- **ats-web:** recruiter SPA; all routes mounted under `RecruiterShell` with per-route `RouteGuard requireScope`; 25 recruiter routes + a 26-entry `admin/*` subtree. Placement surface as in §4.
- **platform-web:** platform-operator SPA (Dashboard, Tenants), gated `platform:tenant:read`; no E2E.
- **portal-web:** passwordless person / data-subject portal (records, verified identity, disputes, notice, delete-my-identity); no E2E.
- **E2E:** `apps/ats-web/e2e/surfaces.spec.ts` (7 Playwright tests) is authored but **not executed in CI** (CI runs `nx affected -t test` only); the live ACTIVE→END assignment path is fixture-blocked (component-proven only).
- **Nav-orphan:** `/identity/portal-disputes` (`PortalDisputesView`, `identity:resolve`) is routed but has no nav entry / no link — reachable only by direct URL.
- **Backend without UI:** `assignment:create`/`update`, derived capacity. **UI with deferred backend seam:** placement transition-write, `REQUISITION_NO_OPENINGS` handler.

## 11. Deployment reality

- **MERGED ≠ DEPLOYED.** The repo establishes merge state only; the deployed state of recent merges is not knowable from substrate. The sole deploy workflow builds the public-site image and is not an app apply — application deploy is a manual box procedure.
- **Production business population must NEVER be inferred from the existence of tables or migrations.** Only Track 4 is corroborated ZERO-ROW in-repo; Track 3 / Portal / Identity / Sourcing populations are UNKNOWN from substrate and require a fresh preflight before any data-touching work.
- Hard deploy-order constraint: Track 4 B2 migration-before-app (see §4).

## 12. Current execution doctrine

```
locked authority
  → substrate grounding (SHA-bound recon)
    → classify differences (approved-evolution | historical-artifact | stale-doc |
                            deferred | real-gap | architecture-contradiction | needs-ruling)
      → PO/Architect ruling or architecture amendment
        → filed LOCKED directive
          → implementation (RED-first per-boundary, D-1 binding)
            → Gate-6 commit plan → PO-authorized merge
```

Substrate does not auto-override locked architecture; the ledger does not auto-override
demonstrated substrate. Contradictions are findings requiring disposition, never silent resolution.

## 13. Current next governance actions

1. ~~Refresh Ledger~~ **DONE (G-REC-1):** Ledger v1.7 supersedes v1.6 at origin/main (#588/#589).
2. ~~Rule on ADR-0017~~ **DONE (G-REC-1):** Pipeline-Boundary → ADR-0029; ADR-0017 remains RDS-DR.
3. ~~Canonicalize T5–T10~~ **DONE (G-REC-1):** carried into Ledger v1.7 §5 as ACTIVE REMAINING PROGRAM.
4. ~~Track 2 architecture ruling~~ ~~Track 2 implementation~~ **DONE / CLOSED:** `selection` owns Selection, `submittal` owns Submittal (Architecture v2.3); T2-P1/P2/P3/P3B all **MERGED** (T2-P3B = PR #617, merge `743769243e96a1919ae6be874bd742ca2c42bb5f`). Governance close-out = **T2-P4** (`doc/t2-closure-record-draft.md`). **Repository implementation CLOSED / NOT DEPLOYED; production migration reconciliation is a SEPARATE governed release operation (not complete, not implied by closure).**
5. **Add the B2 migration-before-app constraint** to `doc/go-live-known-limitations.md`.
6. **OpenAPI route↔handler drift gate** — author a bidirectional coverage check over the 172 undocumented routes.
7. **Preflight production population** for any track that touches existing rows.

## 14. Source / evidence

This baseline is derived from the completed SHA-bound repository recon against
`origin/main = ca0974090724b36b130f4d39ea5b1ef486d6adf4` (2026-08-09). The full,
**unmodified, byte-identical** evidence segments (`path:line` grounded) are preserved under
[`doc/governance/recon/2026-08-09/`](../recon/2026-08-09/):

| Segment | Scope |
|---|---|
| `SEG-01-governance.md` | Authority hierarchy (78 docs classified) |
| `SEG-02-modules-domains.md` | Module inventory + domain ownership |
| `SEG-03-persistence.md` | Persistence / migration / outbox |
| `SEG-04-api-pact.md` | API routes + Pact |
| `SEG-05-scope-errors.md` | Scope + error registry |
| `SEG-06-frontend.md` | Frontend product surface |
| `SEG-07-test-deploy.md` | Test-infra + shared surfaces + deployment |
| `SEG-08-ledger.md` | Ledger reconciliation + completion matrix |

**Evidence-surface classification (Architect disposition, 2026-08-09).** The recon evidence
directory is an immutable evidence surface: its segments quote existing identifiers,
scope-family names, error names, and historical vocabulary **verbatim from the substrate**,
so they may contain otherwise-prohibited Tier-2 vocabulary. It is not product/domain prose
and must not be sanitized. `scripts/verify-vocabulary.sh` carries a narrowly scoped Tier-2
exclusion for exactly `doc/governance/recon/2026-08-09/**` (not a broad `doc/governance/**`),
so the evidence stays byte-identical while vocabulary enforcement remains strict everywhere
terminology is authored.
