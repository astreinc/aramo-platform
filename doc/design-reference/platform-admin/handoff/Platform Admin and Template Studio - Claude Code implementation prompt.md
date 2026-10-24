# Claude Code — Implementation prompt: Aramo Platform Admin console + Template Studio

You are implementing **admin.aramo.ai** (the Aramo Platform Admin console) and its **Template Studio**. Build them in the existing Aramo frontend codebase from an approved high-fidelity design.

## 0. Inputs (read these first, in this order)
The design project zip has been extracted to its canonical location in this repo. Paths below are relative to that project root:
```
handoff/Platform Admin and Template Studio - Claude Code handoff.md
handoff/Platform Admin and Template Studio - Claude Code implementation prompt.md   (this file)
platform/Platform Admin.dc.html
platform/Template Studio.dc.html
platform/support.js
assets/aramo-mark-white.svg
```
1. `handoff/Platform Admin and Template Studio - Claude Code handoff.md`: **the spec**. Its section numbers (§1–§16) are referenced below. Follow its *Don't build these prototype-only items* list and report *Data gaps* in each PR. It covers layout, tokens, copy, states, permissions, the component map, the API calls and the NEEDS BACKEND list. When it conflicts with your assumptions, it wins.
2. `platform/Platform Admin.dc.html` and `platform/Template Studio.dc.html`: **interactive design references**. Open them in a browser with `support.js` alongside, and click through every journey. Read the markup for exact values: inline styles hold the real px, hex, weights and copy. The logic class at the bottom of each file shows the intended state shape, the derived values and the edge cases.
   - Tweaks in the files: `persona`, `demoState`, `showAnnotations`, `signinVariant`, `startScreen`.
   - Deep links: `#tenants`, `#signedout`, `#library`, `#<templateId>`.
3. The existing codebase: the shared Aramo frontend foundation (primitives, AppShell, DataTable, StatusPill, Dialog, etc.), the current admin app, its API client, routing, auth/session and lint rules.

**Do not ship the HTML.** It is a design reference, not production code. Recreate it with the codebase's own patterns. Don't copy `support.js`, `React.createElement` hacks or inline-style soup into the app.

## 1. Hard rules
- **Use foundation components only.** Raw `<button> <input> <select> <textarea> <dialog>` are lint-banned. Map every element using the README *Component map*. Where it says **NEW**, build a reusable component in the shared foundation (or the admin app's `components/` if the foundation is out of scope). Give it typed props, stories or tests, and no one-off styling.
- **Locked visual language.**
  - Midnight `#0B1022` chrome and the terracotta `#D97757` privilege accent, always with midnight text on terracotta fills.
  - Hanken Grotesk for UI and IBM Plex Mono for IDs, keys, codes and timestamps, with tabular numerals.
  - Canvas `#F4F6FA`; cards 13px radius with a 1px `#E5E9ED` border.
  - Never use the retired Platform Violet `#5b3fa0`.
  - Use the tokens in README §Design tokens and add any missing ones to the token layer; don't hard-code hex values in components.
- **Rail = theme, not fork.** Add a `midnight` theme to the shared `AramoRail` using the tokens in README §Rail. Tenant apps stay blue.
- **Gate every action by permission** (README permission table), even though `super_admin` has all 10 today.
  - No read permission: hide the nav entry.
  - Read only: show the view-only note, never silently hidden buttons.
  - Access denied renders **inside the shell**, with the signed-in identity, the missing permission and "Sign in with a different account". No redirect loops.
- **Ground it in the real API.**
  - Use only the endpoints that exist (README §API contract used). Read the API client and DTOs before building each screen.
  - Anything marked **NEEDS BACKEND** must render as the designed placeholder or disabled state, never as working functionality.
  - Do not invent endpoints, and do not change backend contracts or domain authority.
- **Copy is part of the spec.**
  - Use the exact strings from the HTML.
  - Show human labels for every enum, event type and reason code, with the raw code secondary in mono.
  - Never show "TBD", ticket names or internal notes.
  - No wording that grades a tenant or a person.
  - Run the repo's controlled-vocabulary check.
- **No health or rating metrics anywhere.** The dashboard shows counts, ages, statuses and events only.
- **Accessibility, WCAG 2.2 AA.**
  - One `main` and a skip link.
  - `aria-current` on nav items; `aria-sort` on sortable headers.
  - Dialogs and drawers trap focus, close on Esc and return focus to the opener.
  - `role="status"` / `role="alert"` for feedback.
  - Visible focus.
  - Colour is never the only cue.
  - Respect reduced motion.
- **Responsive.** Design for 1280–1600px; it must work down to 900px. The page never scrolls sideways; tables scroll inside their card. Follow the Studio panel breakpoints in README §Studio layout.

## 2. Before writing code
1. Inventory the codebase:
   - the foundation components available and their props;
   - the admin app's routes, the session object and the permissions source;
   - the API client functions and DTOs for tenants, dashboard, audit, sign, domain, personal-review, personal-invites, platform admins, skills, document templates, template variables and matching policy.
2. Write `docs/platform-admin-implementation-plan.md` containing:
   - **Component map, confirmed.** For each README row, the actual component and file path, or NEW with its proposed location and props.
   - **Endpoint map.** For each screen and action, the client function, the request and response DTO, and the error codes, mapped to the README's plain copy.
   - **Gaps.** Every place the real API differs from the README, plus every NEEDS BACKEND item and how it degrades.
   - **Routes.** `/` dashboard, `/tenants`, `/tenants/new`, `/tenants/:id?tab=`, `/personal-review`, `/personal-invites`, `/skills`, `/skills/:id`, `/skills/review-queue`, `/skills/proposals`, `/matching`, `/document-templates`, `/document-templates/:id`, `/template-variables`, `/admins`, `/access-denied` (in-shell), and the auth routes. Adapt the names to the existing routing conventions.
3. **Stop and show me the plan** if any README item conflicts with the real API or the foundation. Otherwise proceed.

## 3. Build order (one PR-sized milestone each; keep `main` green)
1. **Tokens and foundation additions.**
   - Midnight rail theme.
   - StatusPill `muted` tone.
   - NEW components: EnvironmentBar, FilterBar (segmented with counts), ReadOnlyNote (InlineAlert info), Skeleton, EmptyState, ConfirmDialog (from → to, consequence, tones primary / privileged / danger), TypedConfirm, Timeline, DetailDrawer, DiffView, TagInput, Stepper, OneTimeSecret.
   - Unit tests and stories for each.
2. **Shell.**
   - AppShell with the midnight rail and NAV groups filtered by permission.
   - Collapse via button and ⌘/Ctrl+\, persisted, auto-collapsing under 900px.
   - TopBar: breadcrumb ending in the entity name, PLATFORM marker, ⌘K palette with grouped results, account menu with "Sign in with a different account".
   - Environment bar showing email, tenant and role, falling back to the session id and tenant id until name and email exist (NEEDS BACKEND).
   - In-shell access denied.
   - Sign-in `?error=` states (`wrong_account`, `session_expired`, `provider_error`) and the signed-out page. The midnight sign-in panel variant goes behind a flag labelled NEEDS RULING, off by default.
3. **Dashboard.** Clickable status tiles go to a filtered list. The onboarding funnel has resend/send invite. Recent activity uses human labels. Errors are per panel; add "Refreshed at" and Refresh.
4. **Tenants list and provision.**
   - List: client-side sort and filters, a paging-ready table, and muted closed/offboarding rows. Show the Kind column using the README's NEEDS BACKEND treatment if the DTO lacks it.
   - Provision: a three-step stepper with the "What will happen" panel, slug preview and capability rules (Personal locks to core + sign; sourcing reserved). Map all errors to plain copy. On success, route to the tenant detail and show a toast.
5. **Tenant detail.**
   - Header, and a lifecycle menu limited to the transitions allowed from the current status.
   - Tabs: Overview · Lifecycle & audit (Timeline) · Aramo Sign (read-only, correct source labels including FREE, unsubscribed state instead of "—") · Domain (claim card, countdown, promote / release / grant / revoke) · People (invite plus a members placeholder).
   - Lifecycle dialogs with per-action fields and the proposed reason-code lists, kept in one config file and marked as a product decision. Handle `illegal_transition` and "already in status".
6. **Sign Personal.** Review queue with filters, sort and DetailDrawer: signals presented as evidence; reports that stay viewable when an account is closed; actions by state with reason, until and confirm. Pilot invites with OneTimeSecret.
7. **Skills.** Registry and detail: aliases, versions, relationships, merge, override, deactivate. The review queue uses cursor "Load more". Proposals use DiffView, accept/reject and 409 handling.
8. **Matching policy.** Active table, edit as new version (draft), history, and the activate dialog with the impact diff.
9. **Template variables and Platform admins.** Key immutable after create, with its pattern validation. Admin invites use TypedConfirm. List placeholders are NEEDS BACKEND.
10. **Template Studio** (largest milestone; see §4).
11. **Hardening.** Accessibility pass (axe plus a keyboard-only walkthrough of every journey), the 900px responsive pass, the vocabulary check, and loading, empty, error and read-only states on every screen.

## 4. Template Studio — specifics
- **Routes.** The library at `/document-templates`: row click and "Create default template" both open `/document-templates/:id`. The left nav highlights **Document templates** in the library and in the Studio; there is no separate Studio nav item.
- **Editor model.**
  - Keep an ordered `Block[]` (`{ id, type: 'p'|'h2'|'ul'|'ol', content }`), with variable nodes inline.
  - Use the codebase's rich-text library if one exists (e.g. TipTap/ProseMirror, Lexical or Slate). Configure its schema to **exactly** the allowed set: paragraph, heading level 2, bold, italic, underline, bullet and ordered lists, hard break, and an atomic `variable` node.
  - Don't use `document.execCommand` (the prototype does; production must not).
  - Serialise to the HTML subset the draft API accepts, with `{{key}}` for variables, and parse back the same way. Add round-trip tests.
- **Must-have interactions.**
  - Block drag handles and "+" in the margin; the block menu (turn into, duplicate, move, delete).
  - Drag to reorder in the canvas and in the Outline.
  - Drag sections and variables onto the page.
  - `/` slash menu; `{{` variable autocomplete at the caret.
  - Floating selection toolbar and contextual toolbar active states.
  - Enter splits a block; Backspace removes an empty block; ⌥↑/⌥↓ moves a block.
  - Paste sanitised to the allowed set.
  - The shortcuts sheet (`?`).
- **Variables.** Chips are atomic, and their tooltip shows the label and sample. Visual states: known, inactive and unknown. Load the library from the template-variables API, with search, group filters, usage counts and insert at the caret.
- **Workflow.**
  - Save draft goes through the existing endpoint. Autosave fires 3 seconds after the last edit, debounced, with "Saved / Autosaved / Unsaved / Saving" status.
  - Preview calls the existing preview endpoint with sample values, saving first if there are unsaved edits. It offers standard and long sample sets, highlighting, zoom and A4 pages. Page breaks are estimated in the client, labelled NEEDS BACKEND for exact PDF pagination.
  - Publish is enabled only when all required checks pass. The checks are derived, not stored: title set, has content, no unknown variables, allowed content, saved, previewed after the last save, not withdrawn. Inactive variables are a non-blocking warning.
  - The publish dialog shows from → to and added, changed and removed counts.
  - Versions: view any past version read-only (existing API), compare any two of draft and versions (client-side LCS block diff plus word diff, per the README), and restore into the draft (client copy, then save draft).
  - Withdraw with a notice period of 0–365 days (default 7), a reason and a live effective date. Cancel withdrawal.
- **Properties.** Name, description and tags via the existing update endpoint; document type is read-only after creation. Show `GENERATED`; UPLOADED_PDF and HYBRID are NEEDS BACKEND.
- **Shown disabled with a NEEDS BACKEND tag:** tables, H3, alignment, conditional blocks, the shared section library's storage and counts (sections can ship as a static config list if product agrees, otherwise as the placeholder), PDF download, and draft preview for `:read` users. `:read` users see the published version in Preview only.
- **Layout.**
  - Three panels: 272 / 1fr / 328.
  - Below 1280px the left panel becomes an overlay; below 1100px the inspector does too. The rail auto-collapses under 1280px inside the Studio.
  - The toolbar stays on one row and scrolls sideways.
  - At narrow widths the header follows README §Studio top bar: breadcrumb `min-width:110px` with ellipsis, collapsing to "← name"; shorter labels.
  - The account menu warns about unsaved changes and saves before sign-out.

## 5. Testing and acceptance
- **Unit:** permission gating helpers; lifecycle transition table; reason-code config; date formatting (absolute + relative + UTC mono); error-code → copy mapping; Studio serialiser round-trip; readiness derivation; diff algorithm.
- **Component:** every NEW component (stories, plus interaction tests for dialogs, drawer focus, TagInput, TypedConfirm).
- **E2E:** script all 10 journeys from the original brief, plus the Studio journey.
  1. Sign in → dashboard → PROVISIONED tile → tenant → resend owner invite.
  2. Provision a BUSINESS tenant with Sign → review → success → detail.
  3. Suspend an ACTIVE tenant → timeline shows the event → reactivate.
  4. Offboard → close, with the terminal acknowledgement.
  5. Domain: promote with evidence; grant and revoke an exception.
  6. Personal review: open an account in review → restrict until a date → reinstate.
  7. Skills: review-queue surface → add as alias; accept a proposal (and handle the 409).
  8. Documents: create a template → draft with variables in the Studio → preview → publish → withdraw with 7-day notice.
  9. Matching: edit as a new version → activate with the diff.
  10. Wrong account: a tenant user gets in-shell access denied → "Sign in with a different account".
  11. Studio: remove the unknown-variable error via Checks; drag a section in; reorder blocks; compare v3 with the draft; restore v2.
- **Visual:** compare each screen against the HTML reference at 1440px and 900px, and match spacing, type and colour. The `persona` tweak in the HTML shows the read-only (auditor) states to match.
- **Done when:**
  - all journeys pass;
  - lint and vocabulary checks are clean;
  - the axe report has no serious issues;
  - every NEEDS BACKEND item is visibly labelled or degraded;
  - `docs/platform-admin-implementation-plan.md` is updated with what shipped, the remaining gaps and the backend tickets to file.

## 6. Out of scope
Changing plans, subscriptions or capabilities from the console; billing operations; tenant-side apps (ATS, Organization, Sign); public signup; any tenant health or rating metric; a top-nav layout (OPEN-UI-4); backend changes.

Work milestone by milestone. After each one, summarise what changed, list any deviations from the README with the reason, and pause if a backend gap blocks the next milestone.
