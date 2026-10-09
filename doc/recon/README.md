# Aramo — Current-State Architecture & Implementation Baseline

> **Baseline commit (frozen):** `12330b0f5049c97f01022df0b190035933345212` (branch `main`, tip PR #909).
> **Nature:** a read-only, 100% code-grounded reconnaissance snapshot of what the
> repository **implements today**. It is a **current-state baseline, not a newly
> ratified architecture** — it documents what exists before anything is proposed to change.
> **Scope boundary:** no application code, schema, migration, configuration, or
> infrastructure was modified; no existing LOCKED directive or ADR was altered.

## What this is

A full-repository baseline produced by bounded, parallel, domain-by-domain
reconnaissance of the actual source at the frozen SHA, followed by cross-domain
reconciliation and independent adversarial verification. Every substantive
implementation claim is traceable to repository code by `path:line` + symbol at
the baseline SHA. Anything not directly inspected is labelled `NOT VERIFIED`.

### Three strictly-separated categories

| Category | Means | Source of truth |
|---|---|---|
| **AS-BUILT** | What the code does today | Repository code at `12330b0f` (`as-built/`) |
| **AS-DESIGNED** | Ratified architectural intent | LOCKED directives / ADRs, cited by file + section (`as-designed/`) |
| **GAP REGISTER** | Divergences, defects, risks, proposals | Reconciliation of the two (`gaps/G1-gap-register.md`) |

Facts are kept separate from recommendations: AS-BUILT narrative contains only
observed behaviour; recommendations live only in the Gap Register.

## Deliverables

### 15 domain documents (each has an AS-BUILT and an AS-DESIGNED file)

| # | Domain | AS-BUILT | AS-DESIGNED |
|---|---|---|---|
| D01 | System Context, Topology & Monorepo Map | [as-built](as-built/D01-system-context-topology.md) | [as-designed](as-designed/D01-system-context-topology.md) |
| D02 | Database & Domain Data Model | [as-built](as-built/D02-database-data-model.md) | [as-designed](as-designed/D02-database-data-model.md) |
| D03 | Backend API Surface (REST + OpenAPI) | [as-built](as-built/D03-backend-api-surface.md) | [as-designed](as-designed/D03-backend-api-surface.md) |
| D04 | Security: Identity, AuthN/AuthZ, Tenant Isolation & Policy | [as-built](as-built/D04-security-identity-authz.md) | [as-designed](as-designed/D04-security-identity-authz.md) |
| D05 | Talent Domain (Record, Evidence, Intake, Trust) | [as-built](as-built/D05-talent-domain.md) | [as-designed](as-designed/D05-talent-domain.md) |
| D06 | Requisition, Job & VMS | [as-built](as-built/D06-requisition-job-vms.md) | [as-designed](as-designed/D06-requisition-job-vms.md) |
| D07 | Pipeline, Placement & Selection | [as-built](as-built/D07-pipeline-placement-selection.md) | [as-designed](as-designed/D07-pipeline-placement-selection.md) |
| D08 | Submittal, Engagement & Client Policy | [as-built](as-built/D08-submittal-engagement-policy.md) | [as-designed](as-designed/D08-submittal-engagement-policy.md) |
| D09 | Communications, Activity & Recruiting Evidence | [as-built](as-built/D09-communications-activity-evidence.md) | [as-designed](as-designed/D09-communications-activity-evidence.md) |
| D10 | Documents & E-Signature | [as-built](as-built/D10-documents-esignature.md) | [as-designed](as-designed/D10-documents-esignature.md) |
| D11 | Search, Matching, Skills & Intelligence | [as-built](as-built/D11-search-matching-skills-intel.md) | [as-designed](as-designed/D11-search-matching-skills-intel.md) |
| D12 | Sourcing, Ingestion, Import & Résumé Parsing | [as-built](as-built/D12-sourcing-ingestion-import.md) | [as-designed](as-designed/D12-sourcing-ingestion-import.md) |
| D13 | Frontend Architecture & Screen Inventory | [as-built](as-built/D13-frontend-architecture-screens.md) | [as-designed](as-designed/D13-frontend-architecture-screens.md) |
| D14 | Cross-Cutting Platform & External Integrations | [as-built](as-built/D14-cross-cutting-platform-integrations.md) | [as-designed](as-designed/D14-cross-cutting-platform-integrations.md) |
| D15 | Infrastructure, Deployment, Persistence Ops & Quality/Contract Enforcement | [as-built](as-built/D15-infra-deploy-quality-enforcement.md) | [as-designed](as-designed/D15-infra-deploy-quality-enforcement.md) |

### Consolidated reports

- **[G1 — Consolidated Gap Register](gaps/G1-gap-register.md)** — 70 consolidated
  entries (from 74 domain findings, 4 cross-domain merges) with stable ids and
  `src: Dxx-Gy` traceability: **15 confirmed defects**, **34 AS-BUILT⊥AS-DESIGNED
  divergences**, **21 proposed enhancements** (severity: 5 high / 26 medium / 39 low).
- **[C1 — Coverage & Completeness Report](coverage/C1-coverage-completeness.md)** —
  inventory and coverage accounting of every module, route, endpoint, data model,
  and UI screen, with each surface marked inspected or `NOT VERIFIED` and every
  denominator re-derived by command.

### Evidence fragments (traceability)

- `gaps/_fragments/Dxx-*.gaps.md` — each domain's raw gap findings (consolidated into G1).
- `coverage/_fragments/Dxx-*.coverage.md` — each domain's surface counts with the
  derivation command (aggregated into C1).

## At a glance

- 15 AS-BUILT + 15 AS-DESIGNED documents · G1 · C1
- 47 Mermaid diagrams (ERDs, sequence, state, component) derived from code
- ~1,515 `path:line` evidence citations at the baseline SHA
- Coverage axes: backend, frontend, database, infrastructure, security, integrations, workflows

## Method

1. **Parallel domain reconnaissance** — one read-only agent per domain inspected
   the actual source (controllers, services, DTOs, schemas, migrations, OpenAPI,
   frontend components, routing, tests, IaC) and persisted its AS-BUILT /
   AS-DESIGNED documents plus gap and coverage fragments.
2. **Reconciliation** — G1 and C1 were aggregated by reading all on-disk fragments,
   de-duplicating cross-domain findings, and re-deriving every count.
3. **Independent adversarial verification** — a separate read-only pass per document
   resolved a sample of citations against code, re-ran asserted count commands, and
   challenged any overstated exclusivity or invented functionality. Flagged defects
   were corrected and re-verified.

## Verification status

Of 17 verified artifacts (15 AS-BUILT + G1 + C1), 13 passed independent adversarial
verification outright; the remaining 4 (D03, D04, D13, C1) were converged by hand
for single residual count/wording precision items, each with the corrected figure
re-derived directly against code. One verifier-flagged count (D04's "82 files
decorate `@RequireScopes`") was **retained** because it reproduces exactly under a
standard method (`grep -rln '@RequireScopes(' apps libs | grep -v tests` = 82); the
verifier's higher figure came from an unreproducible method.

## Known limitations

- **Largest coverage gap: frontend bodies.** The `.tsx`/`.ts` component inventory is
  enumerated and representative flows are traced, but not every component body was
  line-read (see C1 NOT-VERIFIED register).
- Some contract-parity and runtime-boot surfaces are enumerated but marked
  `NOT VERIFIED` where only static inspection was possible.
- Counts are reproducible at the baseline SHA by the commands recorded beside them;
  they may drift as `main` advances. The snapshot stays pinned to `12330b0f`.

## Process note (recorded for transparency)

During generation, one automated agent ran a branch-switch + fast-forward that
briefly moved the working tree off the baseline onto a later `main`; this was
detected via the verifiers' SHA checks and reverted — the tree was restored to the
frozen baseline `12330b0f` and all documentation is anchored there. No source files
were modified by that event (refs only).

---

*Generated as a read-only reconnaissance baseline. It records current state;
proposals for change live in the Gap Register and are not ratified decisions.*
