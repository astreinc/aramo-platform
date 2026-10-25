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

## CCP-B5 — governance screens vs the CCP-UI v1.0 design file (ccp-b5-parity.spec.ts)

Reference: `doc/design-reference/ccp/CCP-UI-v1_0/Commercial Control Plane v1.0.dc.html` (pinned, `doc/ccp/slices/CCP-B5-pre-execution.md` §5), prototype-only elements stripped (`support/proto-ccp.ts`). 9 states × 1440 / 900.

| ID | Region | Cause |
|---|---|---|
| DV-B5-01 | Comparison clip = the slice-owned content (right of the rail, below the top bar) or the dialog box; dialog states allow 60 px for the rounded corners, which blend with the page behind (B1's chrome and bootstrap banner) | The rail, environment bar, top bar, breadcrumb and bootstrap banner are CCP-B1's (parallel slice); B1's parity record covers them. Unclip at the program merge. |
| DV-B5-02 | Policy table: the two threshold help lines | PO ruling A2-B / TD-A2-2: at or above the threshold escalates. The design says "above … at or below". Same words, reordered. |
| DV-B5-05 | Roster notes: "Finance admin removed {date}"; the pending request's id and summary; the Notes column head | No role-removal history is read (R-13); a request id is a uuid shown as `CR-XXXXXXXX` and its summary is built from the payload; the auto table layout sizes the column from these texts. |
| DV-B5-06 | Audit: the filter row from the first select, and the event table | The rows are the real event stream (create and submit are two events; backend codes; uuids; details read from structured payloads). The selects size to option labels from that stream, and the auto table layout sizes every column from the rows. Compared: the page head and the "Export CSV (16)" count. |

Not a mask: DV-B5-04 — the chain panel renders the maker roles the API returns. The fixture carries the design's maker sets; the API's real sets (above threshold: Commercial ops only; policy change: Finance admin only, TD-A3-5) are proven by `libs/subscription` B5-U-7.
