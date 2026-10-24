# Aramo — Current-State Architecture & Implementation Baseline

> **Baseline commit (frozen):** `680907fc06620845944794e0a529918c980f5124` (branch `main` after PR #1007, 2026-10-24; refreshed from `12330b0f`, PR #909, 2026-10-09).
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
| **AS-BUILT** | What the code does today | Repository code at `680907fc` (`as-built/`) |
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

- **[G1 — Consolidated Gap Register](gaps/G1-gap-register.md)** — 115 consolidated
  entries (from 123 domain findings, 8 cross-domain merges) with stable ids and
  `src: Dxx-Gy` traceability: **27 confirmed defects**, **58 AS-BUILT⊥AS-DESIGNED
  divergences**, **30 proposed enhancements** (severity: 6 high / 35 medium / 74 low);
  **106 open, 9 RESOLVED at 680907fc** (RESOLVED entries keep their ids). At
  12330b0f: 70 entries (15/34/21; 5/26/39).
- **[C1 — Coverage & Completeness Report](coverage/C1-coverage-completeness.md)** —
  inventory and coverage accounting of every module, route, endpoint, data model,
  and UI screen, with each surface marked inspected or `NOT VERIFIED` and every
  denominator re-derived by command against `680907fc` (10 apps, 80 libs, 131
  controllers, 667 handler decorators, 54 schemas / 283 models / 314 migrations,
  9 OpenAPI specs / 435 path-items), plus the method corrections where an old
  count came from an on-disk grep.

### Evidence fragments (traceability)

- `gaps/_fragments/Dxx-*.gaps.md` — each domain's raw gap findings (consolidated into G1).
- `coverage/_fragments/Dxx-*.coverage.md` — each domain's surface counts with the
  derivation command (aggregated into C1).

## At a glance

- 15 AS-BUILT + 15 AS-DESIGNED documents · G1 · C1
- 62 Mermaid diagrams (ERDs, sequence, state, component) derived from code
  (`find doc/recon -name '*.md' -exec grep -c '^```mermaid' {} + | awk -F: '{s+=$2} END{print s}'`)
- 3200 `path:line` evidence citations at the baseline SHA across all recon
  documents (`find doc/recon -name '*.md' -exec grep -ohE '[A-Za-z0-9_./-]+\.(ts|tsx|prisma|yaml|sql|json|sh|mjs|conf|template|tf):[0-9]+' {} + | wc -l`;
  a token-volume count, not a count of independently verified claims)
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

Pending verification of the refresh.

## Known limitations

- **Largest coverage gap: frontend bodies.** The `.tsx`/`.ts` component inventory is
  enumerated and representative flows are traced, but not every component body was
  line-read (see C1 NOT-VERIFIED register).
- Some contract-parity and runtime-boot surfaces are enumerated but marked
  `NOT VERIFIED` where only static inspection was possible.
- The new Talent Intelligence service (`apps/talent-intelligence-service`,
  `libs/intelligence-core`) is enumerated at controller / route / model level, but
  most of its bodies are `NOT VERIFIED`.
- Whether migrations are applied in any live database (including the destructive
  ATI-SEP-1 legacy-schema drop and the separate TI database) is out of a static
  pass and is `NOT VERIFIED`.
- Counts are reproducible at the baseline SHA by the commands recorded beside them;
  they may drift as `main` advances. The snapshot stays pinned to `680907fc`.

## Process note (recorded for transparency)

During generation, one automated agent ran a branch-switch + fast-forward that
briefly moved the working tree off the baseline onto a later `main`; this was
detected via the verifiers' SHA checks and reverted — the tree was restored to the
frozen baseline `12330b0f`, to which that original pass is anchored. No source files
were modified by that event (refs only).

Refreshed on 2026-10-24 from 12330b0f to 680907fc (514 commits, 70 merged PRs) by parallel domain agents, then reconciled and independently verified; the C1 coverage files, previously untracked because of a generic coverage ignore rule, are now tracked.

---

*Generated as a read-only reconnaissance baseline. It records current state;
proposals for change live in the Gap Register and are not ratified decisions.*
