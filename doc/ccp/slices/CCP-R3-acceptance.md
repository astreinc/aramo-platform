# CCP-R3 — acceptance reconciliation

| | |
|---|---|
| **Correction** | CCP-R3, "acceptance reconciliation" |
| **Branch / baseline** | `wip/ccp-r3` at `41a0e3b5` (the integrated program) |
| **Authority** | `doc/ccp/decisions.md`, "Architect program acceptance disposition (2026-10-25)" (binding rows TD-C3-5 / TD-C6-1 / TD-D3-13, TD-A8-3, TD-A7-5, DR-C2-3, TD-B2-1, TD-D3-9). Item 1 then re-scoped by the Lead to `Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0-LOCKED.md` (OneDrive `Aramo/locked`, SHA-256 prefix `c3ce572ae19bba55`; FA-1…FA-8 binding; the interim FA-9 rule superseded on implementation). |
| **Local commits** | **none.** Nothing committed or pushed (Gate 5). |
| **Migrations** | identity `20261028060000_ccp_a1a1_finance_amount_scope` (FA-8); subscription `20261028050000_ccp_r3_entitlement_alert` (item 3). **No guard change**: `20261027000000_ccp_guard_union` and `canTransitionFor` are untouched. |
| **HALT conditions hit** | none (see the divergences below; D-R3-3 needs a Lead decision but nothing was built past it). |

Every count below is exact and read from that run's own log.

## Item 1 — Finance amounts (CCP-A1 Amendment A1, LOCKED)

**First built as the FA-6/FA-9 interim (withhold for every caller, `FINANCE_SCOPE_PENDING`), then replaced by the LOCKED amendment on the Lead's instruction.** What ships is the real scope.

### Scope and grants (FA-1, FA-2, FA-7, FA-8)
- `platform:billing:amount:read`, fixed id `0x335`, granted to exactly platform_owner (`0x2c0`), finance_admin (`0x2c1`) and read_only_auditor (`0x2c5`); RoleScope ids `md5('ccp-a1a1:' || role_id || ':' || scope_id)`.
- Identity migration `libs/identity/prisma/migrations/20261028060000_ccp_a1a1_finance_amount_scope/migration.sql`: one guarded, idempotent, fail-closed DO block (the CCP-A1 pattern): no-op without a role catalog; refuses a scope id/key conflict, a missing holder role, a description drift, or a holder set other than the 3; bumps `AuthorizationVersion` for every principal whose effective set changed (a member of one of the 3 roles gains the scope). Registered in `libs/common/src/lib/testing/identity-migrations.ts`.
- Seed (`libs/identity/prisma/seed.ts`): `SEED_IDS.scopes['platform:billing:amount:read']`, `CCP_A1A1_FINANCE_AMOUNT_SCOPE{,_DESCRIPTION}`, `CCP_A1A1_FINANCE_AMOUNT_HOLDERS`, `ccpA1A1RoleScopeId`; the A1 constants (`CCP_PLATFORM_ROLE_SEED_BUNDLES`, `CCP_A1_SCOPE_DESCRIPTIONS`) are unchanged. Catalogs: `SEED_SCOPE_KEYS` and `PLATFORM_SCOPE_KEYS` (`scope.dto.ts`).
- **Totals, recomputed from the seed: 25 roles / 206 scopes / 987 grants** ("CCP-A1-A1 +1 scope / +3 grants → 25 / 206 / 987"), pinned in `seed-scrub.integration.spec.ts` (3 pins), `identity.integration.spec.ts`, `roles1-role-model.spec.ts`, `commercial-scope-seed.spec.ts`, `search-pr1-seed.spec.ts`, `ccp-a1-commercial-role-catalog.spec.ts`; `libs/identity/scripts/scope-catalog-consistency.mjs`: PASS (bijection 206 ↔ 206).
- Compensation (FA-8, documented, not shipped): `libs/identity/src/tests/fixtures/ccp-a1a1-compensating.sql`. Refuses while any role other than the 3 grantees holds the scope; then bumps the holders and removes the 3 grants and the scope. Run before the CCP-A1 compensation.
- `ci/scripts/verify-orphan-scopes.ts`: `platform:billing:amount:read` = SERVICE_ENFORCED (field authorization below the `platform:billing:read` route gate; no route serves amounts only, so no 403-only route exists).

### Backend field authorization (FA-1, FA-4, FA-5)
`financeAmountAccess(scopes)` = holds `platform:billing:read` AND `platform:billing:amount:read`, read from the server-resolved scopes of the request (`apps/platform-admin/src/app/platform/finance-amount-access.ts`; rule in `libs/subscription/src/lib/billing/finance-amount-withholding.ts`). Without access every monetary field is omitted and `amount_withheld: "FINANCE_SCOPE_REQUIRED"` is set.

| Surface | Holder | Non-holder |
|---|---|---|
| C3 `GET …/tenants/{id}/billing-status` | `invoices` (amounts, currency, hosted / PDF links) + `payment_due`, `payment_overdue` | no `invoices` field at all; `amount_withheld`; `payment_due`, `payment_overdue` (FA-4); a provider error's text replaced by a fixed line |
| C6 outstanding payments | `amount_due: null` (never computed; `amount_due_reason`) | no `amount_due`; `amount_withheld` |
| C6 renewals / reconciliation | unchanged (only catalog list prices: FA-3) | unchanged |
| A3 change requests (every route that maps a request: create, list, get, submit, withdraw, approve, reject; the apply, conversion and support-extension outcomes) | the monetary payload and chain-basis fields | omitted from both, `amount_withheld` |
| A2 audit feed (incl. the A3 CREATED event body) | included | omitted, `amount_withheld` |
| B5 audit CSV export (`detail` column) | included | omitted; the export's own audit event records `amounts: INCLUDED / WITHHELD` |
| D3 alerts and metrics | no monetary field exists (counts and ids only) | same |
| B3 reads (`…/subscriptions`, `…/tenants/{id}/commercial`) | no monetary field exists | same |
| D2 revenue | not in this branch (the D2 agent builds it; coordinate at merge) | — |

**One shared redaction (Lead, TD-C4-7):** `withholdChangeRequestAmounts(action_type, obj, access)` / `withholdAuditPayloadAmounts(payload, access)` (`finance-amount-withholding.ts`), keyed on `MONETARY_ACTION_TYPES = ['CREDIT', 'DISCOUNT', 'REFUND']`. REFUND is not in this base (CCP-C4 adds it) and is covered on merge. For a monetary action every amount-like key (`amount_minor`, any `*_minor`, `amount*`) is omitted recursively; policy thresholds (`credit_escalation_threshold_minor`, `discount_escalation_threshold_bps`) and catalog prices stay. A non-monetary action is untouched except a stray `amount_minor` (fail closed). Used by the A3 request mapper (payload and chain basis), the A2 audit read and the B5 export; B1's inbox and drawer render the marker.

FA-4 booleans: `payment_due` = an invoice in DUE / OVERDUE / PAYMENT_FAILED; `payment_overdue` = OVERDUE. Both are derived from one fixed read window (the newest 50 invoices) for every caller, so `invoice_limit` cannot be used to probe; holders receive the first `invoice_limit` invoices of it.

### FA-6 no leakage — the surfaces that exist, and their tests
| Surface | Evidence |
|---|---|
| Response fields, alternate endpoints | C3-R-1 (3 holders + 2 boolean-only roles), A3-RT per route × 6 roles (7 routes), A2 synthetic audit-only principal, C6-R-1 × 5 roles; `requestDto(row, amount_access)` takes the decision as a required parameter (a missing call site fails the build) |
| Counts / aggregates | non-holder C3 body has no `invoices` (no count); D3-MET-1 (metrics carry no money); C3-R-8 (`invoice_limit` 1 vs 50 give byte-equal non-holder bodies) |
| Error messages | C3-R-7 (provider error text reaches a holder only); C3-R-8 (the 400 body carries no figure) |
| Logs | R3-FA-6 (the C3 service's tenant-mismatch log line carries no figure, currency or link) |
| Exports | R3-FA-1 export unit test (both modes; no flag = withheld) |
| Pact / OpenAPI examples | the support_admin and commercial_ops interactions carry no amount; `openapi/platform.yaml` has no monetary `example` |
| Cache objects | none on these paths (the C3 / C6 services keep no cache; `InMemoryScopeCache` holds scopes only) |
| Search | the change-request list has no amount filter; nothing else searches commercial records |

### UI (platform-web)
- Approvals inbox and drawer: a holder sees "$350 account credit"; a non-holder sees "Amount withheld — Finance amount access required" (`commercial-model.ts amountWithheld`, `AMOUNT_WITHHELD_LABEL`).
- Tenant › Commercial (B3): a holder gets "Invoices ↗" (the hosted page); a non-holder gets "Invoices · withheld · payment overdue / payment due / no payment due" and no link.
- Catalog list prices unchanged for every catalog reader.
- e2e fixtures are persona-aware (`fixtures/commercial.ts` withholds the CREDIT amount for a persona without the scope; `fixtures/session.ts` grants it to the 3 holder personas). The Approvals parity states run as finance_admin (a holder), so no new mask was needed there.

### Item 1 tests
| Spec | Result |
|---|---|
| `libs/identity/src/tests/ccp-a1a1-finance-amount-scope-migration.integration.spec.ts` (new) | 9 / 9 |
| `libs/identity/src/tests/ccp-a1-commercial-role-catalog.spec.ts` (+2 FA-2 tests, A1 views scoped) | in the identity unit run |
| `apps/platform-admin/src/tests/ccp-c3-billing-status-authorization.spec.ts` | 23 / 23 |
| `apps/platform-admin/src/tests/ccp-c6-finance-authorization.spec.ts` | in the platform-admin unit run |
| `apps/platform-admin/src/tests/ccp-a3-commercial-change-request-authorization.spec.ts` (each of the 7 routes × 6 roles: holder vs non-holder payload and basis; A3-RT-FA-1 approvers finance_admin / platform_owner see the amount on detail and approve, commercial_ops / support_admin get the marker on list and detail; A3-RT-FA-2 DISCOUNT bps) | in the platform-admin unit run |
| `apps/platform-admin/src/tests/ccp-a2-commercial-audit-authorization.spec.ts` | in the platform-admin unit run |
| `libs/subscription/src/tests/ccp-r3-acceptance.spec.ts` (new; R3-FA-1, R3-FA-5, R3-FA-7 action-keyed redaction incl. REFUND and DISCOUNT, R3-FA-4, export both modes, R3-FA-6 logs) | 9 / 9 (whole file) |
| `apps/platform-web/src/commercial/ApprovalsInboxView.spec.tsx` (inbox row and drawer, holder vs non-holder) | in the platform-web unit run |

### Item 1 divergences
- **D-R3-1 (interpretation, FA-3 vs FA-1).** C6 shows each tenant row's plan-version list price. FA-3 keeps "a plan version's published list price … wherever an existing reader is shown a plan version", and every billing reader also holds `platform:catalog:read`, from which the same price is directly readable. These stay visible; only the amount owed (`amount_due`) is withheld in C6. If the Architect reads FA-1 "monetary columns of reconciliation views" to include these list prices, the change is one mapper.
- **D-R3-2 (A1 migration edited in place).** The CCP-A1 migration's exact-matrix check compared every grant of the 6 CCP roles against A1's matrix, so any successor grant (this amendment) made the A1 migration refuse on a seeded database ("migrate after seed"). The check is now scoped to A1's own scope set (its 15 scopes and `platform:tenant:read`). Edited in place because no CCP migration is deployed (the CCP-D1-R precedent). The A1 migration spec's "extra grant" refusal still holds.
- **D-R3-3 (approval of a CREDIT by a non-holder).** Under FA-2 the Finance approver (finance_admin) and the Owner hold the amount scope, so approvers see the amount; commercial_ops (the requester) does not see the amount on read-back after creating the request. That follows FA-5 as written. Lead to confirm.
- **D-R3-7 (Lead's reading, TD-C4-7).** A DISCOUNT's `discount_bps` is a percentage, not a tenant amount: it stays visible to every reader (A3-RT-FA-2). Any amount key a DISCOUNT carries is still withheld.
- **D-R3-4 (`payload_checksum`).** A withheld payload no longer matches the stored `payload_checksum` (computed over the full payload); the checksum is returned unchanged. No client verifies it.

## Item 2 — TD-A8-3 refined (eligibility is a refusal)
- `libs/subscription/src/lib/commercial/support-extension.ts`: `SupportExtensionDecision` gains `eligible`; `ELIGIBILITY` is no longer a breach (`breaches` = LENGTH / FREQUENCY / CUMULATIVE only).
- `support-extension.service.ts`: an ineligible request (row not PAST_DUE, or no active D9 attestation) is refused with the stable code `SUPPORT_EXTENSION_INELIGIBLE` (HTTP 409 `COMMERCIAL_CHANGE_REQUEST_CONFLICT`, `details.reason: support_extension_ineligible`, `details.eligibility`). In the same transaction, under the billing lock, exactly ONE audit event `SUPPORT_EXTENSION_REFUSED_INELIGIBLE` is written; no change request, no overlay, nothing to Finance. Eligibility is decided before the limits, so an ineligible request with a limit breach is still a refusal. Only an eligible request with a limit breach escalates.
- Bypass closed: `CommercialChangeRequestService.create` refuses a SUPPORT_EXTENSION `EXTEND` that did not come through the A8 service (400 `support_extension_dedicated_route`); REMOVE is unchanged.
- B6 UI: an ineligible row's preview reads "Not eligible — refused, not escalated", shows no Finance chain, and the commit is disabled ("Not eligible"); a server refusal (e.g. no attestation) shows "Not eligible: …", never an escalation notice. `breachLine` no longer carries eligibility lines (`ineligibleLine` does).
- Tests: `ccp-a8-support-extension.integration.spec.ts` A8-ELIG-1 (both reasons; one audit row each; limit breach + ineligible = refusal), A8-ELIG-2 (generic create refused, nothing written); `ccp-a8-support-extension.spec.ts` A8-B-ELIG-1…4 rewritten; `ccp-a8-support-extension-authorization.spec.ts` +2 HTTP mappings; platform-web B6-M-ELIG, B6-F-INELIG, B6-F-INELIG-SERVER.
- Divergence D-R3-5: `ccp-a6-apply.integration.spec.ts` A6R-REQ-3 created an EXTEND through the generic create; it now passes the A8 service's internal flag (`{ support_extension_decided: true }`) because it only needs a stored request.

## Item 3 — TD-A7-5 (effective access fails closed)
- Proven (`libs/subscription/src/tests/ccp-r3-acceptance.integration.spec.ts`): R3-A75-1 (an ended subscription with its entitlement ACTIVE: allowance read and reserve refuse, capacity reserve refuses NOT_SUBSCRIBED), R3-A75-2 (an ended row whose grace was still running and with a live overlay: nothing re-admits at any instant; past both, both refuse; kept objects are still measured; the entitlement stays ACTIVE), R3-A75-3 (an open PAST_DUE row: the sending decision refuses after grace, a live overlay re-admits it, at `extends_until` it refuses again; INCOMPLETE / CANCELED never send).
- New D3 alert `ENTITLEMENT_WITHOUT_ACTIVE_SUBSCRIPTION` (BILLING, subject kind `product_entitlement`, subject `<tenant_id>:<product_key>`): a live product capability with no open BASE row of that product, past the ended row's grace and with no live overlay. Auto-resolving; read-only; never revokes. Migration `20261028050000_ccp_r3_entitlement_alert` re-asserts the type CHECK with the one added row (no other change); compensation documented in its header (refuse while such a row exists, then re-assert the D3 CHECK verbatim).
- One rule, two readers: `libs/subscription/src/lib/billing/entitlement-subscription-gap.ts` (`entitlementGaps`, `RESIDUAL_AUTHORITY_SQL`) is used by the C6 reconciliation report and the D3 scanner. C6's `entitled_without_subscription` items gain `residual_authority` (`GRACE` / `SUPPORT_OVERLAY` / null) and `residual_authority_until`; null is exactly the alert condition. R3-A75-4 and R3-A75-5 prove the two agree at every instant and across tenants, and that an open subscription or a governed revoke resolves the alert.
- No automatic revoke anywhere.
- **D-R3-6 / TD-R3-1 (decision request).** A first cut also made the capacity (upload) reserve of an OPEN, non-sending row (PAST_DUE past grace, INCOMPLETE) refuse. The CCP-A4 Sign before/after golden (`ccp-a4-sign-equality`, `ccp-a5-plan-version` golden) caught it: it changes live Sign behaviour (such a tenant can upload drafts today; sending is refused). It was reverted. The item's wording ("once a subscription has ended and its grace or overlay authority has ended") is met by the ended-row tests. Whether uploads of an open, non-sending row should also be refused is a product decision for the Lead / PO.

## Item 4 — DR-C2-3 conditions
`ccp-c2-conversion.integration.spec.ts` (new, on the real conversion path):
- C2-R3-1: after MANUAL usage, the self-service period starting after it counts 0 of exactly the plan's limit (equal to a fresh self-service tenant's limit and remaining: no manufactured allowance); the MANUAL rows are byte-identical; the new row's `period_anchor` is the provider period start.
- C2-R3-2: an outstanding MANUAL-period reservation stays on its own period (the new period counts 0); consumed after the conversion it counts once, in the MANUAL period only; the other historic row is byte-identical.
- C2-R3-3: a reservation inside the new period under the MANUAL alignment holds the activation (`USAGE_TREATMENT_UNDEFINED (CROSS_PERIOD …)`); the row is untouched.
- **No gap found; nothing changed in the conversion code.**

## Item 5 — TD-B2-1 (version-only retire)
- `validatePayload('PLAN_RETIRE', …)` refuses a payload without `plan_version_id` (absent, null, or a whole-plan `{ plan_id }`) with the stable reason `plan_version_id_required` (400 `VALIDATION_ERROR`); a malformed id stays `invalid_payload`. `CommercialPayloadError` carries the reason; `CommercialChangeRequestService.create` passes it through.
- OpenAPI: `CommercialActionType` description, the apply route description, the catalog tag and the validation response name the version-only semantics. Code comment of `PLAN_RETIRE` corrected ("retire ONE specified plan version").
- UI: the action is "Retire this version…" and the dialog "Retire this version · <plan> v<n>". No whole-plan retire exists anywhere.
- Tests: R3-RETIRE-1 (unit), R3-B21-1 (service, nothing written), catalog unit and keyboard specs re-labelled.
- Parity: DV-R3-1 (`DIVERGENCES.md`) masks the longer label and title in `ccp-catalog-published` and `ccp-catalog-retire-dialog`; those two references (and only those; `PW_STATE`) were re-captured from the pinned design file. `ccp-catalog-retired` was re-captured by the same prefix filter and is byte-identical (no diff). No PLATFORM-UX-1 baseline touched.

## Item 6 — TD-D3-9 (expiry without a sweep)
- R3-D39-1: with `expireDue` spied and never called, a request at its approval expiry reads `is_expired: true` (state still PENDING_APPROVAL), the approve is refused `EXPIRED` and lazily records EXPIRED, and the apply is refused with nothing applied. Apply-deadline expiry at apply and read time without a sweep is already proven by `ccp-a6r-apply-deadline.integration.spec.ts` A6R-TTL-B / A6R-TTL-READ (no sweep exists for it).

## Validation

| Area | Command | Result |
|---|---|---|
| libs/subscription integration | `ARAMO_RUN_INTEGRATION=1 vitest run --root libs/subscription --maxWorkers=3` | 50 / 50 files, 757 / 757 tests |
| apps/platform-admin integration | same, `--root apps/platform-admin` | 38 / 38 files, 752 / 752 tests |
| libs/identity integration | same, `--root libs/identity` | 85 / 85 files, 961 / 961 tests (run before the TD-C4-7 helper; identity untouched by it) |
| new / changed integration specs alone | `ccp-a1a1-…migration` 9 / 9; `ccp-r3-acceptance` + `ccp-a8-support-extension` 30 / 30; `ccp-c2-conversion` 24 / 24; `ccp-guard-union` unchanged and green in the subscription run | pass |
| libs/subscription unit | `vitest run --root libs/subscription` | 19 files, 312 / 312 (31 integration files skipped) |
| apps/platform-admin unit | `vitest run --root apps/platform-admin` | 23 / 23 files, 605 / 605 |
| libs/identity unit | `vitest run --root libs/identity` | 62 / 62 files, 726 / 726 |
| apps/sign-service unit | `vitest run --root apps/sign-service` | 26 / 26 files, 316 / 316 (sign-service not touched; its integration suite not re-run) |
| apps/platform-web unit | `vitest run --root apps/platform-web` | 47 files, 546 / 547 in the full run under load; the 1 failure (B6-V-SUPPORT) passed on re-run of its spec, 26 / 26 |
| platform-web e2e, all projects | `PW_E2E_PORT=4460 playwright test` | 615 passed, 6 flaky (passed on retry), 2 failed, 268 skipped (reference capture). The 2 failures are the documented PLATFORM-UX-1 baseline exceptions `studio-preview-zoom @900` and `studio-compare-changes @1440` |
| Pact consumers | `pact/pacts` deleted, `npm run pact:consumer` (serial) | 14 / 14 projects, 14 pact files; platform-web-consumer 169 / 169 (1 interaction, a D1 refusal, was "expected but not received" in the chained run and passed on its re-run with its pact file deleted first) |
| Pact providers | `npm run pact:provider` | 5 / 5 files, 6 / 6 tests |
| Gates | contract-parity, openapi drift, orphan scopes, env passthrough, error codes, tests:integration, repo-map, vocabulary | all pass |
| Lint / build | `nx run-many -t lint` (5 projects) / `-t build --skip-nx-cache` (subscription, identity, platform-admin, aramo-platform-web + 29 deps) | pass |

Flakes under load (passed on their own re-run, recorded only): `ccp-c1-billing-operations-authorization` C1-R-1 (once), `ccp-c1-stripe-commands` C1-U-10 (5 s module-compile timeout during the e2e run; passes in the later unit run).

## Files

**10 new paths, 78 modified paths.**

New:
- `apps/platform-admin/src/app/platform/finance-amount-access.ts`
- `doc/ccp/slices/CCP-R3-acceptance.md`
- `libs/identity/prisma/migrations/20261028060000_ccp_a1a1_finance_amount_scope/`
- `libs/identity/src/tests/ccp-a1a1-finance-amount-scope-migration.integration.spec.ts`
- `libs/identity/src/tests/fixtures/ccp-a1a1-compensating.sql`
- `libs/subscription/prisma/migrations/20261028050000_ccp_r3_entitlement_alert/`
- `libs/subscription/src/lib/billing/entitlement-subscription-gap.ts`
- `libs/subscription/src/lib/billing/finance-amount-withholding.ts`
- `libs/subscription/src/tests/ccp-r3-acceptance.integration.spec.ts`
- `libs/subscription/src/tests/ccp-r3-acceptance.spec.ts`

Modified:
- `pps/platform-admin/src/app/platform/dto/commercial-billing-status.dto.ts`
- `apps/platform-admin/src/app/platform/dto/commercial-finance.dto.ts`
- `apps/platform-admin/src/app/platform/dto/commercial-observability.dto.ts`
- `apps/platform-admin/src/app/platform/dto/support-extension.dto.ts`
- `apps/platform-admin/src/app/platform/platform-commercial-apply.controller.ts`
- `apps/platform-admin/src/app/platform/platform-commercial-audit.controller.ts`
- `apps/platform-admin/src/app/platform/platform-commercial-billing-status.controller.ts`
- `apps/platform-admin/src/app/platform/platform-commercial-change-request.controller.ts`
- `apps/platform-admin/src/app/platform/platform-commercial-conversion.controller.ts`
- `apps/platform-admin/src/app/platform/platform-commercial-finance.controller.ts`
- `apps/platform-admin/src/app/platform/platform-commercial-support-extension.controller.ts`
- `apps/platform-admin/src/tests/ccp-a2-commercial-audit-authorization.spec.ts`
- `apps/platform-admin/src/tests/ccp-a3-commercial-change-request-authorization.spec.ts`
- `apps/platform-admin/src/tests/ccp-a8-support-extension-authorization.spec.ts`
- `apps/platform-admin/src/tests/ccp-c3-billing-status-authorization.spec.ts`
- `apps/platform-admin/src/tests/ccp-c6-finance-authorization.spec.ts`
- `apps/platform-web/e2e/fixtures/commercial.ts`
- `apps/platform-web/e2e/fixtures/session.ts`
- `apps/platform-web/e2e/keyboard/ccp-catalog-journeys.spec.ts`
- `apps/platform-web/e2e/visual/DIVERGENCES.md`
- `apps/platform-web/e2e/visual/__screenshots__/ccp-catalog-published-1440.masks.json`
- `apps/platform-web/e2e/visual/__screenshots__/ccp-catalog-published-1440.png`
- `apps/platform-web/e2e/visual/__screenshots__/ccp-catalog-published-900.masks.json`
- `apps/platform-web/e2e/visual/__screenshots__/ccp-catalog-retire-dialog-1440.masks.json`
- `apps/platform-web/e2e/visual/__screenshots__/ccp-catalog-retire-dialog-1440.png`
- `apps/platform-web/e2e/visual/__screenshots__/ccp-catalog-retire-dialog-900.masks.json`
- `apps/platform-web/e2e/visual/__screenshots__/ccp-catalog-retire-dialog-900.png`
- `apps/platform-web/e2e/visual/states-ccp-catalog.ts`
- `apps/platform-web/src/commercial/ApprovalsInboxView.spec.tsx`
- `apps/platform-web/src/commercial/catalog/CatalogView.spec.tsx`
- `apps/platform-web/src/commercial/catalog/CatalogView.tsx`
- `apps/platform-web/src/commercial/catalog/catalog-model.spec.ts`
- `apps/platform-web/src/commercial/catalog/catalog-model.ts`
- `apps/platform-web/src/commercial/commercial-model.spec.ts`
- `apps/platform-web/src/commercial/commercial-model.ts`
- `apps/platform-web/src/commercial/subscriptions/TenantCommercialPanel.spec.tsx`
- `apps/platform-web/src/commercial/subscriptions/TenantCommercialPanel.tsx`
- `apps/platform-web/src/commercial/subscriptions/subscriptions-api.ts`
- `apps/platform-web/src/commercial/support-extensions/SupportExtensionDialogs.tsx`
- `apps/platform-web/src/commercial/support-extensions/SupportExtensionsView.spec.tsx`
- `apps/platform-web/src/commercial/support-extensions/SupportExtensionsView.tsx`
- `apps/platform-web/src/commercial/support-extensions/support-extension-api.ts`
- `apps/platform-web/src/commercial/support-extensions/support-extension-model.spec.ts`
- `apps/platform-web/src/commercial/support-extensions/support-extension-model.ts`
- `apps/platform-web/src/commercial/test-fixtures.ts`
- `ci/scripts/verify-orphan-scopes.ts`
- `doc/ccp/decisions.md`
- `doc/generated/repo-map.projects.json`
- `libs/common/src/lib/testing/identity-migrations.ts`
- `libs/identity/prisma/migrations/20261024120000_ccp_a1_commercial_role_catalog/migration.sql`
- `libs/identity/prisma/seed.ts`
- `libs/identity/src/lib/dto/scope.dto.ts`
- `libs/identity/src/tests/ccp-a1-commercial-role-catalog-migration.integration.spec.ts`
- `libs/identity/src/tests/ccp-a1-commercial-role-catalog.spec.ts`
- `libs/identity/src/tests/ccp-a9-platform-last-owner.spec.ts`
- `libs/identity/src/tests/commercial-scope-seed.spec.ts`
- `libs/identity/src/tests/identity.integration.spec.ts`
- `libs/identity/src/tests/roles1-role-model.spec.ts`
- `libs/identity/src/tests/search-pr1-seed.spec.ts`
- `libs/identity/src/tests/seed-scrub.integration.spec.ts`
- `libs/subscription/src/index.ts`
- `libs/subscription/src/lib/billing/billing-finance-report.service.ts`
- `libs/subscription/src/lib/commercial/commercial-audit-export.service.ts`
- `libs/subscription/src/lib/commercial/commercial-change-request.service.ts`
- `libs/subscription/src/lib/commercial/commercial-change-request.ts`
- `libs/subscription/src/lib/commercial/support-extension.service.ts`
- `libs/subscription/src/lib/commercial/support-extension.ts`
- `libs/subscription/src/lib/observability/commercial-alert.service.ts`
- `libs/subscription/src/lib/observability/commercial-alert.ts`
- `libs/subscription/src/tests/ccp-a6-apply.integration.spec.ts`
- `libs/subscription/src/tests/ccp-a8-support-extension.integration.spec.ts`
- `libs/subscription/src/tests/ccp-a8-support-extension.spec.ts`
- `libs/subscription/src/tests/ccp-c2-conversion.integration.spec.ts`
- `libs/subscription/src/tests/ccp-d3-alerts.spec.ts`
- `libs/subscription/src/tests/ccp-d3-operational-alerts.integration.spec.ts`
- `libs/subscription/src/tests/support/ccp-a3-database.ts`
- `openapi/platform.yaml`
- `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`
