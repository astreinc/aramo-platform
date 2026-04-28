# Aramo Core

This repository is the `aramo-core` Nx monorepo: the modular-monolith service that hosts every Aramo Core module behind a single API surface. PR-1 is scaffolding only — every module folder, OpenAPI file, and Prisma schema is empty by design.

The program documentation lives in [`doc/`](doc/). New contributors should start at [`doc/00-README.md`](doc/00-README.md).

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | `~24.4` (Active LTS; pinned in [`.nvmrc`](.nvmrc)) |
| npm | `~11.4` (ships with Node 24) |
| Docker | required for future Postgres / Testcontainers integration tests (not used in PR-1) |
| ripgrep (`rg`) | required for [`scripts/verify-vocabulary.sh`](scripts/verify-vocabulary.sh) |

## Setup

```bash
nvm use            # picks up Node from .nvmrc
npm ci             # installs locked dependencies
npx nx graph       # opens the Nx project graph in a browser
```

To run the wired CI gates locally:

```bash
npm run lint
npm run build
npm test
npm run openapi:validate
npm run openapi:lint
npm run lint:nx-boundaries
npm run verify:vocabulary
```

## Repository Layout

```
aramo-core/
├── apps/api/                # NestJS bootstrap (no routes, no auth — PR-1)
├── libs/<module>/           # 13 empty NestJS module skeletons
│   ├── src/lib/<module>.module.ts
│   ├── src/index.ts         # public API (re-exports module class only)
│   ├── src/tests/.gitkeep
│   └── prisma/schema.prisma # datasource + generator only; zero models
├── openapi/                 # 4 empty valid OpenAPI 3.1 documents
├── pact/                    # consumer + provider scaffolding
├── ci/                      # workflow + script reservations (per 05-conventions.md)
├── doc/                     # program documentation (read 00-README.md first)
└── .github/workflows/ci.yml # 7 wired + 8 placeholder gates
```

Module boundaries are enforced via the Nx `enforce-module-boundaries` ESLint rule. Each lib's public API is its `src/index.ts`; cross-lib imports must go through the `@aramo/<lib>` path alias declared in [`tsconfig.base.json`](tsconfig.base.json).

## Locked Tooling Versions

The exact versions resolved by `npm ci` against `package-lock.json` (PR-1 install). All runtime/dev dependencies are tilde-pinned: patch-only auto-updates; minor bumps require an explicit decision.

| Concern | Package | Version |
|---|---|---|
| Runtime | Node.js | `24.4.1` |
| Package manager | npm | `11.4.2` |
| Language | `typescript` | `6.0.3` |
| Monorepo | `nx`, `@nx/js`, `@nx/eslint`, `@nx/eslint-plugin`, `@nx/nest`, `@nx/vite`, `@nx/workspace` | `22.7.0` |
| Framework | `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` | `11.1.19` |
| ORM | `prisma`, `@prisma/client` | `7.8.0` |
| Test runner | `vitest`, `@vitest/coverage-v8` | `4.1.5` |
| Test infra | `testcontainers` | `11.14.0` |
| HTTP test | `supertest` | `7.2.2` |
| E2E | `@playwright/test` | `1.59.1` |
| Job queue | `bullmq` | `5.76.3` |
| Contract test | `@pact-foundation/pact` | `16.3.0` |
| OpenAPI validate | `@apidevtools/swagger-cli` | `4.0.4` |
| OpenAPI lint | `@redocly/cli` | `2.30.1` |
| Lint | `eslint`, `typescript-eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin` | `10.2.1`, `8.59.1`, `8.59.1`, `8.59.1` |
| Lint peers | `@eslint/js`, `globals`, `eslint-config-prettier` | `9.39.4`, `16.4.0`, `10.1.8` |
| Lint imports | `eslint-plugin-import-x` [^1] | `4.16.2` |
| Format | `prettier` | `3.8.3` |
| Types | `@types/node`, `@types/supertest` | `24.12.2`, `6.0.3` |
| NestJS peers | `reflect-metadata`, `rxjs` | `0.2.2`, `7.8.2` |

[^1]: Substitutes `eslint-plugin-import` (peer range stops at ESLint 9). See ADR-0001 (PR-1.1).

The rationale for these specific pins (and the tilde-pinning discipline) will be captured in ADR-0001 in PR-1.1.

## What this repo does NOT do yet

PR-1 is scaffolding only. The following are deliberately absent and will be added by subsequent PRs:

- **No entities / models / DTOs.** Each `libs/<module>/prisma/schema.prisma` declares only the datasource and generator; zero models. No `Talent`, no `Tenant`, no `TalentConsentEvent`.
- **No endpoints.** All four `openapi/*.yaml` files are valid OpenAPI 3.1 documents with `paths: {}` and `components.schemas: {}`.
- **No service or controller code.** Each `libs/<module>/src/lib/<module>.module.ts` is an empty `@Module({})` class; `apps/api/src/app.module.ts` imports no libs.
- **No authentication, authorization, tenancy middleware, or any runtime business logic.**
- **No Prisma migrations.** Per-lib schemas are empty; nothing to migrate yet.
- **No seed scripts or fixtures.**
- **No Pact tests.** `pact/consumers/` and `pact/provider/` are empty placeholders.
- **No integration or E2E tests.** `vitest run` passes with `--passWithNoTests`.
- **CI placeholder gates.** Eight CI jobs in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) are deferred — they emit a `::notice::` and exit 0 until the artifacts they check exist.

## Refusal Layer

This repository implements the Aramo Charter refusal layer (R1–R13) — see [`doc/03-refusal-layer.md`](doc/03-refusal-layer.md). PR-1 enforces these refusals via **absence**: no entity definitions, no endpoints, no closed-enum values. Charter Refusal R7 (no LinkedIn) is additionally enforced by [`scripts/verify-vocabulary.sh`](scripts/verify-vocabulary.sh) — a sealed ripgrep gate that runs on every CI build and fails if the literal `linkedin` appears at any path outside its explicit allowlist.

Locked-vocabulary discipline (per [`doc/02-claude-code-discipline.md`](doc/02-claude-code-discipline.md) Rule 5) is enforced two ways:

1. ESLint flat-config `no-restricted-syntax` rules in [`eslint.config.mjs`](eslint.config.mjs) flag identifiers and string literals containing the anti-vocabulary listed in Rule 5.
2. The Tier-2 section of [`scripts/verify-vocabulary.sh`](scripts/verify-vocabulary.sh) runs the same scan via ripgrep with a literal exclusion list for build artifacts and program documentation that legitimately uses anti-terms in anti-pattern examples.

## Where to ask

The program documentation is the persistent shared context — [`doc/00-README.md`](doc/00-README.md) is the entry point and [`doc/07-prompt-template.md`](doc/07-prompt-template.md) is the mandatory template for new PR prompts. Reading order for new Claude Code instances is documented at the top of [`doc/00-README.md`](doc/00-README.md).
