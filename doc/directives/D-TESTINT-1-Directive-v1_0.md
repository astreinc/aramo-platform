# D-TESTINT-1 — Integration-Root Coverage Guard

## 1. Header

| Field | Value |
|---|---|
| ID | D-TESTINT-1 |
| Version | v1_0 |
| Weight | **FULL** |
| Status | DRAFT — under Lead review |
| Target path | `doc/directives/D-TESTINT-1-Directive-v1_0.md` |
| Pin | `a5765fe08f0fa11f3abe1855d8a99dd5bf49feff` (origin/main tip, merge commit) |
| Governing artifacts | `doc/directives/00-DIRECTIVE-STANDARD.md` (authored under); `doc/directives/D-REPOMAP-2-Directive-Amendment-v1_4-LOCKED.md:110` (named the divergence); D-SEED-SCOPES-1 (the incident this class produced) |
| Dev branch | `fix/testint-roots-guard` (implementation; not this filing branch) |
| Parent directive | none |

Weight is FULL by `00-DIRECTIVE-STANDARD.md` Rule H: the artifact governed is the guard that decides which integration specs execute on the path to production. Getting it wrong does not fail loudly — it makes CI test less while staying green, the exact D-SEED-SCOPES-1 shape. Arguable-means-FULL settles it regardless.

---

## 2. Grounding ledger

| Kind | Fact |
|---|---|
| Read by path | `package.json:21` — npm `tests:integration` enumerates integration roots inline (`--root libs/… && …`), run unconditionally and serially. |
| Read by path | `ci/scripts/ci-integration.sh:14-30` — `ROOTS` array; self-described at `:10` as "the authoritative CI integration set". This is what CI runs. |
| Read by path | `ci/scripts/prepush.ts:23-37` — `INTEGRATION_ROOTS`, a third independent enumeration; consumed at `:84` (nx-affected filter) and `:116-119` (run). |
| Read by path | `.github/workflows/ci.yml:467,485` — the CI job named `tests:integration` runs `bash ci/scripts/ci-integration.sh`; it does **not** invoke the npm script of the same name. |
| Read by path | Integration specs gate on `describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')` (e.g. `libs/policy-store/src/tests/*.integration.spec.ts:62`). A spec whose project is not a declared root is **skipped in every CI lane**, silently — no failure, no skip report at suite level. |
| Read by path | `ci/scripts/ci-integration.sh:10` — freezes the literal count `(16)` in prose and instructs a human to hand-sync the list. Rule D violation documented in-file; Rule B violation (frozen count) in the tree. |
| Enumerated | At pin: `*.integration.spec.ts` files = **123**, spanning **29** owning projects (`git ls-files '*.integration.spec.ts'`, mapped to `libs/<x>` / `apps/<x>`). |
| Enumerated | At pin: `ci-integration.sh` ROOTS = **16**; npm + prepush = **13** each (identical set today); the three declared sets are mutually inconsistent (npm/prepush carry `libs/portal-identity`, absent from ROOTS; ROOTS carries `libs/ingestion`, `libs/talent-trust`, `apps/platform-admin`, `apps/auth-service`, absent from npm/prepush). |
| Enumerated | At pin: projects with integration specs **absent from ROOTS** = `libs/auth-storage`, `libs/common`, `libs/identity`, `libs/metering`, `libs/object-storage`, `libs/outbox-publisher`, `libs/policy-store`, `libs/portal-identity`, `libs/resume-parse`, `libs/settings`, `libs/skills-taxonomy`, `libs/sourced-talent`, `libs/talent-record`. |
| Enumerated | At pin: `libs/identity/src/tests/` holds six integration specs — `identity`, `invite-s2-three-state`, `invite-s3-actions`, `seed-scrub`, `auth-hardening-d2-reconcile`, `seed-platform-owner` — all dormant. `seed-platform-owner.integration.spec.ts` exercises the `prisma:seed-platform-owner` seed the repo map flags as invoked by nothing in `deploy/seed-prod.sh`: the seed is unwired and the test that would notice is un-run. |
| NOT VERIFIED | Whether each project absent from ROOTS is a *real* coverage loss versus a stub, WIP, or deliberate exclusion. This is a per-project disposition, not a recon verdict — it is precisely what the allowlist-with-reason and the disposition follow-up exist to resolve (Rule C). |
| NOT VERIFIED — runtime | Whether enabling `libs/identity` in the serial gate passes, or reds/flakes (Docker-saturation surface, per `doc/integration-testing.md:20`). The directive's central probe. Determined only by running it. |
| NOT VERIFIED — runtime | Whether the other 12 absent projects' specs, if enabled, pass — deliberately not probed here (see Rejected alternative B). |

---

## 3. Problem

1. **One suite, three unsynchronised definitions.** `ci-integration.sh:14-30`, `prepush.ts:23-37`, and `package.json:21` each enumerate the integration roots independently. `ci-integration.sh:10` writes the sync obligation into a code comment — the fact is maintained by human discipline across three files, which is the defect class `00-DIRECTIVE-STANDARD.md` Rule D exists to forbid.

2. **None of the three matches the ground truth.** At the pin, 29 projects contain `*.integration.spec.ts`; the authoritative CI set (`ROOTS`) declares 16. Thirteen spec-bearing projects are skipped in every CI lane. Because the gate is `skipIf`, this produces no failure and no visible skip — coverage is absent silently.

3. **The named-incident project is still dark.** `D-REPOMAP-2-Amendment-v1_4-LOCKED.md:110` records that `libs/identity` staying outside `ROOTS` is "the mechanism by which … D-SEED-SCOPES-1 reached the box." At the pin, `libs/identity` remains absent from `ROOTS` with six dormant integration specs (~the identity, tenant, invite, and seed core), including one covering an unwired production seed. The follow-up that was expected to close this did not.

4. **No guard detects the drift.** Nothing asserts that a project owning an integration spec is actually executed by the gate. A spec can be added to a non-root project and skipped forever with a green board.

---

## 4. Decision

Author-declares, guard-verifies, single source, close the named defect, probe viability. Concretely:

1. **Single declared source.** Extract the integration-root list to one data file (`ci/integration-roots.txt`, newline-delimited). `ci-integration.sh` and `prepush.ts` both read it; neither keeps its own array. The list stays **human-declared** — it is not computed from discovery, because a newly-created project must not silently join the serial gate and inflate CI wall-clock. The human declares intent; the guard checks completeness.

2. **npm alias.** Replace the `package.json:21` inline enumeration with a thin alias to `ci/scripts/ci-integration.sh` (which, with `CI_AFFECTED` unset, runs the full declared set serially — verified reachable without nx/CI-only env). This removes the third copy entirely. If review finds a divergent semantic that forbids the alias, that is reported and the npm script instead reads the same data file.

3. **Completeness guard (`ci/scripts/verify-integration-roots.ts`, npm `integration-roots:check`, ci.yml job).** Discovers the set of projects owning a `*.integration.spec.ts` (via `git ls-files`, tracked-state only). Asserts: `declared ∪ allowlist ⊇ discovered`. On any discovered project that is neither declared nor allowlisted, it **classifies and fails** — it prints the offending projects with provenance; it never emits a bare pass/fail that silently decides a contested case (Rule C). The allowlist (`ci/integration-roots.allow.txt`) carries one reason per entry.

4. **Close the named defect.** Add `libs/identity` to the declared roots (not the allowlist). Its six specs enter the gate.

5. **Allowlist the remaining twelve, each with a reason** citing this directive and deferring to a disposition follow-up (D-TESTINT-2). This makes the hole explicit and prevents it growing, without gambling twelve unprobed projects into the serial gate in one change.

6. **Remove the frozen `(16)` and the hand-sync instruction** at `ci-integration.sh:10`; the guard is now the sync mechanism (Rule B fix, in scope).

---

## 5. Rejected alternatives

**A — Guard + allowlist only; allowlist `libs/identity` too; remediate nothing.**
Rejected. Allowlisting `libs/identity` means writing, as a checked-in reason string, that the project which caused a production incident still has no CI integration coverage and that this is accepted — with six dormant specs including the unwired-seed test. That entry cannot be written honestly. Shape C closes it instead.

**B — Guard + remediate all thirteen in this directive.**
Rejected. Forcing thirteen unprobed projects into the serial Docker gate, against a NOT-VERIFIED flake surface (`doc/integration-testing.md:20`), in the same change that installs the guard, stacks two independent risks in one directive. If it reds, the guard install and the remediation fail together and neither can be bisected. Shape C probes viability with one project first: if `libs/identity` passes, the twelve are likely dormant-but-working and the disposition pass is cheap; if it fails, the twelve may be dormant-and-rotted — a larger finding worth surfacing before allowlisting them for a quarter.

**Chosen: C** — guard + unify to one declared source + close `libs/identity` + allowlist the twelve with reasons + probe.

---

## 6. Scope

**In scope**
- `ci/integration-roots.txt` (new) — the single declared root list.
- `ci/integration-roots.allow.txt` (new) — allowlist, one reason per entry.
- `ci/scripts/ci-integration.sh` — read the data file; remove the `ROOTS` array and the `:10` frozen count / hand-sync comment.
- `ci/scripts/prepush.ts` — read the data file; remove the `INTEGRATION_ROOTS` array.
- `package.json:21` — `tests:integration` becomes an alias to `ci-integration.sh` (or reads the data file, if the alias is rejected in review).
- `ci/scripts/verify-integration-roots.ts` (new) + npm `integration-roots:check` + a `ci.yml` job mirroring `repo-map:check`.
- Add `libs/identity` to the declared list.
- Populate the allowlist with the twelve, each with a reason and a D-TESTINT-2 pointer.

**Out of scope**
- Fixing, un-skipping, or triaging the twelve allowlisted projects' specs (→ D-TESTINT-2, the disposition pass).
- Wiring `prisma:seed-platform-owner` into `deploy/seed-prod.sh` (a separate deploy-path defect surfaced by the repo map; noted, not fixed here).
- Any change to the `skipIf` gating convention itself.
- Per-spec parallelism / shared-container harness work (`doc/integration-testing.md` future item).
- Changing which lanes run integration (affected-on-PR / full-otherwise stays).

---

## 7. Acceptance criteria

Each is falsifiable by observation. Counts are asserted as **relations**, never frozen literals (Rule B).

1. **Single source.** `ci-integration.sh` and `prepush.ts` contain no literal root array; both derive their set from `ci/integration-roots.txt`. Falsified if either file still declares roots inline. HALT if the two, run against the same data file, produce different root sets.

2. **Guard completeness.** `integration-roots:check` asserts `declared ∪ allowlist ⊇ discovered`, where `discovered` = projects owning a tracked `*.integration.spec.ts`. Falsified if a project with an integration spec is neither declared nor allowlisted and the guard passes.

3. **Guard classifies, never verdicts.** On failure the guard prints each offending project with its path; the allowlist requires a non-empty reason per entry. Falsified if the guard emits only a boolean, or accepts an allowlist entry with no reason.

4. **Rule I — same verdict from a clean checkout.** The guard reads only committed/tracked state (`git ls-files`). Falsified if its verdict depends on untracked files, build cache, or working-tree state. Acceptance requires demonstrating identical verdict from a clean checkout of the pushed commit.

5. **Rule F — negative control (carried in the execution report, not this directive).** Add a throwaway `*.integration.spec.ts` to a project that is neither declared nor allowlisted, `git add` it, run the guard → it FAILS naming that project; revert → it PASSES. Raw output pasted in the report. A guard never observed failing is not accepted.

6. **Named defect closed.** `libs/identity` appears in `ci/integration-roots.txt`, not in the allowlist.

7. **Frozen count removed.** No literal integration-root count survives in `ci-integration.sh` prose.

8. **`libs/identity` viability probe — HALT gate.** With `libs/identity` enabled, its integration specs are run once in the full lane. If the gate goes red or exhibits Docker-saturation flake, **HALT and report to Lead and PO** — do not repair the specs inside this directive, and do not quietly move `libs/identity` back to the allowlist. Whether to repair or defer is a runway decision and belongs to the PO. Falsified (as a clean pass) only if the specs pass deterministically in the serial gate.

---

## 8. Standing HALT clause

> If, during execution, you discover that this change touches files, contracts, or behaviour not covered by this directive — or that its stated scope is wrong — HALT and report to Lead. Do not widen scope. Do not reconcile a contradiction on your own.

---

## 9. Base-SHA gate

**Tier 1 — HALT if changed since the pin** (the design depends on these):
- `ci/scripts/ci-integration.sh` — the `ROOTS` array, the `CI_AFFECTED` branch semantics, and the `:10` comment. If ROOTS membership or the affected/full lane logic has moved, the extraction and count-removal must be re-grounded.
- `ci/scripts/prepush.ts` — `INTEGRATION_ROOTS` and its consumption (`:84`, `:116-119`).
- `.github/workflows/ci.yml:467-485` — the `tests-integration` job wiring; if it no longer calls `ci-integration.sh`, the alias decision changes.
- The `describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')` gating convention — if integration specs stop gating this way, "absent from ROOTS ⇒ silently skipped" no longer holds and the problem statement must be re-derived.

**Tier 2 — REPORT and continue** (the build self-derives these at run time):
- The exact membership and cardinality of `discovered` (the `*.integration.spec.ts` set) — recomputed by the guard from `git ls-files` at run time; the pin's enumeration is a dated observation, not an input.
- The exact membership of the allowlist beyond `libs/identity`'s exclusion from it — the twelve are enumerated from the same discovery minus the declared set; if a spec-bearing project has been added or removed since the pin, the allowlist is regenerated and the delta reported, not halted on.

---

*Authored under `00-DIRECTIVE-STANDARD.md`. Not LOCKED until merged; merge = ratification.*
