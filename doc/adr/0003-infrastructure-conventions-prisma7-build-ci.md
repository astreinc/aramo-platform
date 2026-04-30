# ADR-0003: Infrastructure Conventions (Prisma 7 + Build/CI Patterns)

**Status:** Accepted

**Date:** 2026-04-30

---

## Context

PR-2 (`feat: PR-2 consent grant contract + ledger foundation`, merged as commit `35b7d52`) implemented the program's first real product surface — `POST /v1/consent/grant`, the `TalentConsentEvent` ledger model, and supporting common / auth infrastructure. In doing so it surfaced eight infrastructure precedent decisions that are not locked in Architecture v2.0, API Contracts v1.0, or the Phase 1 Delivery Plan v1.1. Six of these were caused by Prisma 7's API differences from Prisma 6 — most publicly-available Prisma examples are still written against Prisma 6, and the locked baselines name "Prisma" as the ORM without prescribing which major version's mechanics apply. The remaining two were caused by Nx + TypeScript build mechanics that the locked specs explicitly leave to per-PR resolution: the cross-lib import resolution pattern needed for `@nx/js:tsc` and the per-job CI step required to regenerate the gitignored Prisma client on a fresh clone.

This ADR captures those decisions before PR-3 (consent revoke) starts. Without explicit doctrine, the next implementer would face concrete questions — "do I add another `prisma.config.ts` or extend the existing one?", "do I use `migrate dev` or `migrate diff`?", "why do `@aramo/*` imports resolve from `dist/`?" — and answer them by re-deriving, guessing, or blocking on the Lead. Per `doc/04-risks.md` CX2, ADRs are the named mitigation for forgotten architectural rationale; per D4, an ADR locks the pattern before parallel PRs invent variants. This ADR follows the retroactive-precedent pattern established by ADR-0001: PR-2's working tree is the source of truth for the decisions, and this document is the rationale-recovery mechanism for everything that comes after.

---

## Decision

### Decision 1 — Prisma 7 configuration model: workspace-root `prisma.config.ts`

**What.** A workspace-root `prisma.config.ts` carries `DATABASE_URL` for the Prisma CLI (via `dotenv/config` + `defineConfig`). Module-level `schema.prisma` files declare only the datasource provider, generator, schemas, and models — no `url` line.

**Why.** Prisma 7 removed the `url = env("DATABASE_URL")` property from the `schema.prisma` datasource block; the CLI no longer reads it from there. Validation (`prisma validate`) emits error code P1012 against any `schema.prisma` that retains the line. Supplying the URL via `prisma.config.ts` is the supported Prisma 7 path for the CLI; the runtime client receives its URL separately via Decision 3.

**Current state.** `prisma.config.ts` points at `libs/consent/prisma/schema.prisma` because consent is the only module with models in PR-2. The other three module schemas (`libs/audit`, `libs/auth`, `libs/common`) are stub-only and do not need migrations yet.

**Future direction (not a decision yet).** When PR-3+ adds models to a second module, three viable evolutions exist: (i) per-lib `prisma.config.ts` files alongside each schema; (ii) a multi-config workspace root with a module selector; (iii) status-quo with manual rotation of the `schema:` field per command. **Recommended path: (i)** per-lib config files when the second module's models land, because it mirrors the per-module ownership posture from Architecture §7 and stops PR-3+ from racing to edit a shared root file. The decision itself is deferred until a second module surfaces the concrete trade-off; this ADR captures the recommendation, not a binding choice.

### Decision 2 — Prisma client generation contract (CI + developer)

**What.** A workspace-level npm script `prisma:generate` invokes `prisma generate` for every module schema. CI runs `npm run prisma:generate` immediately after `npm ci` in every job that imports the generated client (`build`, `test:unit`, `tests:integration`). Developer machines run the same script after `git clean`, after a fresh clone, or any time the schema changes.

**Why.** The generated client lives at `libs/<module>/prisma/generated/client/` (per Decision 5). The generated tree is gitignored — generated artifacts do not belong in version control — so on any fresh state the client must be regenerated before any compile or test step that imports it. PR-2 originally surfaced this in CI: fresh clones on the GitHub runner had no client, so `build`, `test:unit`, and `tests:integration` all failed at module-resolution time. The fix codifies the regeneration step as a contract, not a one-off PR-2 fix.

**Current script.** `"prisma:generate": "prisma generate --schema libs/consent/prisma/schema.prisma"`.

**Pattern for module growth.** When PR-3+ adds modules with schemas, the script extends with `&&` chains: `prisma generate --schema libs/consent/... && prisma generate --schema libs/talent/... && ...`. CI does not change — every relevant job already runs `npm run prisma:generate` and the script does the right thing for whatever schemas are configured.

**Why not `postinstall`.** A `postinstall` hook would silently run client generation on every `npm install`, including transitive cases (debugging a dependency, CI installing a single package, IDE-triggered installs). Surprise side effects in CI traces and dev workflows are exactly what we want to avoid. The explicit `npm run prisma:generate` step is auditable in the workflow YAML and obvious in dev shells.

### Decision 3 — Prisma 7 driver adapter (`@prisma/adapter-pg`)

**What.** Runtime `PrismaService` constructs the underlying Prisma client with `new PrismaPg({ connectionString })` (from `@prisma/adapter-pg`) passed via the `adapter` option of `PrismaClientOptions`. Postgres-only program; no other adapters are configured.

**Why.** Prisma 7 removed the `datasourceUrl` and `datasources` constructor options from `PrismaClientOptions`. The supported paths are now (a) a driver adapter, or (b) Accelerate. The program is Postgres-only per Architecture §5/§7, so the driver adapter path is the choice. `@prisma/adapter-pg` is the official Postgres driver adapter for Prisma 7.

**Runtime deps.** `@prisma/adapter-pg ~7.8.0`, `pg ~8.20.0`, `@types/pg ~8.20.0` — all tilde-pinned per ADR-0001 Decision 2.

### Decision 4 — Migration generation: `prisma migrate diff`, not `migrate dev`

**What.** Migrations are generated with `prisma migrate diff --from-empty --to-schema <path> --script` (output redirected to the migration file). Manual SQL — for example, the `TalentConsentEvent` `BEFORE UPDATE` immutability trigger — is appended after the auto-generated DDL with a header comment naming the precedent decision the manual SQL enforces.

**Why.** `prisma migrate dev` requires a live database connection (and a shadow database) to compute the diff, which would mean a developer cannot generate a migration without a local Postgres running and would mean code review cannot inspect the migration without spinning up a database. `migrate diff --from-empty --to-schema` is a pure datamodel-to-SQL function: deterministic, no DB needed at code-review time, no shadow-database concept required.

**Trade-off.** `migrate diff` does not maintain the `_prisma_migrations` table or track migration *application*. Migrations are applied at runtime — by integration tests (PR-2's `consent.integration.spec.ts` applies the migration SQL via raw `$executeRawUnsafe` against a Testcontainers Postgres) and, in production, by `prisma migrate deploy` or an equivalent step in a deploy pipeline that does not yet exist. The trade-off is acceptable because the application path is well-defined for both contexts.

**Note on Prisma 7 flag rename.** The CLI flag is `--to-schema` (Prisma 6 had `--to-schema-datamodel`; the rename happened in Prisma 7). PR-2's migration was generated with the new flag.

### Decision 5 — Prisma generator output path: `./generated/client`

**What.** Each module's `schema.prisma` declares `output = "./generated/client"` (relative to the schema file location). The generated client lands at `libs/<module>/prisma/generated/client/`.

**Why.** PR-1's repo-wide exclusion globs (`**/prisma/generated/**` in `.gitignore`, `eslint.config.mjs`, `scripts/verify-vocabulary.sh`, and the `tsconfig.base.json` exclude list; plus `{projectRoot}/prisma/generated/**/*` in `nx.json`'s production input set) were all written to expect the generated output under the module's `prisma/` directory. PR-1's stub schemas had a typo — `output = "../generated/client"` — that resolved one level higher (`libs/<module>/generated/client/`), outside every exclusion glob. PR-2 fixed the typo in all four PR-1 stub schemas (`audit`, `auth`, `common`, `consent`) so the actual emit path now aligns with the existing exclusion globs and no glob change is required.

### Decision 6 — Multi-schema usage within one Prisma client

**What.** A module whose responsibilities span more than one Postgres schema declares `schemas = [...]` in its `datasource` block and `@@schema("...")` on each model. PR-2's consent module owns both the `consent` schema (`TalentConsentEvent`, `IdempotencyKey`, `OutboxEvent`) and the `audit` schema (`ConsentAuditEvent`) in a single `schema.prisma` file.

**Why.** Architecture §7 mandates schema-per-module separation, but it speaks to module ownership of schemas, not to client topology. Two distinct Prisma clients cannot share a Prisma `$transaction`, and PR-2's consent grant must atomically write four rows across both schemas (consent event, audit event, outbox event, idempotency key). Therefore a single Prisma client owns both schemas. The multi-schema feature went GA in Prisma 5; no preview-feature flag is required in Prisma 7.

**Constraint preserved.** Cross-schema references remain UUID-only with no foreign-key constraints (per Architecture §7). Cross-module references — for example, a `talent_id` UUID on `TalentConsentEvent` referring to a future `Talent` model owned by a different module — are not enforced at the database level. They are program invariants enforced at the application layer (service-to-service calls, not Prisma relations).

### Decision 7 — Cross-lib TypeScript resolution via dist `.d.ts` paths overrides

**What.** Each `libs/<lib>/tsconfig.lib.json` overrides `compilerOptions.paths` so cross-lib `@aramo/*` aliases resolve to the producer's emitted declarations at `dist/libs/<lib>/src/index.d.ts` (not to the producer's source). Tests use a separate alias map in workspace-root `vitest.shared.ts` that resolves the same aliases to source `index.ts` files. `apps/api/tsconfig.app.json` carries the equivalent overrides for application-level builds.

**Why.** The `@nx/js:tsc` executor invokes plain `tsc -p`, not `tsc -b`. TypeScript project references are not honored by `tsc -p`. With `paths` pointing at source, `tsc` pulls cross-lib source files into the consumer's compilation unit and rejects them with `rootDir` errors because they live outside the consumer's `rootDir: "src"`. Pointing `paths` at the dist `.d.ts` makes consumers compile against the producer's emitted declarations, which `tsc -p` accepts as ambient type information rather than as additional source.

**Build order.** Nx infers cross-lib dependencies from `@aramo/*` imports, and `dependsOn: ^build` ensures each producer's `dist/.../*.d.ts` exists by the time a consumer compiles. No manual ordering is required in any `project.json`.

**IDE behavior.** VSCode's TypeScript service may show inconsistent cross-lib resolution depending on whether `dist/` exists on disk. After a fresh clone or `git clean`, running `nx build` once primes the dist tree; the IDE then shows correct types. This is worth noting in developer setup docs that future PRs add.

**Status: durable, with a revisit trigger.** This pattern is load-bearing as long as the program uses `@nx/js:tsc` with `tsc -p`. If a future Nx upgrade or alternative executor handles cross-lib resolution natively (project references, package-export maps, or a bundler-based build), the `paths` overrides can be deleted across all `tsconfig.lib.json` files and the pattern retired. Until then it is a durable convention with surface area in 4+ tsconfig files.

### Decision 8 — `prisma:generate` CI step before every Prisma-touching job

**What.** Every CI job that compiles or runs tests against the generated Prisma client runs `npm run prisma:generate` immediately after `npm ci` and before any build or test step. The pattern is `install → prisma:generate → {build | test}`. Jobs that do not import Prisma (`verify:vocabulary`, `openapi:lint`, `pact:consumer`, the placeholder gates) skip the `prisma:generate` step.

**Why.** Decisions 2 and 5 establish that the generated client is gitignored and lives under `libs/<module>/prisma/generated/client/`. Fresh-clone CI runs have no generated client, so any module-resolution path that imports it fails immediately. The per-job step is the contract that makes Decision 2 actually hold under CI's clean-state assumption. PR-2's first CI run failed exactly this way; the fix was the explicit per-job step, codified as a contract here.

**Pattern stability.** Adding a new CI job that touches Prisma means adding the same `- run: npm run prisma:generate` step after `npm ci`. Removing a CI job that does not touch Prisma does not require touching the `prisma:generate` script. The script and the per-job step are independently versioned: the script changes when modules are added (Decision 2's `&&` chain), the CI step changes when jobs are added or removed.

---

## Consequences

### Positive

- PR-3 and every subsequent PR with a Prisma module inherits all eight decisions in writing. No re-derivation of the Prisma 7 surface, no re-discovery of the `tsc -p` `rootDir` interaction, no re-debugging of the missing-generated-client CI failure.
- The Prisma 7 mechanics are documented at the level of actual usage — `prisma.config.ts` location, driver adapter package, generator output path, multi-schema declaration, migrate-diff invocation — rather than at the level of "we use Prisma" in a tooling table.
- The cross-lib TypeScript resolution pattern's rationale is captured at Decision 7. A future Claude Code instance refactoring `tsconfig.lib.json` knows the `paths` overrides are load-bearing for `tsc -p` and that they can be removed only when the toolchain stops requiring them. The revisit trigger is named.
- The `prisma:generate` CI step is documented as a contract, not a one-off PR-2 fix. Future modules extend the npm script; future CI jobs follow the install → generate → build/test pattern.
- The `migrate diff` strategy is the documented program-wide migration generation method. Future PRs use this without re-deriving and without re-discovering the trade-off with the `_prisma_migrations` table.
- The retroactive-ADR pattern (ADR-0001 captured PR-1 precedents; ADR-0003 captures PR-2 precedents) is now established as the program's idiom. Decisions surface during implementation and are documented after they merge, when the working tree is the source of truth.

### Negative

- **Decision 1 (per-module Prisma config evolution) is deferred, not decided.** The recommended path (per-lib configs) is explicit, but the actual choice lands when PR-3+ surfaces the concrete trade-off. Risk: the next implementer ignores the recommendation and the program ends up with a workspace-root config that has grown an unwieldy `&&` chain or a custom selector. Mitigation: Tier 3 review on the first PR-3+ that adds a second module's models explicitly checks Decision 1 adoption against this ADR's recommendation.
- **Decision 7 (cross-lib TS resolution) is a workaround for a real toolchain limitation.** As long as the program uses `@nx/js:tsc` with `tsc -p`, the `paths` overrides stay in 4+ files. If a future Nx upgrade silently changes `@nx/js:tsc`'s underlying invocation to `tsc -b`, the workaround would still function but would no longer be necessary, and the surface area would be carrying its weight without a current cause. The revisit trigger is named in the Decision section, but no automation currently flags when `tsc -b` becomes default.
- **Decision 5 (output path) was a PR-1 stub typo undetected for the duration of M0.** The fix is correct, but the broader concern is that PR-1 stubs passed PR-1 review without being exercised. Other PR-1 stubs (in modules PR-2 did not touch) may carry similar drift that has not yet been detected. The proposed `prisma:validate` CI gate (separate follow-up PR queued in the M1 known-follow-ups list) addresses one class of these — schema validation under the pinned Prisma version — but broader stub validation across all PR-1 tooling is an open concern.

### Neutral

- This ADR consolidates eight decisions into one file rather than splitting into eight separate ADRs. Consolidation matches ADR-0001's pattern of multiple precedent decisions captured in one ADR when they share a common context (4 decisions for PR-1 in ADR-0001; 8 decisions for PR-2 in ADR-0003). It also keeps the precedent surface together — a reader who comes here for Decision 4 also sees Decisions 2 and 8, which are tightly coupled. If Decision 1 ever crystallizes (per-lib configs decided), it spawns its own new ADR rather than amending this one — ADR-0001's append-only convention applies.
- The Reversal Trigger pattern from ADR-0002 is intentionally not used in this ADR. None of the eight decisions are time-boxed to a bootstrap-phase relaxation. They are durable as long as the underlying tools (Prisma 7, Nx with `@nx/js:tsc`) remain. Decision 7 has a revisit-trigger note in its body rather than a formal Reversal Trigger section because the path forward is open ("when the toolchain changes") rather than predetermined ("when a second human joins").
- The retroactive-ADR pattern produces a small lag between when a precedent is established (PR-2 merge) and when it is documented (PR-2.1 ADR). The program accepts this lag because the alternative — pre-ADR before the PR — would force decisions to be made on speculation rather than on observed implementation friction. PR-2's halt-and-report cycle surfaced six of these decisions through real implementation pressure; an pre-ADR could not have anticipated all six.
- Decision 1's deferred status mirrors how Architecture v2.0 §7 itself defers some implementation mechanics — the architectural posture is locked, the implementation strategy is established once it has been exercised. ADR-0003 documents the strategy that PR-2 exercised; PR-3's ADR (if any) documents what PR-3 exercises.

---

## References

- PR-2 commits: `fb2c61c` (`feat: PR-2 consent grant contract + ledger foundation`), `1b9a95a` (`ci: add workspace-level prisma:generate step`), merged as `35b7d52`
- Architecture v2.0 §5 (technology stack — Prisma named), §7 (schema-per-module data architecture; UUID-only cross-schema references)
- API Contracts v1.0 Phase 1 (foundations), Phase 5 (error envelope) — referenced for context, not re-decided
- `doc/04-risks.md` CX2 (architectural rationale forgotten — the failure mode this ADR mitigates), D4 (pattern drift — the failure mode this ADR locks against)
- `doc/06-lead-review-checklist.md` Tier 3 — ADR linkage requirement for precedent-setting PRs
- `doc/adr/README.md` — ADR conventions; this ADR follows the Michael Nygard short-form template established by ADR-0001
- ADR-0001 (`doc/adr/0001-pr1-precedent-decisions.md`) — pattern PR for ADR format, retroactive-precedent idiom, tilde-pinning convention referenced by Decision 3
- ADR-0002 (`doc/adr/0002-bootstrap-branch-protection-relaxations.md`) — pattern PR for the Reversal Trigger section (intentionally not used in ADR-0003 because no decisions are time-boxed)
- PR-2 source artifacts: `prisma.config.ts`, `package.json`, `.github/workflows/ci.yml`, `libs/consent/prisma/schema.prisma`, `libs/consent/prisma/migrations/20260429164414_initial_consent_schema/migration.sql`, `libs/{audit,auth,common,consent}/tsconfig.lib.json`, `vitest.shared.ts`, `.gitignore`
