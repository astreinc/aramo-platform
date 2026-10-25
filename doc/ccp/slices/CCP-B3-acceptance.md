# CCP-B3 — acceptance evidence

Required by `Aramo-CCP-Program-Build-Directive-v1_0-LOCKED.md` (PBD) §6.3 and the §5.3 B3 row: "**In:** all products; tenant product tab actions (request change, cancel, grant or revoke product); held activations surfaced (Conv. C-8). **Out:** dashboard money (A0-C6)". Mandatory tests: "Held activation shown to operators; actions create change requests only". HALT: "Any direct edit path". Evidence: "Parity; action-to-change-request trace".

| | |
|---|---|
| **Slice** | CCP-B3: Subscriptions workbench + Tenant › Commercial tab |
| **Worktree / baseline** | `.claude/worktrees/ccp-b3`, `wip/ccp-b3`, base `debd033d`. The program branch has since moved to `cc7804e9` (B5-R); the lead merges. B3 does not read `effect_applied_at`, and it shows APPLY_EXPIRED for any request type it displays (§7, TD-B3-9). |
| **Pre-execution record** | `doc/ccp/slices/CCP-B3-pre-execution.md`: design hashes 5 / 5 OK; `MANIFEST.sha256` `12aa308b…` |
| **Local commit SHAs** | **pending (lead commits).** Nothing was committed, pushed or staged. The real index is empty. |
| **HALT conditions hit** | **None.** No code contradicts the instruments. No component is promoted to `fe-foundation`. No design change outside the pin. No console path mutates commercial state: every write is a change-request create or submit, or the requester's governed apply or convert (§3). |

## 1. Commit map (proposed; SHAs pending, lead commits)

| # | Proposed commit | Files |
|---|---|---|
| B3-0 | `CCP-B3: pre-execution check` | `doc/ccp/slices/CCP-B3-pre-execution.md` |
| B3-1 | `CCP-B3: read-only subscriptions workbench and tenant commercial overview reads (service)` | `libs/subscription/src/lib/commercial/commercial-subscription-read.service.ts` (new); `libs/subscription/src/index.ts`; `libs/subscription/src/lib/subscription.module.ts` |
| B3-2 | `CCP-B3: apply_actionable covers the conversion apply (requester-only)` | `libs/subscription/src/lib/commercial/commercial-change-request.service.ts`; `libs/subscription/src/tests/ccp-c2-conversion.spec.ts` (B3-U-1) |
| B3-3 | `CCP-B3: GET /platform/commercial/subscriptions and /tenants/{id}/commercial, OpenAPI and gates` | `apps/platform-admin/src/app/platform/platform-commercial-subscriptions.controller.ts`, `dto/commercial-subscriptions.dto.ts` (new); `platform.module.ts`; `openapi/platform.yaml`; `ci/config/api-surface-manifest.json` |
| B3-4 | `CCP-B3: backend tests (per role, read-only integration)` | `apps/platform-admin/src/tests/ccp-b3-subscriptions-authorization.spec.ts`, `libs/subscription/src/tests/ccp-b3-subscription-read.integration.spec.ts` (new) |
| B3-5 | `CCP-B3: Pact — workbench, tenant overview, conversion apply_actionable` | `pact/consumers/platform-web-consumer/src/platform-commercial.consumer.test.ts`; `pact/provider/src/verify-platform-admin.ts` |
| B3-6 | `CCP-B3: Subscriptions workbench and Tenant › Commercial tab (console)` | `apps/platform-web/src/commercial/subscriptions/` (`SubscriptionsView.tsx`, `TenantCommercialPanel.tsx`, `TenantCommercialDialogs.tsx`, `subscriptions-api.ts`, `subscriptions-model.ts`, `subscriptions.css`); `src/App.tsx` (route); `src/tenants/TenantDetailView.tsx` (tab); `src/components/CommercialRequestDialog.tsx` (an additive optional "Save as draft" action); `src/commercial/CommercialPlaceholderView.tsx` (**deleted**: it has no remaining route) |
| B3-7 | `CCP-B3: unit specs` | `apps/platform-web/src/commercial/subscriptions/*.spec.ts(x)`, `subscriptions-test-data.ts` (new); `src/commercial/commercial-visibility.spec.tsx`; `src/tenants/TenantDetailView.spec.tsx` |
| B3-8 | `CCP-B3: e2e — parity (CCP-UI v1.0), axe, keyboard, 900px` | `apps/platform-web/e2e/fixtures/ccp-subscriptions.ts`, `e2e/visual/states-ccp-subscriptions.ts`, `e2e/keyboard/ccp-subscriptions-journeys.spec.ts` (new); `e2e/visual/states.ts`; `e2e/visual/DIVERGENCES.md`; `e2e/visual/__screenshots__/ccp-subs-*`, `ccp-tc-*` (24 PNG + 24 mask files, new) |
| B3-9 | `CCP-B3: acceptance evidence` + `CCP-B3: regenerate repo map` | `doc/ccp/slices/CCP-B3-acceptance.md` (new); `doc/generated/repo-map.{files,coupling,projects}.json` |

Totals (`git status --short -uall`): **68 new files** (20 plus 48 reference files), **19 modified**, **1 deleted**. `git diff --shortstat` over the tracked files: 20 files, 942 insertions, 77 deletions.

**Unchanged:**
- every migration;
- `pact/provider/src/verify-api.ts`, because no apps/api shape changed;
- the B5-R files (the guard-union migration, the policy apply);
- `libs/fe-foundation`;
- `doc/ccp/decisions.md`;
- every PLATFORM-UX-1 reference image. `git status` shows only new `ccp-subs-*` and `ccp-tc-*` files under `__screenshots__`, and no existing baseline is modified.

## 2. Screens (handoff §11 rows, UI slice B3)

| Screen / state | Route | Data |
|---|---|---|
| Subscriptions workbench: status segments with counts (All, Active, Past due, In grace, Suspended, Ended); Product, Source, Plan version and Commitment ending filters; "Has reconciliation flag"; "n of N"; columns Tenant, Product · plan, Version (grandfathered), Source badge, Status pill, Period · grace, Commitment end, Flags; skeleton; empty state with Clear filters; a row opens Tenant › Commercial | `/commercial/subscriptions` (replaces B1's placeholder) | `GET /platform/commercial/subscriptions` (new); Plan version options from `GET …/catalog` |
| Tenant › Commercial: one card per product (Aramo Sign, ATS, Portal, Intelligence). Each card shows: the entitlement pill; the source badge; the provenance (A7); the facts (plan, pinned version, status with its grace or suspension line, current period, commitment end); the allowance bar (counts only); "No commercial plans yet"; "No open base subscription"; the reconciliation-flag alert with its release state (C-8); the exception overlay (B6's); the "Managed in Stripe" box; the open-request strip with Apply / Retry apply when `apply_actionable`; the actions and their domain reasons; the view-only note | `/tenants/{id}?tab=commercial` (tab after Sign; gate `platform:subscription:read`) | `GET /platform/commercial/tenants/{id}/commercial` (new); `GET /platform/tenants/{id}/sign` (allowance counts); `GET …/support-extensions` (overlays, the policy number and window); `GET …/change-requests/{id}` (`apply_actionable`); `GET …/{id}/conversion` (`pending_provider`); `GET …/tenants/{id}/billing-status` (only the hosted invoice link) |
| Dialogs (§5.10): plan change → SUBSCRIPTION_CHANGE; cancel → SUBSCRIPTION_END (with `contract_end` on a contract-linked row); grant → ENTITLEMENT_GRANT; revoke → ENTITLEMENT_REVOKE; reconciliation release → CONVERSION `TO_GOVERNED` with `held_subscription_ref`; conversion to MANUAL → CONVERSION `TO_GOVERNED` (TD-B3-4). Each dialog has Save as draft and Submit for approval. Support extension → B6's dialog | in the tab | `POST …/change-requests` and `…/{id}/submit`; `POST …/support-extensions` (B6) |

Money (A1-4a): the workbench and the cards show **no** amounts. Plan list prices appear only inside the plan-change dialog's plan options and its before → after rows, read from the catalog, as on B2's catalog screen. Nothing is added to the dashboard. The billing-status read is used only for `invoices[0].hosted_url`; its amounts are discarded in the client (`subscriptions-api.ts invoiceLink`).

## 3. Action-to-change-request trace (PBD B3 acceptance; HALT "Any direct edit path")

| Console action | Call | Payload (CCP-A3 / C2 closed key set) | Applies only after |
|---|---|---|---|
| Request plan change… | `POST …/change-requests` (+ `/submit`) `SUBSCRIPTION_CHANGE` | `{subscription_id, plan_key, plan_version_id}` | Finance signs (TD-A3-2); the requester applies (`/apply`) |
| Request cancel… | `SUBSCRIPTION_END` | `{subscription_id[, contract_end{contract_id, documents: [], evidence_ref}]}` | same |
| Grant product… | `ENTITLEMENT_GRANT` | `{capabilities: [core, sign]}` | same |
| Revoke product… | `ENTITLEMENT_REVOKE` | `{capabilities: [sign]}` | same |
| Request reconciliation release… | `CONVERSION` | `{direction: TO_GOVERNED, held_subscription_ref, governed_subscription_id}` | Finance signs; the requester converts (`/convert`). Stripe side = C1 command; shown "Sent to Stripe — awaiting confirmation" until the webhook |
| Request conversion to MANUAL… | `CONVERSION` | `{direction: TO_GOVERNED, subscription_id, plan_key, plan_version_id}` | same; refused `FINANCIAL_TREATMENT_UNDEFINED` inside a commitment term (DR-C2-1) |
| Apply / Retry apply | `POST …/{id}/apply`, or `…/{id}/convert` for a CONVERSION | — | offered only when `apply_actionable` is true (TD-B2-3) |
| Request support extension… | B6's `POST …/support-extensions` | — | A8 bounds (B6) |

Proof: `TenantCommercialPanel.spec.tsx` records every fetch the screen makes. Every non-GET call matches only `POST /platform/commercial/change-requests` or `…/{id}/(submit|apply|convert)` (B3-T-HELD, B3-T-REVOKE). Keyboard JB3-2 records exactly the create then the submit. The workbench makes 0 writes for every role (B3-W-ROLE).

## 4. Backend additions (minimal reads; reported)

| Addition | Gate | Evidence |
|---|---|---|
| `GET /platform/commercial/subscriptions` (optional `product_key`): the latest BASE row per tenant × product (the open one, else the most recently ended), with the plan and pinned version, source, status, period, grace, commitment, contract, open flag reasons and active overlays. No money | `platform:subscription:read` | per-role spec 12 / 12 (shared with the next row); integration 10 / 10 (shared) |
| `GET /platform/commercial/tenants/{id}/commercial`: per product (sign, ats, portal, intelligence), the entitlement and its provenance, the base row, the open flags each linked to its newest CONVERSION, and the open request (Q14). 404 for an unknown tenant | `platform:subscription:read` | as above |
| `applyActionable` covers CONVERSION (pre-execution C-2) | read hint only; `/convert` stays requester-only | unit B3-U-1 (requester true for APPROVED and APPLY_FAILED; false for another user, DRAFT, PENDING, APPLIED, no scope, service actor) |

**Per role (both routes):**
- allowed: platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor;
- 403 `missing_scopes [platform:subscription:read]`: catalog_manager and super_admin;
- 403 for a tenant-tier token, 400 for a malformed id, 404 for an unknown tenant;
- a deep scan finds no key named like price, amount or currency in either body.

**Integration (real Postgres; `ccp-b3-subscription-read.integration.spec.ts`).** Seeds (a)–(f): a contract-linked MANUAL row with a held flag and its CONVERSION; a PAST_DUE self-service row; an ended-only tenant; a revoked entitlement; an open SUBSCRIPTION_CHANGE; an active bounded overlay. It checks:
- every field;
- the latest-row rule;
- name order;
- the flag-to-newest-conversion link;
- `open_request`;
- `registered` (sign only);
- product isolation;
- **read-only**: count + md5 fingerprints of 11 tables are equal before and after.

## 5. Mandatory tests → evidence

**Per role (6 roles + super_admin):**
- The workbench is shown to the 5 readers. The read is never called for catalog_manager or super_admin, who get the in-shell Commercial access-denied card (`SubscriptionsView.spec.tsx` B3-W-ROLE ×5, B3-W-DENIED ×2).
- The tab is shown to the 5 readers and hidden for catalog_manager and super_admin; `?tab=commercial` falls back to Overview (B3-T-ROLE ×5, B3-T-HIDDEN ×2; TD-B4-3).
- commercial_ops can request; support_admin can request only a support extension; owner, finance and auditor get the view-only note with the role reasons (B3-T-OPS, B3-T-SUPPORT, B3-T-VIEW ×3).
- Model gating: B3-A-1, B3-A-2.
- Backend: §4.

**Governed vs Stripe-owned:**
- B3-T-GOV: MANUAL facts, pinned version, contract, counts, and no money.
- B3-T-STRIPE: the Managed in Stripe box; plan change and cancel disabled with the Stripe reasons; only "Request conversion to MANUAL…" offered.
- B3-T-INVOICE: an AVAILABLE read gives "Invoices ↗" on `hosted_url` with `rel="noopener noreferrer"`; no amount is rendered; the other three are not links.
- B3-A-3, B3-M-4.

**Held activation (operator side):**
- B3-T-HELD: `role="alert"`, the title, "The MANUAL subscription was not replaced.", and the release request → CONVERSION payload, then submit.
- B3-T-HELD-2: a viewer sees the hold with no action, and APPLYING reads "Release sent to Stripe — awaiting confirmation:" with the drawer link.
- B3-T-HELD-3: an APPLY_EXPIRED release is shown and a new release can be requested.
- Workbench flag: B3-W-1. Visual: `ccp-tc-sign-held`. Keyboard: JB3-3, JB3-4.

**Conversion flows, including the refused committed row:**
- B3-T-CONVERT;
- B3-T-COMMIT (DR-C2-1: the action is disabled and its reason names `FINANCIAL_TREATMENT_UNDEFINED`);
- B3-T-APPLY-2 (a CONVERSION applies through `/convert`; the server's 409 `apply_failed` `FINANCIAL_TREATMENT_UNDEFINED` is shown in a `role="alert"` with its explanation; `/apply` is never called);
- B3-T-PENDING (a conversion awaiting Stripe reads "sent to Stripe — awaiting confirmation" and never "Applied");
- model tests B3-A-4 and B3-R-1.

**Revoke request:**
- B3-T-REVOKE: a typed confirmation, then ENTITLEMENT_REVOKE `{capabilities: [sign]}`.
- B3-T-GRANT: the revoked provenance, then ENTITLEMENT_GRANT `{core, sign}`.
- Keyboard: JB3-2.

**Apply only via `apply_actionable`:**
- B3-T-APPLY-0: APPROVED with `apply_actionable` false shows no Apply.
- B3-T-APPLY-1: true → `/apply`.
- B3-T-APPLY-2: `/convert`.
- Backend: B3-U-1 and the Pact interaction (conversion requester, `apply_actionable: true`).

**Other flows:**
- Plan change with chain strip and policy: B3-T-PLAN.
- Draft without submit: B3-T-DRAFT.
- Contract-linked cancel: B3-T-CANCEL.
- Open request (Q14): B3-T-OPEN.
- Workbench filters: B3-W-2, B3-M-6, B3-M-7.
- Row navigation: B3-W-3.
- Error state: B3-W-4.
- Payload trace: B3-P-1…3.

## 6. Parity record (PLATFORM-UX-1 §3 method; references from the pinned file)

Settings unchanged: `threshold 0.2`, `maxDiffPixels 25`. Masks are only the typed divergences in `DIVERGENCES.md` (DV-C1, DV-C2, DV-B3-1…9) and the two documented allowances AA-B3-1 and AA-B3-2. Run on `PW_E2E_PORT=4450`.

| State | Persona | Compared | 1440 | 900 | Masks |
|---|---|---|---|---|---|
| `ccp-subs-workbench` | platform_owner | frame | pass | pass | DV-C1, DV-C2, DV-B3-1 (table) |
| `ccp-subs-loading` | platform_owner | frame | pass | pass | DV-C1, DV-C2, DV-B3-9 |
| `ccp-subs-empty` | platform_owner | frame | pass | pass | DV-C1, DV-C2 |
| `ccp-tc-sign-held` (Meridian) | commercial_ops | Sign card | pass | pass | DV-B3-1, DV-B3-2, DV-B3-3 |
| `ccp-tc-sign-stripe` (Northwind) | commercial_ops | Sign card | pass | pass | DV-B3-1, DV-B3-2, DV-B3-4 |
| `ccp-tc-sign-ended` (Brightline) | commercial_ops | Sign card | pass | pass | DV-B3-1, DV-B3-7 |
| `ccp-tc-portal-revoked` (Brightline) | commercial_ops | Portal card header | pass | pass | DV-B3-2; AA-B3-2 |
| `ccp-tc-viewonly` (Atlas) | finance_admin | view-only note | pass | pass | none |
| `ccp-tc-dialog-plan` (Atlas) | commercial_ops | dialog | pass | pass | DV-B3-1, DV-B3-5 |
| `ccp-tc-dialog-cancel` (Atlas) | commercial_ops | dialog | pass | pass | DV-B3-6 |
| `ccp-tc-dialog-revoke` (Atlas) | commercial_ops | dialog | pass | pass | none |
| `ccp-tc-dialog-recon` (Meridian) | commercial_ops | dialog | pass | pass | DV-B3-3; AA-B3-1 |

**Results:**
- Visual: **24 / 24 pass**. In the final run, `ccp-subs-workbench` @1440 and @900 were **flaky**: they failed the first attempt (560 / 566 px) and passed on retry #1. The likely cause is the Plan version select resizing as the catalog read lands.
- axe (B3 states): **12 / 12**. Gate: 0 serious or critical, excluding the documented design-colour debt.
- 900px pass (no page scroll; the table scrolls inside its card): **12 / 12**.
- Keyboard `ccp-subscriptions-journeys`: **4 / 4** (JB3-1 workbench filters and row Enter; JB3-2 revoke with typed confirmation and focus return; JB3-3 the release dialog from the held alert; JB3-4 the drawer link).

**Compared unmasked:**
- the page header and intro, the segment group with counts, the four selects, the checkbox and the "8 of 8" count;
- the empty and skeleton states;
- the card headers, pills and source badges;
- the facts other than the plan name, and the allowance bar;
- the Managed in Stripe box text;
- the release state line;
- the view-only note;
- the dialog titles, fields, before → after rows, chain strips, typed confirmation and footers (Cancel · Save as draft · Submit for approval).

**Not compared** (no design counterpart; unit-, keyboard- and axe-tested): the conversion-to-MANUAL dialog, the grant dialog, Apply / Retry apply, the notices, and the apply-refusal alert.

## 7. Typed divergences (TD-B3-n; visual DV-B3-n in `DIVERGENCES.md`)

| ID | Type | Divergence | Disposition |
|---|---|---|---|
| TD-B3-1 | Backend addition | The two read routes (§4). No route existed for either screen (pre-execution C-1) | Reported |
| TD-B3-2 | Backend change | `apply_actionable` now covers CONVERSION (pre-execution C-2). Without it a conversion requester could never be offered Apply under TD-B2-3. `/convert` was already requester-only | Reported; Pact-verified |
| TD-B3-3 | Gating | The Commercial tab and the workbench need `platform:subscription:read`. catalog_manager (TD-B4-3) and super_admin get no tab; a workbench deep link gets the Commercial access-denied card. No scope was added | Recorded |
| TD-B3-4 | Unpinned action | "Request conversion to MANUAL…" on a Stripe-owned row is not drawn in CCP-UI v1.0. It is built only from pinned elements (the §5.10 dialog, the action button and the reason list), under the PBD B3 prerequisite "C2 for conversion actions" and the brief ("actions only via a governed conversion"). **Not built:** governed → self-service release (`TO_SELF_SERVICE`) from a MANUAL row. It has no design, and its release-expiry term is DR-C2-2 | **Lead / design to confirm** (a design amendment, or keep as built) |
| TD-B3-5 | Data gap | The plan change carries no discount (SUBSCRIPTION_CHANGE has no discount key; DISCOUNT has no governed apply). The design's discount field is the designed disabled state (R-13). Credits on self-service (C4) are not built | Recorded; C4 not delivered |
| TD-B3-6 | Behaviour | Cancel (SUBSCRIPTION_END) does not revoke the entitlement (TD-A6-8, TD-A7-5), so the dialog says so; the design says "revokes". The chain strip shows the server's Finance-only chain (TD-A3-2) where the design shows Finance → Owner | As DV-B4-2 / DV-B4-3 |
| TD-B3-7 | Authority gap | Grant / Revoke for ATS, Portal and Intelligence are disabled with "No governed request covers this product yet.": request product keys are `sign` only (TD-A7-6) | Recorded; needs a product-registry decision (PBD §7.1) |
| TD-B3-8 | TD-C3-1 applied | "Managed in Stripe" link-outs: only "Invoices ↗" links, to the newest invoice's provider-hosted page, and only when the C3 read is AVAILABLE. It never is in production today (C3 NOT DELIVERED; TD-C3-2: platform-admin has no Stripe key), so it shows unlinked. "Payment methods", "Proration" and "Cancellation" are unlinked text: no operator target is ruled. Invoice amounts are never rendered | **Lead ruling still open (TD-C3-1)** |
| TD-B3-9 | B5-R at merge | The program branch moved to `cc7804e9`. B3 never reads `effect_applied_at`. APPLY_EXPIRED is labelled ("Apply expired") wherever B3 names a request state. A release CONVERSION that ended unapplied (APPLY_EXPIRED, REJECTED, EXPIRED, WITHDRAWN) offers a new release (B3-T-HELD-3). APPLY_EXPIRED is not an open state, so it never occupies the open-request strip | Lead merges |
| TD-B3-10 | Display rule | Request references are `CR-<first 8 hex>` (B5's convention), not the design's sequential numbers | As DV-B5-05 |
| TD-B3-11 | Placeholder removal | `CommercialPlaceholderView.tsx` is deleted: Subscriptions was its last route. B1's visibility spec now asserts the workbench. `.pc-soon` in `commercial.css` is left as dead CSS | Recorded |
| TD-B3-12 | Shared component | `CommercialRequestDialog` gains an optional `secondary` action for the design's "Save as draft" (handoff §5.10). It is additive; B2, B5 and B6 call sites are unchanged | Recorded |
| TD-B3-13 | Workbench order / filter source | The server orders rows by tenant name, and the fixture keeps the prototype's order (the design specifies no sort). The Plan version filter lists the catalog's non-draft versions (the design's `verOpts`), and falls back to the versions on the rows if the catalog read fails | Recorded |
| TD-B3-14 | Open request read | The tab reads the open request's detail (`apply_actionable`, lazily expiring per AD-7) for each product with an open request, plus the conversion read for a CONVERSION. That is 4 GETs at most per tab load | Recorded |
| TD-B3-BE-1…3 | Pact detail | The overview interaction contracts `products` as the fixed four-element array (`eachLike` would drop the nullable `subscription` and `open_request`; TD-B1-15). The `applyActionable` unit case lives in `ccp-c2-conversion.spec.ts`. An unrequested 404 interaction was added | Recorded |
| TD-B6-14 | Untouched | B6's client-side open-request filter is unchanged. B3's overview returns the tenant × product open request server-side | For B6 / Lead |

## 8. Tests and gates: run and not run

All counts are exact. The host was shared, so every run used `--maxWorkers=2`.

| Run | Result |
|---|---|
| platform-web unit (full) `vitest run --root apps/platform-web --maxWorkers=2` | **47 / 47 files, 536 / 536 tests**. The B3 files: `subscriptions-model.spec.ts` 20, `SubscriptionsView.spec.tsx` 11, `TenantCommercialPanel.spec.tsx` 30 |
| platform-web lint `nx run aramo-platform-web:lint --skip-nx-cache` | 0 errors. 43 warnings, all `no-non-null-assertion` in spec, test-data and e2e files (B3 spec/test-data files carry 28; no B3 source file has a warning) |
| platform-web build `nx run aramo-platform-web:build --skip-nx-cache` | success |
| typecheck `tsc -p apps/platform-web/tsconfig.app.json`, `tsc -p apps/platform-web/e2e/tsconfig.json` | 0 errors each |
| CCP-B3 parity / axe / 900px / keyboard | §6 |
| platform-admin per-role spec `ccp-b3-subscriptions-authorization.spec.ts` | 12 / 12 |
| platform-admin unit (full) | 23 files, 596 / 596. One earlier run had 1 failure under load, D3-R-5 (404 instead of 403), in a file B3 does not touch; it passed 28 / 28 alone, and then the full run passed |
| `libs/subscription` B3 integration (`ARAMO_RUN_INTEGRATION=1`) | 10 / 10 (run twice) |
| `ccp-c2-conversion.spec.ts` (unit, with B3-U-1) | 7 / 7 |
| A6R-REQ-2 / apply-deadline / A8 integration re-run (they assert `apply_actionable`) | 3 files, 64 / 64 |
| `libs/subscription` unit (full) | 303 passed, 421 skipped (integration without the flag) |
| `nx run-many -t build -p subscription platform-admin --skip-nx-cache` | ok. `CommercialSubscriptionReadService` is in `dist/libs/subscription/src/index.d.ts` |
| `nx run-many -t lint -p subscription platform-admin` | 0 errors |
| Pact consumer `platform-web-consumer` (pact JSON deleted first; all 3 consumer files; serial) | 3 files, 167 tests. **168 interactions** (+9: 1 conversion `apply_actionable`, 1 workbench, 3 overview, 2 super_admin, 2 tenant-tier) |
| Pact provider `verify-platform-admin` (`ARAMO_RUN_PACT_PROVIDER=1`) | **2 / 2** (CCP route coverage gate + verification). **168 / 168 interactions verified** by the platform-admin provider. New state: `a tenant with a governed Sign subscription and a held activation exists` |
| `contract-parity:check` (temporary index) | 708 live routes (706 governed) · 539 OpenAPI ops · 185 transitional-debt · 0 orphan · 0 unclassified. Before B3: 706 / 704 / 537 |
| `openapi:drift-check` | ok (9 files) |
| `redocly lint openapi/platform.yaml` | valid; 2 warnings (= baseline) |
| `orphan-scopes:check`, `error-codes:check`, `tests:integration:check` | ok (no new scope, no new error code, no new integration root) |
| `repo-map:generate` / `repo-map:check` | ok. Run under a temporary `GIT_INDEX_FILE` with intent-to-add for the new paths and the placeholder removed; the real index is untouched |
| `bash scripts/verify-vocabulary.sh` | exit 0: Tier 1, Tier 2 and front-door clean. No exemption touched |

**Not run:**
- The full `ARAMO_RUN_INTEGRATION=1 nx run api`: no apps/api source or returned shape changed, and it is required before the program push (PBD §8).
- The full platform-admin integration suite: targeted only.
- The PLATFORM-UX-1 / other-slice visual states: B3 touches no shared shell file except `TenantDetailView` (a new tab, gated, which super_admin and the PLATFORM-UX-1 personas do not see) and `CommercialRequestDialog` (an additive prop). Re-run at merge.
- `verify-api`, `verify-sign`.

## 9. Recovery and rollback

UI revert (PBD §5.3 B rows): revert B3-6…B3-8. The two read routes and the service are read-only, with no migration and no data, so reverting B3-1…B3-5 is safe. The `applyActionable` change only widens a read hint. B3 writes no commercial data of its own: every write is an A3 / A6 / C2 governed call.

## 10. Vocabulary result

`bash scripts/verify-vocabulary.sh`: exit 0. Tier 1, Tier 2 and front-door retirement are clean. No exemption allowlist was touched.
