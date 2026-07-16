# Integration testing & the computed prepush

_CI-Velocity Directive v1.0 §PR-1 (local tooling; zero CI-semantics change)._

## `npm run prepush` — the computed run set

The diff→verification mapping is **computed, not remembered** (`ci/scripts/prepush.ts`). It prints its plan first (auditable), then runs:

1. **`nx affected -t build test lint`** vs `origin/main` — unit/build/lint for exactly the affected projects (Nx's dependency graph is the source of truth; a change in a dep propagates downstream).
2. **Affected integration roots** — each of the 13 `ARAMO_RUN_INTEGRATION` roots runs iff its Nx project is affected, **serial** (`--no-file-parallelism`; see below).
3. **Unconditional cheap walls** (never affected-scoped — Charter invariant): `verify-vocabulary`, `error-codes:check`, `identity-index:privacy-wall`, `portal`/`ats`/`ingestion` refusal, `version:sync-check`, `eslint` on every touched file.
4. **Path-computed walls**: `openapi:validate`+`lint`+`drift` when any `openapi/*.yaml` is touched; `pact:consumer`+`provider` when `pact/` is touched **or** the `api` project (the pact provider `aramo-core`) is affected; a `caddy validate` when `deploy/caddy/` is touched.

It supersedes-in-mechanism the six interim run-set rules (full integration per touched root; catalog-addition ⇒ owning unit suite; eslint+vocab per touched file; co-located specs; `openapi:lint` on yaml touch) — the script performs all of them unconditionally or via the graph. The **semantic** lessons stay (hand-built-TestingModule grep on shared-class constructor changes; surface-before-touching shared primitives; the three keyspace birth-certificate rules; ADD-not-rename; semicolon-free migration comments).

## Harness hardening: serial-default (not container reuse)

Integration specs each start their **own** `PostgreSqlContainer('postgres:17')` and apply their **own curated migration list** to that fresh DB. Testcontainers **reuse** (`TESTCONTAINERS_REUSE_ENABLE` + `.withReuse()`) shares one container/DB across specs — but two specs' distinct migration lists would accumulate on the same schema (duplicate `CREATE TABLE`, drifted state), so **reuse is not clean for this harness**.

The Docker-saturation flake (4 occurrences) came from **many spec files starting containers concurrently** within one vitest root. The fix is therefore **serial-default**: `--no-file-parallelism` on every integration run (in `tests:integration` and the prepush). One container starts at a time → no saturation; per-spec DB isolation is preserved. If the harness later adopts per-spec unique databases, bounded-parallel reuse can be revisited.

## The graph-correctness audit (non-nx paths)

`ci/scripts`, `openapi/`, `pact/`, `deploy/caddy` are not Nx projects, so `nx affected` cannot map them. Each is covered:

| Path              | Consumed by an nx build/test?  | Local coverage                                                                       | Stale-cache risk              |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------- |
| `ci/scripts/*.ts` | No (they ARE the wall runners) | The wall scripts run them unconditionally every prepush                              | None                          |
| `openapi/*.yaml`  | No (validated, not imported)   | Path-computed `openapi:validate`+`lint`+`drift` (drift compares the spec)            | None (walls unconditional)    |
| `pact/**`         | No                             | Path-computed `pact:consumer`+`provider`; provider also fires when `api` is affected | None                          |
| `deploy/caddy/**` | No (runtime Caddyfile)         | Path-computed `caddy validate`; authoritative gate is CI `docker-build(caddy)`       | None (nothing nx-consumes it) |

No path can produce a false green through Nx's cache, because every one is either executed by an unconditional wall or has no Nx consumer.
