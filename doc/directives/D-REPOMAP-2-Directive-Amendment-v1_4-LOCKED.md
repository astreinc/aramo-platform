# D-REPOMAP-2 — Directive Amendment v1.4

| Field                | Value                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Amends               | `doc/directives/D-REPOMAP-2-Directive-v1_0-LOCKED.md` (ratified, PR #514) and `doc/directives/D-REPOMAP-1-Directive-v1_1-LOCKED.md` §5.9 (ratified, PR #513) |
| Version              | v1.4                                                                                                                                                         |
| Supersedes           | v1.1, v1.2, v1.3 — all authored, none filed. Do not file any of them.                                                                                        |
| Status               | FOR RATIFICATION (merge = ratified)                                                                                                                          |
| Author lane          | Lead/Architect                                                                                                                                               |
| Target path          | `doc/directives/D-REPOMAP-2-Directive-Amendment-v1_4-LOCKED.md`                                                                                              |
| **Grounded against** | `e0f9e8fc3557f6ddd86e11b53ea3f21ad3e6d1fb` (main, PR #515 merge, 2026-07-30T19:13:48Z)                                                                       |
| Ruling IDs           | R-REPOMAP-1, R-REPOMAP-2                                                                                                                                     |

Two rulings, both raised by standing-clause HALTs from Code before any generator code was written. No product surface is touched by either.

---

## 1. R-REPOMAP-1 — the invocation scan emits evidence, not a judgement

### 1.1 What was wrong

v1.0 §4.1 specified `orphanScripts` — script names with zero references — without defining "reference." Code demonstrated, with path:line evidence, that three principled definitions yield three different orphan sets, and that none satisfies acceptance criterion 10 without either counting English prose as an invocation or conflating npm scripts with nx targets.

- `deploy/backup/pg-backup.sh:5` and `:38` contain an ordinary English word inside comments that collides with a script name. Any bare-token definition counts these as invocations and wrongly rescues that script.
- `ci/scripts/prepush.ts:123` invokes `npm run --silent verify:vocabulary`. A rigid `npm run <name>` needle misses the flag and wrongly orphans it.
- `.github/workflows/ci.yml:123`, `:147`, `:230` run `npx nx affected -t lint|build|test`. These exercise **nx targets**, not the identically-named npm scripts. The npm script `lint` is `nx run-many --target=lint --all` — a wrapper CI never calls.

**The root fault is the output type.** A boolean forces a judgement onto a question with genuine categories; whichever rule produces it silently decides contested cases, which makes the rule a place to hide tuning.

### 1.2 Ruling

**The map emits classified evidence with provenance. It does not emit a judgement.** This is R10 applied to static analysis, and PROPOSE/DISPOSE in miniature: the generator proposes evidence; a human disposes.

Definition C — counting `nx -t <name>` as an invocation of the same-named npm script — is **rejected**. It reaches a convenient answer through a namespace conflation.

### 1.3 Replaces v1.0 §4.1 `invocations` / `orphanScripts`

`repo-map.coupling.json` emits:

```
scripts: [
  {
    name: "verify:vocabulary",
    references: [
      { kind: "npm-run", path: "ci/scripts/prepush.ts", line: 123 }
    ]
  },
  ...
]
unreferenced: [ "...names with zero non-prose references..." ]
```

`kind` is exactly one of:

| kind          | Meaning                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm-run`     | `npm run` / `npm run --flag` invoking this script **by script name**. Flag-tolerant.                                           |
| `nx-target`   | `nx … -t <name>` or `--target=<name>` colliding with this script name. **Recorded, but this is an nx target, not the script.** |
| `script-body` | The name appears inside another `package.json` script's command string.                                                        |
| `prose`       | The token appears in a comment, markdown, or other non-executable text.                                                        |

Rules:

- Whole-token matching, confined to string literals or command positions.
- **`prose` never counts as an invocation.**
- `unreferenced` = zero entries of kind `npm-run`, `nx-target`, or `script-body`.
- `nx-target` counts toward referenced status but **must remain separately labelled**.

### 1.4 Scan scope

`.github/workflows/**`, `deploy/**`, `tools/**`, `scripts/**`, `ci/scripts/**`, `.husky/**`. If `.husky/` does not exist, record that fact rather than skipping silently — its absence is a finding.

## 2. R-REPOMAP-2 — assertions are self-derived, and the staleness gate is two-tier

### 2.1 What was wrong

D-REPOMAP-1 v1.1 §5.9 froze an alias count into the directive as an acceptance constant. That criterion existed because a hand count had been wrong — but freezing the corrected count reproduces the same fault more slowly. It decayed twice in one working session, as PR #512 and PR #515 each added an alias.

The related fault is that the staleness gate is file-level. It halts on any change to a grounded file, including changes that cannot affect the build. PR #515 altered `package.json` script _bodies_ (appending a schema path to the prisma chains) without adding or removing any script _name_ — leaving the invocation-scan universe untouched — yet a file-level gate halts on it.

### 2.2 Ruling — replaces D-REPOMAP-1 v1.1 §5.9 (criterion 9)

The generator is **not** checked against a frozen integer. Instead:

- The `aliases` map emitted in `repo-map.projects.json` must equal, **as a set**, the `compilerOptions.paths` keys in `tsconfig.base.json` at the built commit.
- Every alias target must resolve to a file that exists in the tree.
- Totals — overall, into `libs/`, into `apps/` — are emitted as **data in the map** and are asserted nowhere in any directive.

Set-equality tests extraction correctness, which is strictly stronger than cardinality, and it cannot stale.

### 2.3 Ruling — two-tier staleness gate

Applies to this directive and to any subsequent long-running build directive.

**Tier 1 — HALT.** Artifacts the directive's _design_ depends on:
`.github/workflows/ci.yml`, `.prettierrc`, `.prettierignore`, `doc/05-conventions.md`, `ci/scripts/`, and the **key set** of `package.json` `.scripts`.

**Tier 2 — REPORT and continue.** Data the build self-derives at run time:
`tsconfig.base.json`, `nx.json`, and `package.json` script **bodies**.

The `package.json` distinction is semantic, not file-level. The gate compares `.scripts` key sets, not file bytes.

## 3. Findings accepted as true positives

Not to be tuned away. Each is a genuine instance of the deploy-path wiring defect class (register item 9):

| Script                                                                                                                                         | Finding                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepush`                                                                                                                                      | Zero in-tree references; no `.husky/` in the repo. A fresh clone installs no hook, silently.                                                                                                                                                                                                            |
| `tests:integration`                                                                                                                            | The npm script enumerates integration roots; `ci/scripts/ci-integration.sh` enumerates them independently; CI runs the shell script. Two unsynchronised definitions of one suite. **This is the mechanism by which `libs/identity` stayed outside the ROOTS list and D-SEED-SCOPES-1 reached the box.** |
| `prisma:generate-identity`, `prisma:generate-auth-storage`, `prisma:validate-identity`, `prisma:validate-auth-storage`, `prisma:seed-identity` | Multi-schema convenience scripts wired into no CI or deploy path. Further register-item-9 instances.                                                                                                                                                                                                    |

## 4. Amended acceptance criteria

**Criterion 9 (replaces D-REPOMAP-1 v1.1 §5.9).** As §2.2 above — set-equality plus resolvability, no frozen totals.

**Criterion 10 (replaces v1.0 §5.10).** `unreferenced` must contain at minimum `prisma:seed-platform-owner`, `prisma:seed-auth-storage`, `format`, and `format:check`. If any is missing, HALT and report which, together with its `references` array — a `prose`-only reference set miscounted as an invocation is the expected failure mode.

**Criterion 10b.** `format` must appear in `unreferenced` **and** carry exactly two `prose` references at `deploy/backup/pg-backup.sh:5` and `:38`. Proves prose classification works rather than that prose was missed.

**Criterion 10c.** `lint`, `build`, and `test` must each carry at least one `nx-target` reference into `.github/workflows/ci.yml`. Proves the namespace distinction is recorded rather than collapsed — under the rejected Definition C this would fail.

**The ~15 orphan ceiling in v1.0 §6 is WITHDRAWN.** Asserted without basis. Report the full list; a large count is information, not a fault.

## 5. Unchanged

Everything else in D-REPOMAP-2 v1.0 and D-REPOMAP-1 v1.1 stands: the §3 prettier round-trip override, `repo-map.projects.json`, `repo-map.files.json`, `pathRefs`, the CI job and its `deployment-gate` wiring, and criteria 1–8, 11, 12.

`feat/repo-map` must be re-cut or rebased onto the pin above before the build proceeds.

## 6. Vocabulary gate ruling

`doc/directives/**` is **not** added to the Tier-2 exclusion list in `scripts/verify-vocabulary.sh`.

The gate blocked two earlier drafts of this amendment, both Lead-authored. Directives are checked-in prose that people read; the discipline binds their author as much as any other contributor. If a future directive genuinely requires an excluded term, it takes a named per-file entry — a visible, reviewable act, consistent with existing entries. No blanket glob.

**Consequence for authoring.** Every directive must pass `bash scripts/verify-vocabulary.sh` before filing, and a narrower ad-hoc check is not a substitute. Directive prose refers to `scripts/verify-vocabulary.sh` and `doc/02-claude-code-discipline.md` Rule 5 as the authority and does not restate their contents.

## 7. Standing HALT clause

Unchanged from v1.0 §6, minus the withdrawn ceiling. The instruction that produced both rulings — halt on an underspecified or stale premise rather than choosing on your own authority — worked as intended and remains in force.
