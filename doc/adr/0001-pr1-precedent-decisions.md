# ADR-0001: PR-1 Precedent Decisions

**Status:** Accepted

**Date:** 2026-04-28

---

## Context

PR-1 (`feat: PR-1 monorepo + CI bootstrap`, commit `6e0b2a8`) established the `aramo-core` Nx monorepo: an empty NestJS application, thirteen empty NestJS library modules, four empty OpenAPI 3.1 documents, per-module Prisma scaffolding, CI workflow with seven wired gates and eight placeholder gates, and the supporting workspace configuration. PR-1 was a Tier 3 precedent-setting PR per `doc/06-lead-review-checklist.md`.

While the high-level structure of `aramo-core` is locked in Architecture v2.0 (modular monolith — §1; technology stack categories — §5; schema-per-module data architecture — §7) and in API Contracts v1.0 Phase 6 (OpenAPI / Pact / CI infrastructure shape), four implementation choices in PR-1 are **not** specified by any locked baseline. They were made by the PR-1 author under Lead direction, and they shape every subsequent PR. Per `doc/06-lead-review-checklist.md` Tier 3 review, an ADR is required for non-obvious decisions; per `doc/04-risks.md` CX2, ADRs are the named mitigation for forgotten architectural rationale.

This ADR captures those four decisions retroactively. The decisions themselves are already merged in PR-1; this ADR is the rationale-recovery mechanism so subsequent PRs and future Claude Code instances do not re-decide.

### Context for Decision 1 — Vocabulary enforcement mechanism

`doc/02-claude-code-discipline.md` Rule 5 locks the program's vocabulary: which terms are accepted (Talent, Tenant, Engagement, Examination, Submittal, Entrustability) and which corresponding anti-terms are forbidden. `doc/03-refusal-layer.md` R7 separately locks the strictest refusal in the program — the prohibition on the social-network ingestion source whose name `R7` refuses to permit. `doc/04-risks.md` D3 names vocabulary drift as one of the most likely failure modes of a multi-instance Claude Code program. None of the locked baselines, however, prescribe **how** the vocabulary discipline is enforced in CI. PR-1 had to choose a mechanism.

### Context for Decision 2 — Exact tooling pins

`doc/05-conventions.md` Stack table names the technologies (TypeScript, Node.js LTS, NestJS, Prisma, PostgreSQL 15+, Vitest + Testcontainers + Supertest + Playwright, Pact, Nx) but does **not** pin exact versions. The Phase 1 Delivery Plan v1.1 likewise references the stack by category. PR-1 had to choose specific resolved versions, install them, and decide a range-style discipline so future PRs know whether incidental minor or major bumps are permitted. The lockfile that resulted from PR-1's `npm install` is now the program's tooling baseline.

### Context for Decision 3 — Per-module Prisma client generation strategy

Architecture v2.0 §7 mandates schema-per-module: every module owns its Prisma schema, and cross-schema references are UUID-only with no FK constraints. The §7 mandate covers the **schema split** but is silent on the **generator output strategy** — where each module's generated Prisma client lives, whether multiple per-module clients can coexist, how migrations are sequenced across modules, and how the build excludes generated artifacts from version control. With thirteen modules and Prisma's default output path (`node_modules/.prisma/client`), the default would have produced a collision the moment the first two modules added models. PR-1 had to pick a generator output strategy that preserves the §7 schema-per-module split end-to-end.

### Context for Decision 4 — Redocly deferred-strict rule list

API Contracts v1.0 Phase 6 mandates OpenAPI lint as a CI gate using `@redocly/cli`. PR-1's four OpenAPI documents are valid OpenAPI 3.1 scaffolds whose body shape is fixed by PR-1's Acceptance Criteria to `openapi: 3.1.0`, `info` (title + version + description only), `paths: {}`, and `components: { schemas: {} }`. Several of Redocly's default lint rules (in the bundled `recommended` config and even in the `minimal` config) raise errors against this empty shape — for example, `no-empty-servers` errors when no `servers` block is present. Re-enabling these rules would require PR-1 to deviate from its Acceptance Criteria; relaxing them universally without record would silently weaken the OpenAPI lint gate over time. PR-1 had to choose which rules to relax, document why each relaxation is scoped to the empty-scaffold state, and define the trigger condition under which each rule must be re-enabled.

---

## Decision

### Decision 1 — Vocabulary enforcement is two-tier

PR-1 enforces vocabulary discipline through two distinct mechanisms wired into CI:

**Tier 1 — ESLint flat config (`eslint.config.mjs`).** Five `no-restricted-syntax` rules — one per locked entity term in `doc/02-claude-code-discipline.md` Rule 5 (Talent, Tenant, Engagement, Examination, Submittal) — flag both identifiers and string literals that match the corresponding anti-vocabulary regex. The Tier 1 rules are scoped to product source (`apps/**/*.{ts,tsx,js,jsx}` and `libs/**/*.{ts,tsx,js,jsx}`) so the ESLint config file itself, scripts, and documentation are not subject to AST-level scanning. Tier 1 runs on every Nx `lint` invocation and gives editor-time feedback in IDEs configured to surface ESLint errors.

**Tier 2 — Sealed ripgrep gate (`scripts/verify-vocabulary.sh`).** A bash script wired into CI as the `verify:vocabulary` job. It performs two scans:

- **R7 strict gate.** Searches the entire repository for the literal term that R7 forbids and fails the build if any occurrence is found outside an explicitly-named allowlist of paths. The allowlist is a literal list of file paths (not globs), with a per-entry comment citing the PR-1 authorization for each entry. Adding a new path to the allowlist requires Architect approval per Charter R7.
- **Tier 2 broader vocabulary check.** Substring-scans for the five entity anti-terms (the same set Tier 1 covers, but applied to all file types ripgrep can read) and word-boundary-scans for the two Portal field-name anti-terms enforced by `doc/03-refusal-layer.md` R10. An exclusion list specifies which paths are permitted to contain these terms (build artifacts, vendored dependencies, locked program documentation that uses the anti-terms in anti-pattern examples, the ESLint config file itself, and this script). Each exclusion entry has a per-entry comment citing the PR-1 authorization.

The two-tier separation is deliberate: it makes the strict R7 refusal structurally visible as its own gate rather than buried inside a broader vocabulary lint config. Operator-help pointers in both error blocks tell a future contributor exactly which file to edit if they need to update an allowlist or exclusion list (`R7_ALLOWLIST` for Tier 1, `TIER2_EXCLUDES` for Tier 2 — both in `scripts/verify-vocabulary.sh`).

**ESLint plugin set.** PR-1 installed `@nx/eslint`, `@nx/eslint-plugin`, `@eslint/js`, `globals`, `typescript-eslint`, `eslint-config-prettier`, and `eslint-plugin-import-x`. The substitution of `eslint-plugin-import-x` for the more familiar `eslint-plugin-import` is required because `eslint-plugin-import`'s peer range stops at ESLint 9 and PR-1 installed ESLint 10. `eslint-plugin-import-x` is an actively maintained drop-in fork that supports ESLint 10. PR-1 wires it with exactly two rules: `import-x/order` (consistent import grouping with `newlines-between: 'always'`) and `import-x/no-cycle` with `maxDepth: Infinity` (DAG-shaped dependency graph across the thirteen modules). These two rules are the minimum needed to preserve module-boundary discipline at import time; expanding the rule set is a separate decision for a future PR.

**Configuration format.** PR-1 uses `eslint.config.mjs` (the Nx 22 default flat-config format). The legacy `.eslintrc.json` format is **not** present in the repo and should not be reintroduced.

**Source-of-truth recovery.** A precedent comment block above the `eslint-plugin-import-x` rule entries in `eslint.config.mjs` documents the substitution rationale at the implementation site. The comment is the recovery anchor: even if this ADR is not consulted, the comment ensures the next reader of the ESLint config sees why the substitution exists.

### Decision 2 — Exact tooling pins (tilde range style)

PR-1 pins every program dependency with the tilde (`~`) range specifier: patch-level updates apply automatically on `npm install`; minor and major updates require an explicit dependency edit. The exact versions resolved at PR-1 install time and recorded in `package.json` and `package-lock.json` are:

| Tool | Pinned Version | Range Style | Rationale |
|---|---|---|---|
| Node.js | `24.4` (in `.nvmrc`) | major.minor literal | Active LTS through Oct 2026, Maintenance through Apr 2028 |
| npm | `~11.4` (in `engines`) | `~` | Ships with Node 24.4 |
| `nx`, `@nx/js`, `@nx/eslint`, `@nx/eslint-plugin`, `@nx/nest`, `@nx/vite`, `@nx/workspace` | `~22.7.0` | `~` | Latest stable Nx at PR-1 install time; flat-config default |
| `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` | `~11.1.19` | `~` | Latest stable NestJS at PR-1 install time |
| `typescript` | `~6.0.3` | `~` | Latest stable TypeScript at PR-1 install time; `baseUrl` removed from `tsconfig.base.json` because TS 6 deprecates it (paths resolve relative to the tsconfig file location instead) |
| `prisma`, `@prisma/client` | `~7.8.0` | `~` | Latest stable Prisma at PR-1 install time |
| `vitest`, `@vitest/coverage-v8` | `~4.1.5` | `~` | Latest stable Vitest at PR-1 install time |
| `testcontainers` | `~11.14.0` | `~` | Latest stable |
| `supertest` | `~7.2.2` | `~` | Latest stable |
| `@playwright/test` | `~1.59.1` | `~` | Latest stable |
| `bullmq` | `~5.76.3` | `~` | Latest stable |
| `@pact-foundation/pact` | `~16.3.0` | `~` | Latest stable; Pact V3 spec support verified (`MatchersV3` and `PactV3` exports both present, matching the example in `doc/05-conventions.md`) |
| `@apidevtools/swagger-cli` | `~4.0.4` | `~` | Latest available; npm-deprecation notice is acknowledged but the tool still validates correctly. A future PR may replace it with `@redocly/cli` validate alone |
| `@redocly/cli` | `~2.30.1` | `~` | Latest stable |
| `eslint` | `~10.2.1` | `~` | Latest stable; ecosystem peer-range constraints are acknowledged in Decision 1 |
| `eslint-plugin-import-x` | `~4.16.2` | `~` | Substituted for `eslint-plugin-import` (peer range stops at ESLint 9) |
| `eslint-config-prettier` | `~10.1.0` | `~` | Latest stable |
| `@eslint/js` | `~9.39.0` | `~` | Latest stable; required as a peer of `@nx/eslint-plugin`'s flat configs |
| `globals` | `~16.4.0` | `~` | Latest stable; required as a peer of `@nx/eslint-plugin`'s flat configs |
| `typescript-eslint` | `~8.59.1` | `~` | Latest 8.x supporting both ESLint 10 and TypeScript 6 |
| `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin` | `~8.59.1` | `~` | Match `typescript-eslint` meta package |
| `prettier` | `~3.8.3` | `~` | Latest stable |
| `@types/node`, `@types/supertest` | `~24.12.2`, `~6.0.2` | `~` | `@types/node` aligned with Node 24 major; `@types/supertest` matches Supertest 7 |
| `reflect-metadata` | `~0.2.2` | `~` | NestJS peer dependency |
| `rxjs` | `~7.8.0` | `~` | NestJS peer dependency |

**PostgreSQL** is referenced in `doc/05-conventions.md` Stack table as `15+` but is **not** an npm package. PR-1 does not pin a specific PostgreSQL minor version because the database is environmental (provisioned by AWS RDS in production, by `testcontainers` in integration tests). The first PR that introduces a Prisma model will need to pin a Postgres image tag for Testcontainers; that pin will be documented in its own ADR if it constrains future PRs.

**Package manager.** PR-1 stayed on `npm`, matching the initial bootstrap commit and the `package-lock.json` already present in the repo. A pnpm migration is **deferred, not foreclosed** — if a future PR demonstrates a clear benefit (faster installs, better workspace dedup, or stricter peer-dep checking), the migration is open for discussion at that time. The existing `npm` installation does not preclude a future migration.

### Decision 3 — Per-module Prisma client generation, isolated output, no shared client

Each module's `libs/<name>/prisma/schema.prisma` declares the generator and datasource only:

```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../generated/client"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

**Output path.** The `output = "../generated/client"` setting is relative to the schema file. The generated client lands at `libs/<name>/prisma/generated/client/`. Each module produces its own typed client; the thirteen clients do not share a generation directory and cannot collide.

**Version-control exclusion.** The `.gitignore` entry `**/prisma/generated/` excludes every per-module generated client from version control. Generated artifacts are reproducible from the schema; checking them in would create merge conflicts and review noise.

**Nx wiring.** PR-1 does **not** wire a `prisma:generate` Nx target on any module's `project.json`. Each PR-1 `project.json` declares only `build`, `lint`, and `test` targets. This is intentional: PR-1 has zero models, so `prisma generate` would produce nothing meaningful. **The first PR that introduces a Prisma model on any module must add a `prisma:generate` target to that module's `project.json` and wire it as a `dependsOn` of the module's `build` target.** That same PR is responsible for adding `prisma:generate` to the `verify:vocabulary` exclusion list if necessary (it shouldn't be — the generated output is already excluded by the `**/prisma/generated/**` glob).

**Migration sequencing.** Architecture v2.0 §7 mandates UUID-only cross-schema references with no FK constraints. As a direct consequence, **migrations are sequenced per-module with no global ordering required.** Each module's migration history lives alongside its schema (`libs/<name>/prisma/migrations/`). The first PR that introduces a Prisma model is responsible for establishing the migration directory layout and the `prisma migrate` command shape; this ADR does not pre-decide that detail, but it does guarantee the structure can support it without any pre-existing global migration ordering to undo.

**Schema discipline.** Every PR-1 `schema.prisma` declares only `generator client` and `datasource db`; zero models. The first model added to any module is its own Tier 3 PR (per `doc/06-lead-review-checklist.md`'s schema-additions rule).

### Decision 4 — Redocly deferred-strict rule list (eight rules)

PR-1's `redocly.yaml` extends the `minimal` bundled config and explicitly disables the following eight rules. Each rule is disabled because the artifact it validates does not yet exist in PR-1's empty-scaffold state. Each entry has a trigger condition for re-enabling — the PR that introduces the relevant artifact is responsible for re-enabling the rule (and removing the corresponding entry from `redocly.yaml`).

| Rule | What it validates | Trigger to re-enable |
|---|---|---|
| `no-empty-servers` | An OpenAPI document declares at least one `servers` entry | First `servers` block added to any of the four OpenAPI documents |
| `info-license` | `info.license` is present | License decided (likely M2 or later) |
| `info-license-url` | `info.license.url` is present | Same as `info-license` |
| `info-contact` | `info.contact` is present | Contact decided (likely M2 or later) |
| `tag-description` | Every declared tag has a description | First `tags` block added |
| `operation-description` | Every operation has a description | First operation added |
| `operation-2xx-response` | Every operation declares at least one 2xx response | First operation added |
| `operation-operationId` | Every operation declares an `operationId` | First operation added |

**Refusal-layer guarantee.** None of the eight relaxations touches refusal-relevant validation. Specifically, **no rules around `additionalProperties`, schema strictness, or `const` constraints were relaxed.** The `additionalProperties: false` universal rule from `doc/02-claude-code-discipline.md` Rule 3 remains in force the moment the first object schema is introduced; the `const: true` / `const: false` constraints from `doc/03-refusal-layer.md` will be enforceable from their first introduction. The eight rules above are all about OpenAPI metadata or operation-level completeness, not about schema content.

**Header comment in `redocly.yaml`.** The `redocly.yaml` rule list is preceded by a comment scoping the relaxations to PR-1's empty-scaffold state. That comment is the recovery anchor for future readers who edit this file.

---

## Consequences

### Decision 1 — Consequences

**Positive.**
- The strict R7 refusal is structurally visible as its own CI gate. A future PR that accidentally introduces the forbidden term anywhere outside the sealed allowlist fails the `verify:vocabulary` gate immediately; the failure points to the exact mechanism for resolution (escalate to Architect; do not unilaterally edit `R7_ALLOWLIST`).
- ESLint Tier 1 gives editor-time feedback during development, which catches anti-vocabulary at the keystroke level before the code is committed.
- The two-tier separation makes auditable: Lead reviewers can verify R7 enforcement by reading a small bash script, separately from auditing the broader ESLint config.
- The `eslint-plugin-import-x` substitution unblocks the use of ESLint 10 today.

**Negative.**
- Adding a new forbidden term in the future requires a synchronized edit to **both** `eslint.config.mjs` (Tier 1 selectors) and `scripts/verify-vocabulary.sh` (Tier 2 patterns and, if applicable, Tier 1 R7 allowlist). Forgetting either side weakens the enforcement.
- The R7 allowlist is sealed: any expansion requires Architect approval per Charter R7. This adds friction to legitimate operational changes (e.g., a new program-doc file that needs to reference the term in its locked refusal text), but the friction is the point.
- The `eslint-plugin-import-x` substitution means future PRs cannot copy import-related ESLint configurations from generic Nx-generated examples that use `eslint-plugin-import` without translating rule names from `import/*` to `import-x/*`.
- ESLint Tier 1 patterns appear inside the ESLint config file itself, which means the ESLint config file is necessarily on the Tier 2 exclusion list and on the R7 allowlist. The self-reference is documented but increases the required set of allowlisted paths by one.

**Neutral.**
- Vocabulary discipline runs on every CI build. Build time impact is minimal (ripgrep is fast on a repo of this size), but the gate is a hard fail: a single anti-term occurrence outside the exclusion list blocks the build. Operator help pointers in both error blocks reduce time-to-fix when the gate fires.
- The `import-x/no-cycle` rule will become more meaningful as the thirteen modules accumulate inter-module imports. In PR-1, the modules are empty and no cycles are possible.

### Decision 2 — Consequences

**Positive.**
- Tilde pinning makes patch-level updates automatic on `npm install` (security fixes flow in without ceremony) while making minor and major bumps deliberate, reviewable events. This matches the program's preference for explicit, auditable change.
- The exact pins are reproducible across machines: `npm ci` against the committed `package-lock.json` produces an identical install.
- The pin set is documented in this ADR and in `README.md`'s Locked Tooling Versions table — two recovery anchors so the next contributor never has to reverse-engineer "what version was current when PR-1 shipped."

**Negative.**
- Minor version bumps require an explicit decision and an updated `package.json`. CI builds against a fresh `npm install` (which can update transitive deps within tilde ranges) may exhibit subtle behavior changes from upstream patches. The program accepts this risk in exchange for security-fix automation.
- Several pins constrain ecosystem choices. ESLint 10 with `eslint-plugin-import-x` means no `eslint-plugin-import`-based examples can be copied without translation (see Decision 1). TypeScript 6 with `baseUrl` removed means future contributors copying tsconfig snippets that include `baseUrl` will see deprecation errors. Both constraints are documented but real.
- The `@apidevtools/swagger-cli` package is npm-deprecated. The pin is acknowledged in the table; a future PR may replace it with `@redocly/cli` validate alone, which would simplify the OpenAPI gate to a single tool. That replacement is its own decision.

**Neutral.**
- npm is the package manager. Pnpm migration is deferred but not foreclosed. The program does not commit to npm forever; it commits to npm for now.
- PostgreSQL is environmental rather than pinned in `package.json`. The first PR introducing a Prisma model will pin the Postgres image tag for Testcontainers in its own ADR if that pin constrains future PRs.

### Decision 3 — Consequences

**Positive.**
- The schema-per-module split from Architecture v2.0 §7 is preserved end-to-end: schema, generated client, migrations, and Nx project boundaries all align per-module. A reviewer auditing `libs/<name>/` sees the entire data-layer boundary for that module in one folder.
- Per-module clients are independently typed. Adding a model to one module does not cascade type changes into other modules' compiled output.
- The `**/prisma/generated/` `.gitignore` exclusion keeps generated artifacts out of version control, eliminating a class of merge-conflict noise.

**Negative.**
- **A single shared `PrismaClient` instance is foreclosed.** Connection pooling design must be addressed when the first module with models lands. With thirteen potentially-active per-module clients, a naive "one PrismaClient per module" approach could blow PostgreSQL's connection limits. The first model PR is responsible for proposing a connection-pooling strategy (likely a shared connection pool fronted by per-module clients via Prisma's `datasource` URL parameters, or an external pooler such as PgBouncer).
- Cross-module queries cannot use Prisma's relation features. Cross-schema references are UUID-only per Architecture v2.0 §7, but with separate Prisma clients there is no ambient way to traverse a UUID into a typed object from a different module. Modules that need to display data from another module must call that module's service-layer API, not its repository.
- The first model PR carries additional precedent weight: it must establish the `prisma:generate` Nx target shape, the migration directory layout, the `prisma migrate` command invocation, and the connection-pooling strategy. That PR will be a Tier 3 review.

**Neutral.**
- PR-1 does not wire `prisma:generate` because no models exist yet. The `build` target compiles only TypeScript; nothing depends on a generated Prisma client. This is correct for PR-1's state but means the first model PR introduces a new Nx-target shape for the program.
- Migrations are sequenced per-module with no global ordering. This follows from the no-FK rule and is documented in this ADR for clarity rather than chosen here.

### Decision 4 — Consequences

**Positive.**
- The OpenAPI lint gate is wired and green in PR-1. As soon as artifacts are added (a `servers` block, a license, an operation), Lead reviewers can re-enable the corresponding rule by removing one line from `redocly.yaml`. The trigger conditions are documented in this ADR's Decision 4 table.
- No refusal-relevant rules are relaxed. The `additionalProperties: false` universal rule and the `const`-based refusal constraints will be enforceable from the first object schema's introduction. This guarantee is preserved structurally.

**Negative.**
- **CI does not currently warn that a rule is disabled.** The only mechanism by which a future Claude Code instance is reminded to re-enable a deferred rule is consultation of this ADR or reading the comment block in `redocly.yaml`. A PR that introduces a `servers` block but forgets to re-enable `no-empty-servers` would not be caught by automation. Lead review is the intended catch.
- Each of the eight rules adds a small re-enablement burden to whichever future PR introduces the corresponding artifact. The PR introducing operations, for example, must re-enable three rules (`operation-description`, `operation-2xx-response`, `operation-operationId`) at once.

**Neutral.**
- The `redocly.yaml` rule disables are scoped narrowly: each rule is disabled by name, not by glob. Adding a new rule that PR-1 does not anticipate (e.g., a future Redocly version introduces a new default rule) will surface in CI on first use.
- The header comment in `redocly.yaml` is the day-to-day recovery anchor; this ADR is the deeper documentation. Both are intentional duplicates: the comment is for a contributor scanning the file, the ADR is for a reviewer asking "why was this disabled."

---

## References

- PR-1 commit: `6e0b2a8` (`feat: PR-1 monorepo + CI bootstrap`)
- Architecture v2.0 §1 (modular monolith), §5 (technology stack), §7 (schema-per-module)
- API Contracts v1.0 Phase 6 (OpenAPI / Pact / CI infrastructure)
- `doc/02-claude-code-discipline.md` Rule 3 (`additionalProperties: false`), Rule 5 (vocabulary)
- `doc/03-refusal-layer.md` R7 (the strict refusal), R10 (Portal-forbidden field names)
- `doc/04-risks.md` CX2 (architectural rationale forgotten), D3 (vocabulary drift)
- `doc/05-conventions.md` Stack table, Database Conventions
- `doc/06-lead-review-checklist.md` Tier 3 (ADR linkage requirement)
- PR-1 source artifacts: `package.json`, `package-lock.json`, `.nvmrc`, `eslint.config.mjs`, `scripts/verify-vocabulary.sh`, `redocly.yaml`, `tsconfig.base.json`, `libs/*/prisma/schema.prisma`, `libs/*/project.json`, `.github/workflows/ci.yml`
