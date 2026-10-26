# CCP-A8 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.2, before the slice's first commit. Slice: **CCP-A8, support exception overlay** (PBD §5.1 A8 row).

## 1. Baseline and drift

| | |
|---|---|
| Worktree / branch | `.claude/worktrees/ccp-a8`, `wip/ccp-a8` |
| Baseline SHA | `078d4f78` (program HEAD: A1–A6, A9, A10 merged; "Merge CCP-A6 … into the program branch") |
| Drift since the previous slice | none: `git status` clean at start; no commit after `078d4f78` |
| Parallel slices | B1, B2, B5, D1, A7, C1, B4 (separate worktrees; not touched) |

## 2. Prerequisites (A8 row: "A2 and A6 evidence")

| Prerequisite | Evidence |
|---|---|
| A2 evidence recorded | `doc/ccp/slices/CCP-A2-acceptance.md`: policy v1 content with `support_extension_max_days` 14, `_frequency_window_days` 90, `_cumulative_max_days` 30, `_cumulative_window_days` 365; checksum `bdc36ef2…52f5`; the pure `checkSupportExtension` boundary table (37 / 37) |
| A6 evidence recorded | `doc/ccp/slices/CCP-A6-acceptance.md`: the single-transaction apply, `takeBillingLock`, NC-5 at apply, `CommercialChangeApplication`, the APPLIED backstops, the no-APPLYING-commit constraint trigger |
| A2 boundary semantics confirmed | `doc/ccp/decisions.md` A2-B (inclusive; ≤ 14 in limit) and **TD-A2-1** (half-open windows; PO 2026-10-25) |
| Chain for an out-of-limit extension | `doc/ccp/decisions.md` **Q7** (Finance) and TD-A3-2 (escalated extension = Finance-only) |
| Exception rule | DDR v1.2 §3.2 item 5 (`Aramo-Authorization-Model-DDR-Amendment-v1_2-CCP-Commercial-Authority-LOCKED.md:106`): "The only acts that apply without approval are the bounded `EXCEPTION` kind defined in the active policy (the support extension, within its limits). Each such act SHALL be audited with `is_exception = true`. Every out-of-bounds act SHALL escalate and SHALL NOT apply." |
| Role and scope | A1 directive `:115` (`platform:subscription:support` = support_admin only), `:339` (support_admin description); DDR v1.2 `:85` |
| What the overlay extends | Recon Report (`documents/ARAMO-CCP-Architecture-Reconciliation-Report-20261024.md:87`, G1): "Support extensions on those rows use an overlay row, never `grace_until`, because each sync recomputes it." `:30-39`: exception = a change request with `kind = EXCEPTION` and zero approvals, an audit event `SUPPORT_EXTENSION_EXCEPTION_APPLIED` with `is_exception = true`, actor id and role snapshot, policy version and clause, counter snapshot. |

## 3. path:line re-verified at `078d4f78`

| Fact | Location |
|---|---|
| `SUPPORT_EXTENSION` is in the closed action set; requester scope `platform:subscription:support` | `libs/subscription/src/lib/commercial/commercial-change-request.ts:36`, `:76` |
| Chain for SUPPORT_EXTENSION = FINANCE_ONLY, basis "Q7 escalated support extension" | `commercial-change-request.ts:277` |
| A3 payload validation for SUPPORT_EXTENSION = `requested_days` only (the applying slice owns the full schema, TD-A3-15) | `commercial-change-request.ts:350-352` |
| `canTransitionFor` = A3 base + A9 role set + A6 set | `commercial-change-request.ts:159-164` |
| `create` refuses any kind but NORMAL ("EXCEPTION is created by the CCP-A8 bounded path") | `commercial-change-request.service.ts:270-273` |
| A6 `apply` dispatch refuses non-A6 actions | `commercial-apply.service.ts:205-207` |
| `takeBillingLock` | `libs/subscription/src/lib/billing/governed-subscription.ts:17-19` |
| Current guard body (A3 base ∪ A9 role branch ∪ A6 branch, generic APPLIED needs `applied_at`) | `libs/subscription/prisma/migrations/20261025200000_ccp_a6_transactional_apply/migration.sql:104-225` |
| Deferred no-APPLYING-commit trigger, WHEN limited to the 4 A6 actions | same file, constraint trigger `commercial_change_request_no_applying_commit` |
| `CommercialChangeApplication.action_type` CHECK = the 4 A6 actions | same file, `CommercialChangeApplication_action_type_check` |
| `CommercialAuditEvent.is_exception` column | `20261024180000_ccp_a2_commercial_audit_policy/migration.sql:153` |
| The pure bound check | `libs/subscription/src/lib/commercial/commercial-policy-boundaries.ts:100-132` (`checkSupportExtension`) |
| The effective sending rule (PAST_DUE sends until `grace_until`) | `libs/subscription/src/lib/allowance.service.ts:78-82`; used by `activePlan` at `:124` |
| The webhook sync recomputes / keeps `grace_until` | `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts:759-765`, `:865` (the Recon Report's `:661-688` citation predates later edits; same logic) |

## 4. Choices this record fixes (executor; flagged where a ruling may be wanted)

1. **What an extension extends.** A support extension extends the **sending window of a PAST_DUE subscription** past its grace. It is an overlay row (`subscription."SupportExtension"`) keyed to the subscription row; `grace_until` and every other column of the subscription row are never written (Recon G1). The effective rule becomes: a PAST_DUE row sends while `grace_until > at` **or** an unremoved overlay of that row has `extends_until > at` (half-open, TD-A2-1). It changes no limit, no usage row and no period: allowance is never manufactured (T8).
2. **Window.** `base_until = max(applied_at, grace_until)` and `extends_until = base_until + days`. Recorded on the row (CHECKed).
3. **Bounded path (`kind = EXCEPTION`).** A new route `POST /platform/commercial/support-extensions` (scope `platform:subscription:support`). Under the billing lock it reads the prior overlays and decides with the A2 pure check plus the eligibility facts. In bounds → one transaction: a DRAFT `EXCEPTION` request with a zero-step `BOUNDED_EXCEPTION` chain, `DRAFT → APPLYING → APPLIED`, the overlay, the `CommercialChangeApplication`, and `SUPPORT_EXTENSION_EXCEPTION_APPLIED` with `is_exception = true` and the counter snapshot. Out of bounds → a NORMAL `SUPPORT_EXTENSION` request is created and submitted (Finance, Q7) and nothing applies.
4. **Breaches that escalate:** `LENGTH`, `FREQUENCY`, `CUMULATIVE` (A2 check) and `ELIGIBILITY`, with typed reasons: the target row is not `PAST_DUE` (`SUBSCRIPTION_NOT_PAST_DUE`), and the requester has no active D9 attestation (`REQUESTER_NOT_ATTESTED`: a zero-approval act needs a human-attested actor). No instrument enumerates "eligibility"; this is an executor reading (TD-A8).
5. **Refusals (no request at all):** not a user principal; scope missing; invalid input; platform tenant; tenant not found; the named subscription is not the open BASE row of that tenant × product; an open change request exists (Q14); policy unavailable (fail closed).
6. **Counting.** Frequency and cumulative count **every applied overlay** of the tenant × product (bounded and approved, removed or not), by `applied_at`. Fail-closed reading of "once per tenant per 90 days"; the A2 docstring says "in-limit extensions" (TD-A8).
7. **Escalated apply and removal reuse A6.** `CommercialApplyService.apply` admits `SUPPORT_EXTENSION` (NORMAL) and runs the same steps (billing lock, `FOR UPDATE`, NC-5, `APPLYING`, domain, application row, audit, `APPLIED`; `APPLY_FAILED` retry). The bounded path calls the same service's in-transaction core. Removal = a `SUPPORT_EXTENSION` request with payload `operation = REMOVE` (Finance chain, applied through the same route). No new action type, so the closed action CHECK is unchanged.
8. **Guard.** New migration `20261026010000_ccp_a8_support_extension_overlay` re-creates `guard_commercial_change_request()` with the A6 body verbatim plus one A8 branch; a second deferred constraint trigger covers `SUPPORT_EXTENSION` (the A6 trigger is untouched). TS mirror in `canTransitionFor` (kind-aware for SUPPORT_EXTENSION); A9-U-4 and A6-SM-1 updated.
9. **Stripe-owned rows.** The overlay applies to any open BASE row, Stripe-owned included (that is the Recon G1 design). No A8 path writes `TenantSubscription`. Proven by a test that installs a trigger raising on any UPDATE of the Stripe-owned row, then applies, escalates, approves and removes.

Items 1, 4, 6 and the removal chain (Finance-only, requested by support_admin) are executor readings for PO / Architect confirmation; none is a new commercial decision (no value, threshold or chain shape is invented beyond Q7 / TD-A3-2), so no correction-1 trigger.

## 5. Correction-1 triggers (PBD §2.4)

None has arisen: no unanticipated architectural change (the overlay is the Recon design and the PBD A8 row), no new regulatory or commercial decision, no governing-contract amendment. No HALT condition is met: no A8 path mutates a Stripe-owned row.
