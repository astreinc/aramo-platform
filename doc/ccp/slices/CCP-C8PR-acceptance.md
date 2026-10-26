# CCP-C8-PR — acceptance record (PAYMENT_RECORD)

| | |
|---|---|
| **Slice** | CCP-C8-PR, PAYMENT_RECORD and enterprise payment-gated activation |
| **Branch / base** | `wip/ccp-c8pr` at `eefa795d` |
| **Authority** | PAYMENT_RECORD amendment `4409e3a1…` (PR-1 … PR-13, §4), CCP-A1 Amendment A2 `20941ccc…` (PS-1 … PS-6), catalog amendment A1 `ad862360…`, MP-A2 N-3 / N-4. Pre-execution: `doc/ccp/slices/CCP-C8PR-pre-execution.md` (N-4 statement §3). |
| **Scope** | Frozen by the Architect during the slice: built exactly as the LOCKED text defines; gaps classified A/B/C/D below; no UI. |
| **Local commits** | **none.** Nothing committed, pushed or stashed (Gate 5). |
| **HALT conditions hit** | none. |

Every count below is exact and read from that run's own log.

## 1. What was built, by rule
| Rule | Where | Evidence |
|---|---|---|
| §2 catalog row 16 | `commercial-change-request.ts` (`COMMERCIAL_ACTION_TYPES` 16, `COMMERCIAL_ACTIONS.PAYMENT_RECORD`, `resolveRequiredChain`, `validatePayload`, `canTransitionFor`, `APPLY_EXPIRABLE_ACTIONS`, `APPLY_SERVICE_ACTIONS`) | C8PR-U-1, U-2; A3-CH-15 (16); A9-U-4; GUARD-UNION-1 / -4 |
| PS-1 … PS-6 | identity migration `20261028070000_ccp_a1a2_payment_request_scope` (scope 0x336; commercial_ops 0x2c2, finance_admin 0x2c1; RoleScope ids `md5('ccp-a1a2:'…)`); `seed.ts`; `scope.dto.ts`; `identity-migrations.ts`; `verify-orphan-scopes.ts` (SERVICE_ENFORCED) | totals from the seed **25 / 207 / 989** ("CCP-A1-A2 +1 scope / +2 grants → 25 / 207 / 989"); `ccp-a1a2-payment-request-scope-migration.integration.spec.ts` 11 tests; `scope-catalog-consistency.mjs` PASS (207 / 207) |
| PR-1 terms | `commercial-payment-terms.ts` `paymentTermsErrors`; `commercial-contract.ts` (`contract.payment_terms` required; `contract_amendment.payment_terms` optional); `Contract` + 5 columns, `ContractPaymentObligation` (migration `20261030010000`) | C8PR-U-5; C8PR-GATE-2; C8PR-AMEND-1 |
| PR-2 / PR-3 | `commercial-change-request.service.ts` create (`resolvePaymentRecordChain` inside the create transaction, live roles + roster, after the Q14 slot); requester-only apply | C8PR-CHAIN-1 … 3, C8PR-ROLE-1, C8PR-U-6 |
| PR-4 | `commercial-apply.service.ts` (`PAYMENT_RECORD` domain step → `applyPaymentRecordInTx`); guard-union and constraint-union CCP-C8-PR blocks; deferred backstop `commercial_change_request_no_applying_commit_c8pr` | C8PR-IDEM-1; GUARD-UNION-1 (probes incl. PAYMENT_RECORD) |
| PR-5 / PR-6 / PR-8 | `resolvePaymentRecordInTx` (create, and again at apply); receipt CHECKs and partial unique indexes | C8PR-U-3 / U-4, C8PR-DUP-1 / -2, C8PR-MIS-1, C8PR-GOV-1 |
| PR-7 / §4.3 | `prepaidInitialReceipt` (lock FOR UPDATE + verify) → subscription → `recordContractInTx` → `recordObligationsInTx` → `linkInitialReceiptInTx` (+ `COMMERCIAL_PAYMENT_RECEIPT_LINKED`) → entitlements → application row → APPLIED, one transaction; guard trigger on the link | C8PR-GATE-1 / -2 / -3, C8PR-SEQ × 7 steps, C8PR-LINK-1 |
| PR-9 | CORRECT REPLACE / VOID; supersession mark set once by the applying CORRECT | C8PR-COR-1 / -2 / -3 |
| PR-10 | `obligationPaymentStatus`, `calendarDateIn` (contract IANA zone); `ContractPaymentReadService` | C8PR-U-7 / U-8, C8PR-STAT-1 |
| PR-11 | `GET /platform/commercial/contracts/{id}/payments` (gate `platform:billing:read`; amounts, terms, records only with `platform:billing:amount:read`); `PAYMENT_RECORD` in `MONETARY_ACTION_TYPES` | C8PR-RT-1 … 5 (9 tests), C8PR-U-9, R3 pin |
| PR-12 | audit `COMMERCIAL_PAYMENT_RECORDED`, `COMMERCIAL_PAYMENT_CORRECTED`, `COMMERCIAL_PAYMENT_RECEIPT_LINKED`, `COMMERCIAL_PAYMENT_REFUSED` (with the PR-8 typed decision request); Q14 | C8PR-Q14-1, C8PR-MIS-1 |
| PR-13 | `origin` CHECK = MANUAL; `external_evidence_ref` reserved (CHECK IS NULL) | C8PR-U-4 |
| §4.3 step 5 | C6 `reconciliationReport.unlinked_receipts` + count (an exception); D3 alert `PAYMENT_RECEIPT_UNLINKED` (BILLING, `payment_receipt`) via the alert-type union block | C8PR-COR-3; D3-U-1 (12 types) |
| No UI | — | B4 Payments panel: CCP-UI design addition (class C) |

## 2. Tests (exact counts)
| Run | Result |
|---|---|
| `libs/subscription` full suite, `ARAMO_RUN_INTEGRATION=1` (64 files; includes the C8-PR specs, GUARD-UNION, the full compensation chain 29 → 1, the merge-train compensation, B4, D3) | 954 passed, 1 failed (A3-CH-15 pinned 15 action types); pin re-based to 16, file re-run 86 / 86 |
| `ccp-c8pr-payment-record.integration.spec.ts` alone | 26 / 26 |
| `ccp-c8pr-payment-record.spec.ts` (pure) | 10 / 10 |
| `apps/platform-admin` full suite, `ARAMO_RUN_INTEGRATION=1` (44 files) | 910 passed, 9 failed (6 in C6 authorization: the mock lacked `unlinked_receipts`; 3 D4 count pins); fixed; the 2 files re-run 32 / 32 |
| `ccp-c8pr-contract-payments-authorization.spec.ts` | 9 / 9 |
| `libs/identity` full suite, `ARAMO_RUN_INTEGRATION=1` | 976 / 976 (86 files) |
| Pact consumers (all 15, generated pacts deleted first, serial `npm run pact:consumer`) | 650 passed; platform-web 201 |
| Pact provider (`npm run pact:provider`) | 7 / 7 (5 files) |
| D4 negative controls extended to PAYMENT_RECORD (scenario with `alsoRequesters: ['finance_admin']`) | inside the 32 / 32 re-run |

Per-role coverage: service level C8PR-ROLE-1 (6 roles + super_admin + a scope-only token), route level C8PR-RT (6 roles + super_admin), D4-CREATE-1 / D4-SELF-1 / D4-APPLY-1 over HTTP.

## 3. Gates
| Gate | Result |
|---|---|
| contract-parity (run with a temporary git index carrying the new files as intent-to-add; the real index untouched) | 0 orphan, 0 unclassified (739 live routes, 574 OpenAPI ops) |
| openapi drift / validate / lint | drift ok (9 files); `swagger-cli validate openapi/platform.yaml` valid; `redocly lint` 0 errors, 2 warnings (no-server-example.com, no-ambiguous-paths; neither names the new route); strict YAML parse (`uniqueKeys`) 0 errors |
| orphan scopes | ok (+ self-test ok, identity agent run) |
| env passthrough | ok (no new variable) |
| error codes / dead error codes | ok / ok (no new AramoError code: refusals use `COMMERCIAL_CHANGE_REQUEST_CONFLICT` + `details.refusal`, the REFUND precedent) |
| vocabulary | OK (Tier 1, Tier 2, front-door clean) |
| repo-map | regenerated (temporary index), check ok |
| lint | eslint on every changed / new TS file: clean |
| build | `nx run-many -t build -p subscription platform-admin identity --skip-nx-cache`: first run 1 flaky (subscription:build under host load), second run successful (3 projects, 27 dependent tasks) |

## 4. Commit map (proposed for Gate 6; nothing committed)
1. **identity — CCP-A1 Amendment A2 scope** — `libs/identity/prisma/migrations/20261028070000_ccp_a1a2_payment_request_scope/`, `libs/identity/prisma/seed.ts`, `libs/identity/src/lib/dto/scope.dto.ts`, `libs/common/src/lib/testing/identity-migrations.ts`, `libs/identity/src/tests/*` (11 files: the new migration spec, the compensation fixture, the re-pinned specs), `ci/scripts/verify-orphan-scopes.ts`.
2. **subscription — C8-PR migration, model and apply** — `libs/subscription/prisma/migrations/20261030010000_ccp_c8pr_payment_record/`, the three union files (labelled blocks), `schema.prisma`, `commercial-payment-terms.ts`, `commercial-payment-record.ts`, `commercial-change-request.ts`, `commercial-change-request.service.ts`, `commercial-apply.service.ts`, `commercial-contract.ts`, `commercial-contract.repository.ts`, `finance-amount-withholding.ts`, `billing-finance-report.service.ts`, `commercial-alert.ts`, `commercial-alert.service.ts`, `subscription.module.ts`, `index.ts`.
3. **subscription — tests and compensation** — the two C8-PR specs, `fixtures/ccp-c8pr-compensating.sql`, the three union compensations, `ccp-full-compensation-chain` (27 → 29), and the expectation changes in B3, B4 (payload + integration), D2, D3 (unit + integration), A9, R3, A3 eligibility, guard union, `support/ccp-a3-database.ts`.
4. **platform-admin — payments route** — new controller + DTO, `platform.module.ts`, change-request controller error map (`PAYMENT_REFUSED`), C6 finance controller + DTO, the new route spec, C6 / D4 specs and `support/ccp-d4-scenarios.ts`, `ci/config/api-surface-manifest.json`, `openapi/platform.yaml`.
5. **pact** — `platform-commercial.consumer.test.ts` (2 payments interactions + catalog_manager refusal + GATE_ROUTES row + reconciliation/metrics keys), `verify-platform-admin.ts` (state "a prepaid enterprise contract with its initial payment recorded exists", contract fixtures with payment terms).
6. **docs / generated** — this record, the pre-execution record, `apps/platform-web/e2e/fixtures/session.ts` (bundle restatement), `doc/generated/repo-map.*`.

## 5. Compensating SQL (documented, not shipped; proven by the full chain, COMP-1 … COMP-29 and REAPPLY)
Reverse order (latest first):
1. `libs/subscription/src/tests/fixtures/ccp-c8pr-compensating.sql` — refused while any PAYMENT_RECORD request, receipt, obligation or contract with payment terms exists (`CCP-C8-PR compensation refused: …`); then drops the deferred trigger, `CommercialPaymentReceipt` + its guard, `ContractPaymentObligation` + its guard, the Contract payment-terms trigger, CHECKs and 5 columns.
2. `fixtures/ccp-alert-type-union-compensating.sql` — now also refused while a `PAYMENT_RECEIPT_UNLINKED` alert row exists.
3. `fixtures/ccp-constraint-union-compensating.sql` — now also refused while a PAYMENT_RECORD request or application row exists; re-asserts A7's `CommercialChangeApplication_subscription_check`.
4. `fixtures/ccp-guard-union-compensating.sql` — PAYMENT_RECORD added to the "apply branch the preceding body lacks" refusal.
5. `libs/identity/src/tests/fixtures/ccp-a1a2-compensating.sql` — refused while a role other than commercial_ops / finance_admin holds `platform:payment:request`; bumps the holders, removes the 2 grants and the scope. Runs before the A1-A1 compensation.

`ccp-full-compensation-chain.integration.spec.ts`: 29 steps (+ `A1-A2 identity`, data only, catalog 16 / 48 after it; + `C8-PR`, probe a PAYMENT_RECORD request APPROVED); `FULL_CATALOG` 6 / 17 / 50. Passed inside the subscription suite run above.

## 6. Divergences and gaps (typed; classification per the scope-freeze rule)
| ID | Type | Item | Class |
|---|---|---|---|
| D-C8PR-1 | interpretation | POSTPAID marker = `{ statement, evidence_ref, documents? }`, statement and evidence_ref required (PR-1 "with its evidence"). | D (resolved in build; Lead to confirm) |
| D-C8PR-2 | interpretation | The Platform Owner exception reuses rule `DISTINCT_PLATFORM_OWNER` (one platform_owner step, `platform:billing:approve`) with `basis.exception: true`, `finance_chain_fulfillable: false`, `evaluated_at`; no new rule name, so the parser, guard and UI enums are unchanged. | D (Lead to confirm) |
| D-C8PR-3 | interpretation | PR-6 triple: refused against every receipt, except that a REPLACE may keep the triple of the receipt it supersedes; the DB index is on effective (uncorrected) rows. | D (Lead to confirm) |
| D-C8PR-4 | addition within K-1 | A PREPAID SUBSCRIPTION_OPEN is refused at creation (`PAYMENT_NOT_RECORDED` / `PAYMENT_OBLIGATION_MISMATCH`, audited) as well as at apply. | D |
| D-C8PR-5 | interpretation | PR-1 amendment: v1 admits additions only; every other payment-terms change fails closed `PAYMENT_TERMS_CHANGE_UNDEFINED` (PR-8 "fails closed"). | C (the full amendment semantics need a ruling) |
| D-C8PR-6 | refusal codes | Codes not named by the amendment: `PAYMENT_CORRECTION_TARGET_INVALID` (absent / other tenant / already corrected / VOID of an unlinked INITIAL without `no_contract_will_follow`), `PAYMENT_TERMS_CHANGE_UNDEFINED`. Create refusals ride `COMMERCIAL_CHANGE_REQUEST_CONFLICT` 409 with `details.reason: payment_refused` and `details.refusal` (REFUND precedent; no new AramoError code). | D |
| D-C8PR-7 | interpretation | A REPLACE of a consumed INITIAL is allowed when it keeps the amount and currency (corrected evidence); VOID or an amount change of a consumed INITIAL is `PAYMENT_OBLIGATION_MISMATCH` (PR-9). | D |
| D-C8PR-8 | expectation changes | B4-N3-c column list (+5 Contract columns) and static-scan allowlist (+2 C8-PR modules); B4-N3-d usage-FK query excludes the obligation and receipt tables (N-3(b) children, not usage tables); contract fixtures in B3, B4, D2, D4, pact provider gain POSTPAID payment terms; pins re-based: A3-CH-15 16, A9-U-4, GUARD-UNION-4, D3-U-1 12, D3 billing metric keys, R3 `MONETARY_ACTION_TYPES`, D4 counts (15 / 11 / 12-step totals), compensation chain 29. | D |
| D-C8PR-9 | guard file | `CommercialChangeApplication_subscription_check` (only A7 wrote it) is now re-asserted in the constraint-union CCP-C8-PR block so a PAYMENT_RECORD application may carry no subscription (an unlinked INITIAL). | D |
| G-C8PR-1 | gap | B4 Payments panel (UI) needs a CCP-UI design addition; nothing built. | C |
| G-C8PR-2 | gap | `doc/runbooks/RUNBOOK-ccp-migration-validation.md` (D5) still lists 27 migrations / 16 / 48 catalog counts; the integrator updates it at merge (the identity agent listed lines 49, 274, 304). | C |
| G-C8PR-3 | gap | `doc/ccp/decisions.md` and earlier slice records still say 25 / 206 / 987; the integrator records the A1-A2 totals at merge. | C |
| G-C8PR-4 | gap | platform-web shows an unknown action type generically; no PAYMENT_RECORD label (no UI in this slice). | C |
| G-C8PR-5 | parallel slice | R3-W (W-3) extends the redaction helpers in parallel; this slice only adds `PAYMENT_RECORD` to `MONETARY_ACTION_TYPES` (one line). Evidence, reason and notes redaction for PAYMENT_RECORD is R3-W's. | B (coordination at merge) |

No class A item was found.
