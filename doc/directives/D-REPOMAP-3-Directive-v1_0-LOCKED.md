# D-REPOMAP-3 — Coupling identity is architectural, not textual

| Field        | Value                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Directive ID | D-REPOMAP-3                                                                                                                                               |
| Version      | v1.0                                                                                                                                                      |
| Status       | FOR RATIFICATION (merge of this file = ratified)                                                                                                          |
| Author lane  | Lead/Architect (drafted by Executor on PO relay, 2026-08-04)                                                                                              |
| Amends       | **D-REPOMAP-1 v1.1 §4.2** (`pathRefs`), **D-REPOMAP-2 v1.0** (coupling table row), **D-REPOMAP-2 Amendment v1.4 §1.3** (`invocations.references[]` shape) |
| Target path  | `doc/directives/D-REPOMAP-3-Directive-v1_0-LOCKED.md`                                                                                                     |

## 0. Why

The coupling map stores a **source line number** on every path-coupling edge and
every invocation reference. Nothing consumes it semantically (recon: the checker
whole-file byte-compares; `verify-vocabulary.sh` uses only the file paths; no query
tool, docs generator, editor/MCP integration, or test reads it). Its only effects
are (a) a sort tie-breaker inside the generator and (b) inclusion in the byte-compare.

Because the byte-compare includes the line, **any unrelated edit that shifts a line
above a recorded reference regenerates the coupling artifact** and fails
`repo-map:check`. Every PR that inserts or deletes a line above such a reference must
regenerate and commit the map. This is chronic drift on a location field no consumer
needs. D-REPOMAP-2 Amendment v1.4 §2 already named the sibling fault ("the staleness
gate is file-level… halts on any change… that cannot affect the build").

**Canonical coupling identity should represent architectural relationships, not
textual occurrences or current source offsets.**

## 1. Rulings

1. **Remove `PathRef.line` and `ScriptRef.line`** from the canonical coupling schema.
2. Canonical coupling identity **represents architectural relationships**, not textual
   occurrences or current source offsets.
3. **`PathRef` identity** is `from`, `to`, `status`, and `excludedBy` where present.
4. **`ScriptRef` identity** is its enclosing invocation identity (the script name),
   its `kind`, and its `path`.
5. **Multiple textual occurrences of the same canonical relationship collapse to one
   edge.** This is an explicit ruling, not an accidental side effect of dropping `line`.
6. **Do not add `occurrence_count`.** Frequency is non-canonical implementation detail
   and would reintroduce drift.
7. **Deterministic ordering uses stable semantic fields only.** No location field may
   participate in ordering, equality, hashing, fingerprints, or `repo-map:check` drift
   detection.
8. **No debug/source-location artifact in this change** (recon found no consumer). A
   FUTURE non-canonical diagnostic artifact, **excluded from `repo-map:check`**, is
   permitted but out of scope here. (F-2 rationale: an invocation reference — a `prose`
   or `npm-run` occurrence — is a diagnostic, so a source location is _more plausibly_
   wanted there than on a `pathRef`. That case is exactly the future debug artifact
   above: it does not belong in the artifact byte-compared on every PR.)
9. The implementation PR must prove the acceptance set in §8.

## 2. Exact current clauses superseded

**(a) D-REPOMAP-1 v1.1 §4.2 — `repo-map.coupling.json`:**

> `pathRefs`: every file containing a string literal that matches another tracked file
> path, as `{ from, to, line }`. _This is the PR-5b class._

**(b) D-REPOMAP-2 v1.0 — coupling table row:**

> `repo-map.coupling.json` | `pathRefs` (`{from,to,line}` where a file contains a string
> literal matching another tracked path) · `invocations` (script name → referencing
> files) · `orphanScripts` (scripts with zero references)

**(c) D-REPOMAP-2 Amendment v1.4 §1.3 — `invocations.references[]` element shape:**

> `{ kind: "npm-run", path: "ci/scripts/prepush.ts", line: 123 }`

This amendment strikes `line` from (a), (b), and (c). All other content of those
clauses — the definition of what constitutes a `pathRef`, the invocation scan universe,
`orphanScripts`/`unreferenced`, the `prose`-never-counts rule, `status`/`excludedBy` —
is **unchanged**.

**F-1 (PO ruling): the spec references to `line` are the consumer check PASSING, not a
blocker.** These five sites — clauses (a), (b), (c) above plus the generator's
`PathRef` type (`generate-repo-map.ts:385`) and `ScriptRef` type (`:426`) — assert
`line` exists _because the current shape has it_. Updating them **is** the change, not
an obstacle to it. Nothing **reads** `line` for behaviour (no tool, doc generator, or
query), so striking it from the schema and these five declarations is the whole of the
work; there is no behavioural consumer to migrate.

## 3. Old and new JSON shapes

**`pathRefs[]` — OLD → NEW**

```
OLD: { "from": "<path>", "to": "<path>", "line": <int>, "status": "<status>", "excludedBy"?: "<glob>" }
NEW: { "from": "<path>", "to": "<path>",                "status": "<status>", "excludedBy"?: "<glob>" }
```

**`scripts[].references[]` (the invocation references — the `ScriptRef`) — OLD → NEW**

```
OLD: { "kind": "<RefKind>", "path": "<path>", "line": <int> }
NEW: { "kind": "<RefKind>", "path": "<path>" }
```

**Both line-bearing structures are covered (F-2, PO ruling).** `repo-map.coupling.json`
has exactly two structures that carry `line`: `pathRefs[]` (3003 entries) and
`scripts[].references[]` (251 entries — the invocation references). This amendment
strikes `line` from **both** — fixing one and leaving its twin would reopen the same
`repo-map:check` failure from the other direction. There is **no separate
`unresolvedInvocations` field**: `scripts[].references[]` is the invocation-reference
structure the PO's F-2 names, and `unreferenced` (the orphan-script diagnostic) is a
plain `string[]` of script names that carries **no** `line` — nothing to remove there.

`repo-map.files.json` and `repo-map.projects.json` are unchanged (they carry no `line`).
`scanScope`, `scripts[].name`, and `unreferenced` are unchanged.

## 4. Canonical identity rules

- A `pathRef` edge is uniquely identified by the tuple **(`from`, `to`, `status`,
  `excludedBy`)**. Two edges with the same tuple are the same edge.
- An invocation `reference` is uniquely identified by **(enclosing script name, `kind`,
  `path`)**.
- Identity is **location-free**: it does not change when a reference moves within a
  file, and it does not depend on how many times the reference textually appears.

## 5. Deduplication rules

- When a file references the same target on multiple lines (or a script is referenced
  multiple times in the same file under the same `kind`), the generator emits **exactly
  one** edge/reference for that identity tuple.
- Deduplication is by the §4 identity tuple. `status`/`excludedBy` are part of the
  tuple, so a genuine status difference remains two edges; a pure line difference does
  not.

## 6. Sort rules

- Arrays are sorted by their **semantic identity fields only**, by code-unit order:
  `pathRefs` by (`from`, `to`, `status`); `invocations` and their `references` by
  (script name), then (`path`, `kind`). **No location field participates in the
  comparator** (superseding `generate-repo-map.ts`'s `… || a.line - b.line` tie-break).
- Ordering must be total and deterministic after `line` is removed; where the prior
  comparator relied on `line` as the final tie-break, the new final tie-break is the
  identity tuple itself (which is now unique after dedup, so ordering is total).

## 7. Migration & generated-artifact impact

- **Generator** (`ci/scripts/generate-repo-map.ts`): remove `line` from the `PathRef`
  and `ScriptRef` types; stop computing/emitting it; dedup by identity tuple; drop the
  `line` tie-break from both comparators. Localized to the pathRef producer (~`:385`,
  `:403–418`) and the invocation producer (~`:426`, `:500–518`).
- **Generated artifact** (`doc/generated/repo-map.coupling.json`): regenerate. The diff
  is **large but purely mechanical** — 3254 `line` fields removed plus edge dedup;
  `files.json`/`projects.json` unchanged.
- **Checker** (`ci/scripts/verify-repo-map.ts`): **no change** — it byte-compares
  whatever the generator emits.
- **`verify-vocabulary.sh`**: **no change** — consumes file paths, not `line`.
- **CI wiring / lanes**: unchanged; `repo-map:check` remains a wall.
- **No consumer migration**: recon confirmed no semantic dependency on `line`.

## 8. Test & gate requirements (the implementation PR must prove ALL)

1. Inserting a blank line above a recorded reference **does not** alter canonical
   coupling output — asserted for **BOTH** a `pathRef` AND a `scripts[].references`
   invocation reference (F-2: both line-bearing structures).
2. Moving an unchanged reference to a different line within a file **does not** alter it
   — asserted for **BOTH** a `pathRef` AND an invocation reference.
3. Adding a **new** architectural relationship **does** change it.
4. Deleting the **final** occurrence of a relationship **removes** the edge.
5. Adding a **duplicate** occurrence **does not** duplicate the edge.
6. Generation is **deterministic** (byte-identical across repeated runs).
7. **No semantic consumer** depended on `line` (restated from recon; assert the checker
   - vocab paths are unaffected).
8. `repo-map:generate` and `repo-map:check` pass.
9. `npm audit` passes with `fast-uri 3.1.5`.

Tests 1, 2, 5 are the load-bearing new proofs (the drift-immunity properties this
amendment exists to create) and **MUST FAIL against the pre-amendment generator** —
including the `scripts[].references` half of tests 1 and 2. A proof set that passes
both with and without the amendment demonstrates nothing about the churn this removes;
the implementation PR must state explicitly that these were verified to fail first.

## 9. Ordering constraint

**This amendment must merge BEFORE the code PR.** Both amended directives mandate it:
D-REPOMAP-1 v1.1 standing clause ("Lead rules; if the scope changes, the directive is
amended and the amendment merges **before** the code PR") and D-REPOMAP-2 §6 ("any scope
change is an amendment that merges **before** the code PR"). The generator/artifact PR
is gated on this file being merged first.

## 10. Implementation note — filing this directive regenerates repo-map (deterministic byproduct)

`doc/directives/` participates in canonical repo-map generation: it is a tracked path
in `repo-map.files.json`, and directive prose that cites tracked file paths produces
`pathRefs` edges in `repo-map.coupling.json` (58 such edges originate from existing
`doc/directives/*` today). Therefore **filing a new directive necessarily regenerates
the canonical repo-map artifacts** — one new `files.json` entry for this directive, and
new `coupling.json` `pathRefs` whose `from` is this directive. That regeneration is a
**deterministic byproduct of adding a tracked file under repository policy, not
additional implementation scope**. This directive's own ratification PR therefore
carries `repo-map.files.json` and `repo-map.coupling.json` alongside the authored file
— one authored directive plus deterministic generated artifacts required by policy.
`repo-map:check` is not suppressed and `doc/directives/` is not excluded.

_End of D-REPOMAP-3 v1.0 — FOR RATIFICATION (merge of this file = ratified)._
