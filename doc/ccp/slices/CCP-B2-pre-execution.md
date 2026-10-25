# CCP-B2 — pre-execution check

Required by PBD §6.2, before the slice's first commit.

| | |
|---|---|
| **Slice** | CCP-B2: product and plan catalog (platform-web screen + the platform-admin read and draft routes it needs) |
| **Schedule** | Program Build Directive §5.3, row B2 (`Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md:111`), plus the "Common to every B row" block (`:101-107`) |
| **Authority** | PBD §2.1 (implementation authority for B1…B6); PLATFORM-UX-1 Amendment A1: A1-1 (bounded supersession of `:135-136` for CCP UI slices), A1-2 (`:47`, no direct mutation), A1-3 (Pact), A1-4 (`:61`, R-1, R-2, R-3, R-5, R-12, R-13, R-18, R-19 bind), A1-5 (`:70`, own design pin); PLATFORM-UX-1 v1.0 §3 (pixel parity); MP-A2 N-15…N-18 (`:154-161`, version immutability, grandfathering) |
| **Baseline** | worktree `ccp-b2`, branch `wip/ccp-b2`, at the program HEAD `7f574fa5` (`CCP: record TD-A9-1 and TD-A9-16`). Drift since the previous slice: none (A9's last commit is the base). Working tree clean at start. Built in parallel with CCP-B1 (Commercial rail group + Approvals inbox). |

## 1. Locked instruments (SHA-256 re-verified against their `.sha256` sidecars, 2026-10-25)
| Instrument | SHA-256 | Sidecar |
|---|---|---|
| `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` | `8149cef2faf42335396a455d679eaac6bcb510e87bfac8bd067cbb849c5e9a95` | match |
| `Aramo-PLATFORM-UX-1-Platform-Admin-and-Template-Studio-Directive-Amendment-A1-CCP-Scope-v1_0-LOCKED.md` | `9c84fbc9e5af5bbf790553723f1080739b2318c30fa9431a9bdbc9f377c7a50c` | match |
| `Aramo-PLATFORM-UX-1-Platform-Admin-and-Template-Studio-Directive-v1_0-LOCKED.md` | `e94fa124341ecaa125dcd170066999549f1c8599756437f4294db4ae1361ac2c` | match |
| `Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-Amendment-A2-CCP-Multi-Product-and-Versioning-v1_0-LOCKED.md` | `7f4698bf434a8cf28d1ee673a78107e65f7cbfe021b4ace7446f162a4df481ba` | match |

## 2. Pinned design handoff (PBD §2.5; Amendment A1-5)
OneDrive `Aramo/design/Platform-Admin-prototype/ccp/CCP-UI-v1_0/`. `shasum -a 256 -c MANIFEST.sha256` on 2026-10-25: **5 / 5 OK**. The hashes equal the release pin in `doc/ccp/design-inputs.md`.

| SHA-256 | File |
|---|---|
| `276ac8192e9f39adaf3230904b918852b59200e6e35c0b1933d42ad90ef198a2` | `Commercial Control Plane v1.0.dc.html` (design authority) |
| `313fe1e1b67115688862921d4b273b1be07be6445b7d9dfa021d517a62e7b3df` | `ccp-data.js` (prototype data only; never shipped) |
| `8fe7df74405f3c55f49b7249c74ea1397e65d07dea2b1bd3b4a489bec2e28cbe` | `support.js` |
| `385e629f5b6453892cff55a955dd1ab671d655396ccb39df6b3a477e78b5049b` | `handoff/Commercial Control Plane - Claude Code handoff v1.0.md` |
| `721f7122196dd21e13bf51e6033c4c96c0152f183f5352ffcaf4d4a7d0fec01c` | `handoff/Commercial Control Plane - design amendments log v1.0.md` (empty) |

Rows covered (handoff §11): "Catalog: products, 'No commercial plans yet'" (§5.4; A4), "Catalog: plan versions, draft from version, edit draft, pin counts, grandfathering, v1 locks" (§5.4; A5), "Catalog: Request publish / Request retire" (§5.4; A5, A3). Prototype-only elements not built (handoff "Don't build"): the PROTOTYPE chip, the persona switcher, Tweaks, `ccp-data.js`, the fixed `NOW`. For the visual harness only, the five pinned files are copied byte-for-byte to `doc/design-reference/platform-admin/ccp/CCP-UI-v1_0/` (already excluded from the vocabulary gate by `**/design-reference/**`); the copy is re-verified against the manifest by the harness.

## 3. Prerequisites (§5.3 B2 row: "A5 evidence")
| Prerequisite | Evidence | Status |
|---|---|---|
| A5 evidence | `doc/ccp/slices/CCP-A5-acceptance.md` (commits `b225c388` … `7dc90949`, merged `27a993ca`): `PlanVersion` DRAFT → PUBLISHED → RETIRED, N-16 trigger, checksum, pin `plan_version_id`, the repository | ✅ |
| A4 evidence (product registry) | `doc/ccp/slices/CCP-A4-acceptance.md`; `libs/subscription/src/lib/product-registry.ts` `PRODUCT_KEYS = ['sign']` | ✅ |
| A3 evidence (the change-request chain the UI submits into) | `doc/ccp/slices/CCP-A3-acceptance.md:44` (`PLAN_VERSION_PUBLISH`, `PLAN_RETIRE` → finance_admin → platform_owner); decision TD-A3-2 (`doc/ccp/decisions.md:20`, PO 2026-10-25: PLAN_RETIRE uses the catalog-publish chain) | ✅ |
| A10 evidence (Pact consumer + provider + coverage gate) | `doc/ccp/slices/CCP-A10-acceptance.md` §2, §5 ("Extending the contracts") | ✅ |

## 4. path:line re-verification (at `7f574fa5`)
| Relied on | Location | Verified |
|---|---|---|
| Catalog action requester scope | `libs/subscription/src/lib/commercial/commercial-change-request.ts:81-82` (`PLAN_VERSION_PUBLISH`, `PLAN_RETIRE`: domain catalog, not tenant-scoped, requester `platform:catalog:draft`) | ✅ |
| Catalog chain | same file `:234-236` (`FINANCE_THEN_OWNER`, "D6 catalog publish") | ✅ |
| Payload for the catalog actions is not validated by A3 ("the applying slice owns the full payload schema") | same file `:294-338` (`validatePayload`, no case for the catalog actions) | ✅ |
| Repository (no in-place edit of a published version) | `libs/subscription/src/lib/plan-version.repository.ts:90` `createDraft`, `:117` `updateDraft` (refuses a non-DRAFT), `:135` `publish`, `:149` `retire` (A6 only) | ✅ |
| One PUBLISHED version per plan | `libs/subscription/prisma/migrations/20261025160000_ccp_a5_plan_version/migration.sql:133` (`PlanVersion_one_published_per_plan`); `publish` retires the previous PUBLISHED version (`plan-version.repository.ts:141-143`) | ✅ |
| Role bundles (all 6 CCP roles hold `platform:catalog:read`; only catalog_manager holds `platform:catalog:draft`; super_admin holds neither) | `libs/identity/scripts/scope-catalog-consistency.mjs:233-238`; `libs/subscription/src/tests/support/ccp-a3-database.ts:39-48` | ✅ |
| `platform:catalog:read` reservation ("removed when that enforcing route lands") | `ci/scripts/verify-orphan-scopes.ts:94` | ✅ |
| No catalog route exists yet | `apps/platform-admin/src/app/platform/` holds only the audit and change-request CCP controllers | ✅ |
| Console routes and per-route gate | `apps/platform-web/src/App.tsx:73-75` (`gate(scope, page, element)` → in-shell `PlatformAccessDenied`) | ✅ |
| Visual harness | `apps/platform-web/e2e/visual/{parity,capture-reference}.spec.ts`, `state-types.ts`, `support/proto.ts` | ✅ |

## 5. Choices the schedule leaves to the record
| Choice | Decision | Needs confirmation? |
|---|---|---|
| Routes | 4 platform-admin routes under `/platform/commercial/catalog`: `GET /catalog` (registry products, their plans and version summaries with pin counts and the open catalog requests; the catalog-publish chain preview), `GET /catalog/versions/:versionId` (one version's terms, pinned tenants, open requests), `POST /catalog/plans/:planId/drafts` (`platform:catalog:draft`; a DRAFT copied from a named version; one DRAFT per plan), `PATCH /catalog/versions/:versionId` (`platform:catalog:draft`; edits a DRAFT only; a PUBLISHED or RETIRED version is refused 409). No publish, retire or apply route (A6 applies). | No (within the B2 row "In") |
| Editable terms | The design's four editor fields map onto the A5 content: price → `plan.list_price_minor`; envelopes per month → allowance `sign.envelopes` (null = unlimited); storage (GB, binary) → capacity `sign.storage_bytes`; **seats has no backing key** in the Sign plan model → rendered as the designed disabled state (R-13, typed divergence). Currency and billing interval are the v1 locks: never editable, the route has no field for them. No new allowance, capacity or feature key can be created through the route (no invented terms; C7). | No |
| Publish / retire | Through the A3 surface only: `POST /platform/commercial/change-requests` (`PLAN_VERSION_PUBLISH` or `PLAN_RETIRE`, payload `{ plan_version_id, evidence }`) then `POST …/{id}/submit`. The payload key set is proposed to A6 (typed divergence). | Payload shape: A6 to confirm |
| Products | The registry (`sign`) comes from the backend. ATS, Portal and Intelligence are shown as static "No commercial plans yet — pricing not set" cards; they are entitlement capabilities, not registry products, and no plan or registry row is created for them (PBD §7.1, §10). | No |
| Pin count | Open BASE subscriptions (`ended_at IS NULL`) pinned to the version. | No |
| Error code | `COMMERCIAL_CATALOG_CONFLICT` (409; details.reason `not_draft`, `draft_exists`, `stale`, `plan_mismatch`, `contract_priced`, `term_missing`). | No |
| Rail item | **Not edited here** (B1 owns the Commercial rail group). B1 must add the Catalog item → `/commercial/catalog` (scope `platform:catalog:read`). Until B1 lands, the parity states mask the rail, the breadcrumb and the environment-bar context line as a pending-B1 divergence. | Lead at merge |

## 6. Correction-1 trigger check (PBD §2.4)
None. B2 is a UI slice with the read and draft routes the B2 row names; no architectural change, no new commercial decision (no plan, price or registry value is created; non-Sign products stay plan-less), no governing-contract amendment. The design's sample data shows two PUBLISHED versions of one plan at once, which the A5 store does not admit (one PUBLISHED per plan); the design is an input, not an instrument (handoff "the file wins; record the difference"), so this is a typed data divergence, not a HALT.
