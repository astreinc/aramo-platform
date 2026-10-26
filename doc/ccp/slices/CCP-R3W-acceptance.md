# CCP-R3-W — Finance visibility extension (W-2, W-3, C4 refusal text)

| | |
|---|---|
| **Slice** | CCP-R3-W, an extension of CCP-R3's Finance amount redaction |
| **Branch / baseline** | `wip/ccp-r3w` at `eefa795d` |
| **Authority** | `doc/ccp/decisions.md`, "Architect rulings: CCP-UI v1.2 Finance visibility (2026-10-25)" (W-1, W-2, W-3); `Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0-LOCKED.md` (FA-1…FA-6); TD-MERGE-43, the "Residual for R3-W" (REFUND_REMAINDER_UNVERIFIABLE provider text) |
| **Scope** | Frozen by the Architect during the build: W-2, W-3, the refund error-text leak and no-bypass coverage. Nothing else is built. Gaps are recorded below and classified (A / B / C / D). |
| **Local commits** | **none.** Nothing is committed or pushed (Gate 5). |
| **Migrations** | none. No guard, constraint or seed change. The scope catalog is unchanged at 25 / 206 / 987. |

Every count below is exact and was read from that run's own log.

## Rule (one projection boundary, the same marker)
A caller "holds" the Finance amount scope when it has `platform:billing:read` AND `platform:billing:amount:read`. The 3 holders are platform_owner, finance_admin and read_only_auditor.

For a non-holder, each field is **omitted** (not sent for the UI to hide). The object that lost the field carries a marker, always the value `"FINANCE_SCOPE_REQUIRED"` (the OpenAPI `FinanceAmountWithheld`). Stored rows are never changed.

The shared helpers are extended, not forked. They live in `libs/subscription/src/lib/billing/finance-amount-withholding.ts`, and the decision is made in `apps/platform-admin/src/app/platform/finance-amount-access.ts`:

| Helper | Use |
|---|---|
| `projectChangeRequestFinance(row, reader)` | the change-request projection: R3 amounts + W-2 + W-3 |
| `projectApprovalNotes` | approver comments |
| `withholdContractTerms` / `withholdContractTermsDeep` | W-2 |
| `withholdEvidence`, `evidenceVisible` | W-3 evidence |
| `withholdProviderText`, `isFinancialCommandKind` | item 3 |
| `withholdAuditPayloadAmounts` | extended for the audit feed and the CSV export |
| `financeReader(auth)` (platform-admin) | the amount decision + `auth.sub`, so the requester can be identified (a non-user caller is never the requester) |
| `withholdErrorProviderText` (platform-admin) | provider text in HTTP error details |

The scope list is `FINANCIAL_REQUEST_ACTION_TYPES = ['CREDIT', 'DISCOUNT', 'REFUND', 'PAYMENT_RECORD']`. PAYMENT_RECORD is not yet an action type; it is listed so the projection covers it the day it lands.

## The response-field contract (for UI-V12)

**Change request** (`CommercialChangeRequest`: create, list, detail, submit, withdraw, approve, reject, apply, billing-adjustment, conversion, support-extension outcomes):

| Field | Holder | Non-holder, requester (`requested_by` = caller) | Non-holder, anyone else |
|---|---|---|---|
| `reason` | present | present (financial) | **financial: omitted, `reason_withheld`**; other actions: present |
| `rejection_reason` | present | **financial: omitted, `notes_withheld`** | **financial: omitted, `notes_withheld`** |
| `payload` evidence `category`, `basis`, `refund_policy_ref` (REFUND) | present | present | **omitted, `payload.evidence_withheld`** |
| `payload.contract.terms`, `payload.contract_amendment.terms` (any action) | present | **omitted, `terms_withheld` on that block** | **omitted, `terms_withheld` on that block** |
| amounts (R3, unchanged) | present | omitted, `amount_withheld` | omitted, `amount_withheld` |

- For a financial request read by a non-holder, `notes_withheld` is ALWAYS set, even when the note is null.
- Exactly one of `reason` / `reason_withheld` is present.
- Exactly one of `rejection_reason` / `notes_withheld` is present.

**Approval** (`CommercialApproval`, in the detail `approvals[]` and the approve response `approval`): on a financial request, for any non-holder (the requester included), `comment` is omitted and `notes_withheld` is set. Non-financial requests always carry `comment`.

**Contract detail** (`GET /platform/commercial/contracts/{id}`): for a non-holder:
- `terms` and `recorded_terms` are omitted, with `terms_withheld` on the detail;
- every `amendments[]` entry omits `terms` and always carries `terms_withheld` (also for an unchanged amendment);
- `summary` stays (gap G-1);
- the list route carries no terms.

**Refund report** (`GET …/finance/refunds`): `category` is present for a holder or on the caller's own request. Otherwise it is omitted, with `evidence_withheld`.

**Billing command** (`BillingProviderCommand`: the billing-commands list and the billing-adjustment `commands[]`):
- For a CREDIT_GRANT, CREDIT_REVERSE, DISCOUNT_APPLY, DISCOUNT_REMOVE or REFUND_CREATE command, a non-holder gets `detail_withheld` in place of `last_detail`, and `failure` becomes `{ code, detail_withheld }`.
- SUBSCRIPTION_CANCEL and CHECKOUT_SESSION_EXPIRE are unchanged.

**409 refusal details** (REFUND_NOT_REFUNDABLE on create; every billing-adjustment apply / resolve refusal or failure): `refusal`, `basis`, `explanation` and the codes stay. Provider text (`error`, `message`) is omitted, with `details.detail_withheld`, for any non-holder (the requester included).

**Audit feed and CSV export:** these are holder-only by route scope (`platform:commercial:audit:read`). For defence in depth, a non-holder body still gets:
- financial `reason` → `reason_withheld`;
- `comment` / `rejection_reason` → `notes_withheld`;
- provider text → `detail_withheld`;
- contract-block terms → `terms_withheld`.

The audit stream has no requester exception (fail closed).

## W-3 provenance (requester exception proven, else fail closed)
- **Request row:** `guard_commercial_change_request()`, whose last writer is `20261027000000_ccp_guard_union` (asserted), raises on any UPDATE of `payload`, `payload_checksum`, `reason`, `requested_by`, `action_type` or `created_at`. Requester text is set only at create.
- **Approver comments:** these live in `CommercialApproval.comment`. The table is append-only: UPDATE and DELETE are rejected by `reject_commercial_approval_mutation`, whose only writer is the A3 migration.
- **Columns:** the request row's free-text columns are exactly `reason` (immutable) and `rejection_reason` (written later by the rejecter). `rejection_reason` is in `FINANCIAL_NOTE_KEYS`, so it is always withheld. No later text shares storage with requester text, so no fail-closed fallback was needed.
- **Payload keys:** CREDIT and DISCOUNT closed key sets refuse `category`, `basis`, `refund_policy_ref`, `notes` and `note`. REFUND refuses `notes`, `note` and `comment`.

## No-bypass scan (`ccp-r3w-serializer-scan.spec.ts`, 8 tests)
| Check | Result |
|---|---|
| Sensitive field reads in `apps/platform-admin/src/app/platform` | 20 classified (key + exact count). 11 are guarded, and their file calls the helper; 9 are not W fields. |
| `requestDto` / `adjustmentRequestDto` calls | 15, every one passing `financeReader(auth)` / `reader` |
| `approvalDto` calls | 2, every one passing the action type + reader |
| Commercial controllers / handlers | 17 controllers, 44 handlers, each set exact |
| Readers of the audit stream (lib) | 4 (A2 repository; CR service internal; refund report = `change_request_id` only; support extension = clause / counters only). The export uses `withholdAuditPayloadAmounts` + `financeAmountAccess(actor.scopes)`. |
| D3 alert evidence objects | 9, none carrying reason, note, evidence, contract terms, C4 provider text or an amount |
| Notification senders in commercial code | 0 |
| Log lines interpolating requester text, notes or terms | 0 |
| W-1: response DTO fields naming a negotiated, contracted or effective price | 0 |

## Tests (exact)
| Run | Result |
|---|---|
| `libs/subscription` `ccp-r3w-finance-visibility.spec.ts` (W-2, W-3, provenance, item 3, audit / CSV, W-1) | 20 / 20 |
| `apps/platform-admin` `ccp-r3w-finance-visibility-authorization.spec.ts` | 67 / 67 |
| `apps/platform-admin` `ccp-r3w-serializer-scan.spec.ts` | 8 / 8 |
| `ccp-b4-commercial-contract-authorization.spec.ts` (updated) | 13 / 13 |
| platform-admin unit suite | 26 files, 698 / 698 |
| subscription unit suite | 23 files passed / 40 skipped; 374 passed / 563 skipped |
| platform-admin integration, targeted (A3 routes, C4 routes, B5 governance, A8, D4 ×3) | 7 files: 154 / 155 on the first run; C4P-RI-1 updated (below); C4 file re-run 6 / 6 |
| subscription integration (`ccp-r3*`, `ccp-b5*`, `ccp-c4*`) | 8 files, 118 / 118 |
| Pact consumer platform-web (generated pact deleted first; serial) | 3 files, 199 / 199; 200 interactions |
| Pact provider `verify-platform-admin` | 2 / 2; 200 interactions verified |

**Test details:**
- **The authorization spec** runs the real JwtAuthGuard + RolesGuard. It covers the 6 roles + super_admin + a second commercial_ops + a synthetic audit-only non-holder, across 7 change-request routes, contract detail, refund report, billing-adjustment (read, apply, resolve), billing-commands and the audit feed.
- **commercial_ops creates a CREDIT:** it sees its own reason, while the approver comment is `notes_withheld`. Another commercial_ops user gets `reason_withheld` and `notes_withheld`.
- **R3 leak tests:** no regression (A2, A3, C3, C6, D2 authorization and R3 acceptance pass inside the suite counts).
- **C4P-RI-1 (updated):** commercial_ops (the requester) keeps `category`, and support_admin now gets `evidence_withheld`. This is the intended W-3 change.

**New Pact interactions:**
- a pending credit detail read by support_admin (`reason_withheld`, `notes_withheld`);
- the same read by its requester;
- a contract detail read by commercial_ops (`terms_withheld`).

**Updated Pact interactions:**
- the support_admin refund report row (`evidence_withheld`);
- `requestBody({ withheld })` (`notes_withheld` replaces `rejection_reason: null`).

**Gates:**
| Gate | Result |
|---|---|
| contract-parity, openapi drift, openapi validate, orphan scopes, error codes, dead error codes, vocabulary | exit 0 |
| repo-map | exit 0 after regenerating (new index exports) |
| lint (platform-admin, subscription) | 0 errors |
| `nx run platform-admin:build` (+29 deps) | success |

## Divergences (typed)
- **DV-1 (evidence key set).** "Payload evidence" = the REFUND RF-2 provenance: `category`, `basis` and `refund_policy_ref`.
  - `provider_invoice_ref` and `provider_payment_ref` stay visible as identity references, as R3 / TD-MERGE-43 ruled.
  - CREDIT and DISCOUNT have no evidence keys.
- **DV-2 (refund report category).** The C4-P refund report is an alternate read path of REFUND evidence, so W-3 applies to it (no bypass).
- **DV-3 (C4 command provider text).** The REFUND_REMAINDER_UNVERIFIABLE provider text also lands in `BillingProviderCommand.last_error_detail` (`billing-command.service.ts:538`), which the billing-commands list and the adjustment view return to platform:billing:read roles. Class A, fixed with the smallest change: C4 kinds only.
- **DV-4 (audit stream).** No requester exception in the audit feed and export (fail closed). The route scope admits only holders anyway.
- **DV-5 (W-2 and the requester).** Contract terms in a SUBSCRIPTION_* payload are withheld from the requester too. W-2 states no requester exception.

## Gaps recorded (scope frozen; not implemented)
| Id | Class | Gap |
|---|---|---|
| G-1 | C | `ContractAmendment.summary` and `contract_end.summary` (free text, up to 500 characters) stay visible to non-holders. W-2 names only `terms`; an amendment summary may describe negotiated changes. Needs an Architect ruling. |
| G-2 | C | `BillingWebhookInbox.last_error` (the webhook-inbox read, and the D3 webhook alert `evidence.last_error`) is visible to platform:billing:read roles. It is the handler's own error text for any event type, not a C4 refusal, so it was left unchanged. |
| G-3 | C | D2 revenue `basis: OPEN_SUBSCRIPTIONS_X_PINNED_LIST_PRICE` aggregates list prices into a revenue figure. It is amount-scope gated and labelled as a list-price basis, not a tenant effective price. Recorded against W-1 ("never derive effective billing amounts from list prices") for the Architect. |
| G-4 | B | `apps/platform-web` (types, fixtures, e2e) must render the new markers. This is the UI-V12 slice, which codes against the contract above. |
| G-5 | C | `payload_checksum` (SHA-256 over the full stored payload, terms included) is still returned to non-holders. It is not reversible in practice; recorded only. |
