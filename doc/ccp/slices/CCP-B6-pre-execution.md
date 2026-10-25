# CCP-B6 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.2, before the slice's first commit. Slice: **CCP-B6, support workflows** (PBD §5.3, B6 row: "**In:** extensions and escalations. **Out:** out-of-bounds applies"; mandatory test "A breach escalates and never applies"; acceptance evidence "Parity; bound tests").

## 1. Baseline and drift

| | |
|---|---|
| Worktree / branch | `.claude/worktrees/ccp-b6`, `wip/ccp-b6` |
| Baseline SHA | `8bcf09fb` (A8 on A1–A6, A9, A10: "CCP-A8: verification tests for TD-A8-5/6 (Architect conditions)") |
| Drift since the previous slice | none: `git status` clean at start; no commit after `8bcf09fb` |
| Not in this base | B1 (rail group, shell, Approvals inbox, commercial AccessDenied), B2, B4, B5, A6-R (`apply_actionable`). They are built in parallel worktrees, which are **read, not touched**. |

## 2. Prerequisites (B6 row: "A8 evidence")

| Prerequisite | Evidence |
|---|---|
| A8 evidence recorded | `doc/ccp/slices/CCP-A8-acceptance.md`: the bounded path (`POST /platform/commercial/support-extensions`, `platform:subscription:support`; in bounds → `kind EXCEPTION` APPLIED with zero approvals and `is_exception = true`; any breach → a NORMAL Finance request, nothing applies), the list route (`GET …`, `platform:subscription:read`), removal (`SUPPORT_EXTENSION` with `operation: REMOVE`, through the A3/A6 routes), the per-role matrix (§4), Pact 46 interactions |
| Q7 | `doc/ccp/decisions.md:8`: an out-of-limit extension goes to the Finance (below-threshold) chain |
| TD-A8-5 / TD-A8-6 | APPROVED by the Architect (`CCP-A8-acceptance.md` TD-A8-21; program decisions "integration wave"): support_admin requests removal and Finance approves; overlays apply to PAST_DUE rows, Stripe-owned included, and never mutate them |
| TD-B2-3 | Lead-relayed ruling (program branch `doc/ccp/decisions.md`, not in this base): Apply is offered only to the original requester, only when the request is approved and actionable. The A6-R flag `apply_actionable` (on `GET /platform/commercial/change-requests/{id}`) arrives at merge. B6 codes against it and mocks it |
| TD-B1-2 | Lead-relayed ruling: the Dashboard stays for the commercial roles. B6 does not touch the rail or the Dashboard |

## 3. path:line re-verified at `8bcf09fb`

| Fact | Location |
|---|---|
| `POST` gate `platform:subscription:support` | `apps/platform-admin/src/app/platform/platform-commercial-support-extension.controller.ts:36-37` |
| `GET` gate `platform:subscription:read`, `tenant_id` required | same file `:65-66`; `dto/support-extension.dto.ts` `ListSupportExtensionsQueryDto` |
| Request body: `tenant_id`, `product_key`, `subscription_id`, `requested_days` (1–3650), `reason` (1–2000), `idempotency_key` | `dto/support-extension.dto.ts` `RequestSupportExtensionDto` |
| Removal payload `{operation: REMOVE, support_extension_id}`; extend payload `{operation: EXTEND, subscription_id, requested_days}` | `libs/subscription/src/lib/commercial/commercial-change-request.ts:399-407` |
| SUPPORT_EXTENSION requester scope `platform:subscription:support` | `commercial-change-request.ts:76` |
| Apply route `POST /platform/commercial/change-requests/:id/apply`, route gate `platform:approval:read` | `platform-commercial-apply.controller.ts:37-39` |
| Change-request list has no tenant or action filter (`state`, `requester`, `eligible_for_me`, `limit`, `cursor`) | `dto/commercial-change-request.dto.ts` `ListCommercialChangeRequestsQueryDto` |
| Open states (Q14 slot) | `commercial-change-request.ts:106` |
| support_admin bundle: tenant:read, catalog:read, subscription:read, subscription:support, billing:read, approval:read | `libs/identity/scripts/scope-catalog-consistency.mjs:237` |
| catalog_manager has no `platform:subscription:read` | same file `:236` |

## 4. Pinned design inputs (PBD §2.5; PLATFORM-UX-1 Amendment A1-5)

Release **CCP-UI v1.0**, OneDrive `Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_0/`. `shasum -a 256 -c MANIFEST.sha256` on 2026-10-25: **5 / 5 OK**. `MANIFEST.sha256` itself: `12aa308b7b781fe6c1a8ba929f5c6ab162244e5f47937f2b991b674120f7d65e`.

| SHA-256 | File |
|---|---|
| `276ac8192e9f39adaf3230904b918852b59200e6e35c0b1933d42ad90ef198a2` | `Commercial Control Plane v1.0.dc.html` |
| `313fe1e1b67115688862921d4b273b1be07be6445b7d9dfa021d517a62e7b3df` | `ccp-data.js` (prototype data only, never shipped) |
| `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` | `support.js` |
| `385e629f5b6453892cff55a955dd1ab671d655396ccb39df6b3a477e78b5049b` | `handoff/Commercial Control Plane - Claude Code handoff v1.0.md` |
| `721f7122196dd21e13bf51e6033c4c96c0152f183f5352ffcaf4d4a7d0fec01c` | `handoff/Commercial Control Plane - design amendments log v1.0.md` (empty) |

Rows covered (handoff §11): "Support extension: in-bounds exception and out-of-bounds escalation, exception overlay" (§5.9; backend A8, A3; UI slice B6).

Design anchors: handoff §5.9 (exception overlay, support extension dialog), §5.10 (dialog pattern), §5.3 (the "Extension · exception" flag), §2 (view-only), §6 (`ExceptionOverlay` NEW), §9 (preview `role="status"`); `.dc.html:390` (overlay card), `:722-738` (`dlgExt`), `:928` (view-only text), `:937` (the action), `:496-525` (dialog markup).

## 5. Choices the schedule leaves to the record

| # | Choice | Ruling needed? |
|---|---|---|
| C-1 | **Where the screen lives.** The design puts the extension on the Tenant › Commercial tab (B3, not built; B1 owns the shell and rail). Per the lead's brief, B6 builds a routed view `/commercial/support-extensions` (tenant chosen by `?tenant=<uuid>`), composed only of pinned elements (the §5.9 product card, overlay, open-request strip, actions and reasons, the §5.10 dialog). Parity is cropped to those elements. The page frame (header, tenant select) has no design counterpart | Lead (recorded as a divergence) |
| C-2 | **Data the screen cannot get today.** The POST needs the open base `subscription_id`, which no platform route returns, and the live preview needs the ACTIVE policy clause, which no route in this base returns. A minimal additive backend change on the A8 GET route is required (§6) | Recorded; reported |
| C-3 | **Gating.** Route gate `platform:subscription:read` (the GET's scope). Create and removal: `platform:subscription:support`. Apply: requester and `apply_actionable === true`. Without the read scope (super_admin, catalog_manager) the route shows the in-shell access-denied state through the existing `gate()`; B1's `commercialGate` replaces it at merge | Lead at merge |
| C-4 | **Removal UI has no design.** Built on the §5.10 dialog pattern (danger tone, Finance chain strip) | Recorded as a divergence |

## 6. Backend change (minimal, additive; reported)

`GET /platform/commercial/support-extensions` (same scope, same consumer) gains `subscriptions` (the open base rows of the tenant × product: id, product, source, status, grace, period end), `policy` (the ACTIVE version number, the four extension clause values and the approval window; `null` when no valid policy) and a per-extension `context` (policy version number, clause and counters recorded at apply, and the actor's roles at the time from the audit event). No migration, no write path, no scope change. OpenAPI and a Pact consumer interaction are added; the provider verifies it.

## 7. Correction-1 triggers (PBD §2.4)

None has arisen. The backend change is an additive read on the A8 route inside the A8/B6 boundary: it adds no state, route, scope or authority. No component is promoted to `fe-foundation` (no edit to `libs/fe-foundation`). No console action mutates commercial state directly: every mutation is the A8 bounded route or a governed change request.
