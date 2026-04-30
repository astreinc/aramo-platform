# ADR-0004: Pact Contract Test Convention

**Status:** Accepted

**Date:** 2026-04-30

---

## Context

PR-2 introduced the program's first Pact consumer test (`pact/consumers/ats-thin/`) alongside the consent grant endpoint. PR-2 passed CI on its own runs, but the test occasionally surfaced a parallel-execution race after merge — Pact V4's mock-server lifecycle does not tolerate concurrent siblings under tight CPU contention. The race manifested as a "request was expected but not received" complaint from the mock server, with different specific tests failing on different runs (race signature, not a deterministic bug). PR-2.2 (commit `2075927`) fixed this with a target rename pattern and a CI invocation strategy that decouples the dedicated Pact gate from Nx's aggregate test orchestration.

ADR-0004 locks the resulting convention before PR-3 (consent revoke) ships the second Pact consumer in the program. Without explicit doctrine, PR-3+ implementers re-derive the convention from PR-2.2's `project.json` or guess. The convention has three coupled mechanisms (target naming, Nx aggregate exclusion, dedicated CI job as canonical gate); all three must land together for the convention to work, and missing any one creates either silent failure (the race returns) or missing CI coverage. This ADR is the rationale-recovery anchor per `doc/04-risks.md` CX2 and the pattern lock per D4. The retroactive-ADR pattern (ADR-0001 captured PR-1; ADR-0003 captured PR-2; ADR-0004 captures PR-2.2) is the program's idiom for documenting precedent after a precedent-setting PR merges.

---

## Decision

The Pact contract test convention has three coupled mechanisms. Every Pact consumer in the program implements all three.

### Mechanism 1 — Target rename: `test` no-op + `pact-test` real

Each project containing a Pact consumer test declares two test targets in its `project.json`:

```jsonc
"targets": {
  "test": {
    "executor": "nx:run-commands",
    "options": {
      "command": "echo 'Pact contract tests are excluded from the aggregate test target. Run nx pact-test <project-name> (or invoke vitest directly) to execute them.'"
    }
  },
  "pact-test": {
    "executor": "nx:run-commands",
    "options": {
      "command": "vitest run --passWithNoTests --root pact/consumers/<project>"
    }
  }
}
```

The `test` no-op overrides the auto-synthesized target from `@nx/vite/plugin` (registered in `nx.json` with `testTargetName: "test"`). Without the explicit override, the plugin synthesizes a `test` target on every project containing a `vitest.config.ts`, and `nx run-many --target=test --all` would discover and run Pact tests through that synthesis — re-introducing the race the convention is designed to eliminate. The explicit no-op replaces synthesis with a deliberate echo that documents the intentional exclusion at runtime.

The `pact-test` target is the explicit Nx invocation path for developers who want to run Pact tests via Nx (`nx run <project>:pact-test`). The dedicated CI gate (Mechanism 3) does not use this target; it invokes vitest directly.

### Mechanism 2 — Nx tag: `pact-consumer`

Each Pact consumer project declares the `pact-consumer` Nx tag in its `project.json`:

```jsonc
"tags": ["pact-consumer"]
```

The tag identifies these projects for future tag-based tooling — Nx affected detection scoped to Pact consumers, lint-by-tag rules, future ADR-driven constraints. The tag is currently informational; no Nx constraint depends on it as of PR-2.2. Future PRs that introduce tag-based enforcement extend the tag's role; existing consumers do not need to be revisited because they already carry the tag.

### Mechanism 3 — Dedicated CI job: canonical gate

The `pact:consumer` job in `.github/workflows/ci.yml` is the canonical gate for Pact tests. It invokes vitest directly, bypassing Nx entirely:

```yaml
- run: npx vitest run --root pact/consumers/ats-thin
```

Bypassing Nx means the dedicated job is unaffected by the target rename in Mechanism 1 — it does not use the `test` or `pact-test` Nx targets at all. This decoupling is intentional: the CI gate works regardless of how the project's `project.json` is structured, and the project.json's structure works regardless of how the CI gate is invoked.

For each new Pact consumer added in future PRs, the dedicated CI job must be extended (a sibling step running vitest against the new consumer's directory) or a parallel CI job added with the same shape. The aggregate `test:unit` CI job intentionally does not run Pact tests.

### Why these three mechanisms, not alternatives

The PR-2.2 diagnostic explored four alternatives before settling on the convention above. Each alternative is recorded here so future implementers do not re-explore them.

- **Project-level `parallelism: false`.** Nx 22's `parallelism: false` constrains the *same* target across multiple projects, not cross-target parallelism on a single project. With only one Pact consumer initially, the constraint had nothing to serialize against. Empirically verified during PR-2.2 diagnosis: 1/5 verification runs failed even with `parallelism: false` set on the consumer's project.
- **Workspace-wide `targetDefaults.test.parallelism: false`.** Heaviest blast radius; serializes ALL test targets program-wide; punishes the entire program for one project's contention. Wrong shape for a single-source-of-contention problem.
- **`dependsOn` chains forcing Pact tests to run after lib tests.** Brittle: each new lib that ships a `test` target must be added as a dependency of the Pact target. Maintenance cost compounds across PR-3+ as new libs land.
- **Retry-on-failure or test-isolation hacks (e.g., `vitest --retry=N`, `pool: 'forks', singleFork: true`).** These mask the underlying race rather than addressing the layer that creates it. The race is at Nx orchestration, where multiple Vitest invocations from different projects start within ~1.5s of each other on constrained CPU. Removing Pact from the orchestration is the structurally honest fix.

---

## Consequences

### Positive

- **Pact tests run deterministically.** The race is structurally eliminated at the target boundary. No serialization tax on lib unit tests; no retries papering over a race; no opaque flakes blocking unrelated PRs.
- **The dedicated `pact:consumer` CI job is the canonical gate.** Pact failures are visible in CI without contaminating the `test:unit` aggregate's signal. A red `test:unit` always means a real lib test failure; a red `pact:consumer` always means a real contract violation.
- **Future Pact consumers (PR-3+ revoke, PR-4+ check, portal Pact, ingestion Pact) inherit the convention.** No re-derivation of why the `test` no-op exists, why the tag is present, or why the CI job is dedicated.
- **Local development matches the program's existing pattern of dedicated invocation paths for some test categories** (integration tests require `ARAMO_RUN_INTEGRATION=1`). The Pact convention extends the same shape: tests with environment-specific or concurrency-specific requirements get a dedicated invocation rather than participating in the aggregate. Two precedents now reinforce the pattern; PR-3+ implementers see a consistent shape.

### Negative

- **`nx run-many --target=test --all` does not run Pact tests.** A developer running this command locally will not see Pact coverage unless they also run `nx run <project>:pact-test` or the dedicated vitest command. Mitigation: documented in this ADR; future onboarding docs should reference the dedicated invocation paths for both Pact and integration tests.
- **Each new Pact consumer requires three coordinated changes.** (1) Declaring both `test` no-op and `pact-test` real targets in its `project.json`. (2) Declaring the `pact-consumer` tag. (3) Adding a CI job (or extending the existing one) to invoke vitest against its directory. Missing any one creates either silent failure (the race returns if `test` no-op is missing, because synthesis backfills) or missing CI coverage (if the dedicated job is not extended). Mitigation: Tier 3 review on every PR adding a Pact consumer explicitly verifies all three. A future CI gate could enforce the tag and the no-op programmatically.
- **The convention assumes Pact V4 mock-server semantics.** If a future Pact major version changes the mock-server lifecycle to be process-safe, the convention may become unnecessary. The mechanisms (especially the `test` no-op) would survive that change without harm, but they would carry surface area in every consumer's `project.json` that is no longer load-bearing. At that point a successor ADR supersedes this one and removes the no-op declarations.

### Neutral

- This ADR captures one convention with three coupled mechanisms in a single Decision section. Per the consolidation pattern from ADR-0003 (8 decisions for shared PR-2 context in one file) and ADR-0001 (4 decisions for shared PR-1 context), this is the program's idiom for ADR scoping: one ADR per coherent precedent context, multiple sub-decisions within when they share a common rationale.
- The Reversal Trigger pattern from ADR-0002 is intentionally not used. The convention is durable as long as Pact V4's mock-server lifecycle remains process-unsafe under concurrent siblings on constrained runners. There is no discrete event that would trigger reversal on a known timeline. If Pact's mock-server semantics change in a future major version, the program revisits this ADR and either supersedes it (Pact convention no longer needed) or amends it (different mechanisms required).
- The three mechanisms are coupled at the convention level but live in different files with different change cadences. Mechanism 1 (per-consumer `project.json`) changes when a new consumer is added. Mechanism 2 (the tag) is stable per consumer once declared. Mechanism 3 (the CI job) changes when a new consumer is added. The cross-file coupling is the load-bearing precedent; this ADR is the seam that makes the coupling explicit so a reviewer of any one file knows what the other two files must look like.
- This is the fourth retroactive ADR in the program (ADR-0001, ADR-0003 captured infrastructure precedents from PR-1 and PR-2 respectively; ADR-0002 captured a bootstrap-phase relaxation; ADR-0004 captures the PR-2.2 fix-PR precedent). The retroactive-ADR pattern is now a firmly established program idiom: precedent surfaces during implementation, the precedent-setting PR merges, the ADR follows immediately to lock the rationale.

---

## References

- PR-2.2 commits: `a03611c` (`ci: PR-2.2 exclude Pact tests from aggregate test target`), merged as `2075927`
- PR-2 commits: `fb2c61c`, `1b9a95a`, merged as `35b7d52` — introduced the Pact consumer test that surfaced the race
- API Contracts v1.0 Phase 6 — Pact as the program's contract testing tool (referenced; not re-decided)
- `doc/04-risks.md` CX2 (architectural rationale forgotten — the failure mode this ADR mitigates), D4 (pattern drift — the failure mode this ADR locks against)
- `doc/05-conventions.md` — Pact convention reference (the strategy; this ADR captures mechanics)
- `doc/06-lead-review-checklist.md` Tier 3 — ADR linkage requirement for precedent-setting PRs
- `doc/adr/README.md` — ADR conventions; this ADR follows the Michael Nygard short-form template established by ADR-0001
- ADR-0001 (`doc/adr/0001-pr1-precedent-decisions.md`) — pattern PR for ADR format and the retroactive-precedent idiom
- ADR-0002 (`doc/adr/0002-bootstrap-branch-protection-relaxations.md`) — pattern PR for the Reversal Trigger section (intentionally not used in ADR-0004 because no decisions are time-boxed)
- ADR-0003 (`doc/adr/0003-infrastructure-conventions-prisma7-build-ci.md`) — most recent retroactive infrastructure ADR; matches the format ADR-0004 follows; Decision 4 establishes the integration-test dedicated-invocation precedent that ADR-0004 extends to Pact tests
- PR-2.2 source artifacts: `pact/consumers/ats-thin/project.json` (Mechanisms 1 and 2), `.github/workflows/ci.yml` (Mechanism 3)
