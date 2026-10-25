# CCP-D5 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.4 D5 row: "**D5** runbooks | All A, C
evidence | **In:** recovery, break-glass (Conv. C-15), migration validation. Each runbook states that design approval is not
production migration authority (A0-C15) | Runbook dry-runs on non-production | Docs revert | — | Dry-run records".

| | |
|---|---|
| **Slice** | CCP-D5: runbooks (migration validation, recovery, break-glass, platform-owner bootstrap, dark-state verification) |
| **Branch / baseline** | `wip/ccp-d5` at `41a0e3b5` (the Architect program acceptance disposition record) |
| **Local commit SHAs** | **pending (lead commits).** Nothing committed or pushed by the executor. |
| **HALT conditions hit** | **None.** The D5 row names none. No runbook step needed a production-code change to be written; the three production-code defects found are reported (§5), not fixed. |
| **Production** | Never connected. Every dry run used a local Postgres 17 container (`pgvector/pgvector:pg17`, 17.11) or local stand-in containers. |

## 1. Prerequisites and inputs (PBD §6.2 items, recorded here)

- **Prerequisites ("All A, C evidence").** The acceptance records `CCP-A1…A11`, `CCP-C1`, `C2`, `C3`, `C6` are present in
  `doc/ccp/slices/`; C4, C5, C7 are NOT DELIVERED by PBD §10 (Architect disposition 2026-10-25: built in test mode with
  disabled states, no scope amendment). The runbooks cover only what is delivered.
- **Inputs read:** PBD §2.6, §5.4, §7.3, §7.5, §12; Conversion Rule C-1…C-29 (C-15 verbatim in the break-glass runbook);
  Charter Amendment A1 AD-1…AD-8; T2-F1-H3 Amendment A1 A1-0…A1-4, §6; `doc/ccp/decisions.md`; `doc/ccp/program-gate-20261025.md`
  §6 (the 21 migrations and their compensations); every `doc/ccp/slices/*-acceptance.md` cited in the runbooks; existing
  runbook style (`tenant-last-owner-invariant.md`, `RELEASE-box.md`, `RELEASE-esign-allowance.md`).
- **Correction-1 trigger (§2.4):** none arose. No new architectural, regulatory or commercial decision is made by a runbook;
  the choices left to D5 are typed divergences (§4) for Lead / PO confirmation.

## 2. Deliverables

| File | Lines | Content |
|---|---|---|
| `doc/runbooks/RUNBOOK-ccp-migration-validation.md` | 325 | the 21 migrations with their compensation locations; HALT list; pre-checks P1 backup, P2 exact pending set, P3 read-only fact-check (`--po-authorization-ref`), P4 TD-A1-1 catalog pre-check, P5 C-16, P6 Astre snapshot; the bounded apply before code; post-checks Q1–Q10 with production expectations; the compensation order 21 → 1 with the ledger rule |
| `doc/runbooks/RUNBOOK-ccp-recovery.md` | 330 | alert triage (D3); stuck APPLYING (none should commit); APPLY_FAILED retry by the requester; expired requests (approval window, apply deadline); failed or stuck Stripe command (C1); webhook inbox failure; usage NOT_RECONCILED (D1 rebuild); held activation (C-8, resolved through C2); policy rollback through POLICY_ACTIVATE |
| `doc/runbooks/RUNBOOK-ccp-break-glass.md` | 262 | Part A: C-15 verbatim; when, who, evidence, procedure (one transaction under the billing lock, self-refusing), audit, reconciliation afterwards; never a SQL edit implying a Stripe change. Part B: the A9 platform last-owner trigger break-glass (A1-4), as a one-transaction window |
| `doc/runbooks/RUNBOOK-ccp-platform-owner-bootstrap.md` | 137 | the A9 one-time command: what it writes, preconditions, refusals, run and post-check; never against production without explicit PO authorization; HALT on D5-DEF-3 |
| `doc/runbooks/RUNBOOK-ccp-dark-state-verification.md` | 124 | §7.3 re-verification: public signup, Personal, live Stripe, checkout (`STRIPE_PLAN_PRICES` + price pins), command worker, Astre MANUAL; read-only; prints SET / UNSET / TEST / LIVE only |
| `doc/ccp/runbook-dry-runs-20261025.md` | 2315 | the dry-run record: every step's command and actual output |
| `doc/ccp/slices/CCP-D5-acceptance.md` | — | this record |
| `doc/generated/repo-map.{coupling,files}.json` | — | regenerated for the new docs (§6); `repo-map.projects.json` unchanged |

Each runbook opens with: "Design approval is not production migration authority (ruling A0-C15)" and states that every
production step needs its own, separate PO authorization.

## 3. Tests run and not run

**Run (mandatory test: "Runbook dry-runs on non-production").** Full detail and outputs: `doc/ccp/runbook-dry-runs-20261025.md`.

| Runbook | Dry run | Result |
|---|---|---|
| Migration validation | fresh Postgres 17; the pre-CCP chain (310 migrations) + pre-CCP seeds + an Astre-shaped MANUAL row; P1–P6; `deploy/migrate-prod.sh --until 20261027000200_ccp_b5r_policy_activate_apply` in its local-proof mode; Q1–Q10; compensation of migrations 21, 20, 19 with ledger rows and re-apply; restore drill | 21 / 21 applied, 0 errors; every check as expected; compensation: `union_blocks` 22 → 0 → 22, B5-R trigger 1 → 0 → 1, ledger 331 → 328 → 331; restore: ledger 310, 0 CCP rows |
| Recovery | 9 scenarios on a fixture database through the real services and the fake Stripe | every scenario detected and resolved; alert scan 1 raised 7, scan 2 resolved 7, 0 open |
| Break-glass | Part A: 6 steps on 3 fixture tenants; Part B: 7 steps on the bootstrapped database | Part A: 4 refusals, 1 authorized end with 1 audit row, 2 rows untouched; Part B: guard refuses without break-glass; window commits with 5 / 5 re-armed; a failure or a missing re-arm commits nothing |
| Bootstrap | the shipped CLI (5 invocations), a direct invocation (4), the bootstrap logic through a driver (5), the inert check (2) | CLI refuses every invocation (D5-DEF-3); logic: 1 grant, 1 no-op, 3 refusals, then `ALREADY_BOOTSTRAPPED` ×2 |
| Dark state | the published script against `dark` and `lit` stand-ins; the data check | dark 7 / 7 rows as expected; lit: 6 / 6 switch rows flagged; 0 key-material leaks; data check passes |
| Rendered text | 16 read-only SQL blocks extracted from the five published runbooks | 16 / 16 exit 0 |

**Supporting targeted specs** (`ARAMO_RUN_INTEGRATION=1`, Postgres 17 testcontainers): `ccp-c1-command-inbox` 23 / 23,
`ccp-c2-conversion` 21 / 21, `ccp-a6r-apply-deadline` 8 / 8, `ccp-a9-bootstrap-role-change` 17 / 17,
`ccp-merge-train-compensation` 4 / 4 (libs/subscription, 73 / 73); `ccp-a9-platform-last-owner` 4 / 4 (libs/identity).
Total **77 / 77**.

**Gates.** `bash scripts/verify-vocabulary.sh`: exit 0 (Tier 1, Tier 2 and front-door clean; no exemption added).
`npm run repo-map:check`: see §6.

**Not run.** Any production command (by design). The console and HTTP routes for the recovery actions (the services they call
were driven directly; route authorization is CCP-D4's and the route specs'). Lint, build, Pact and the apps/api suite (D5
changes no code, spec, contract or migration). The prose compensations (14 of 21) cannot be dry-run: they are not executable
SQL (§4, TD-D5-4).

## 4. Typed divergences

| ID | Divergence | Disposition |
|---|---|---|
| TD-D5-1 | PBD §6.2 asks for a pre-execution record before a slice's first commit. The D5 instruction named only this acceptance record, so the §6.2 items are recorded in §1 here. | For the Lead: accept, or split §1 into `CCP-D5-pre-execution.md`. |
| TD-D5-2 | **The break-glass operation set.** C-15 names break-glass but no LOCKED text defines what it may do. The runbook limits it to one operation, ending one governed MANUAL row (the governed SUBSCRIPTION_END semantics), refused under the billing lock when the row is provider-linked, contract-linked, already ended, or the tenant has an open flag, another open row, an open change request or an unconfirmed Stripe command. It writes `COMMERCIAL_BREAK_GLASS_SUBSCRIPTION_ENDED` (`is_exception = true`) in the same transaction. | **Needs Lead / PO ratification** of the operation set, the event name and the refusals. |
| TD-D5-3 | **A9 break-glass as one transaction.** ROLES-1 (`tenant-last-owner-invariant.md`) disables, operates and re-enables in separate steps. The CCP runbook does all three in one transaction (`ALTER TABLE … DISABLE TRIGGER` is transactional), and the commit is refused unless 5 / 5 triggers are `A`. Stricter than the precedent A1-4 points to. | For the Lead. |
| TD-D5-4 | 14 of the 21 compensations exist only as prose in acceptance records. The runbook says they are not executable until written as reviewed SQL, tested and separately authorized; until then the backup is the recovery for those steps. | For the Lead (D6 rollout plan). |
| TD-D5-5 | No operator retry path exists for a FAILED Stripe command (TD-C1-7). The runbook makes it an escalation with a PO decision and a manual evidence record, and forbids an SQL state edit. | Open item TD-C1-7 / TD-D3-3 stays open. |
| TD-D5-6 | `RELEASE-box.md` STEP 2's `tail -1` backup-marker check does not work with `pg_dump` 17 (D5-OBS-1); the CCP runbook uses `grep -c`. `RELEASE-box.md` itself is not edited (outside D5). | For the Lead. |

## 5. Defects found (reported, not fixed)

| ID | Defect | Where | Effect |
|---|---|---|---|
| **D5-DEF-1** | `deploy/migrate-prod.sh` exits 1 after the shared-database gate passes when the `.env` has no `INTELLIGENCE_DB_USER=` line (`read_env` under `set -euo pipefail` inside `TI_USER="$(…)"`). Pre-existing (ATI-SEP-1). | `deploy/migrate-prod.sh:196` (same pattern `:164`) | the Talent Intelligence step never runs; the deploy STOPs with only the generic banner. Runbook pre-check added. |
| **D5-DEF-2** | The B5 policy draft editor cannot set `apply_expiry_hours` (`POLICY_EDITABLE_KEYS` omits it; `updateDraft` refuses `policy_key_not_editable`), so the v2 that Charter Amendment A1 AD-1 requires cannot be authored through the governed path. | `libs/subscription/src/lib/commercial/commercial-policy-governance.service.ts:47-59`, `:197-199` | the apply deadline cannot be activated in production without SQL; bears on TD-ACC-1. |
| **D5-DEF-3** | `npm run ccp:bootstrap-platform-owner` refuses every invocation (`INVALID_ARGUMENT`, the script's own path as `unknown_argument`): the script parses `process.argv.slice(2)` while the jiti runner puts the entry at `argv[2]`. | `libs/subscription/scripts/ccp-bootstrap-platform-owner.ts:31` | the A9 bootstrap cannot be executed by its shipped command (fails closed). The bootstrap runbook HALTs on it. |

Observations D5-OBS-1…5 are in the dry-run record §9.

## 6. Repo map and vocabulary

- Vocabulary: `bash scripts/verify-vocabulary.sh` exit 0 with every new file in the working tree. No banned Tier-2 term
  appears in any new file; no exemption added.
- Repo map: the gates read `git ls-files`, and the executor does not stage, so they ran under a temporary `GIT_INDEX_FILE` with
  intent-to-add entries for the 7 new doc paths (the real index is untouched; the TD-A2-7 method). Before regeneration
  `repo-map:check` failed with 2 drift issues (`repo-map.files.json`, `repo-map.coupling.json`), as expected for new files.
  `npm run repo-map:generate` then `npm run repo-map:check`: **ok**. Diff: `repo-map.coupling.json` +280, `repo-map.files.json`
  +7, 0 deletions; `repo-map.projects.json` unchanged. If the lead stages a different file set, re-run `npm run repo-map:generate`.

## 7. Recovery / rollback

Docs revert (PBD D5 row): remove the seven new doc files and restore the two regenerated repo-map files. The runbooks change
no code, migration, contract or configuration. The temporary dry-run drivers and seed copies were never in the tree at the end
of the slice (`git status` shows only the deliverables).
