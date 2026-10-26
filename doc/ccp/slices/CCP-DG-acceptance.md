# CCP-DG — the refund dual gate: acceptance evidence

| | |
|---|---|
| **Scope** | Charter Amendment A2 RX-1…RX-11 (the C4-P successor): the three optional refund policy keys, the draft editor, the dual gate at the apply / re-arm / dispatch, RX-8 binding, RX-9 revocation, RX-10 ungated paths, the refusal code `REFUND_EXECUTION_NOT_RELEASED` |
| **Branch / baseline** | `wip/ccp-dg` at `eefa795d` |
| **Governing text** | `Aramo-CCP-Charter-Amendment-A2-Refund-Execution-Policy-Keys-v1_0-LOCKED.md` (SHA-256 `800c89c3d9e661baec5807005fc214d0b8af187824102f304573ac5656e20e40`, sidecar verified equal); catalog amendment §3 RF-8 / RF-9; `doc/ccp/decisions.md` (TD-C4-12, C4-P disposition, "Architect ratification: PAYMENT_RECORD A2 + Charter A2"); Lead scope freeze 2026-10-25 (RX-1…RX-11 only; B5 UI deferred) |
| **Local commit SHAs** | **None.** Nothing committed, pushed or stashed. Gate 5 stop. |
| **Production** | Not touched. No migration. Refunds stay disabled: no ACTIVE policy declares the keys, and the switch is unset everywhere outside tests. |
| **HALT conditions hit** | None. |

## 1. What was built

| RX | Where | What |
|---|---|---|
| RX-1, RX-D3 | `libs/subscription/src/lib/commercial/commercial-policy.ts` | `REFUND_POLICY_KEYS` (`refund_execution_enabled`, `refund_policy_ref`, `refund_policy_sha256`) appended to `COMMERCIAL_POLICY_OPTIONAL_KEYS`. All present or all absent; boolean; `^[A-Z0-9-]+@[0-9]+\.[0-9]+$`; exactly 64 lowercase hex. Any partial, wrong type or bad format → `MALFORMED`. Absent → disabled. Not seeded, no default. |
| RX-11 | `commercial-policy-governance.service.ts`, `dto/commercial-governance.dto.ts`, `openapi/platform.yaml` | The three keys are editable draft keys (via `COMMERCIAL_POLICY_OPTIONAL_KEYS`, the FIX1 `apply_expiry_hours` pattern). The DTO checks the JSON type only; the strict parser checks all-or-none and the formats (`400 policy_value_invalid`). |
| RX-5…RX-7 | `refund-execution-gate.ts` (new) | `decideRefundExecution` / `evaluateRefundExecution`: gate 1 = `CCP_REFUND_EXECUTION_ENABLED=1` (else `REFUND_EXECUTION_NOT_RELEASED`). Gate 2 = the ACTIVE policy and the snapshotted policy (checksum re-verified against the request's pin) both enable refunds, with an equal ref and sha, and the payload names that ref (else `REFUND_POLICY_NOT_APPROVED`, `details.gate_2` names the basis). Both gates are evaluated on their own inputs, and the refusal detail carries `gate_1_released` and `gate_2`. |
| RX-5…RX-7 checkpoints | `commercial-billing-adjustment.service.ts` | At the apply: before anything else, including the payment-picture read, so a refusal makes zero provider calls and writes one `APPLY_REFUSED` row. Again inside the apply transaction, just before the command is created, and before a FAILED command is re-armed. |
| | `billing-command.service.ts` | Dispatcher: immediately before the first provider write (after the reconcile-first read, before the payment-picture read). A refusal leaves the command FAILED with the code and writes one `COMMERCIAL_REFUND_DISPATCH_REFUSED` row (system actor). The runbook `retryFailed` of a FAILED `REFUND_CREATE` is gated too. |
| RX-8 | `commercial-change-request.service.ts` | At create: under an ACTIVE policy that declares the keys (enabled or not), the payload `refund_policy_ref` must equal its ref. Otherwise `400 VALIDATION_ERROR`, `reason refund_policy_ref_mismatch`, `codes [REFUND_POLICY_REF_MISMATCH]`, `declared_ref`, before any provider read. Under a policy without the keys the ref is a proposal only. Gate 2 checks it again at apply. |
| RX-9 | gate 2 reads the ACTIVE policy | Activating a version without the keys, or with `false`, refuses every request, including requests snapshotted under an enabling version. A snapshot or ACTIVE pair with a different identity → `REFUND_POLICY_IDENTITY_CHANGED`. |
| RX-10 | — | Webhook processing, `reconcilePending`, recording a confirmed refund (ledger) and `resolveRefund` never call the gate. |
| RX-D1 codes | `commercial-apply-records.ts`, `commercial-billing-adjustment.ts`, OpenAPI | `REFUND_EXECUTION_NOT_RELEASED` is a refusal code inside the existing `409 COMMERCIAL_CHANGE_REQUEST_CONFLICT apply_refused` envelope, following the pattern of `REFUND_POLICY_NOT_APPROVED`, with an explanation. No new top-level `ErrorCode`, so the common.yaml registry is unchanged. |

## 2. Tests (exact counts)

| Suite | Result |
|---|---|
| `libs/subscription/src/tests/ccp-dg-refund-gate.spec.ts` (new, unit): DG-P-1…5 parser matrix (all absent; all present valid; 6 partial subsets; 17 malformed values + an unknown key + a missing one), DG-G-1 the 2 × 2 matrix, DG-G-2 identity match / mismatch with unrelated changes, DG-G-3 revocation and fail-closed, DG-G-4 RX-8 at apply, DG-G-5 RX-8 at create, DG-G-6 codes | 11 / 11 |
| `ccp-dg-refund-gate.integration.spec.ts` (new, Postgres 17): DG-I-1 production config (v1: switch off → NOT_RELEASED, on → POLICY_NOT_APPROVED); DG-I-2 the 2 × 2 at the apply (exactly 1 of 4 proceeds); DG-I-3 snapshot vs current (other checksum, same identity → proceeds; other sha / ref → refused both ways); DG-I-4 revocation (false, keys absent, v1); DG-I-5 RX-8 at create; DG-I-6 re-arm gated (apply and `retryFailed`, both gates); DG-I-7 dispatcher gates (0 writes, 0 picture reads, 1 audit row each); DG-I-8 RX-10 with both gates off (webhook, re-fetch, dispatcher reconcile, resolution CONFIRMED and RESOLVED_NOT_EXECUTED; 0 new writes, 0 refusal rows); DG-I-9 draft editor; DG-TX-1 | 10 / 10 |
| Zero provider calls on every refusal | asserted through the fake's call log in every refusal of DG-I-1…7 (`expectRefusedApply`: 0 calls naming the invoice and +1 `APPLY_REFUSED` row) |
| `ARAMO_RUN_INTEGRATION=1` libs/subscription (all) | 64 files, 938 / 938 (C4 36 / 36 among them) |
| `ARAMO_RUN_INTEGRATION=1` apps/platform-admin `src/tests/ccp-*` | 29 files, 712 / 712 (DG-RI-1 and DG-RI-EDIT among them) |
| Pact consumers (`pact/pacts` deleted first, `npm run pact:consumer`, serial) | 15 runs, 0 failed. platform-web 3 files, 199 / 199; `platform-web-platform-admin.json` holds 200 interactions (+4: NOT_RELEASED, POLICY_NOT_APPROVED, editor 200, editor partial 400) |
| Provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`) | 2 / 2 tests; 200 interactions verified |
| Guard probes | not touched (no guard union change) |
| Full compensation chain | not applicable (no migration) |

## 3. Gates

| Gate | Result |
|---|---|
| `contract-parity:check` | ok (738 live routes, 736 governed, 573 ops, 0 orphan, 0 unclassified) |
| `openapi:drift-check` | ok (9 files) |
| `error-codes:check` / `dead-error-codes:check` | ok / ok |
| `env:passthrough-check` | ok (123 passthrough + 3 required-interp + 2 guarded). `CCP_REFUND_EXECUTION_ENABLED` is still deliberately not wired. |
| `verify:vocabulary` | OK |
| `repo-map:check` | ok after regeneration (`doc/generated/repo-map.projects.json`: new exports) |
| lint (subscription, platform-admin, aramo-pact-provider, platform-web-consumer-pact) | 0 errors. The 6 warnings in the changed files were all there before this slice. |
| build (subscription, platform-admin, `--skip-nx-cache`) | ok (2 projects + 28 dependency tasks) |

## 4. Typed divergences and decisions

- **DG-D1 (dispatcher order).** In the dispatcher, the reconcile-first `readAdjustmentEffect` still runs before the gate. That read is RX-10 reconciliation: a refund that already exists is recorded, never refused. On a gate refusal the dispatcher makes 0 provider writes and 0 payment-picture reads, plus that 1 effect read. The apply-path refusals make 0 provider calls of any kind. For the Architect to confirm.
- **DG-D2 (both gates fail).** The code reported is `REFUND_EXECUTION_NOT_RELEASED` (gate 1 is evaluated first). The detail carries both outcomes.
- **DG-D3 (dispatcher audit row).** RX-7 requires "one audit row", so the dispatcher refusal writes a new event, `COMMERCIAL_REFUND_DISPATCH_REFUSED` (system actor, correlation `billing-dispatch:<command>:<attempt>`). The apply refusal keeps `COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED`.
- **DG-D4 (entry gate breadth).** As before with the flag alone, the entry gate refuses every REFUND apply call, including a replay on APPLYING or APPLIED. Conservative; it never gates RX-10 paths.
- **DG-D5 (`retryFailed`).** The runbook re-arm of a FAILED `REFUND_CREATE` is gated, with 2 new internal `BillingCommandErrorCode` values. Not an HTTP route.
- **DG-D6 (race).** The in-transaction re-check does not take the policy advisory lock (to avoid a new lock order). An activation that commits after that read is caught by the dispatcher check before any write.
- **DG-D7 (existing suites updated, not weakened).**
  - The C4 lib suite and the platform-admin C4 routes spec now run under an ACTIVE test policy (v1 + test keys; `support/ccp-dg.ts`), so their flag-on paths pass gate 2.
  - Refusal assertions with the switch off changed `REFUND_POLICY_NOT_APPROVED` → `REFUND_EXECUTION_NOT_RELEASED`: C4-REFUND-1 (3 sites), C4-REFUND-2 (2), C4R-3 (1), C4P-6 (1), C4-RI-3 (1).
  - 2 `POLICY_V1` snapshot assertions changed to the test policy (C4-TH-2, C4-NC-5).
  - The test `REFUND_PROVENANCE.refund_policy_ref` is now the test identity `ARAMO-COM-REFUND-POL-TEST@1.0` (C4P-1 assertion updated).
  - C2-U-5's exact optional-key list was extended.
  - The Pact provider releases both gates only around the `appliedRefund` seed (a test version activated raw, then the previous one restored).
  - The production-config proof (v1, refused whatever the switch) is DG-I-1.
- **DG-D8 (draft key removal).** As with `apply_expiry_hours`, a draft edit cannot remove the keys. Revocation is `refund_execution_enabled: false` (RX-9). A draft copied from a version without the keys has none.
- **DG-D9 (payload ref format).** The C4-P payload format check at create is unchanged (lenient). Under a policy with the keys, RX-8 equality makes it the strict format.
- **DG-D10 (read flag).** `refund_execution_disabled` on the adjustment read now reflects both gates.

## 5. Gaps (classified per the Lead scope freeze)

| # | Gap | Class |
|---|---|---|
| G-1 | B5 policy-screen UI field for the three keys (`apps/platform-web` governance model) | C (deferred, Lead) |
| G-2 | RX-4 "before release": the D6 release checklist step that verifies the ACTIVE `refund_policy_sha256` against the LOCKED sidecar (a runbook item, read-only; the runtime does not read OneDrive) | C (release-time; refunds stay disabled until dependencies 2, 7 and 8) |
| G-3 | RX-3: the approved refund policy (Finance, Legal, Platform Owner), filed LOCKED with a sidecar; PO D5 confirmation of the keys | B (external) |
| G-4 | Dispatcher order (DG-D1) | D (resolved under RX-10; Architect to confirm) |
