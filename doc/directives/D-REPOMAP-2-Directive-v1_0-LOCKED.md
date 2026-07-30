# D-REPOMAP-2 — Build: Generated Repo Map

| Field                | Value                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Directive ID         | D-REPOMAP-2                                                                                                                  |
| Version              | v1.0                                                                                                                         |
| Status               | FOR RATIFICATION (merge of this file = ratified)                                                                             |
| Author lane          | Lead/Architect                                                                                                               |
| Target path          | `doc/directives/D-REPOMAP-2-Directive-v1_0-LOCKED.md`                                                                        |
| **Grounded against** | `3c5775371f8aa60cf43559fe91ed3bb380336147` (main, PR #513 merge)                                                             |
| Implements           | `doc/directives/D-REPOMAP-1-Directive-v1_1-LOCKED.md` (ratified, on main)                                                    |
| Governing artifacts  | D-REPOMAP-1 v1.1 §4 (scope), §4.4 (determinism), §5 (acceptance); `doc/05-conventions.md`; `.github/workflows/ci.yml` header |
| Dev branch           | `feat/repo-map` cut from `origin/main` at the pin                                                                            |

---

## 1. Grounding ledger

| How verified                                | What                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read by path (Lead, at the pin)             | `ci/scripts/` listing (12 entries), repo root listing, `.prettierignore`, `.prettierrc`, `nx.json`, `tsconfig.base.json`, `package.json`, `.github/workflows/ci.yml`, `doc/05-conventions.md` |
| Verified via GitHub checks API              | PR #513 completed with **33 check runs, all success**, `deployment-gate` green                                                                                                                |
| Enumerated                                  | 57 `@aramo/*` aliases (55 `libs/`, 2 `apps/`); 10 executable scripts in `ci/scripts/` plus `tsconfig.json` and `.gitkeep`; `.prettierrc` = `printWidth 100`, `tabWidth 2`, `endOfLine lf`     |
| **Resolved** open item (a) from D-REPOMAP-1 | No nx-graph helper exists in `ci/scripts/`. Nothing to reuse; the generator builds its own.                                                                                                   |
| **Resolved** open item (b) from D-REPOMAP-1 | `.prettierignore` exists and does **not** cover `doc/generated/`. See §3 — this changes the design.                                                                                           |
| **Resolved** — no CI `format:check`         | The 33 check runs on #513 contain no `format:check` or prettier job. `format` and `format:check` exist in `package.json` and are invoked by nothing in CI.                                    |
| **NOT verified — Code must confirm**        | (a) exact `git ls-files` count; (b) whether `ci/scripts/prepush.ts` invokes `format:check` locally; (c) whether `scripts/` or `tools/` reference any `package.json` script by name            |
| **NOT verified — runtime**                  | Nothing here touches runtime, the box, or the database.                                                                                                                                       |

---

## 2. Objective

Implement D-REPOMAP-1 v1.1 exactly as scoped. No scope beyond it.

## 3. Design amendment discovered at grounding — prettier round-trip

D-REPOMAP-1 §4.4 requires `JSON.stringify(value, null, 2) + '\n'`. **That is insufficient and must be superseded by this section.**

`.prettierignore` does not exclude `doc/generated/`, so the generated files are within prettier's scope. With `printWidth: 100`, prettier collapses short JSON arrays and objects onto one line when they fit; `JSON.stringify(…, null, 2)` always expands them. The two disagree — for example `["es2022"]` stays inline under prettier and expands under `stringify`.

Left unfixed, the committed map would be byte-unstable the first time anyone runs `npm run format`, and the drift check would fire spuriously.

**Required instead:** both generator and verifier serialise through prettier's own API using the repo's resolved config.

```ts
import * as prettier from 'prettier';

async function serialise(filePath: string, value: unknown): Promise<string> {
  const config = await prettier.resolveConfig(filePath);
  return prettier.format(JSON.stringify(value), { ...config, filepath: filePath });
}
```

Generator writes `serialise(...)`. Verifier regenerates through the identical function and byte-compares. They agree by construction, `format:check` would pass if it were ever wired, and no `.prettierignore` change is needed.

**Do not add `doc/generated/` to `.prettierignore`.** That is a convention change and is Lead's call, not a workaround to reach green.

## 4. Work plan

### 4.1 `ci/scripts/generate-repo-map.ts`

Follow the structure and error style of `ci/scripts/verify-error-codes.ts`. Pure: no network, no DB, no `Date.now()`.

Emits three files under `doc/generated/`, per D-REPOMAP-1 §4.2:

| File                     | Contents                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo-map.projects.json` | `projects` (name, root, sourceRoot, tags, target names) · `aliases` (from `tsconfig.base.json`) · `exports` (exported symbol names per lib `index.ts`) · `importedBy` (reverse index: alias → importing projects) |
| `repo-map.files.json`    | tracked paths from `git ls-files`, sorted; excluding `node_modules`, `dist`, `**/prisma/generated/**`, `package-lock.json`                                                                                        |
| `repo-map.coupling.json` | `pathRefs` (`{from,to,line}` where a file contains a string literal matching another tracked path) · `invocations` (script name → referencing files) · `orphanScripts` (scripts with zero references)             |

Invocation scan reads `.github/workflows/**`, `deploy/**`, `tools/**`, `scripts/**`, `ci/scripts/**`. Note `scripts/` is a separate directory from `ci/scripts/` — **both** must be scanned.

Sorting: every object key and array sorted explicitly. Never preserve source order — the `paths` block in `tsconfig.base.json` is not alphabetical.

### 4.2 `ci/scripts/verify-repo-map.ts`

Regenerates in memory via the same module, byte-compares against the committed files, exits non-zero on any difference, printing which file drifted and a bounded diff excerpt.

### 4.3 `package.json`

```
"repo-map:generate": "node --import jiti/register ci/scripts/generate-repo-map.ts",
"repo-map:check":    "node --import jiti/register ci/scripts/verify-repo-map.ts"
```

### 4.4 `.github/workflows/ci.yml`

Add one job copying the `error-codes-check` block byte-for-byte, substituting name and run line:

```yaml
repo-map-check:
  name: repo-map:check
  runs-on: ubuntu-latest
  needs: install
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v6
      with:
        node-version-file: .nvmrc
        cache: npm
    - run: npm ci || npm ci || npm ci # retry: free-email-domains postinstall fetches 3 third-party hosts and hard-exits on a transient ETIMEDOUT
    - run: npm run repo-map:check
```

Add `- repo-map-check` to `deployment-gate.needs`. Unconditional wall on all three lanes; never affected-scoped.

### 4.5 Out of scope

No endpoint inventory. No Prisma model inventory. No change to any existing lib, app, product surface, deploy artifact, or `.prettierignore`. Do not wire a `format:check` CI job — that is a separate ruling.

## 5. Acceptance criteria

Criteria 1–9 of D-REPOMAP-1 v1.1 §5 apply unchanged. In addition:

10. **Orphan set.** `orphanScripts` must contain, at minimum: `prisma:seed-platform-owner`, `prisma:seed-auth-storage`, `format`, `format:check`. The first two are the seeds absent from `deploy/seed-prod.sh`; the last two are confirmed absent from all 33 CI checks. **If any of the four is missing, the invocation scan has a gap — HALT and report which.**
11. **Prettier round-trip.** `npx prettier --check doc/generated/` exits 0 immediately after `npm run repo-map:generate`, with no `.prettierignore` modification.
12. **Cross-run stability.** `repo-map:generate` run twice with the working tree otherwise untouched produces zero `git diff`.

Criterion 10 is the acceptance test for the whole exercise: it is register item 9 detected statically, including two instances found by hand during authoring.

## 6. Standing HALT clause

> If, during execution, you discover that this change touches files, contracts, or behaviour not covered by this directive — or that its stated scope is wrong — **HALT and report to Lead. Do not widen scope. Do not reconcile a contradiction on your own.**
>
> Report what you found, where (path:line), and what you believe the correct scope is. Lead rules; any scope change is an amendment that merges **before** the code PR.

Directive-specific HALT triggers:

- `orphanScripts` returns a very large set (say, more than 15). That suggests the scan is over-reporting rather than that the repo is broken — report the full list before proceeding.
- `pathRefs` returns zero entries. Known-false; the scan is wrong.
- Any temptation to edit `.prettierignore`, `.prettierrc`, or an existing lib to reach green.

## 7. Base-SHA check (first step)

```
git fetch origin && git merge-base --is-ancestor 3c5775371f8aa60cf43559fe91ed3bb380336147 origin/main && echo PIN_OK

git diff --name-only 3c5775371f8aa60cf43559fe91ed3bb380336147..origin/main -- \
  nx.json tsconfig.base.json package.json .github/workflows/ci.yml \
  .prettierrc .prettierignore doc/05-conventions.md ci/scripts/
```

Empty output → proceed. Any output → **HALT and report**; recon may be stale.

Note the grounded-file set is wider than D-REPOMAP-1's, adding `.prettierrc`, `.prettierignore`, and `ci/scripts/` — all three are load-bearing for this build.
