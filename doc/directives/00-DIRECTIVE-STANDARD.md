# 00 — Directive Standard

**Binds:** anyone authoring a directive in this repo, human or agent.
**Directives live in:** `doc/directives/`. Merge of a directive PR = ratification.
**Authority:** `doc/02-claude-code-discipline.md`, `doc/05-conventions.md`, `scripts/verify-vocabulary.sh`.

This document is amendable, not immutable. When a defect escapes the rules below, add a rule and cite the defect.

---

## Part 1 — Required sections

Directives come in two weights. The weight is declared in the header and is not a matter of taste.

**FULL** — the change can affect a tenant, production, the database schema, a cross-cutting invariant, or an external contract.

**LIGHT** — repo-internal only. Cannot affect a tenant, production, or the schema. Tooling, CI wiring, developer ergonomics, documentation.

If the weight is arguable, it is FULL.

| Section               | FULL                       | LIGHT                                                                                       |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| Header table          | required                   | required                                                                                    |
| Grounding             | full ledger table          | inline `path:line` citations; no table                                                      |
| Problem               | required                   | required                                                                                    |
| Decision              | required                   | required                                                                                    |
| Rejected alternatives | required                   | required — it is cheap, and it is the cheapest evidence that the decision was thought about |
| Scope, in and out     | required                   | required                                                                                    |
| Acceptance criteria   | required                   | required                                                                                    |
| Standing HALT clause  | required                   | required                                                                                    |
| Base-SHA gate         | two-tier, both sets listed | single `--is-ancestor` check; state "no design-dependent artifacts" if true                 |

**Header table** — ID · version · **weight** · status · target path · **pin** · governing artifacts · dev branch · parent directive if any.

The **pin** is `origin/main`'s tip commit, whatever its type. Never a feature-branch tip — a branch tip passes `--is-ancestor` while not representing main's state. The `--is-ancestor` check in Part 3 is what verifies it.

**Grounding ledger** (FULL) — four row kinds: _read by path_ · _enumerated_ · **NOT VERIFIED** · _NOT VERIFIED — runtime_. If there are no unverified rows, state in one line why the work has no assumptions.

**Scope** — in-scope work, and an out-of-scope list of things deliberately not done. If it is empty, say in one line why nothing adjacent was in reach.

**Standing HALT clause** — verbatim:

> If, during execution, you discover that this change touches files, contracts, or behaviour not covered by this directive — or that its stated scope is wrong — HALT and report to Lead. Do not widen scope. Do not reconcile a contradiction on your own.

**Base-SHA gate** (FULL) — two tiers. **Tier 1, HALT:** artifacts the _design_ depends on. **Tier 2, REPORT and continue:** data the build _self-derives_ at run time. Where the distinction is semantic rather than file-level — `package.json` script names versus script bodies — compare the semantic unit, not file bytes.

---

## Part 2 — Authoring rules

Each rule exists because it was violated and cost real time. Each states its own check.

**A — Cite, or mark unverified.**
Every claim carries `path:line`. A claim without a citation is an assumption and belongs in the NOT VERIFIED row. Binds equally in review: a concurrence states what was checked, an objection quotes the source. A review with neither is noise.
_Check:_ can every factual claim be traced to a path?

**B — Assert guarded invariants, never unguarded values.**
_The test:_ a value is **banned** if nothing fails when it goes stale. It is a **required invariant** if a guard catches the drift.
Not "58 aliases" (nothing catches its decay) but "the emitted alias set equals `compilerOptions.paths` keys at the built commit" (the drift check catches it).
This governs **forward assertions**. It does not govern observations dated to the pin — a ledger row saying "at commit X, N aliases" stays true forever. Nor does it govern enumerated scope ("all 11 call sites"), because the standing HALT clause is its guard: if execution finds 14, it halts.
_Check:_ for each number in this directive — what fails if it goes stale? If the answer is "nothing," it is either a dated observation or a defect.
_(A frozen count decayed twice in one working session — R-REPOMAP-2)_

**C — Classify, never emit a verdict.**
If a proposed output is a boolean, and producing it requires silently deciding contested cases, the **output type is the defect**, not the matching rule. Emit classified evidence with provenance; let a human dispose. R10 applied to tooling.
_Check:_ does any output collapse cases that a reader would want distinguished?
_(R-REPOMAP-1; reconfirmed by R-REPOMAP-4, where a binary filter would have silently dropped every test edge)_

**D — Never create a second copy of a fact maintained elsewhere.**
Before writing any list, glob, constant, or threshold: _what already maintains this fact?_ Derive from it.
_Check:_ for each list in this directive — does something else already hold it?
_(The `tests:integration` divergence: the npm script and `ci-integration.sh` enumerate roots independently, which is how a library stayed outside the tested set and a seed defect reached production)_

**E — Never restate a locked-vocabulary anti-term.**
Refer to `scripts/verify-vocabulary.sh` and `doc/02-claude-code-discipline.md` Rule 5 as the authority. Do not enumerate their contents, quote a term as a literal, or write a regex containing one — including in a change log describing a previous violation.
_Check:_ `bash scripts/verify-vocabulary.sh` exits 0.
_(Two consecutive drafts were blocked, the second by prose describing the first)_

**F — A guard is not trusted until it has been observed failing.**
Two lanes, two artifacts:

- The **directive** specifies the negative control as an acceptance criterion: _"guard X must be shown failing against a seeded violation, then passing after revert."_
- The **execution report** carries the raw output of that cycle.
  A directive cannot paste output for a guard that does not exist yet. It can and must require it.
  _Check:_ does every new check have a stated negative control, and does the report carry its output?

**G — Read the restriction before ruling on it.**
Do not assert why a rule exists. Quote it. A restriction often carries a qualifier that inverts the correct action — a term forbidden _as an entity name_ is canonical in every other position.
_Check:_ does every "X is forbidden/required" carry a quoted source?
_(A rename was recommended for eleven correctly-named files before the rule was read)_

**H — Match ceremony to stakes.**
The header weight is this rule, made mechanical. State in one line what the change can damage: a tenant, production, the schema, or nothing outside the repo. Over-ceremony is a real cost, paid in calendar.
_Check:_ is the declared weight defensible?

**I — A guard's verdict counts only from the state CI sees.**
A check that passes because of local working state has not been verified. Before trusting any guard: the index must reflect what will be committed (new files `git add`ed), caches must not be masking the result, and nothing staged-but-uncommitted may be doing the work.
_Check:_ would this guard return the same verdict from a clean checkout of the commit being pushed?
_(The repo map is `git ls-files`-based: untracked new files are invisible to a local run while CI sees them tracked — green locally, red in CI. Same family: nx cache hiding type errors, `eslint --fix` on staging, lockfile regeneration.)_

---

## Part 3 — Pre-filing checklist

Pointers to Part 2, plus mechanical items. The rule text has one home; nothing here restates it.

- [ ] Weight declared and defensible — **Rule H**
- [ ] Every claim cited or marked unverified — **Rule A**
- [ ] No unguarded forward value — **Rule B**
- [ ] No verdict output over a question with categories — **Rule C**
- [ ] No list duplicating a fact maintained elsewhere — **Rule D**
- [ ] `bash scripts/verify-vocabulary.sh` exits 0 — **Rule E**
- [ ] Every new check has a stated negative control — **Rule F**
- [ ] Every restriction claim carries a quoted source — **Rule G**
- [ ] Guards specified to be checked from committed state — **Rule I**
- [ ] Pin verified: `git merge-base --is-ancestor <pin> origin/main`
- [ ] Parent directive, if declared, present on `origin/main`
- [ ] Every acceptance criterion is falsifiable by an observation
- [ ] All Part 1 sections present for the declared weight

---

## Part 4 — Lane roles

**Code Executor** grounds and drafts. It stands in the tree, so it cites rather than assumes. It halts on contradiction; it does not resolve one.

**Lead/Architect** reviews against Part 2 and rules. It reads the directive from `doc/directives/` directly — no relay, no summary. It does not author from partial grounding.

**PO** ratifies by merging, and decides what is worth building at all. Neither other lane can see runway, users, or opportunity cost.

---

## Part 5 — Removed-surface hygiene (mandatory; Architect ruling 2026-08-28)

Any slice that **retires, withdraws, or supersedes a product surface** (a route, scope, error code, DTO, contract, capability, or behaviour) MUST run a `REMOVED_SURFACE_SWEEP` before Gate-5. "Removal" means **zero live / product-contract residue** — historical evidence may remain ONLY in explicitly historical artifacts (migrations, ADRs, closure records, `doc/governance/history/*`), never in production code describing obsolete behaviour as current.

**The sweep** searches every layer for the retired surface: controller/route · repository/service method · DTO/request type · scope catalog + seed + role grants · FE API client + affordance + capability check · OpenAPI spec · Pact/contracts · error codes/messages · integration/E2E/unit tests · fixtures/personas · exports/imports · comments/TODOs/docstrings claiming the obsolete behaviour is current · dead constants · CI scripts/allowlists · architecture docs. Every hit is classified into exactly one of:

- `ACTIVE_REQUIRED` — still legitimately used (incl. dynamic/service-level enforcement, not just literal guards).
- `HISTORICAL_REQUIRED` — legitimate history in a historical artifact — KEEP.
- `ACTIVE_RESERVED` — deliberate forward-reservation tied to a named authority; KEEP with an explicit current-state rationale + machine-detectable classification (see the HYG-3 guards).
- `EXIT_HYG / OWNING_LANE` — a live-surface question the hygiene slice must NOT resolve; hand it to the owning lane with owner + reason. Does NOT count against closure.
- `REMOVE_NOW` — live/product-contract residue.

**Gate-5 acceptance:** `REMOVE_NOW` MUST be **EMPTY**. Any non-empty `REMOVE_NOW` HALTs — do not silently carry residue forward. A hygiene removal may only retire already-unreachable or explicitly-superseded substrate; anything currently callable or contractually reserved **exits the hygiene slice back to its owning lane** (no stealth feature modification). The Gate-5 report carries a **working-feature attestation**: the diff changes no reachable business operation, no enforced-route authorization decision, no API behaviour, and no provider/consumer contract behaviour — only dead catalog/code residue (evidenced by green Pact/OpenAPI/integration).

Recurrence is prevented by CI: `orphan-scopes:check` (every seeded scope literally-enforced or machine-classified) and `dead-error-codes:check` (every code emitted or machine-classified reserved), each with a negative self-test.
