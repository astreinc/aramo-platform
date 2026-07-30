# D-REPOMAP-1 — Generated Repo Map (Lead Grounding Substrate)

| Field                | Value                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Directive ID         | D-REPOMAP-1                                                                                                        |
| Version              | **v1.1**                                                                                                           |
| Supersedes           | v1.0 — **never filed, never ratified.** Halted at the recon-staleness gate. Do not file v1.0.                      |
| Status               | FOR RATIFICATION (merge of this file = ratified)                                                                   |
| Author lane          | Lead/Architect                                                                                                     |
| Target path          | `doc/directives/D-REPOMAP-1-Directive-v1_1-LOCKED.md`                                                              |
| **Grounded against** | `9c91fb65e9ba9760d735736c10ac31ac49c3827e` (main, 2026-07-30T17:43:32Z, PR #512)                                   |
| Governing artifacts  | `doc/05-conventions.md`; `doc/02-claude-code-discipline.md`; `.github/workflows/ci.yml` header (CI-Velocity lanes) |
| Branch               | `directive/repomap-1` → dev branch `feat/repo-map`                                                                 |

---

## 0. Change log v1.0 → v1.1

| #   | Change                                                                                                                                      | Cause                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pin advanced `80772e88` → `9c91fb65`                                                                                                        | PR #512 (`feat/policy-engine`, ADR-0024 PR-1) landed on main mid-session, adding `@aramo/policy-engine` to `tsconfig.base.json`. Caught by the staleness gate. |
| 2   | **Correction:** v1.0 stated "57 `@aramo/*` path aliases." The count at `80772e88` was **56**, not 57. v1.0's figure was wrong when written. | Lead counted by eye instead of enumerating. Recorded rather than silently fixed.                                                                               |
| 3   | **Correction:** v1.0 called these "libs." 2 of the aliases resolve into `apps/`, not `libs/`.                                               | Same.                                                                                                                                                          |
| 4   | Added §4.4 ordering requirement — the alias block is not alphabetically ordered in source                                                   | Discovered during re-verification.                                                                                                                             |
| 5   | Added acceptance criterion 9 (alias-count self-check)                                                                                       | Makes the corrected counts machine-verified instead of hand-asserted.                                                                                          |

---

## 1. Grounding ledger

Everything below is stated at the pinned SHA. Anything not listed here is **unverified** and must be treated as an assumption.

| How verified                                | What                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read by path (Lead, in-session, at the pin) | `nx.json`, `tsconfig.base.json`, `package.json`, `.github/workflows/ci.yml`, `doc/05-conventions.md`, `doc/` listing, `.github/workflows/` listing, `libs/policy-engine/src/` listing                                                                                                                       |
| Enumerated (not estimated)                  | **57 `@aramo/*` path aliases: 55 resolving into `libs/`, 2 into `apps/`** (`@aramo/api` → `apps/api/src/app.module.ts`; `@aramo/auth-service` → `apps/auth-service/src/app/auth/auth.module.ts`)                                                                                                            |
| Derived from the above                      | 4 docker matrix legs; 21 jobs in `deployment-gate.needs`; `ci/scripts/*.ts` + `node --import jiti/register` convention; three CI lanes (pull_request / merge_group / schedule); alias block is **not** alphabetically ordered in source                                                                     |
| Confirmed no hazard                         | `libs/policy-engine/src/index.ts` exists (1170 bytes), standard `lib/` + `tests/` + `index.ts` shape — the new alias resolves, so the generator's `exports` step will not fault on it                                                                                                                       |
| **NOT verified — Code must confirm**        | (a) whether `ci/scripts/` contains an existing helper for reading the nx project graph; (b) whether `.prettierignore` exists and whether `npm run format:check` would flag generated JSON; (c) the exact file count under `git ls-files`; (d) whether any existing script already emits a project inventory |
| **NOT verified — runtime**                  | Nothing in this directive touches runtime, the box, or the database.                                                                                                                                                                                                                                        |

---

## 2. Problem

The Lead/Architect lane authors directives from `claude.ai`, which can **read any file by path but cannot search the repository** — GitHub code search does not index this private repo (verified 2026-07-30: `tc-button--ghost` is present in `libs/fe-foundation/src/components/Button.tsx` and `search_code` returns `total_count: 0`).

Consequence: Lead can confirm facts it already suspects, but cannot _discover_ coupling. The defect classes this has produced are all discovery failures:

- **Path-coupling** — a spec read `auth.controller.ts` by literal path and broke on the PR-5b move.
- **Blast-radius scoping** — the `asChild`-over-`Button` inventory is what bounded the forwardRef fix; without it the directive scope would have been wrong.
- **Deploy-path wiring (register item 9)** — an artifact exists in the repo but nothing in the deploy path invokes it. Four confirmed instances; two live prod outages.

A fourth instance was produced by this very directive: v1.0 asserted a hand-counted alias figure that was wrong. Counts stated by a human reading a file are unreliable; counts emitted by a generator that CI keeps current are not.

Every one of these is answerable from a static index.

## 3. Decision

Add a **generated repo map** to the repository, maintained by the same generate-and-compare idiom already used by `openapi:drift-check`, `version:sync-check`, and `error-codes:check`.

**Rejected alternative:** a CI job that commits the map back to `main`. It would retrigger the `push` lane, contend with branch protection, and add bot commits to the history. The drift-check idiom achieves the same currency guarantee with none of that, and it is the house pattern.

## 4. Scope

### 4.1 New scripts

| Path                              | Purpose                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ci/scripts/generate-repo-map.ts` | Writes the map files. Pure; no network; no DB.                                                                          |
| `ci/scripts/verify-repo-map.ts`   | Regenerates to a temp dir, byte-compares against committed files, exits non-zero on any difference with a diff summary. |

`package.json` scripts, matching existing style:

```
"repo-map:generate": "node --import jiti/register ci/scripts/generate-repo-map.ts",
"repo-map:check":    "node --import jiti/register ci/scripts/verify-repo-map.ts"
```

### 4.2 Generated artifacts

Three files under `doc/generated/` — split so each is independently readable rather than one large blob.

**`repo-map.projects.json`**

- Every nx project: `name`, `root`, `sourceRoot`, `tags`, `targets` (names only)
- `aliases`: the `@aramo/*` → path map from `tsconfig.base.json`
- `exports`: exported symbol names per lib `index.ts`
- `importedBy`: **reverse index** — for each `@aramo/*` alias, the list of projects importing it

**`repo-map.files.json`**

- Every tracked file path from `git ls-files`, sorted
- Excludes: `node_modules`, `dist`, `**/prisma/generated/**`, `package-lock.json`

**`repo-map.coupling.json`**

- `pathRefs`: every file containing a string literal that matches another tracked file path, as `{ from, to, line }`. _This is the PR-5b class._
- `invocations`: every `package.json` script name, paired with every reference to it found in `.github/workflows/**`, `deploy/**`, `tools/**`, and `ci/scripts/**`. A script with **zero** invocations is reported under `orphanScripts`. _This is register item 9._

### 4.3 CI wiring

Add one job to `.github/workflows/ci.yml`, following the `error-codes-check` job byte-pattern (checkout@v4 → setup-node@v6 with `.nvmrc` + npm cache → the triple `npm ci` retry → run):

```yaml
repo-map-check:
  name: repo-map:check
  runs-on: ubuntu-latest
  needs: install
```

Add `repo-map-check` to `deployment-gate.needs`. It is a **wall**: unconditional on all three lanes, never affected-scoped, per the workflow header invariant.

### 4.4 Determinism

The drift check only works if generation is byte-stable. Required:

- All object keys sorted; all arrays sorted by a stated key
- **Explicit sort, never source order.** The `paths` block in `tsconfig.base.json` is _not_ alphabetically ordered — `portal-identity` falls between `calendar` and `canonicalization`, `policy-engine` between `matching` and `metering`, `examination` after `field-masking`. Preserving file order would make the map churn on unrelated edits.
- `JSON.stringify(value, null, 2) + '\n'`, LF endings
- No timestamps, no SHAs, no absolute paths, no host or user names, no `Date.now()`
- Output identical across Linux and macOS, and independent of `git` clone order

### 4.5 Out of scope

Deliberately excluded from v1.1 — do not add them:

- HTTP endpoint inventory (needs decorator parsing; belongs in its own directive)
- Prisma model/column inventory (large; overlaps `prisma:validate`)
- Any runtime, deploy, or database behaviour
- Any change to an existing lib, app, or product surface

## 5. Acceptance criteria

1. `npm run repo-map:generate` produces all three files under `doc/generated/`.
2. Running it twice produces byte-identical output.
3. `npm run repo-map:check` exits 0 on a clean tree.
4. **Negative control (mandatory):** hand-edit one committed map file, confirm `repo-map:check` **fails** with a readable diff, then revert. Paste the failure output in the Gate-6 report. A check not proven to fail is not a check.
5. `repo-map.coupling.json` `orphanScripts` is non-empty and includes at least `prisma:seed-platform-owner` and `prisma:seed-auth-storage` — both known-uninvoked by `deploy/seed-prod.sh`. **If it does not, the invocation scan is wrong — HALT.**
6. `repo-map.coupling.json` `pathRefs` contains at least one entry (specs referencing files by literal path are known to exist).
7. Full local gate passes: `npm run lint`, `npm run test`, `npm run format:check`.
8. `deployment-gate` lists `repo-map-check`.
9. **Alias self-check:** `repo-map.projects.json` `aliases` contains exactly **57** entries at the pin — **55** resolving under `libs/`, **2** under `apps/`. If the generator emits different numbers, either the pin has moved (re-verify) or the reader is wrong — **HALT and report both counts.**

Criteria 5 and 9 are the load-bearing ones. Criterion 5 reproduces, statically, the defect that caused two production outages. Criterion 9 replaces a hand-counted figure — which v1.0 got wrong — with a machine-checked one.

## 6. Standing HALT clause

Applies to this and every directive under the GitHub-canonical model:

> If, during execution, you discover that this change touches files, contracts, or behaviour not covered by this directive — or that its stated scope is wrong — **HALT and report to Lead. Do not widen scope. Do not reconcile a contradiction on your own.**
>
> Report: what you found, where (path:line), and what you believe the correct scope is. Lead rules; if the scope changes, the directive is amended and the amendment merges **before** the code PR.

Specific to this directive: if `format:check` rejects the generated JSON, HALT rather than adding a `.prettierignore` entry — that is a convention change and is Lead's call.

## 7. Base-SHA check (first step)

Before any edit, confirm the tree still matches the pin:

```
git fetch origin && git merge-base --is-ancestor 9c91fb65e9ba9760d735736c10ac31ac49c3827e origin/main && echo PIN_OK
```

Then confirm the grounded files are unchanged since the pin:

```
git diff --name-only 9c91fb65e9ba9760d735736c10ac31ac49c3827e..origin/main -- \
  nx.json tsconfig.base.json package.json \
  .github/workflows/ci.yml doc/05-conventions.md
```

Empty output → proceed. Any output → **HALT and report**; the recon behind this directive may be stale.

## 8. Why this one first

It is self-contained, touches no product surface, cannot affect a tenant, and every directive authored after it is better grounded. It is the cheapest possible pilot for the new lane mechanism — and it has already paid for itself once, by catching a stale pin and a bad hand count before either reached a build.
