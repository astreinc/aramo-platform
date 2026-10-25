# PLATFORM-UX-1 H-1 — visual parity: masks and typed divergences

The parity suite (`parity.spec.ts`) compares the build against the design files
(`doc/design-reference/platform-admin/platform/Platform Admin.dc.html`; the template
library and the Studio against `Template Studio.dc.html`, `states-studio.ts`) at
1440×900 and 900×900. A region is masked ONLY for a sanctioned divergence listed
here. The same solid `#FF00FF` rectangle is painted into the reference (at
capture, from the design-file locator, plus 1px of slack) and into the build
(both regions), so a masked region compares equal. Any part of the build region
that falls outside the reference region still fails.

Comparison settings (`playwright.config.ts`): `threshold: 0.2` (pixelmatch
per-pixel YIQ distance) and `maxDiffPixels: 25` per frame. At the time of
writing every unmasked screen-state is pixel-exact under `threshold 0.2`
(`PW_STRICT=1` runs with `maxDiffPixels: 0`).

## Masks

| ID | Divergence | Cause | Screen-states |
|---|---|---|---|
| DV-01 | Onboarding funnel: no slug line under the tenant name, so the rows are shorter (masked to the bottom of the column) | Data gap: the dashboard DTO's onboarding row carries no slug (directive R-13; B-1b adds slug to list and detail only) | dashboard-loaded, dashboard-panel-error, shell-rail-collapsed, shell-account-menu, shell-cmdk |
| DV-02 | Identity shows the session `sub` and tenant id (env bar, rail footer, avatar, the "Signed in as" and "Organization" rows on access denied) | Directive R-6: the designed fallback while `/platform/me` is not called or is refused | denied-console |
| DV-03 | Read-only persona role label ("Read only auditor" vs the design's "Read-only auditor") | Data: no read-only platform role exists in the identity role catalog; the label is the fixture key's sentence case (`identity.tsx roleKeyLabel`) | denied-page, tenants-list-viewonly, tenant-overview-viewonly, skill-viewonly, matching-viewonly |
| DV-05 | Domain claim "Since" value is "—" | Data gap: the domain response has no claim date (directive R-13). The row is kept with the designed empty value | tenant-domain, tenant-domain-exception |
| DV-06 | Tenant role chips: the real role catalog is longer than the design's seven sample roles, so the invite card is taller | Real values win (`tenant-roles.ts`, the identity role catalog) | tenant-people |
| DV-07 | Mono reason code `owner_first_session` vs the design's `owner_first_sign_in` | Real code (backend activation source) | tenant-lifecycle |
| DV-08 | Billing events show the raw event code in mono under the label, so the rows are taller and the columns re-flow | Builder brief hard rule ("human labels, raw code secondary in mono"); lead to confirm | tenant-sign |
| DV-09 | Overview "Capabilities": human labels ("Core, ATS, Portal") vs the design's raw keys ("core, ats, portal") | Builder brief hard rule (human labels); lead to confirm | tenant-overview, tenant-overview-provisioned, tenant-overview-viewonly, tenant-lifecycle-menu, dialog-suspend, dialog-offboard, dialog-reactivate, dialog-close |
| DV-11 | Sign Personal drawer: the phone fact reads "Verified · Phone step done" (real `phone_verified_at` / `step_up_*` fields); signal labels are the real signal keys' labels | Real values win (`personal-review-model.ts`) | personal-drawer, personal-drawer-reports, personal-action-dialog |
| DV-12 | Matching role families: the real `ROLE_FAMILIES` replace the design's nine sample families; the auto table layout re-flows every column with them | Real values win (`matching-policy-api.ts`) | matching, matching-edit, matching-viewonly, matching-activate-dialog |
| DV-13 | Skills: real alias types, version status (Active / Inactive, no status on add), relationship sources and add-form selects; the registry drops the Aliases column, searches names only, and lists skills in server order (by canonical name) | Directive R-9; `skill.repository` orders by `canonical_name` | skill-aliases, skill-versions, skill-relationships, skills-registry, skills-registry-inactive, skills-proposals, skills-proposal-relationship, skills-proposal-409 |
| DV-14 | Dashboard first load: no "Refreshed HH:MM UTC" yet | Data: no refresh has completed during the first load | dashboard-skeleton |
| DV-15 | Skill review queue: "First seen" dropped; rows are counts-only (no source domain under All), so the columns re-flow | Directive R-9; the queue DTO is counts-only | skills-review-queue |
| DV-16 | Proposals: no evidence line (the proposal DTO has none); the breadcrumb ends in the proposal | Data gap (R-13); directive §6 F-2 ("breadcrumb ends in the entity name") | skills-proposals, skills-proposal-relationship, skills-proposal-409 |
| DV-17 | Merge dialog consequence copy | The real merge is a soft merge (`skill-registry.service.ts`: the loser goes inactive and points at the winner; aliases, versions and relationships are not moved), so the design's "move to the winner" would be untrue | skill-merge-dialog |
| DV-18 | Activate dialog consequence copy reworded | Directive R-18: the design's word is banned by `scripts/verify-vocabulary.sh` (`TIER2_TERMS_REGEX`) | matching-activate-dialog |
| DV-20 | Rail icons for Tenants, Review queue and Platform admins: Template Studio.dc.html draws them in an older style; the shell rail is Platform Admin.dc.html's (one rail for the whole console) | The two design files disagree; the console shell (Platform Admin.dc.html §3.3) wins. Lead to confirm | every lib-* and studio-* state |
| DV-21 | Library top bar: the console top bar (crumb weight 500, the ⌘K search beside the PLATFORM marker) where the Studio file's library header has a plain crumb link and no search | Handoff §3.4 (⌘K on every console page); `/document-templates` is a console route (R-12). Lead to confirm | lib, lib-filtered, lib-empty, lib-viewonly, lib-create, lib-create-copy |
| DV-22 | Library Draft column: no block count under "Open draft" / "No draft" (at 900px the shorter cells re-flow the auto table layout, so the table is masked to the bottom) | Data gap: the list DTO carries no content (R-13; known F-9 divergence) | lib, lib-filtered, lib-create, lib-create-copy |
| DV-23 | Reader persona identity and rail: the Studio file keeps the operator's identity and lists every page for its `reader` persona; the build shows the auditor's own identity fallback and the rail filtered by permission | Prototype simplification vs directive R-6 / handoff §3.3 | lib-viewonly, studio-viewonly |
| DV-24 | Library view-only note: the build shows the ViewOnlyNote above the filters (the table moves down) | Handoff §16.3 ("an auditor sees view-only notes"); the Studio file's library has none | lib-viewonly |
| DV-25 | Sections tab: the designed empty state ("No sections yet…") instead of the section library | Data gap: no shared section library (R-13; known F-9 divergence) | studio-sections |
| DV-26 | Read-only renders (version view, `:read` preview) draw variables as the shared SafeDoc label chips, not the `{{key}}` chip text, so the document body re-flows | `libs/document-templates-web` SafeDoc is the only allowed HTML renderer (R-11); its exports stay byte-compatible (known F-9 divergence) | studio-version-view, studio-viewonly |
| DV-27 | Preview footer: "Draft · vN" (the draft version number) instead of "Draft · rev N" (a session save counter) | The server has no save revision; the version number is the stable id (known F-9 divergence) | studio-preview, studio-preview-plain, studio-preview-zoom |
| DV-28 | Preview "Long values" sample set is disabled | Data gap: the server has one sample set (R-13; known F-9 divergence) | studio-preview, studio-preview-plain, studio-preview-zoom, studio-viewonly |
| DV-29 | Pending-withdrawal bar: no reason after "Takes effect …" | Data gap: the template DTO carries no withdrawal reason (known F-9 divergence) | studio-withdrawal-pending |
| DV-30 | `:read` Studio panels describe the PUBLISHED version (outline, variable usage, checks, readiness pill) and the preview page header has no organization sample; the design file's describe the draft | Directive R-13 (`:read` sees the published version only; no sample render for `:read`) | studio-viewonly |
| DV-31 | Unhighlighted preview: each sample value is its own span (shared SafeDoc), so the line's text is shaped per run (sub-pixel glyph differences, no layout shift) where the design file renders one text run | R-11 (SafeDoc is the only renderer; byte-compatible exports) | studio-preview-plain |
| DV-B4-1 | CCP-B4 Contracts: the amendments timeline is masked to the bottom of the detail column | Record model: a migrated contract's recording IS its migration and amendments are titled "Amendment n"; the prototype's sample history (a legacy "Contract recorded" before the migration, free-form titles such as "Portal added") is prototype data (CCP-UI v1.0 `ccp-data.js` C0). The ended-contract state (`ccp-contracts-ended`) compares the timeline unmasked | ccp-contracts-ops, ccp-contracts-view-only |
| DV-B4-2 | CCP-B4 dialogs: the approval-chain strip reads "Below threshold · Finance · chain fixed by the active policy" | The server resolves SUBSCRIPTION_CHANGE / _END to the Finance-only chain (PO ruling TD-A3-2); the design draws Finance → Owner for contract amend / end (TD-B4-2, needs PO confirmation). The policy version is not readable by any B4 route | ccp-contracts-amend-dialog, ccp-contracts-end-dialog |
| DV-B4-3 | CCP-B4 End contract: the sub line and the second Before → after row say the MANUAL subscription ends and the entitlement is NOT revoked | A6 `SUBSCRIPTION_END` does not revoke (governed revoke is CCP-A7; TD-A6-8), so the design's "revokes the Sign entitlement" would be untrue (TD-B4-5) | ccp-contracts-end-dialog |

CCP-B4 page states are compared on the FULL viewport since the merge train (TD-MERGE-19: CCP-B1's shell is present; B1's DV-C1 rail and DV-C2 ⌘K masks apply, as in the B1 states); dialog states stay cropped to the dialog box. Images: `__screenshots__/ccp-contracts-*-{1440,900}.png`, captured from the pinned CCP-UI v1.0 file by `ccp-contracts.spec.ts` with `PW_CAPTURE_REFERENCE=1`.

## CCP-B1 — Commercial screens (Commercial Control Plane v1.0.dc.html, CCP-UI v1.0)

The CCP states (`states-ccp.ts`) compare the build against the pinned CCP design
file (`doc/design-reference/ccp/CCP-UI-v1_0/Commercial Control Plane v1.0.dc.html`,
`MANIFEST.sha256` 5/5 OK; pinned in `doc/ccp/slices/CCP-B1-pre-execution.md`),
loaded by `support/proto-ccp.ts openCcpProto`. Prototype-only elements are stripped
before render (handoff "Don't build"): the "PROTOTYPE — NOT AUTHORIZED FOR BUILD"
chip, the Prototype rail group, the ↗ link-out marks and the rail NEW tag, and the
retired pilot policy v0 with every request created under it. The build runs on
`fixtures/commercial.ts` at the prototype's clock (2026-10-24 14:00 UTC). The
element-level state `ccp-rail-group` compares the Commercial group alone.

| ID | Divergence | Cause | Screen-states |
|---|---|---|---|
| DV-C1 | The rail: the build keeps the Dashboard item for commercial roles and draws the console's own rail glyphs, so every item below Operations shifts (the Commercial group itself is compared element-level: `ccp-rail-group`, unmasked) | Pre-execution C-2: the Dashboard item keeps its `platform:tenant:read` gate (the six roles hold it); hiding it is the handoff §2 "assumption", for the PO. Glyphs: the console shell's (as DV-20) | every ccp-* frame state |
| DV-C2 | The ⌘K trigger keeps the console placeholder ("Tenants, skills, templates") | ⌘K request results are not in the B1 brief (pre-execution C-8) | ccp-approvals, ccp-approvals-pending, ccp-approvals-empty, ccp-approvals-history-empty, ccp-approvals-loading, ccp-approvals-bootstrap, ccp-denied-super-admin |
| DV-C3 | Inbox table (masked whole: the auto layout sizes every column, head included, from the rows) and the request reference: the A3 DTO carries a UUID (shown short in the table, full in the drawer, which moves the state pill), the requester's id, the policy version id and payload-derived summaries, not the prototype's sample rows | Real values win (A3 `CommercialChangeRequestDto`); data gaps R-13 | ccp-approvals, ccp-approvals-pending, ccp-approvals-bootstrap, ccp-drawer, ccp-dialog-reject |
| DV-C4 | Drawer facts "Requested by" (no name or roles: ids only) and "Policy" (no version number: the version id, plus the window length) | Data gap: the A3 routes carry user ids and `policy_version_id` only (R-13) | ccp-drawer, ccp-dialog-reject |
| DV-C5 | Drawer from the effect down: the request carries the after side only (before = "—"), no evidence field, no per-admin roster ("Who can sign" shows its designed empty line), no apply panel (A6 not delivered); every section below the effect shifts | Data gaps (R-13); pre-execution C-7, C-8 | ccp-drawer, ccp-dialog-reject |
| DV-C6 | Access denied: the card keeps R-5's **Missing** row and **Sign out**, and offers **Back to dashboard** (the design: no Missing row, no Sign out, "Back to tenants") | PLATFORM-UX-1 R-5, bound by Amendment A1-4, outranks the design file (handoff order of authority) | ccp-denied-super-admin |
| DV-C7 | The reject dialog is the platform ConfirmDialog with the from → to Change box (the lead's brief), so it is taller and centres lower than the design's plain dialog; the dialog box is masked whole, its copy and controls are asserted by the unit and keyboard suites. The Approve confirmation has no design counterpart (the design approves on click) and has no visual state | Lead brief (approve and reject on ConfirmDialog with from → to + consequence); pre-execution C-5 | ccp-dialog-reject |
| DV-C8 | Bootstrap banner: no "View chains" link (its target is B5's Platform admins page); the chains come from the loaded pending requests' `chain_satisfiable` and from 409 responses, so the fixture adds the pending policy activation the design's banner names (All pending 7 vs 6, the count badge masked) | The A3 routes expose no roster-wide chain fulfillability (R-13); B5 owns the page | ccp-approvals-bootstrap |

Not compared (no design counterpart, unit- and keyboard-tested): the Approve
confirmation dialog; the five placeholder pages (Subscriptions, Catalog, Contracts,
Policy, Audit), whose designed disabled state replaces screens later slices build;
the commercial-role access-denied variant ("Your roles don't include access to
this page.").

DV-03 note (CCP-B1): `identity.tsx` now labels the six commercial role keys with the
handoff §3 labels, so the auditor persona's role reads "Read-only auditor", as the
design does. The DV-03 masks are kept (harmless) until the lead re-baselines.

## CCP-B6 — Support extensions (Commercial Control Plane v1.0.dc.html, CCP-UI v1.0)

The B6 states (`states-ccp-support.ts`) compare the build against the pinned CCP design
file (`doc/design-reference/ccp/CCP-UI-v1_0/`, `MANIFEST.sha256` 5/5 OK; pinned in
`doc/ccp/slices/CCP-B6-pre-execution.md`), loaded by `support/proto-ccp.ts openCcpProto`
(adopted byte-identical from CCP-B1). B1 owns the shell and the rail, which are not in
B6's base, so every B6 state is ELEMENT-level: the support extension dialog (in bounds
and escalated), the exception overlay card and the view-only note. An element state's
design-file mask regions are stored relative to the element and re-anchored on the build
element (`capture-reference.spec.ts`, `parity.spec.ts`; no change for frame states). The
build runs on `fixtures/ccp-support.ts` at the prototype's clock (2026-10-24 14:00 UTC).

| ID | Divergence | Cause | Screen-states |
|---|---|---|---|
| DV-B6-1 | The workflow is a routed view (`/commercial/support-extensions?tenant=`) built from the pinned Tenant › Commercial elements, not the Commercial tab itself; the page frame (header, tenant select, earlier-extensions table) has no design counterpart and is not compared | Lead brief: B3 owns the tab and B1 the shell; pre-execution C-1 | (frame not compared) |
| DV-B6-2 | The clause help line and the preview's "Policy clause" line drop "§4.2" ("Policy v1: up to 14 days, …"); the overlay's clause names policy v1, not the retired pilot v0 | The commercial policy document has no section numbers (A2 format 1); v0 is "Don't build" | ccp-sx-dialog-in-bounds, ccp-sx-dialog-escalates, ccp-sx-overlay |
| DV-B6-3 | The overlay reference is the A8 overlay row id, shown `EXT-<first 8 hex>`, not the prototype's `EXT-0042` | Real values win (A8 `SupportExtension.id` is a UUID) | ccp-sx-overlay |

Not compared (no design counterpart; unit-, keyboard- and axe-tested): the removal dialog
(TD-B6-4), the Apply button on the open-request strip (TD-B2-3), the escalation notice, the
"Choose a tenant" empty state and the earlier-extensions table.

| ID | State | Allowance | Measured | Evidence |
|---|---|---|---|---|
| AA-B6-1 | `ccp-sx-dialog-escalates` | 320 px | 293 (900), 293 (1440) | diff = the two field captions' glyphs, 1px apart; every box (dialog top 194.078, captions 83.250 / 177.250, inputs, preview) measured identical in both DOMs |

## States asserted on copy, not pixels

| ID | States | Cause |
|---|---|---|
| DV-04 | signin, signin-session-ended, signin-provider-error, signin-wrong-account, signed-out | Directive R-16 / R-17 and the brief's frozen areas: the shared `SignInPage` / `AuthShell` (AUTH-SIGNIN-1) may not be edited, and the platform copy reaches it only through `errorCopy`. The design file's "shared" panel is an approximation of that shared screen, about 10% of pixels apart. The reference images are still captured; the test asserts the designed copy. `TENANT_ACCESS_DENIED` keeps the shared wrong-account screen (F-2 report). |

## Method notes (not masks)

| ID | Note |
|---|---|
| DV-10 | Dialog states are captured unfocused (`blur: true`, both sides). On open the build moves focus to the first field (WCAG 2.4.3); the design file models no focus. The keyboard suite asserts the focus behaviour itself. |
| DV-19 | Sub-threshold only: the design file's buttons and inputs that set no colour render the browser default `#000`; the build uses ink `#18212B`. Absorbed by `threshold 0.2`; visible at `threshold 0.02`. Lead to confirm that ink is intended. |
| — | Every image is taken at the top of the page with the pointer parked in the bottom-right corner (no hover), on both sides. |
| — | The design file is served from disk through `page.route` on `http://proto.test/` rather than `file://`: its runtime fetches its own source, which Chromium refuses on `file://` (the onboarding funnel and the rail icons then never render). |
| — | Prototype-only elements are removed through the file's own switches before render: `showAnnotations=false`, the Handoff nav group dropped from `NAV`, and the account menu's "Components & open questions" item hidden. |
| — | Template Studio.dc.html (library + Studio, `support/proto.ts openStudioProto`): `showAnnotations=false`; the Handoff nav group dropped from `NAVS`; the dashed "NEEDS BACKEND" tags on the slash menu's disabled items (not gated by `showAnnotations`) hidden (R-13: never built). Every Studio state starts from the save state the file shows when a template is opened from the library (`openStudio()`: "Saved · —", rev 1), not its seeded "Saved · 14:52:08". |
| — | Both sides load every web-font face and unicode subset before an image is taken (`support/fonts.ts`): `document.fonts.ready` alone can resolve before a late weight has loaded. The reference capture shoots until two consecutive frames are identical (as toHaveScreenshot does). |
| — | The panel toggles at the ends of the formatting toolbar, and the Compare dialog's "Changes only" box, are activated with a dispatched click: a real click first scrolls the overflowing toolbar / the dialog, which the design file's state does not. The keyboard suite activates them with the keyboard. |
| — | Studio fixtures (`fixtures/templates.ts`) port the file's VARS, DOC_TYPES and TPLS0 (with its draft / v3 / v2 / v1 content) into the real DTOs; the preview fixture renders samples as the server does (`htmlWithSamples`: an unknown key is an empty `data-sample` span). |

## Accessibility conflicts (design vs WCAG) — Lead ruling 2026-10-24

**Ruling:** the LOCKED design wins for this program (PO: 100% pixel parity). The
two rules below come only from the design file's own values; fixing them changes
the pixels this suite locks (directive §3 vs §7). `e2e/a11y/axe.spec.ts` reports
them as known design debt without failing; every other rule must pass.
`PW_A11Y_DESIGN_CONFLICTS=strict` makes them fail. A contrast-safe token revision is
requested from Claude Design (design amendment 2); on landing, re-baseline and run
strict. The PO may overrule this at Gate 5.

- `color-contrast`: the faint ink `#93A0A8` (table headers, the ⌘K placeholder and
  key, mono codes, relative dates), the muted and info pill pairs, the sign-in
  eyebrow and footer (frozen `SignInPage`). It appears on 66 of 66 axed states.
- `link-in-text-block`: colour-only inline links (the dashboard activity rows,
  the sign-in wrong-account line). It appears on 5 states.

`PW_A11Y_DESIGN_CONFLICTS=allow` reports these two rules without failing; every
other serious or critical finding still fails, and there are none.

## Anti-aliasing allowances (directive §3: rasterisation only, no layout shift)

Lead ruling 2026-10-24. The visual project retries a failed comparison up to twice
(random glyph noise under machine load clears; a real difference fails all three).
A state whose text rasterises differently on every run carries a per-state
`aaAllowance`; the diff image must show glyph-edge pixels only.

| ID | State | Allowance | Measured | Evidence |
|---|---|---|---|---|
| AA-01 | `studio-withdraw-dialog` | 160 px | 116 (900), 134 (1440) | diff = dialog title, field labels and live line glyph edges; boxes and positions identical |
| AA-B2-01 | `ccp-catalog-publish-dialog`, `ccp-catalog-retire-dialog` (CCP-B2) | 300 px | 202 / 131 (publish-dialog 1440, two runs); 0 (retire-dialog, both viewports, `PW_STRICT=1`) | diff = dialog title, field labels, diff-row and chain-strip glyph edges; boxes and positions identical |

## CCP-B2 — Catalog (`states-ccp-catalog.ts`) against the CCP-UI v1.0 release

Reference: `doc/design-reference/ccp/CCP-UI-v1_0/Commercial Control Plane v1.0.dc.html`
(byte copy of the pinned release; `e2e/support/proto-ccp.ts` re-verifies every served file against
its `MANIFEST.sha256`; merge train TD-MERGE-5 folded the byte-identical B2 copy and opener into
B1's). Seven screen-states × 1440 / 900 = 14 comparisons: draft (catalog
manager), view only (platform owner), published, retired (grandfathered), no plans (ATS), the
publish dialog and the retire dialog. Under `PW_STRICT=1` (0 px) 9 of 14 are pixel-exact; the rest
differ by 2–202 glyph-edge pixels.

| ID | Divergence | Cause | Screen-states |
|---|---|---|---|
| DV-B2-01 | The rail (with the Commercial group), the breadcrumb ("Commercial / Catalog"), the environment bar's CCP context line ("commercial changes need approval from other people"), the ⌘K placeholder ("Tenants, requests, pages"), and at 900px the identity text the longer context line truncates | **Pending CCP-B1** (built in parallel): the shell, rail, crumbs and ⌘K belong to B1's Commercial rail group; B2 does not edit the shell. **The lead removes these masks at the B1 + B2 merge and re-captures** | **CLOSED at the merge train (TD-MERGE-19):** the B1 shell is present; the breadcrumb, the environment bar's CCP context line and the 900px identity text are now compared full-page. Only B1's own DV-C1 (rail) and DV-C2 (⌘K placeholder) masks remain, as in the B1 states; references re-captured from the pinned file. |
| DV-B2-02 | No "SAMPLE NAMES AND PRICES" tag on the plans card and no "· SAMPLE" on the Aramo Sign product card | The build shows the real catalog; "SAMPLE" marks the prototype's mock prices (handoff "Mock data only in the prototype"). Lead to confirm | every ccp-catalog state |
| DV-B2-03 | Seats: an empty disabled field (tooltip "Not part of the Aramo Sign plan model…") and "—" → "—" in the diff, where the design shows seat counts | Data gap (R-13): the Sign plan model has no seat term (only `sign.envelopes`, `sign.forms`, `sign.templates`, `sign.storage_bytes`); no term is invented | draft, view only, published, retired, publish dialog, retire dialog |
| DV-B2-04 | The open-request line names the change request by its short UUID ("cca1000…") where the design shows "CR-1044"; the id's width moves the rest of the line, so the line's text is masked (the box is not) | Real ids are UUIDs (CCP-A3); the human request number is not in the contract | draft, view only |
| DV-B2-05 (fixture note, no mask) | The fixture reproduces the prototype's data, including two PUBLISHED versions of Starter and of Team at once | The A5 store admits one PUBLISHED version per plan (publishing retires the previous one), so the API never returns that state; the renderer is data-driven and the unit specs cover the real states | draft, view only, published, publish dialog, retire dialog |

Not pixel-compared: the catalog's loading skeleton (the CCP file draws no catalog loading state;
the build uses the PLATFORM-UX-1 `SkeletonPanel`, handoff §10 item 11 — covered by the unit spec)
and the in-shell access-denied state for super_admin (since the merge train it is CCP-B1's commercial
card, compared in B1's states and asserted by the B2-W-ROLE unit test).

## CCP-B5 — governance screens vs the CCP-UI v1.0 design file (ccp-b5-parity.spec.ts)

Reference: `doc/design-reference/ccp/CCP-UI-v1_0/Commercial Control Plane v1.0.dc.html` (pinned, `doc/ccp/slices/CCP-B5-pre-execution.md` §5), prototype-only elements stripped (`support/proto-ccp.ts`). 9 states × 1440 / 900.

| ID | Region | Cause |
|---|---|---|
| DV-B5-01 | Comparison clip = the slice-owned content (right of the rail, below the top bar) or the dialog box; dialog states allow 60 px for the rounded corners, which blend with the page behind (B1's chrome and bootstrap banner) | The rail, environment bar, top bar, breadcrumb and bootstrap banner are CCP-B1's (parallel slice); B1's parity record covers them. Unclip at the program merge. Merge train (TD-MERGE-19): a full-page trial with B1's DV-C1 / DV-C2 shell masks passed for the three policy states but not for Audit (53 px on the Export CSV glyph, every attempt) or Platform admins (the environment bar's CCP context line is not shown on /admins in the build; 571 / 1301 / 1412 px), so the content crop is KEPT for every B5 state. |
| DV-B5-02 | Policy table: the two threshold help lines | PO ruling A2-B / TD-A2-2: at or above the threshold escalates. The design says "above … at or below". Same words, reordered. |
| DV-B5-05 | Roster notes: "Finance admin removed {date}"; the pending request's id and summary; the Notes column head | No role-removal history is read (R-13); a request id is a uuid shown as `CR-XXXXXXXX` and its summary is built from the payload; the auto table layout sizes the column from these texts. |
| DV-B5-06 | Audit: the filter row from the first select, and the event table | The rows are the real event stream (create and submit are two events; backend codes; uuids; details read from structured payloads). The selects size to option labels from that stream, and the auto table layout sizes every column from the rows. Compared: the page head and the "Export CSV (16)" count. |

Not a mask: DV-B5-04 — the chain panel renders the maker roles the API returns. The fixture carries the design's maker sets; the API's real sets (above threshold: Commercial ops only; policy change: Finance admin only, TD-A3-5) are proven by `libs/subscription` B5-U-7.
