# CCP-B1 — pre-execution check

Required by PBD §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-B1: Commercial rail group + Approvals inbox (platform-web UI) |
| **Schedule** | Program Build Directive §5.3, B1 row (`Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md:110`) and the "Common to every B row" block (`:101-106`) |
| **Authority** | PBD §2.1, §2.5 (UI slices pin the design handoff), §6, §7; PLATFORM-UX-1 Amendment A1 A1-1, A1-2, A1-4 (R-1, R-2, R-3, R-5, R-12, R-13, R-18, R-19), A1-4a, A1-5; PLATFORM-UX-1 §3 (pixel-parity standard and method) |
| **Baseline** | worktree `.claude/worktrees/ccp-b1`, branch `wip/ccp-b1`, at `7f574fa5` (program HEAD: A1–A5, A9, A10 merged). Drift since the previous slice: none (B1 starts at the program head). Working tree clean at start. |

## Pinned design input (PBD §2.5, A1-5)

Release **CCP-UI v1.0**, OneDrive `Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_0/`. `shasum -a 256 -c MANIFEST.sha256` run on 2026-10-25 before any code: **5 / 5 OK**. The hashes equal `doc/ccp/design-inputs.md:10-14`.

| SHA-256 | File |
|---|---|
| `276ac8192e9f39adaf3230904b918852b59200e6e35c0b1933d42ad90ef198a2` | `Commercial Control Plane v1.0.dc.html` (pixel truth) |
| `313fe1e1b67115688862921d4b273b1be07be6445b7d9dfa021d517a62e7b3df` | `ccp-data.js` (prototype data; loaded by the reference capture only, never shipped) |
| `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` | `support.js` |
| `385e629f5b6453892cff55a955dd1ab671d655396ccb39df6b3a477e78b5049b` | `handoff/Commercial Control Plane - Claude Code handoff v1.0.md` |
| `721f7122196dd21e13bf51e6033c4c96c0152f183f5352ffcaf4d4a7d0fec01c` | `handoff/Commercial Control Plane - design amendments log v1.0.md` (no amendments) |

The visual harness loads a byte-identical copy committed under `doc/design-reference/ccp/CCP-UI-v1_0/` (same layout as the PLATFORM-UX-1 copy under `doc/design-reference/platform-admin/`; excluded from the vocabulary gate by `COMMON_GLOBS` `**/design-reference/**`). The copy carries the release's own `MANIFEST.sha256`.

Handoff rows this slice covers (handoff §11): Commercial rail group, role-based visibility, super_admin AccessDenied (§2); Approvals inbox (§5.1); CR drawer: stepper, diff, chain, timeline (§5.2); eligibility verdict, 7 reasons (§3.1); Approve / Reject / Submit / Withdraw (§4, §5.2); bootstrap banner and 409 `CCP_NOT_BOOTSTRAPPED` (§3.2). Rows mapped to B1 but out of the brief's scope or blocked on an undelivered backend are listed under "Choices" below.

## Prerequisites (B1 row)

| Prerequisite | Evidence | Status |
|---|---|---|
| A3 evidence | `doc/ccp/slices/CCP-A3-acceptance.md`: 7 routes, the 7-refusal table (§3), per-step caller verdict on `GET /:id` (§7 A3-RI-READ), `eligible_for_me` (TD-A3-21) | ✅ |
| A9 evidence (bootstrap gate, `applied_at`, `apply`) | `doc/ccp/slices/CCP-A9-acceptance.md` §2, TD-A9-17 | ✅ |
| A10 consumer to extend | `doc/ccp/slices/CCP-A10-acceptance.md` §5; `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts` | ✅ |
| A1 scope catalog (rail filtering) | `libs/identity/prisma/seed.ts:3241-3297` (`CCP_PLATFORM_ROLE_SEED_BUNDLES`); super_admin holds 0 commercial scopes (A1 acceptance §2) | ✅ |

## path:line re-verification (at `7f574fa5`)

| Relied on | Location | Verified |
|---|---|---|
| Change-request routes | `apps/platform-admin/src/app/platform/platform-commercial-change-request.controller.ts:49` (base), `:54` POST, `:82` GET list, `:106` GET `:id`, `:117` submit, `:125` withdraw, `:133` approvals, `:152` reject; every route gated `platform:approval:read` (`:55`, `:83`, `:107`, `:119`, `:127`, `:135`, `:154`) | ✅ |
| List filters | `dto/commercial-change-request.dto.ts:28-35` (`state`, `requester`, `eligible_for_me`, `limit` ≤ 200, `cursor`) | ✅ |
| Detail verdicts | `dto/commercial-change-request.dto.ts:91-102` (`is_expired`, `chain_satisfiable`, `steps[].status`, `steps[].caller`) | ✅ |
| `applied_at`, `apply` | `dto/commercial-change-request.dto.ts:67`, `:70-76` | ✅ |
| The 7 refusals and their order | `libs/subscription/src/lib/commercial/commercial-approval-eligibility.ts:32-40` | ✅ |
| Error codes | `libs/common/src/lib/errors/error-codes.ts:1055` (`CCP_NOT_BOOTSTRAPPED`), `:1059` (`COMMERCIAL_APPROVAL_REFUSED`) | ✅ |
| Rail model | `apps/platform-web/src/shell/nav.ts:47` (`NAV_GROUPS`), `:75` Documents, `:82` Platform, `:98` `navKeyFor` | ✅ |
| Route table | `apps/platform-web/src/App.tsx:73` (`PlatformConsole`), `:152` (`/admins`) | ✅ |
| Role labels | `apps/platform-web/src/identity/identity.tsx:31-33` | ✅ |
| Visual harness | `apps/platform-web/e2e/support/proto.ts`, `e2e/visual/{capture-reference,parity}.spec.ts`, `e2e/visual/state-types.ts`, `e2e/a11y/axe.spec.ts` | ✅ |

## Choices the schedule leaves to the record

| # | Choice | Decision | Needs confirmation? |
|---|---|---|---|
| C-1 | Read scope per rail item (handoff §2 says "Commercial (all)" for every role; the brief says "each item shown only to roles holding its read scope") | Approvals `platform:approval:read`; Subscriptions `platform:subscription:read`; Catalog `platform:catalog:read`; Contracts `platform:subscription:read` (no contract scope exists; B4 may re-point); Policy `platform:approval:read` (no policy read scope; B5 may re-point); Audit `platform:commercial:audit:read` (the A2 route's own gate) | Lead (provisional for B4 / B5) |
| C-2 | Dashboard for commercial roles (handoff §2 "assumption": hidden) | Unchanged: the existing Dashboard item stays gated on `platform:tenant:read`, which the six roles hold (A1 matrix R-3: `GET /platform/dashboard` 200 for every role). Hiding it changes a non-commercial screen | PO (handoff assumption) |
| C-3 | Platform admins for platform_owner / read_only_auditor (handoff §2) | Not in B1: that page change is B5 (handoff §5.8, §11) | No |
| C-4 | Routes | `/commercial/approvals` (+ `?request=<id>` opens the drawer), `/commercial/subscriptions`, `/catalog`, `/contracts`, `/policy`, `/audit`; `/commercial` → approvals. Never under `/platform/` (R-12) | No |
| C-5 | Approve confirmation | The brief asks for approve and reject dialogs (ConfirmDialog from → to + consequence); the design approves on click and has a reject dialog only. Both are built on ConfirmDialog; the approve dialog has no design reference (typed divergence) | Lead |
| C-6 | Access-denied copy vs R-5 | R-5 (LOCKED via A1-4) wins over the CCP card where they differ: the card keeps **Sign out** and the **Missing** permission row, and the back action is **Back to dashboard**. The CCP rows (Current role, Grants access chips) and footnote are added | No (authority order: A1 › design) |
| C-7 | Data the A3/A9 routes cannot supply (R-13) | Designed empty values / states, each a typed divergence: requester and approver **names** (ids only; the caller's own name via `/platform/me`); the policy **version number** (only `policy_version_id`); the effect's **before** values; **evidence**; the per-admin roster verdicts ("Who can sign"); roster-wide chain fulfillability (the banner derives from the loaded requests' `chain_satisfiable` and from 409 responses); the human **CR number** (UUID shown short) | Backend follow-ups (lead) |
| C-8 | Rows mapped to B1 in handoff §11 but out of the brief's scope or blocked | ⌘K request results (not in the brief's "In" list); Apply panel, Retry apply and "Sent to Stripe" (A6 / C1 not delivered on this branch; the role-change `apply` result is shown) | Lead |
| C-9 | Tenant names in the inbox | Read through the existing `GET /platform/tenants` (non-CCP; every commercial role holds `platform:tenant:read`). Not contracted (A10 TD-A10-7: non-CCP routes optional) | No |
| C-10 | Pact | The UI adds two list shapes (`?limit=200`, `?eligible_for_me=true&limit=200`) and approves without a comment. Each gets a consumer interaction; the provider is re-run (A10 §5) | No |

## Correction-1 trigger check (PBD §2.4)

None. B1 is a console UI slice over existing A3/A9 routes: no architectural change, no new regulatory or commercial decision, no governing-contract amendment. No backend change, no migration, no new route, no new nx edge, no component promoted into `fe-foundation` (B-row HALT), no direct commercial mutation from the console (every act is an A3 route call).
