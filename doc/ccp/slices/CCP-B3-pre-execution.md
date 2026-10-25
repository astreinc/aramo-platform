# CCP-B3 — pre-execution check

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.2, before the slice's first commit. Slice: **CCP-B3, subscriptions workbench + tenant commercial overview** (PBD §5.3, B3 row: "**In:** all products; tenant product tab actions (request change, cancel, grant or revoke product); held activations surfaced (Conv. C-8). **Out:** dashboard money (A0-C6)"; mandatory tests "Held activation shown to operators; actions create change requests only"; HALT "Any direct edit path"; acceptance evidence "Parity; action-to-change-request trace").

## 1. Baseline and drift

| | |
|---|---|
| Worktree / branch | `.claude/worktrees/ccp-b3`, `wip/ccp-b3` |
| Baseline SHA | `debd033d` ("Merge CCP-D3 (operational alerts + metrics) into the program branch"): the integrated program branch with A1–A11, B1, B2, B4–B6, C1–C3, C6, D1 (D1-R) and D3 |
| Drift since the previous slice | none: `git status` clean at start (no tracked change); no commit after `debd033d` |
| Parallel work (not touched) | B5-R edits the guard-union migration (`20261027000000_ccp_guard_union`) and the policy apply. B3 changes neither file and no migration |
| Setup | `npm ci --no-audit --no-fund` (exit 0); `npm run prisma:generate` (exit 0) |

## 2. Prerequisites (B3 row: "A6, A7 evidence (C2 for conversion actions)")

| Prerequisite | Evidence |
|---|---|
| A6 (apply, hold) + A6-R (requester-only, `apply_actionable`, APPLY_EXPIRED, pending activation) | `doc/ccp/slices/CCP-A6-acceptance.md` §2–§4, §A6-R.2–§A6-R.4b; merged (decisions.md "Merge train") |
| A7 (revoke, provenance) | `doc/ccp/slices/CCP-A7-acceptance.md` §1–§2 (`ENTITLEMENT_REVOKE`, `granted_source`, `revoked_at`); merged (TD-MERGE-26…28) |
| C2 (conversion) | `doc/ccp/slices/CCP-C2-acceptance.md` §2 (`POST …/{id}/convert`, `GET …/{id}/conversion`; `TO_SELF_SERVICE` / `TO_GOVERNED`, `held_subscription_ref`); merged (TD-MERGE-21…23) |
| C1 (commands; "Sent to Stripe — awaiting confirmation") | `doc/ccp/slices/CCP-C1-acceptance.md`; a TO_GOVERNED conversion commits in APPLYING while its provider command is unconfirmed (C2 TD-C2-1) |
| C3 (billing-status read) | `doc/ccp/slices/CCP-C3-acceptance.md` §3: **NOT DELIVERED** (`STRIPE_PORTAL_CONFIGURATION` unverified). Invoice `hosted_url` only; no operator target for payment methods, proration or cancellation (TD-C3-1) |
| A8 / B6 (support overlay) | `CCP-A8-acceptance.md`, `CCP-B6-acceptance.md`; B6's dialogs, `ExceptionOverlay` and model are on the branch (TD-MERGE-32) |
| B4 (contracts) | `CCP-B4-acceptance.md`; a contract-linked SUBSCRIPTION_END must carry `contract_end` (`libs/subscription/src/lib/commercial/commercial-contract.ts:49`) |
| D1 (usage counts) | `CCP-D1-acceptance.md`; B3 reads the allowance counts through the existing `GET /platform/tenants/{id}/sign` (no money) |
| B1 shell | `commercialGate` (`apps/platform-web/src/App.tsx:100-101`), `COMMERCIAL_PERMISSIONS` (`apps/platform-web/src/components/permissions.ts:23`), the Subscriptions placeholder (`App.tsx:183`) and rail item (B1 §3) |
| B2 dialog | `CommercialRequestDialog` / `ChainPreview` (`apps/platform-web/src/components/CommercialRequestDialog.tsx`, `ChainPreview.tsx`) |

## 3. Rulings this slice applies (`doc/ccp/decisions.md`)

| Ruling | Effect on B3 |
|---|---|
| TD-B2-3 (`decisions.md:62`) | Apply / Retry apply is offered only when the request read returns `apply_actionable: true` |
| TD-B1-2 (`:57`) | No money on the dashboard; B3 adds nothing to the dashboard |
| TD-B4-3 (`:68`) | RBAC preserved: catalog_manager holds no `platform:subscription:read`, so it gets no Subscriptions item and no Commercial tab; no scope is added for parity |
| TD-A6-12 (`:43`) | Held-activation details are operator-only (the console is the operator surface); B3 adds no tenant-facing surface |
| TD-A3-2 (`:20`) | Subscription change / end, grant / revoke and conversion use the Finance-only chain |
| TD-MERGE-10 (`:93`) | Evidence travels in the reason (`<reason>\n\nEvidence: <evidence>`) |
| TD-C3-1 (`CCP-C3-acceptance.md:99`) | "Managed in Stripe" link-outs: invoice `hosted_url` only; the other three are recorded, not linked |
| DR-C2-1 (`CCP-C2-acceptance.md:153`) | A self-service row inside a commitment term is refused `FINANCIAL_TREATMENT_UNDEFINED`; the console surfaces the refusal |

## 4. path:line re-verified at `debd033d`

| Fact | Location |
|---|---|
| No cross-tenant subscription read and no per-tenant commercial read exist under `/platform/commercial` (the controllers' route list) | `apps/platform-admin/src/app/platform/platform-commercial-*.controller.ts` |
| The change-request list filters: `state`, `requester`, `eligible_for_me`, `limit`, `cursor` (no tenant filter) | `apps/platform-admin/src/app/platform/dto/commercial-change-request.dto.ts:28-34` |
| `apply_actionable` covers the A6, catalog, A7 and SUPPORT_EXTENSION applies, **not CONVERSION** | `libs/subscription/src/lib/commercial/commercial-change-request.service.ts:1141-1148` |
| Conversion apply is requester-only (`POST …/{id}/convert`), route gate `platform:approval:read` | `apps/platform-admin/src/app/platform/platform-commercial-conversion.controller.ts:41-43` |
| Requester scopes: SUBSCRIPTION_* and CONVERSION `platform:subscription:request`; ENTITLEMENT_* `platform:entitlement:request` | `libs/subscription/src/lib/commercial/commercial-change-request.ts:74-80` |
| Request product keys: `sign` only | `commercial-change-request.ts:51` |
| CONVERSION payload key sets | `libs/subscription/src/lib/commercial/commercial-conversion.ts:69-86` |
| Governed = open MANUAL row | `libs/subscription/src/lib/billing/governed-subscription.ts:30-32` |
| Hold reason `governed_subscription_open` | `governed-subscription.ts:35` |
| Flag model (`subscription_ref`, `intent_id`, `reason`, `resolved_at`) | `libs/subscription/prisma/schema.prisma`, model `BillingReconciliationFlag` |
| Provenance columns | `libs/entitlement/prisma/schema.prisma`, model `TenantEntitlement` (`granted_source`, `change_request_id`, `revoked_at`, `revoke_change_request_id`) |
| Role bundles (catalog_manager: no `platform:subscription:read`) | `libs/identity/prisma/seed.ts:3240-3297` |
| Tenant tabs (PLATFORM-UX-1): overview, lifecycle, sign, domain, people | `apps/platform-web/src/tenants/TenantDetailView.tsx:43-56` |

## 5. Pinned design inputs (PBD §2.5; PLATFORM-UX-1 Amendment A1-5)

Release **CCP-UI v1.0**, OneDrive `Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_0/`. `shasum -a 256 -c MANIFEST.sha256` on 2026-10-25: **5 / 5 OK** (the committed copy `doc/design-reference/ccp/CCP-UI-v1_0/`: 5 / 5 OK). `MANIFEST.sha256` itself: `12aa308b7b781fe6c1a8ba929f5c6ab162244e5f47937f2b991b674120f7d65e`.

| SHA-256 | File |
|---|---|
| `276ac8192e9f39adaf3230904b918852b59200e6e35c0b1933d42ad90ef198a2` | `Commercial Control Plane v1.0.dc.html` |
| `313fe1e1b67115688862921d4b273b1be07be6445b7d9dfa021d517a62e7b3df` | `ccp-data.js` (prototype data only, never shipped) |
| `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` | `support.js` |
| `385e629f5b6453892cff55a955dd1ab671d655396ccb39df6b3a477e78b5049b` | `handoff/Commercial Control Plane - Claude Code handoff v1.0.md` |
| `721f7122196dd21e13bf51e6033c4c96c0152f183f5352ffcaf4d4a7d0fec01c` | `handoff/Commercial Control Plane - design amendments log v1.0.md` (empty) |

Rows covered (handoff §11, UI slice B3): Subscriptions workbench (filters, source badge, status, grace, flags); commitment ending filter, past-due / in grace; Tenant › Commercial: subscription facts, pinned version, allowance; entitlement provenance, Grant / Revoke product; plan change, cancel; reconciliation flag (checkout hold); reconciliation release; Managed in Stripe link-outs; "Sent to Stripe — awaiting confirmation" (shared with B1). Not covered: credits on self-service (C4, not delivered), discount (DISCOUNT has no governed apply), the support-extension dialog itself (B6 owns it; B3 hosts B6's dialog and overlay on the tab).

Design anchors: handoff §5.3, §5.9, §5.10, §2, §4, §9; `.dc.html:150-182` (workbench), `:360-400` (tenant + Commercial tab), `:700-720` (plan change, cancel, grant, revoke, reconciliation release dialogs), `:835-856` (workbench logic), `:925-950` (card logic).

## 6. Choices the schedule leaves to the record

| # | Choice | Ruling needed? |
|---|---|---|
| C-1 | **Two minimal read routes** (no route exists for either screen): `GET /platform/commercial/subscriptions` (the latest BASE row per tenant × product, open or most recently ended; no money) and `GET /platform/commercial/tenants/{tenant_id}/commercial` (per product: entitlement + provenance, the base row, open reconciliation flags with their linked conversion request, the open request of the tenant × product). Both `platform:subscription:read`; read-only; no migration; OpenAPI, manifest, per-role tests, Pact consumer + provider | Recorded; reported |
| C-2 | **`apply_actionable` for CONVERSION.** The conversion apply is requester-only (`…/convert`) but the read flag omits CONVERSION, so a requester would never be offered Apply. B3 adds CONVERSION to `applyActionable` (same rule: requester, APPROVED / APPLY_FAILED, the requester scope) | Recorded (TD-B3) |
| C-3 | **Conversion actions not drawn in the design.** Besides the designed reconciliation release (held activation → governed, `TO_GOVERNED` + `held_subscription_ref`), the Stripe row offers "Request conversion to MANUAL…" (`TO_GOVERNED`) and the MANUAL row "Request conversion to self-service…" (`TO_SELF_SERVICE`), on the §5.10 dialog pattern. PBD B3 row prerequisites name C2 "for conversion actions" | Recorded (TD-B3); no parity reference |
| C-4 | **Committed self-service rows (DR-C2-1).** The conversion action is disabled with the domain reason while `commitment_end` is in the future; a server refusal on apply (`FINANCIAL_TREATMENT_UNDEFINED`) is shown verbatim with its explanation | Recorded |
| C-5 | **Products without a governed path.** Grant / Revoke for ATS, Portal and Intelligence are disabled with a domain reason (request product keys are `sign` only; A7 TD-A7-6) | Recorded (TD-B3) |
| C-6 | **Commercial tab gate** `platform:subscription:read`; hidden otherwise (catalog_manager, super_admin), TD-B4-3 | Recorded |

## 7. Correction-1 triggers (PBD §2.4)

None has arisen. The two routes are reads inside the A4–A8 / C2 data the program already owns; they add no state, scope or authority. The `applyActionable` change widens a read hint to an apply the service already restricts to the requester. No component is promoted to `fe-foundation`. No console action mutates commercial state directly: every write is a change request create / submit, or the requester's governed apply or convert.
