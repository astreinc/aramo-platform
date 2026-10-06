# Aramo Console Defect Register — v1.0 (for LOCK authorization)

**Doc ID:** `Aramo-UI-HotFix-Console-Defect-Register-v1_0-LOCKED`
**Status:** FINAL v1.0 — READY FOR RATIFICATION — all Architect/PO rulings baked in
(Q-A/Q-B/Q-C, RN-1 note semantics, G2.5 presentation-only). Awaiting the PO/Architect's
**LOCK authorization on the presented version hash**. On authorization this file is filed
**verbatim** to canonical OneDrive `Aramo/locked/` under the Doc ID above; built code cites it.
**NOT YET FILED. IMPLEMENTATION NOT AUTHORIZED** until this version's hash is ratified.

**Frozen scope — v1.0 authorizes exactly three items: `G1`, `G2`, `D-INT-1` — and nothing
else.** This is **NOT a living document**. New defects discovered after lock require an
**amendment (v1.1)** or a **successor directive**; they must not be silently folded into this
scope.

**Program shape — three focused PRs under one directive**, built in order **D-INT-1 → G1 → G2**,
each independently gated through Gate-5/Gate-6:

- **PR-1 — D-INT-1** (deploy-config): PROD M365 delegated-OAuth env wiring. Independent; fixes a
  live prod defect; not held behind the UI work.
- **PR-2 — G1** (fe-foundation): the `Input`/`TextArea`/`Select`/`TextField` primitives + the
  all-console raw-control migration + the fail-closed CI guard.
- **PR-3 — G2** (Requisitions UI): pixel-parity, built on the G1 primitives.

**Workstreams**

- **Workstream A — fe-foundation standard + Requisitions UI** (presentation-layer; §1–§9 = G1,
  §G2 = G2). `doc/adr` FE conventions; `apps/ats-web/src/ui/ui.css` token discipline.
- **Workstream B — PROD integration/deploy defect** (§B): D-INT-1, the PROD Microsoft 365
  "Connect" failure (missing `MSGRAPH_*` env-var wiring). Distinct **deploy-config** change
  class; ships as **PR-1**.

---

# Workstream A — fe-foundation standard gaps

## 1. Context / problem

`@aramo/fe-foundation` is the **single Aramo design-system standard** — theme tokens,
fonts, and the Radix-based component set (`Button`, `Card`, `Dialog`, `FormField`,
`Table`, `Tabs`, `Toast`, …) consumed by all three consoles (`ats-web`,
`platform-web`, `portal-web`). Building console UI on this standard is the rule.

The problem this directive fixes is a **gap in that standard** that lets a screen
fall through to non-standard, hand-rolled markup. Concretely: the standard offers
`FormField`/`Label` (wrappers) but **no form-control primitive** — there is no
standard `Input`, `TextArea`, or `Select`, and `fe-foundation` global CSS does not
style bare `input`/`textarea`. When a screen needs a text field it has **nothing
standard to reach for**, so it drops to a bare, unstyled element. There is also
**no CI guard** that catches this, so the drift is invisible until a fidelity review.

This directive closes the standard's gap (add the missing primitives), makes the
standard **enforceable** (a fail-closed CI guard), and brings the screens that fell
through back onto the standard — as **one PR**.

## 2. The gap in the standard (grounding)

- **No form-control primitive.** `libs/fe-foundation/src/components/index.ts` barrel:
  `Button Card Combobox Dialog DialogClose ForbiddenState FormField InlineAlert Label
  NavLink PageHeader RadioGroup SignedOut Switch Table Tabs Toast ToastProvider` —
  **no `Input` / `TextArea` / `Select`**.
- **No global styling for bare controls.** `libs/fe-foundation/src/ui/ui.css` styles
  only classed controls (e.g. `.rc-rowq button`), not bare `input`/`textarea`, so a
  hand-rolled control renders at browser defaults (narrow, unpadded).
- **No enforcement.** The only `no-restricted-syntax` rule in `eslint.config.mjs` is
  the vocabulary guard; nothing restricts raw interactive HTML in app code.
- **Result — screens that fell through the gap:** raw interactive HTML in app code
  (tests excluded): **60 `<button>`, 42 `<input>`, 20 `<select>`, 4 `<textarea>`
  (0 `<dialog>`) = 126 sites across 51 files**, almost all in `ats-web`. For context,
  **343 files already consume `fe-foundation` correctly** — the fix restores the 51
  outliers to that same standard, it does not change the standard's identity.

## 3. Rulings — the approved fix to the standard

- **R1 — Complete the standard's form-control set.** Add first-class primitives to
  `@aramo/fe-foundation`: **`Input`, `TextArea`, `Select`**, plus a **`TextField`**
  composite (`FormField` + `Input`) for the common labelled-field case. Token-styled,
  **full-width by default**, matching the existing component visual identity. These
  become the standard controls every console reaches for.
  - **Q-A ratified:** `Select` is a **token-styled native `<select>` wrapper** now; a richer
    Radix/listbox `Select` is deferred to a future version.
  - Implementation note: honor the existing Radix `asChild` constraint — a primitive
    that must compose as a slot needs proper ref forwarding (a no-`forwardRef`
    control breaks Radix `asChild`). CSS rides `ui.css`/design tokens (exact-token
    class discipline); no inline style literals.

- **R2 — Make the standard enforceable (fail-closed CI guard).** Extend the existing
  `no-restricted-syntax` config with `JSXOpeningElement` selectors banning raw
  `button`, `input`, `textarea`, `select`, `dialog` in `apps/**/src/**`, **allowed
  only under `libs/fe-foundation/**`** (the standard is where primitives legitimately
  wrap native elements). Message points to the standard component to use. Uses the
  **built-in** rule — no new ESLint plugin dependency. `lint` is a required CI target,
  so any future fall-through fails the build. **Q-B ratified:** a narrowly-scoped,
  **commented** `eslint-disable` is permitted **only** for a genuinely uncovered native
  need (e.g. a hidden/file input); repeated use means *add a primitive* (a v1.1 amendment),
  never *normalize the disable*.

- **R3 — Bring the outliers back onto the standard.** Migrate the 51 files / 126 sites
  to the standard components: raw `<button>` → `Button` (primitive already exists);
  raw `<input>`/`<textarea>`/`<select>` → the R1 primitives. The two screens from the
  originating finding are the **reference conversions** (see §5), rebuilt to the
  approved fidelity so the pattern is unambiguous for the rest.

- **R4 — Three PRs, one directive, order D-INT-1 → G1 → G2.** Each rides its own dedicated
  branch off `origin/main` and is independently gated (Gate-5/Gate-6): **PR-1 D-INT-1**
  (deploy-config), **PR-2 G1** (primitives + migration + guard), **PR-3 G2** (Requisitions UI,
  on G1). **Q-C ratified:** G1's migration covers **all three consoles** (`ats-web` +
  `platform-web` + `portal-web`) in PR-2 — the guard is repo-wide, so no known raw-control
  outlier is left behind. Scope is frozen (G1 + G2 + D-INT-1); later defects are a v1.1
  amendment or successor directive, never folded in.

- **R5 — No moat / behavior change.** This is a presentation-layer standardization
  only: no API, DTO, scope, migration, or returned-shape change; no `verify-api.ts`
  registration; no new nx dependency edge (primitives are added *within* the existing
  `fe-foundation` lib, already 3-place wired). RED-first proofs are component-level
  (render/interaction) plus the guard flipping the anti-pattern from green to red.

## 4. Impact / scope (top offenders)

| File | raw controls |
| --- | --- |
| `apps/ats-web/src/companies/CompanyForm.tsx` | 16 |
| `apps/ats-web/src/talent/TalentEditDrawer.tsx` | 7 |
| `apps/ats-web/src/requisitions/NewRequisitionView.tsx` | 6 |
| `apps/platform-web/src/skills/skill-form-dialogs.tsx` | 5 |
| `apps/ats-web/src/task/components/TaskDrawer.tsx` | 5 |
| `apps/ats-web/src/talent/RecordReferenceForm.tsx` | 5 |
| `apps/ats-web/src/companies/components/CompanyQuickEditForm.tsx` | 5 |
| `apps/platform-web/src/skills/skill-action-dialogs.tsx` | 4 |
| `apps/ats-web/src/task/components/TaskRowItem.tsx` | 4 |
| … + 42 more files (1–3 each) | remainder |

**Totals:** 51 files · 126 raw-control sites · concentrated in forms (which is exactly
the primitive the standard was missing).

## 5. Reference conversions (acceptance pattern for R3)

The M365 talent-contact surfaces are the worked examples every other conversion
follows:

- **`apps/ats-web/src/microsoft/RequisitionContactEmailComposer.tsx`** — replace the
  bare `<input>` (subject) and `<textarea>` (body) with the R1 `Input`/`TextArea`
  (full-width), and bring the compose modal to the approved fidelity: draft-state
  header treatment, sender/recipient presentation, connected-mailbox and
  logged-to-activity reassurance copy, and a full-width, comfortable body.
- **`apps/ats-web/src/microsoft/MicrosoftRecruiterActions.tsx`** — replace the raw
  `<button>` "Send email" / "Create Teams meeting" with the standard `Button`
  (iconed, styled), and restore the connected-mailbox helper copy.

Copy/element specifics for these two screens are carried in the originating fidelity
finding and are in-scope for **PR-2** (G2's §G2.3 / §G2.2 give the fuller spec and govern on
overlap).

## 6. Execution model (post-lock only) — three PRs, order D-INT-1 → G1 → G2

Three dedicated branches off `origin/main`, each independently Gate-5/Gate-6 gated:

- **PR-1 — D-INT-1 (deploy-config).** `docker-compose.prod.yml` + `.env.prod.example` env
  wiring (§B1). Independent of the UI work; lands first.
- **PR-2 — G1 (fe-foundation).** Internally ordered so the guard lands green:
  1. add `Input`/`TextArea`/`Select`/`TextField` (+ tests, tokens, barrel);
  2. migrate the §4 files across **all three consoles** to the primitives + `Button`, and
     rebuild the §5 reference screens to fidelity (RED-first per screen);
  3. enable the R2 `no-restricted-syntax` guard — green because steps 1–2 cleared the tree.
- **PR-3 — G2 (Requisitions UI).** Pixel-parity per §G2, built on PR-2's primitives.

Gate discipline: Gate 5 stops at verified local diff; Gate 6 is the commit-plan turn.
`lint` + the FE test suite are the walls; run full affected before push.

## 7. Defect Register (frozen v1.0 scope — exactly G1, G2, D-INT-1)

`G` = Workstream A (fe-foundation standard + Requisitions UI). `D` = Workstream B (deploy).
**Frozen:** no rows are added to this table after lock — a new defect is a v1.1 amendment or a
successor directive.

| ID | Workstream | Defect | Recommended fix | Status |
| --- | --- | --- | --- |
| **G1** | A | No form-control primitive (`Input`/`TextArea`/`Select`) + bare controls unstyled + no enforcement → 51 files fell through to raw HTML; M365 email composer & recruiter-actions drawer rendered below fidelity | R1 (add primitives + `TextField`), R2 (fail-closed element guard), R3 (migrate 51 files; §5 reference conversions) | v1.0 (this LOCK) |
| **G2** | A | Requisitions module UI must match the updated prototype 100% pixel-perfect (list, Talent drawer, review-email modal, New requisition, Detail Overview view/edit, Log-a-note modal, shared shell) — built on fe-foundation components + tokens; **depends on G1** primitives; **supersedes** §5's email-composer/recruiter-actions targets | RG2 (implement per §G2 spec; New-req form and Detail Overview are ONE `mode`-prop component; read-only/masked fields enforced server-side) | v1.0 (this LOCK) |
| **D-INT-1** | B | PROD Microsoft 365 "Connect" (per-recruiter delegated OAuth) fails with *"We couldn't start the Microsoft connection. Please try again."* — `MSGRAPH_REDIRECT_URI` + `MSGRAPH_OAUTH_STATE_KEY` never reach the prod `api` container (§B1) | RB1 (wire both into `docker-compose.prod.yml` + document in `.env.prod.example`), RB2 (set prod values), RB3 (recreate `api`) | v1.0 (this LOCK) |
## 8. Acceptance criteria

- `@aramo/fe-foundation` exports `Input`, `TextArea`, `Select`, `TextField`,
  token-styled and full-width by default, with tests.
- No raw `button`/`input`/`textarea`/`select`/`dialog` remains in `apps/**/src/**`
  outside justified, commented `eslint-disable` escape hatches.
- The R2 guard is active and fails CI on a newly introduced raw control.
- The §5 reference screens render at the approved fidelity.
- No API/DTO/scope/migration/returned-shape change; no new nx edge; `lint` + FE suites
  green.

## 9. Ratified decisions (Architect/PO)

- **Q-A → styled native `Select`.** Token-styled native `<select>` wrapper in `fe-foundation`
  now; richer Radix/listbox `Select` deferred to a future version. (Folded into R1.)
- **Q-B → narrow, commented escape hatch.** A local `eslint-disable` only for a genuinely
  uncovered native need (file/hidden inputs); recurrence means "add a primitive," not
  "normalize the disable." (Folded into R2.)
- **Q-C → all three consoles in G1.** `ats-web` + `platform-web` + `portal-web` migrate
  together in PR-2; the guard is repo-wide. (Folded into R4/§6.)
- **G2.5 → presentation-only (OPTION a).** G2 uses only existing substrate (`version`/CAS,
  `created_at`, `updated_at`, `owner_id`); no `created_by`/`updated_by`, no field-edit audit,
  no edit-history/snapshot table, no migration/Pact/OpenAPI expansion. Status transitions keep
  their existing governed actor/reason audit. (Folded into §G2.5.)
- **D-INT-1 → stays** (independent prod defect; ships as PR-1).

---

# Workstream A · G2 — Requisitions UI (pixel-perfect prototype match)

**Register:** G2. **Depends on:** G1 — build every field with the new
`Input`/`TextArea`/`Select`/`TextField` primitives plus the existing `Button`, `Dialog`,
`Card`, `Table`. **Supersedes** the email-composer + recruiter-actions targets named in §5
(G1): where they overlap, **G2 governs** (G2.3 is the authoritative email-modal spec; G2.2 §5
is the authoritative Microsoft 365 card spec).

**Reference prototype (UI acceptance reference):** `platform/Requisitions.dc.html`,
`platform/Requisition Detail.dc.html`, `platform/New Requisition.dc.html`. Match layout,
hierarchy, copy, and states. **Do not** copy the prototype's markup or inline styles — build
with the app's existing fe-foundation components, tokens, and patterns. Do not add behavior
not listed here; anything marked **Deferred** (§G2.8) stays out of this increment.

**Change class:** presentation-layer + governed-action wiring; no new moat. Read-only and
scope-masked fields are enforced **server-side** (see rules), never merely hidden. RED-first
per screen; acceptance = pixel match at 1440px, functional at 1024px (§G2.9).

## G2.1 Requisitions list (`/requisitions`)

- Remove the "needs attention" banner above the table and the **Priority** pill on rows.
- The header count and results line come from real data ("N open · N on hold · N closed",
  "N results · click a row to preview talent").
- **New requisition** goes to `/requisitions/new` (see §G2.4). It is not a modal.

## G2.2 Talent drawer (Requisitions → click a talent under a requisition)

**Layout**
- Widen the drawer to about **620px** (`min(620px, 94vw)`).
- Remove the prototype-only stage switcher row. The drawer must render its full body with
  nothing missing.

**Sections, in order**
1. Header: avatar, name, "Role · REQ-code".
2. **Talent Journey**: milestones Recruiting → Client → Offer → Pre-Start → Employment.
   Recruiting is current. Recruiting stages list: No contact → Contacted → Talent responded
   → Qualifying → Qualified. The current stage shows a CURRENT tag; completed stages show a
   green check.
3. **Next step**: primary CTA driven by the stage. For *No contact* this is "Contact Talent",
   which opens the email draft (§G2.3). For *Qualified*, show "Make offer is not available yet
   — offers unlock after client selection."
4. **Voice engagement**: "No voice activity recorded yet." plus a disabled **Call** button,
   with a tooltip saying it isn't configured.
5. **Microsoft 365**: a card with **Send email** (outlined, primary color, mail icon) and
   **Create Teams meeting** (secondary, calendar icon). Helper text: "Sent as you from your
   connected Microsoft 365 mailbox · logged to this Talent's activity automatically."
6. **Submittal readiness**: policy text.
7. **Résumé — this position**: dashed empty state, "No résumé selected yet." plus a
   **Select résumé** button.
8. **Talent details** and **Rates** (desired rate from the Talent record; "—" when absent).

## G2.3 Review email draft modal (Send email / Contact Talent)

**Layout**
- Centered modal, about **980px** wide × **min(860px, 94vh)** tall.
- Scrollable body; header and footer stay fixed.

**Header**
- Title: "Review email draft".
- Subtext: "Sent via your connected Microsoft 365 mailbox · nothing sends until you click Send".
- Status pill: `DRAFT · NOT SENT`.

**Banner**
- Exact copy: "Draft prepared from **REQ-XXXX · &lt;Title&gt;**. Review and edit the message
  before sending."
- Do not list which fields were inserted.

**Fields**

| Field | Editable | Behavior |
|---|---|---|
| From | Read-only | The user's M365 identity, with an `M365 CONNECTED` badge. |
| To | Read-only | A chip (avatar, name, email) plus a lock icon and "Resolved from the Talent record — recipient can't be changed here." Resolve the address server-side from the authoritative TalentRecord. Never accept a free-text recipient. |
| Subject | Yes | Generated from the requisition: "&lt;Title&gt; — &lt;Arrangement&gt;, &lt;City ST&gt; (&lt;Engagement&gt;)". **No client name.** |
| Body | Yes | Large textarea (min 340px, 13.5px, line-height 1.65). |

**Default body.** Generate it from the authoritative requisition context. Include no client
information and no attachment. Keep it short and inline:

```
Hi <FirstName>,

I'm reaching out regarding the <Title> opportunity (<REQ-code>).

Location: <City, ST> — <Arrangement>
Engagement: <Engagement type>

Based on your background, I'd like to connect with you to discuss the role and learn more about your experience and interest.

About the opportunity:
<short job summary / selected JD content — not the full JD>

Would you be open to a short call this week?

Best regards,
<Recruiter name>
<Tenant name>
<Recruiter email>
```

**Footer**
- Left: static text "Sent email is logged to this Talent's activity on &lt;REQ&gt;
  automatically." with a green check. This is **not** a checkbox; logging is automatic on an
  accepted send.
- Right: **Cancel** and **Send email** (primary, send icon). **No "Save draft"**: there is no
  persisted draft model, and Graph is send-only. The draft exists only while the modal is open.

**Rules**
- Explicit Send only.
- An accepted send goes through the governed CONTACT action, which moves
  *No contact → Contacted*.
- Sending never sets *Talent responded*.
- If the user has no M365 connection, show the connect path (My Settings → Connected accounts)
  instead of the modal.

## G2.4 New requisition (`/requisitions/new`), full page

**Start state**
- Card: "Start from a client email or a few lines".
- Textarea: at least 150px.
- Buttons: **Draft with AI** (primary) and **Import requisition** (secondary).
- Helper text: "Import parses a ready requirement into the form — no AI. You review, edit and
  create."
- Below the card: "Prefer to type it? **Enter the requisition manually**".

**Review state.** Two columns: the form (`minmax(0,1fr)`) and a sticky right rail of about
**260–300px**. The rail must stay narrow so the form has the width.

- **Banner** (import or draft) with **Re-import / Re-draft**. The import copy says nothing was
  invented, the full text is kept in the JD, and nothing is created until the user clicks Create.
- A **PARSED** tag and a tinted field background mark only the fields that were actually parsed.
- **Sections:**
  - *Role & client:* Job title\*, Client\*, Hiring manager (disabled until a client is picked;
    options come from that client's contacts), Requisition type, Openings, Status (Draft),
    Priority "Mark as hot" toggle.
  - *Location & work arrangement:* address search helper, City, State, ZIP, Work arrangement,
    Contract duration, Start date.
  - *Commercials:* Bill rate (max), Rate type, Allow subcontractors.
  - *Job description:* large textarea, at least 220px.
  - *Requirement skills:* Required and Nice to have, as removable chips plus an add input.
    Parse real skills (e.g. Python, Flask, SQL, CI/CD), not phrases like "writing" or "testing
    their own code".
  - *Work authorization:* `SENSITIVE` tag.
  - *Hiring-manager notes:* **at least 160px / 7 rows** (currently too small). Placeholder:
    "Call notes and context from the hiring manager — must-haves, team setup, interview process,
    red flags…". Right-aligned hint: "Internal — never shared with talent".
  - *Additional fields:* collapsible. Includes a *Financial planning* subgroup with a
    `RESTRICTED` tag.
- Grids use `repeat(auto-fit, minmax(240px, 1fr))` so they reflow at narrow widths.
- **Right rail:**
  - Source: monospace, about 220px, scrolls.
  - Duplicate check: coming soon.
  - Matching toggle.
  - Owner.
  - Checklist (Job title, Client).
  - **Create requisition**: disabled until every required field is valid.
  - Cancel.

## G2.5 Requisition Detail — Overview uses the create form, with read and edit modes

The Overview tab reuses the **same section layout, field order, labels, and grid as New
requisition (§G2.4)**. A recruiter editing a requisition sees the exact screen they created it
in. Build it as **one shared form component with a `mode` prop (`create | view | edit`)**, not
as two separate layouts.

**Layout**
- Two columns: the form (`flex: 1 1 560px; min-width: 0`) and a right rail
  (`flex: 1 1 260px; max-width: 300px`, sticky).
- **Below about 900px the rail stacks under the form.** It must never squeeze the form so that
  field grids collapse to one column at normal widths.
- Section headers: the icon and title (`white-space: nowrap`) come first, then any header note
  (right-aligned, wraps onto its own line when it doesn't fit).
- Field grids: `repeat(auto-fit, minmax(240px, 1fr))`.

**Sections** — same as §G2.4, in the same order:
1. Role & client
2. Location & work arrangement
3. Commercials
4. Job description
5. Requirement skills
6. Work authorization (`SENSITIVE`)
7. Hiring-manager notes
8. Additional fields (collapsible; *Financial planning* `RESTRICTED` subgroup appears only with
   financial scope)

Commercials keeps the header note "Shown per your scopes — masked fields are absent, never null."

**View mode** (default)
- Every field renders as a **read-only value box in the same position and size as its input**:
  light fill, subtle border, 38px min height. Nothing shifts when the user switches to edit.
- Empty values show `—` in a muted color.
- The JD and notes show as read-only multi-line text.
- Skills show as chips without remove controls. An empty group shows "None stated".
- Additional fields are collapsed by default.

**Edit mode** — entered only through the **Edit** button in the page header.
- The Edit button switches to an active state labelled "Editing". Clicking Edit from another
  tab switches to Overview.
- Every field becomes its input or select. The JD and notes become textareas (JD at least
  200px, notes at least 160px). Skills get × remove and an "Add a skill…" input. Additional
  fields auto-expand.
- A **sticky edit bar** sits at the top of Overview: "**Editing REQ-XXXX.** Saving creates
  version vN+1. Nothing changes until you save." plus **Cancel** and **Save changes**.
- The right rail also shows a required-field checklist (Job title, Client) plus **Save changes**
  and Cancel.
- **Cancel** discards all unsaved changes and returns to view mode.
- **Save changes** validates the same required fields as create. On success it creates a new
  version, returns to view mode, and updates Record → Version and Last edited.

**Right rail** — takes the place of the create-only cards:
- **Record**: Version (`vN`, monospace), Created (`created_at` date — **no user**, since
  `created_by` does not exist), Last edited (`updated_at` date — **no user**), Source. The
  label column is fixed at about 84px with `nowrap`, so rows never overlap.
- **Owner**: avatar and name, plus the roster note.
- **Matching**: status plus "Evidence only, never a ranked list · Coming with Aramo Core".

**Rules**
- **G2.5 presentation-only (OPTION a — ARCHITECT RULING).** Use only substrate that exists
  today: field edits use the existing `PATCH`/CAS/`version` semantics; show `version` as `vN`,
  plus `created_at`, `updated_at`, `owner_id`. This directive adds **no** `created_by`/
  `updated_by`, **no** requisition edit-history/version-snapshot table, **no** generic or
  field-edit audit events, **no** migration or Pact/OpenAPI expansion. Ordinary field edits are
  **not** user-attributed or audited server-side, and the UI must not imply they are. *(Future
  "who changed what, when" for ordinary edits = a separate requisition edit-history/audit
  directive.)*
- **Status transitions** stay governed by lifecycle rules and retain their existing
  actor/reason audit behavior (unchanged).
- Scope-masked fields stay absent in both view and edit. Don't render them as empty inputs.
- Status changes made here follow the same transition rules as the header actions. Don't bypass
  the governed transitions.
- The other tabs (Talent, Offers, Activity, and so on) are unchanged.
- **Left nav:** only **Requisitions** is active on Requisition Detail. Fix the bug that also
  highlights Contacts.

## G2.6 Requisition Detail — Log a note modal

**Layout**
- About 720px wide, max height 88vh.
- The body scrolls on short viewports so the textarea never goes under the footer.

**Header**
- "Log a note".
- The context line must match the page's requisition: "Recorded against **REQ-XXXX ·
  &lt;Title&gt;** · &lt;visibility sentence&gt;".

**Controls** (keep them separate)

Both controls mirror the **already-ratified RN-1 (LOCKED 2026-09-21)** enums exactly —
`activity.NoteCategory` (7 values) and `activity.NoteVisibility` (2 values). The FE list is
1:1 with `libs/activity/src/lib/dto/note-category.ts` / `note-visibility.ts` (drift-tested).

| Control | Options (RN-1 exact) | Notes |
|---|---|---|
| **Category** (pills) | General (default), Client interaction, Hiring team, Commercial, Interview feedback, Decision, Risk / blocker | All **7** `NoteCategory` values in RN-1 order; `GENERAL` default. May become a compact select on small screens. |
| **Visibility** (select) | Requisition team (default), Private to me | RN-1 V1 ships exactly `TEAM` (default) + `PRIVATE` (author-only). **`RESTRICTED` is DEFERRED to RN-2** — it is NOT a value in this directive: do not render it, not even as a disabled placeholder. A description line sits under the select, and the header sentence changes with the selection. |

**Body**
- Textarea: at least 240px normally, 140px when the viewport is constrained; vertical resize.
- Placeholder: "Capture decisions, client feedback, requirement changes, risks, blockers, or
  next steps…"

**Hints**
- Left: "Timestamped and attributed to you · saved notes can be redacted, not edited".
- Right: "Plain text · links auto-detected · 20,000 char limit".
- **No Markdown label.**

**Footer**
- "Pin to overview" checkbox. **Pin availability follows the existing RN-1 note-write
  permission** — do not invent a fine-grained pin scope. When the user lacks note-write, hide
  or disable the checkbox; never let the save fail on it.
- Cancel and **Save note**.

**Rules**
- Visibility is enforced server-side.
- Notes are immutable after save.
- Enforce 1–20,000 characters in both the frontend and the API.
- A note never changes workflow state, Talent truth, consent, communications evidence, or
  commercial state.

## G2.7 Shared shell (all requisition pages)

- Top bar, right-aligned: search → bell → tenant name → avatar menu.
- Avatar menu: identity block → Settings (admins only) → My Settings → Sign out.
- The left-nav user block shows identity only.

## G2.8 Deferred (do not build)

- Persisted email drafts.
- Activity timeline filters and the pinned-notes projection on Overview.
- Mentions.
- Rich text or Markdown.
- Attachments.
- AI note writing.
- Duplicate detection.
- Matching results.

## G2.9 Acceptance

- Each screen visually matches the attached prototype at 1440px and still works at 1024px.
- The New requisition form and the Requisition Detail Overview (view and edit) are the same
  component, with an identical section order and field grid.
- Switching between view and edit causes no layout shift.
- No layout regressions in the drawer or the modals.
- Every read-only field is enforced server-side, not just hidden in the UI.

---

# Workstream B — PROD integration/deploy defects

## B1 (D-INT-1) — PROD Microsoft 365 "Connect" failure

### B1.1 Context / defect

The tenant Microsoft 365 tile reads **active** (the app-credential connection is
configured — `client_id` + client secret present). But the per-recruiter **"Connect"**
(delegated OAuth that binds the recruiter's own mailbox) fails immediately with the
front-end message *"We couldn't start the Microsoft connection. Please try again."*
"Active tile" and "recruiter can connect" are two different things: the tile reflects
the tenant app credential; Connect exercises the delegated authorize flow, which needs
extra runtime settings.

### B1.2 Root cause

The delegated authorize/**start** step reads two settings from `process.env`:

- `MSGRAPH_REDIRECT_URI` — `apps/api/src/microsoft/microsoft-config.resolver.ts:56`
  (`redirectUri()` throws `MSGRAPH_REDIRECT_URI is not configured` when unset).
- `MSGRAPH_OAUTH_STATE_KEY` — 32-byte base64url key checked in
  `libs/microsoft-graph/src/lib/domain/oauth-state.ts` (signs/verifies the OAuth `state`).

Neither is in the prod deploy: **absent** from the `api` service `environment:` list in
`docker-compose.prod.yml` and undocumented in `.env.prod.example`. Both are plain
`process.env` reads — **not** AWS-sourced. Per the compose passthrough rule (a var read
by code but absent from the compose `environment:` list never reaches the container),
they simply do not exist for the prod API → the start step 500s → the FE surfaces the
generic "couldn't start" message. The redirect URI throws first; the state key would
throw next once the redirect URI is added, so **both** must land together.

### B1.3 Evidence (AWS + repo recon, read-only, 2026-09-23)

- **App credential is healthy — not the blocker.** Secrets Manager secret
  `aramo/prod/connector/019000a0-…001/45a99ef3-de7c-4941-80ac-2905c9b37db9` exists,
  `AWSCURRENT`, `us-east-1`, account `472534873684`, re-saved today. The client secret
  is used only at the **callback** (token exchange), not at start.
- **The two settings exist nowhere in AWS.** No SSM parameter and no Secrets Manager
  secret for either (searched) — they are env-only.
- **Absent from deploy config.** Confirmed by grep of `docker-compose.prod.yml` +
  `.env.prod.example`.
- **Entra side already correct.** The `astre-aramo` app registration already has the
  Web redirect `https://astre.aramo.ai/v1/integrations/microsoft/callback` registered
  (alongside the Cognito federation reply URL) — so **no Entra change is required**.
- **Why local works, prod does not.** The primary workspace `.env` sets both
  (`MSGRAPH_REDIRECT_URI=http://localhost:3000/v1/integrations/microsoft/callback`,
  `MSGRAPH_OAUTH_STATE_KEY` = 43-char/32-byte key, `ARAMO_ENV=local`), so the local API
  start step succeeds — proven by the existing `aramo/local/msgraph-delegated/…` token
  secret. Prod is missing exactly those two vars.

### B1.4 Rulings — the fix

- **RB1 — Wire the two vars into the prod deploy (the only repo change in Workstream B).**
  Add `MSGRAPH_REDIRECT_URI` and `MSGRAPH_OAUTH_STATE_KEY` to the `api` service
  `environment:` passthrough list in `docker-compose.prod.yml`, and document both (with
  guidance) in `.env.prod.example`.
- **RB2 — Prod values (set in the deploy shell env / host `.env`, never committed).**
  - `MSGRAPH_REDIRECT_URI = https://astre.aramo.ai/v1/integrations/microsoft/callback`
    — **byte-for-byte** the already-registered Entra Web redirect (use the actual prod
    API host if not `astre.aramo.ai`).
  - `MSGRAPH_OAUTH_STATE_KEY` = 32 random bytes base64url, e.g.
    `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` (43 chars). It signs only
    in-flight OAuth `state` (no stored data), so a fresh value is safe.
- **RB3 — Recreate the `api` container** so it picks up the new env. First confirm the
  deployed code SHA (the running prod `api` was built 21 Sep from `aramo/api:local`;
  main is `1c8e06be`) — do not conflate this env fix with a code rollforward.
- **RB4 — No AWS / Entra / secret change.** All verified present and correct. No
  API/DTO/scope/migration/returned-shape change; no new nx edge.
- **RB5 — Provisioning forward-fix (closes the silent re-drop gap).** RB2 set the
  values directly in the live `/opt/aramo/.env`; a fresh box provision / `.env`
  reauthoring would re-drop them because both vars are **lazily validated** (read on
  the authorize/START route, not at boot — the api boots clean with them empty and
  only 500s at click-time, so no crash-loop flags a miss). The source-controlled
  provisioning path now **requires** both vars at provision:
  `doc/runbooks/singlebox-ops.md` §0 (first-time provision — the required-at-provision
  callout, with the state-key generation command + the `MSGRAPH_REDIRECT_URI`
  byte-match-to-Entra note) and §E (the state key as secret-grade box env material).
  The Entra Web redirect `https://astre.aramo.ai/v1/integrations/microsoft/callback`
  is confirmed already registered on the `astre-aramo` app (§B1 above) — standing
  human-gate attestation; re-verify on the Entra portal if the app's reply URLs are
  ever edited. **Acceptance:** a fresh provision from source yields a `.env` carrying
  both vars with the fill requirement called out, no manual hotfix.

### B1.5 Execution — PR-1

**PR-1** = one commit touching `docker-compose.prod.yml` + `.env.prod.example`, on its own
branch off `origin/main`, Gate-5/Gate-6 gated, landing first (independent of G1/G2). RB2
(value-set) and RB3 (container recreate) are **deploy-runtime operator steps** performed from
the Mac/deploy source — not code, not part of the PR diff.

### B1.6 Acceptance

- `docker compose config` on the prod host shows both vars populated on the `api` service.
- After recreate, "Connect" advances to the Microsoft sign-in screen; on completion a
  `aramo/prod/msgraph-delegated/<tenant>/<…>` secret appears (delegated token custody)
  and the recruiter mailbox shows connected.
- No regression to the tenant-level M365 tile (already active).
