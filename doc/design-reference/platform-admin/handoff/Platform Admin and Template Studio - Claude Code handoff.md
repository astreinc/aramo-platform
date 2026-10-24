# Aramo Platform Admin console and Template Studio (Claude Code handoff)

**Design authority:**
- `platform/Platform Admin.dc.html`: the console.
- `platform/Template Studio.dc.html`: the template library and editor.

Values are normative: zero drift. Where this document and a file differ, the file wins; record the difference in the PR.

**Secondary references (this project):**
- `platform/Platform Admin.dc.html` → Sign-in and Signed out screens: the shared sign-in brand panel and provider buttons.
- `platform/Template Studio.dc.html` → Library screen: the template list that the Studio opens from.
- `assets/aramo-mark-white.svg`: the logo mark used in the rail and sign-in panel.

**Scope and rules:**
- **Front end only.** Use the existing platform endpoints (§13). No new identity, roles or backend contracts.
- **Data gaps.** Where the backend doesn't return a value, show the designed empty or placeholder state and list it in the PR under *Data gaps*. Don't invent data.
- **Permissions.** Gate every action by permission (§2), even though `super_admin` holds all 10 today.
- **Raw controls are lint-banned.** Every control maps to a foundation component (§12). Items marked NEW become reusable components, not one-offs.
- **No numeric rating of any kind.** No health score, index or rating of a tenant or a person.
- **Don't build these prototype-only items:**
  - the Tweaks controls (`persona`, `demoState`, `showAnnotations`, `signinVariant`, `startScreen`)
  - the dashed "NEEDS BACKEND" tags (replace each with the real disabled or empty state)
  - the dashed "Prototype only" box on sign-in (account picker and `?error=` buttons)
  - the prototype hint on Provision ("try the name Northwind Logistics…")
  - the **Handoff › Components & questions** rail item and page
  - simulated latency, random IDs and codes, and seeded mock data
  - in the Studio, `document.execCommand`, `contentEditable` per block, and `dangerouslySetInnerHTML` previews; use the codebase's rich-text library (§10.4)
- **Behind flags, off by default:**
  - midnight sign-in panel variant: NEEDS RULING
  - section library storage: NEEDS BACKEND

## 1. Flow
```
/login ─ Microsoft | Google ─▶ provider
   ├─ staff account with platform:tenant:read ─▶ / (Dashboard)
   ├─ tenant account / no platform permission ─▶ in-shell Access denied (§3.5)
   │        └─ "Sign in with a different account" ─▶ /login?error=TENANT_ACCESS_DENIED
   └─ provider error / expired ─▶ /login?error=<existing auth-service code>

Dashboard ─ status tile ─▶ /tenants?status=… ─ row ─▶ /tenants/:id
/tenants ─ Provision tenant ─▶ /tenants/new (details → capabilities → review) ─▶ /tenants/:id
/tenants/:id ─ Lifecycle actions ─▶ dialog (from → to, consequence) ─▶ timeline event + toast

/document-templates ─ row | Create ─▶ /document-templates/:id
Studio: edit ─ autosave/save ─▶ Preview (saves first) ─▶ all checks pass ─▶ Publish vN ─▶ Versions
```
- **Signed-in identity is always visible.** The environment bar shows email · tenant · role, and so does the account menu.
- **Access denied never redirects.** It renders inside the shell.
- **Sign out** goes to `/signed-out`. The Studio saves unsaved changes first.

## 2. Permissions
| Permission | Gates |
|---|---|
| `platform:tenant:read` | Console entry, Dashboard, Tenants (list and detail), tenant Sign view |
| `platform:tenant:provision` | Provision tenant, resend/send owner invite, invite users into a tenant |
| `platform:tenant:lifecycle:manage` | Lifecycle transitions, domain actions, **Sign Personal review queue (read and actions — `GET /platform/personal-review` requires it)**, report decisions, pilot invites |
| `platform:admin:invite` | Platform admins |
| `platform:skill:read` / `:manage` | Skills read / change |
| `platform:document_template:read` / `:manage` | Documents read / change. Preview needs `:manage` today |
| `platform:matching_policy:read` / `:write` | Matching read / change |

- **No read permission:** hide the nav entry, and hide the group if it becomes empty.
- **Read but not change:** show the **view-only note** (§3.6). Never hide buttons silently.
- **Missing the entry permission** (`platform:tenant:read`): show Access denied (§3.5) for every route.

## 3. Shell

### 3.1 Layout
```
Environment bar 30px (sticky, z 70)
Rail 236 / 64 │ Top bar 56px (sticky under the bar)
              │ <main id="main"> padding 28px 32px 72px, max-width 1400px, canvas #F4F6FA
```
- The page never scrolls sideways. Tables scroll inside their card.
- Designed for 1280–1600px; works down to 900px.

### 3.2 Environment bar (NEW `EnvironmentBar`)
- **Bar:** 30px, `#D97757` background, `#0B1022` text (6.05:1), 12px/600, `role="banner"`.
- **Left:** a 7×7 midnight diamond, then **PLATFORM ADMIN** (IBM Plex Mono 600, .08em), then "admin.aramo.ai · actions here apply across every tenant" (500).
- **Right:** "Signed in as **{email}** · {tenant} · {role}", with ellipsis on overflow.
- Inside the Studio the middle text reads "Template changes apply to every tenant that uses the default".

### 3.3 Rail: midnight theme of the shared rail (tokens, not a fork)
| Token | Value |
|---|---|
| `--rail-bg` | #0B1022 |
| `--rail-surface-raised` | #1A1E2F |
| `--rail-label` | #91939C · 10.5px/600 · .09em · uppercase |
| `--rail-item-fg` / active | #C9CACE 500 / #FFFFFF 700 |
| `--rail-item-bg-active` | rgba(255,255,255,.12), no border |
| `--rail-item-bg-hover` | rgba(255,255,255,.08) |
| `--rail-accent` | #D97757: a 3px bar on the rail edge for the active item (non-colour cue) |
| `--rail-link` / focus | #7FB0FF |

- **Size:** 236px expanded / 64px collapsed, `width .18s`.
- **Items:** padding 9px 12px, 9px radius, 12px gap, 19px icons at stroke 1.7.
- **Header:** white logo mark (keep the terracotta spoke) and "aramo**.ai**" (.ai in #C9CACE). Below it a PLATFORM tag: 1px #D97757 outline, #F0B49E text, mono 10.5px; it reads "P" when collapsed.
- **Footer:** a 30px avatar (#1A1E2F background, 1px terracotta border), then the name and "role · tenant".
- **Collapse:**
  - The header button or **⌘/Ctrl+\\** toggles it.
  - Use AppShell's existing `RAIL_COLLAPSE_KEY` (`'rc-rail-collapsed'`, `libs/fe-foundation/src/ui/AppShell.tsx:18`). Do not add a new key. (The prototype's `aramo.platform.rail` is prototype-only.)
  - It auto-collapses below 900px, and below 1280px inside the Studio editor.
- **Groups:**

| Group | Items |
|---|---|
| Operations | Dashboard · Tenants |
| Sign Personal | Review queue · Pilot invites |
| Skills | Registry · Review queue · Proposals |
| Matching | Matching policy |
| Documents | Document templates · Template variables |
| Platform | Platform admins |

- **Active item:** `aria-current="page"`.
  - Tenant detail and Provision highlight **Tenants**.
  - Skill detail highlights **Registry**.
  - Template detail and the Studio highlight **Document templates**.
  - The Studio has no separate nav item.

### 3.4 Top bar
- **Bar:** 56px, white, 1px #E5E9ED bottom border, padding 0 24px, 12px gap.
- **Breadcrumb:** 13px; links #5C6770/500; the last item #18212B/600 with `aria-current="page"`. It **always ends in the entity name**, for example "Operations / Tenants / Northwind Logistics".
- **PLATFORM marker:** 24px, 5px radius, #D97757 fill, #0B1022 mono 10.5px/600 at .08em.
- **⌘K trigger:** 36px tall, width `min(300px,28vw)`, 1px #E5E9ED, 9px radius, placeholder "Tenants, skills, templates", ⌘K key cap.
- **Account menu (290px):**
  - A 36px midnight avatar, name (700), email (mono), role badge (#FBE7DF/#8A3A1F, 10px/700) and tenant.
  - Items: **Sign in with a different account**, then **Sign out** (#A8412F).
  - *Data gap:* the session has no name or email today. Show the account ID until it does.
- **Command palette (NEW grouped results on `CmdKSearch`):**
  - Overlay rgba(15,25,40,.45). Panel `min(620px,96vw)`, 12vh from the top, 14px radius. Input 52px/15px.
  - Results grouped by kind: Tenant (with slug and status pill) · Skill · Template · Page.
  - Enter opens the first result; Esc closes.

### 3.5 Access denied (inside the shell)
- **Card:** max-width 620px, 32px padding.
- **Contents, in order:**
  - "No access" pill (danger tint).
  - Title: "This account can't open {Platform administration | page name}".
  - An explanation line.
  - A box listing **Signed in as** (mono), **Organization** and **Missing** (permission in plain words plus the mono code).
  - Buttons: **Sign in with a different account** (primary) · **Sign out** · **Back to dashboard** (only if the user has `tenant:read`).
  - Footnote: "Platform administration needs an Aramo staff account. If you were signed in to a tenant app in another tab, that session may have been reused here."

### 3.6 Shared patterns
| Pattern | Spec |
|---|---|
| Page header | H1 24px/700, -.02em. Intro 14px #5C6770, max 720px. Actions right-aligned. 18–22px below |
| Card | White, 1px #E5E9ED, 13px radius. Header padding 14–16px 20px; title 15px/700, subtitle 12.5px #5C6770 |
| Table | Header #FAFBFC, 11px/600, .05em, uppercase, #93A0A8, padding 10px 16px. Cells padding 12px 16px, row rule #EEF1F4, hover #F7F9FC. Muted rows: ink #7C8790. Sort headers are buttons with `aria-sort` and an ↑/↓ arrow in mono |
| Filter bar (NEW) | Segmented group (white, 1px #E5E9ED, 10px radius, 3px padding). Items 30px; active is #0B1022 fill with white 700 text, plus a mono count in #93A0A8. Then Select, search Input, and a result count on the right |
| Input | 38px, 1px #D5DBE1, 8px radius. Focus: #022AC0 border + `0 0 0 3px rgba(2,42,192,.15)` |
| View-only note (NEW, local to platform-web — InlineAlert is frozen) | #FAFBFC, 1px #E5E9ED, 10px radius, 13px #3F4A55: "**View only.** You can view this. Changing it needs the **{permission label}** permission." |
| Inline alert | Error: #F8E9E6 / #EBC6BE / #7A2E21, `role="alert"`. Success: #E3F1EA / #BFDCCB / #17603C, `role="status"`. Info: #E6EFF8 / #C9DAEE / #1E4E80. Warning: #FAF0DC / #E7D3A8 / #6B4609 |
| Skeleton (NEW) | Static #EEF1F4 blocks sized to the final content, one set per panel |
| Empty state (NEW) | Centred in the card: title 600, one line in 13px #5C6770, optional action |
| Toast | #18212B, white 13.5px/500, 10px radius, 24px from the bottom, centred, `role="status"`, 4 seconds |
| Dates | Absolute plus relative ("2 Oct 2026 · 22 days ago"). Timestamps in mono `YYYY-MM-DD HH:MM UTC`. Tabular numerals |

### 3.7 Status pill (one system everywhere)
- **Pill:** 22px tall, padding 0 9px, full radius, 12px/600, a 6px `currentColor` dot, then the label.

| Tone | Text | Fill | Used for |
|---|---|---|---|
| ok | #1F7A4D | #E3F1EA | Active, Clear, Authoritative, Published, Accepted |
| info | #2C6FB3 | #E6EFF8 | In review, Provisional, Invited, Pending, Trialing, Draft |
| warn | #946011 | #FAF0DC | Suspended, Restricted, Lapsed, Past due, Not yet invited |
| danger | #A8412F | #F7E7E3 | Confirmed report, No access |
| neutral | #3F4A55 | #EBEEF2 | Provisioned, No subscription, Not published |
| muted (NEW tone) | #66717B | #F0F2F4 | Offboarding, Closed, Released, Retired, Replaced, Rejected |

### 3.8 Confirm dialog (NEW pattern on `Dialog`)
- **Modal:** `min(580px,94vw)` (720px when it holds a diff), max-height 88vh, 14px radius, overlay rgba(15,25,40,.45), footer #FAFBFC.
- **Body, in order:**
  1. **Change** box: from pill → to pill.
  2. Consequence line, 13.5px #3F4A55.
  3. Fields.
  4. Error (`role="alert"`).
- **Commit tones:**
  - midnight #0B1022 for normal actions
  - **terracotta #D97757 with #0B1022 text** for privileged actions
  - **danger #A8412F with white text** for terminal actions
- Commit sits at 45% opacity until the required fields are valid.
- Focus is trapped, Esc closes, and focus returns to the opener.

## 4. Routes
Keep the routes that already exist in `apps/platform-web/src/App.tsx`. Only the rows marked NEW are added.

| Route | Screen | Gate (mirrors the API) |
|---|---|---|
| `/` | Dashboard | `platform:tenant:read` (app-level RouteGuard) |
| `/tenants?status&kind&q` | Tenants list | tenant:read |
| `/tenants/new` | Provision tenant | tenant:read (view) · `:provision` to submit |
| `/tenants/:id` | Tenant detail; tab in `?tab=overview|lifecycle|sign|domain|people` (NEW query param) | tenant:read. **Domain tab needs `:lifecycle:manage`, reads included** (`platform.controller.ts:348`) |
| `/personal-review` | Sign Personal review queue | `platform:tenant:lifecycle:manage` |
| `/personal-invites` | Pilot invites | `platform:tenant:lifecycle:manage` |
| `/skills` · `/skills/:id` · `/skills/review-queue` · `/skills/proposals` · `/skills/proposals/:id` | Skills | `platform:skill:read` |
| `/matching` | Matching policy | `platform:matching_policy:read` |
| `/document-templates` | Template library | `platform:document_template:read` |
| `/document-templates/:id` | **Template Studio** (replaces the current detail view at the same path) | document_template:read |
| `/template-variables` | Template variables | document_template:read |
| `/admins` (NEW) | Platform admins. Not under `/platform/`: nginx proxies `/platform/` paths to the backend | `platform:admin:invite` |
| `/login?error=CODE` · `/signed-out` | Auth. Rendered **outside** RouteGuard (existing short-circuit) | none |

- Unscoped routes keep the existing `ForbiddenState scope=…` pattern. Restyle it to the access-denied design (§3.5); don't replace the pattern.
- The access-denied state for a session without `platform:tenant:read` comes from RouteGuard (403 `TENANT_ACCESS_DENIED` → `/login?error=TENANT_ACCESS_DENIED`).

## 5. Dashboard (`GET /platform/dashboard`)
- **Header:** "Refreshed HH:MM UTC" (mono) and **Refresh**.
- **Status tiles** (`KpiCard`, buttons):
  - Grid `repeat(auto-fit,minmax(150px,1fr))`, 12px gap.
  - Each tile: pill, count (30px/700), "View tenants →".
  - Clicking a tile opens `/tenants?status=X`.
  - The Aramo Platform tenant is excluded. **Counts only.**
- **Onboarding funnel** (PROVISIONED, oldest first, top 10):

| Column | Content |
|---|---|
| Tenant | Name link plus slug (mono) |
| Provisioned | Date |
| Waiting | "N d", right-aligned, 600 |
| Owner invite | **Invited** (info) or **Not yet invited** (warn) |
| Action | **Resend invite** or **Send invite** (`:provision`) |

- **Recent lifecycle activity** (last 15):
  - "**{Event label}** · {tenant}". The tenant links to its Lifecycle tab.
  - "{Reason label} · {Actor type}".
  - Relative time plus a mono UTC timestamp.
  - Raw dotted event names and snake_case codes are never shown as labels.
- **States:**
  - Skeleton per panel.
  - **Per-panel error:** "**Couldn't load recent activity.** The other panels are unaffected." with **Try again**.
  - Empty funnel: "No tenants waiting / Every provisioned tenant's owner has signed in."

## 6. Tenants

### 6.1 List (`GET /platform/tenants?status&q`)
- **Filters:**
  - Status: segmented All + 5, with counts.
  - Kind: select All / Business / Personal.
  - Search: "Search name or slug", 240px.
- **Columns:** Tenant · Kind · Slug (mono) · Status · Status reason · Created · Last transition · Activated. Created and Last transition show the date with the relative age underneath.
- **Sorting:** client-side, default Created descending. Make the table paging-ready.
- **Footer:** "Showing 1–N of N" with disabled Previous / Next.
- CLOSED and OFFBOARDING rows are muted.
- **Primary action:** **+ Provision tenant**, shown only with `:provision`.
- **Empty:** "No tenants match these filters" with **Clear filters**.
- *Data gaps:* `kind` is missing from the list DTO; server paging and sorting don't exist yet.

### 6.2 Provision (`POST /platform/tenants`)
- **Stepper (NEW):** pills with a 22px circle. Current: midnight fill. Done: #E3F1EA with ✓. Steps: **1 Organization & owner · 2 Capabilities · 3 Review**.
- **Layout:** the form card spans 2 columns. A sticky (top 110px) **What will happen** card lists:
  1. "{name} is created as **Provisioned**."
  2. The owner invite line.
  3. "It becomes **Active** automatically when the owner first signs in."

| Step | Fields and rules |
|---|---|
| 1 | **Tenant name*** (min 2). **Kind** as radio cards (1.5px border, selected #0B1022): Business "A company or team. Any capability set; users invited by the owner." / Personal "One person using Sign. Capabilities are fixed to Core and Sign." **Owner email*** (valid email). **Owner display name** (optional). **Slug** (optional; `^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$`) with a `.aramo.ai` suffix and the live line "Sign-in address: **slug.aramo.ai**", generated from the name when empty |
| 2 | Capability cards: core (always on), ats, portal, sourcing (reserved, disabled), sign, intelligence. Default core + ats + portal. Personal locks to core + sign with the note "Personal tenants always get **Core + Sign**. Other capabilities need a Business tenant." Checkbox **Send owner invitation now** (on) |
| 3 | Summary list (Tenant, Kind, Sign-in address, Owner, Capabilities). **Provision tenant** in terracotta |

- **Errors** (top of the form, plain copy plus the mono code):

| Code | Copy |
|---|---|
| `TENANT_ALREADY_EXISTS` | A tenant with this name or slug already exists. Choose a different name or slug. |
| `EMAIL_UNAVAILABLE` | This email already belongs to another organization. One person can belong to only one organization, so use a different owner email. |
| `COGNITO_PROVISION_FAILED` | We couldn't create the owner's sign-in account. Nothing was saved. Try again in a minute; if it keeps failing, contact platform engineering. |
| validation | Inline under the field, 12.5px #A8412F |

- **Success:** go to `/tenants/:id` with the toast "{name} provisioned · owner invite sent."

### 6.3 Detail (`GET /platform/tenants/:id`, `/audit`, `/sign`, `/domain`)
- **Header:**
  - H1 name, status pill and kind badge (1px #D5DBE1, 6px radius).
  - `slug.aramo.ai` (mono).
  - Tenant ID (mono) with **Copy**.
  - *Data gap:* the slug isn't in the detail payload.
- **Lifecycle actions ▾ (NEW `LifecycleActionMenu`):** 1px terracotta outline with a diamond. The menu lists only the allowed transitions (§7), each with a one-line consequence.
  - PROVISIONED adds the note "Becomes Active automatically when the owner first signs in."
  - CLOSED replaces the button with "Closed is terminal. No further lifecycle actions."
- Without `:lifecycle:manage`, show the view-only note.
- **Tabs:** active is 700 with a 2px midnight underline.

| Tab | Content |
|---|---|
| Overview | Two-column list: Tenant ID (mono), Name, Kind, Status, Home sign-in provider (or "Chooser (no home provider)"), Active, Created, Updated, Capabilities. PROVISIONED adds an info callout ("**Invited.** Owner invite sent…" or "**Not yet invited.** …") with Resend/Send owner invite (`:provision`) |
| Lifecycle & audit | Action buttons, then the **Timeline** (NEW), newest first: 10px dot in the target status tone (rejected = danger), human label, from → to pills, "date · relative" on the right, reason label plus mono code, actor type plus short ID (full ID on hover), mono UTC, optional note box. *Data gap:* domain and Personal events aren't in this feed |
| Aramo Sign | Read-only banner ("Plan, subscription and capability changes are governed commercial actions…"). Plan plus subscription pill: Trialing / Active / Past due / Canceled / Incomplete / **No subscription**, never "—". "(not sending)" flag. Capabilities, Sign enabled, **Source**: Manual (contract) · Development · Self-service · **Free (Sign Personal)**, plus the mono code. Eligibility (Eligible / Lapsed), storage, online billing. Usage "N of M envelopes" with a 6px bar, and dates (started, period end, cancellation, grace, ended, commitment end). Billing events table with outcome Applied (ok) / Ignored (neutral) / Stale (warn) |
| Domain | Explainer: "One organization per email domain. A **Provisional** or **Authoritative** claim holds the domain…". Claim card: domain (mono 16px), state pill, "Holds the domain", reason, since, exception. Provisional countdown: "N days left of 30" with a bar and the expiry date. Actions: **Promote to authoritative…** (terracotta; evidence reference required), **Grant shared-domain exception…** (justification ≤ 2000 plus evidence), **Revoke exception…**, **Release domain…** (danger outline; reason plus "I understand another organization could claim this domain."). Exceptions history table. Personal tenants: "No domain claim" |
| People | Invite form: email, display name (optional), role chips (toggle buttons with ✓; **Owner** disabled, "Only an existing owner can grant this"). Errors: `INVITATION_ALREADY_EXISTS`, `EMAIL_UNAVAILABLE`, `VALIDATION_ERROR` (includes refused role combinations; show the server message). Success: "Invitation sent to {email}." *Data gap:* the members list (dashed placeholder) |

## 7. Lifecycle dialogs
| From | Allowed |
|---|---|
| PROVISIONED | Close (Active happens automatically, so there's no button) |
| ACTIVE | Suspend · Start offboarding |
| SUSPENDED | Reactivate · Start offboarding |
| OFFBOARDING | Close |
| CLOSED | none (terminal) |

| Action | Tone | Consequence | Fields | Proposed reason codes (**product decision**) |
|---|---|---|---|---|
| Suspend | terracotta | No one in this tenant can sign in, and all writes are frozen until it is reactivated. Data is kept. | Reason*, Reason details* (≤ 500, "Recorded in the tenant audit trail.") | payment_overdue, terms_violation, security_incident, legal_hold, owner_request |
| Reactivate | terracotta | Users can sign in again and writes resume immediately. | Reason* | issue_resolved, payment_received, suspended_in_error, owner_request |
| Start offboarding | terracotta | The tenant enters a wind-down period… | Retention policy* (helper "How long tenant data is kept after the tenant closes."), Close at*, Reason (optional), Notes (optional) | contract_ended, owner_request, consolidation |
| Close | danger | Closing is terminal. No one can sign in, writes are frozen permanently, and the tenant cannot be reopened. | Reason*, Notes, checkbox "I understand closing is terminal and cannot be undone."* | offboarding_complete, never_activated, duplicate_tenant, owner_request |

- Keep the reason-code lists in one config file. The backend accepts any non-empty code.
- **Errors:**
  - `illegal_transition`: "This change isn't allowed from {status}."
  - Already in that status: "No change: this tenant is already {status}."
- **Success:** a timeline event plus the toast "{name} is now {status}."

## 8. Sign Personal

### 8.1 Review queue (`GET /platform/personal-review`)
- **Filters:** segmented state with counts (All · In review · Restricted · Clear · Closed) and a sort select (Signed up, newest · Restricted until, soonest).
- **Columns:** Account (tenant plus email in mono) · State pill (with "Review owed", 11.5px warn) · Reason · Risk points (mono, right) · Phone · Reports · Signed up · Restricted until.
- **Detail drawer (NEW `DetailDrawer`):**
  - Right side, `min(560px,96vw)`, overlay rgba(15,25,40,.32). Esc closes and focus returns to the row.
  - Facts list.
  - **Signals:** human label, mono code and "+N". Header: "N risk points from recorded signals". (Run all copy through `scripts/verify-vocabulary.sh`.)
  - **Reports:** category, outcome pill (Open info / Confirmed danger / False report neutral / Dismissed muted), note and decision. Reports stay viewable for **Closed** accounts. Open reports offer **Confirm… / Mark false report… / Dismiss…**, each with a required reason.
  - Footer actions by state:

| State | Actions |
|---|---|
| In review | Clear review · Restrict… · Close account… |
| Restricted | Reinstate… · Close account… (plus Clear review while a review is owed) |
| Clear | Restrict… · Close account… |
| Closed | none |

- Every action needs a reason (≤ 500).
- Restrict takes an optional "until" date-time (UTC). Error `until_in_past`: "The 'until' time is in the past. Choose a later time."
- Close needs the checkbox "I understand this closes the account."
- Other errors: `no_personal_risk_state`, `illegal_risk_transition`.

### 8.2 Pilot invites (`POST /platform/personal-invites`)
- **Form:** Email, then **Create invite code**. *Data gap:* no read endpoint for seat usage, so do **not** show "N of 50 pilot seats used"; the cap surfaces only as `personal_pilot_full`.
- **Result (NEW `OneTimeSecret`):** 1.5px midnight border, `role="status"`:
  - "THIS CODE IS SHOWN ONLY ONCE" (warn)
  - the code (mono 22px on #F4F6FA) with **Copy**
  - the recipient email and expiry
  - "I've saved it — dismiss"
- **Errors:** "Enter an email address." · "The pilot is full. No more invites can be sent until seats are released."

## 9. Skills, Matching, Variables, Admins
| Screen | Spec |
|---|---|
| Skills registry | Search names and aliases, **Include inactive**, **+ Create skill** (`:manage`). Columns: canonical name · normalized (mono) · status · aliases · updated. *Data gap:* paging |
| Skill detail | Header: name, pill, `id · normalized` in mono. Actions: Edit · Override… (optional surface form, reason*) · **Merge into…** (terracotta outline; winner plus the acknowledgement "I understand this merge can't be undone from the console.") · Deactivate/Reactivate… (from → to). Tabs: Overview · Aliases (n) · Versions (n) · Relationships (n). Aliases: inline add of surface plus 1 of 5 types (Synonym, Abbreviation, Misspelling, Colloquial, Translation); remove. Versions: version (mono), family, Current/Supported/Legacy. Relationships (dialog): target skill, 6 types (Related to and Alternative to are symmetric; Requires, Part of, Broader than and Narrower than are directed), 4 sources (Curated, AI proposal, Import, Tenant signal), reference. Always show skill **names**, never IDs |
| Review queue | Domain segmented (All/Talent/Requisition), Min. occurrences (number), search. Columns: surface (mono, quoted) · domain · occurrences · tenants · first seen. Row actions: **Add as alias…** (skill plus type) · Create skill. Footer: "50 per page" with **Load more** (cursor) |
| Proposals | Status segmented (Pending default · Accepted · Rejected · All), then a list and a detail pane. **Diff view (NEW):** existing rows plain, the proposed row prefixed "+" (#E3F1EA / #17603C / 700). **Accept and apply** · **Reject…** (optional reason), only while Pending. 409 → warning alert: "This proposal is no longer pending — it was accepted by another operator a moment ago. The list has been refreshed. (SKILL_PROPOSAL_NOT_PENDING)" |
| Matching policy | Active vN table: 9 role families × Min. evidence (1–20) × Ingested evidence (Required / Not required). With no active version: "No active version · Compiled defaults apply." **Edit as new version** turns the table into number inputs and checkboxes, plus a Note (≤ 500), and saves as a DRAFT. History rows: vN, pill, note, created, last activated, **Activate vN…** (terracotta outline). The Activate dialog (720px) has an impact table (Role family · Active now · After activation); changed rows are #FAF0DC with a ● and 700 |
| Template variables | Columns: key (mono) · label · group · type (mono) · products · ATS binding (mono) · sample · status. Add/Edit dialog. **The key can't change after creation** (the field is disabled). Pattern `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`, max 64. Errors: "Key must look like a.b_c…" and "A variable with this key already exists." |
| Platform admins | Card "Invite platform admin" (terracotta diamond): staff email (the `@aramo.ai` restriction is **not enforced by the backend** — PRODUCT DECISION before shipping the client check), display name, **Review invitation…** (terracotta). The dialog explains Super admin scope and uses **TypedConfirm (NEW)**: a 1px terracotta mono input, with commit disabled until the email matches exactly. *Data gap:* the admins list (dashed placeholder) |

Skills errors: `SKILL_CONFLICT`, `SKILL_PROPOSAL_NOT_PENDING`, `SKILL_PROPOSAL_PAYLOAD_INVALID`.

## 10. Template Studio

### 10.1 Library (`/document-templates`)
- **Header:** page header plus **+ Create default template** (`:manage`).
- **Filters:** product segmented (All products / ATS / SIGN) and search.
- **Columns:**

| Column | Content |
|---|---|
| Template | Name, then "type · id" (mono) |
| Current version | Published vN (ok) or Not published (neutral), with any withdrawal pill below |
| Draft | "Open draft" (#2C6FB3) or "No draft", plus the block count |
| Products | Mono tags |
| Updated | Date and relative age |
| — | "Open studio →" |

- A row click opens the Studio.
- **Create default template dialog:**
  - **Document type*.** Non-configurable types are listed but disabled, with the reason in the label.
  - **Name*** (≤ 120, with a counter) and **Description** (≤ 500).
  - **Product tags (NEW `TagInput`).** Enter adds a tag; uppercase `A-Z0-9_`; up to 16.
  - **Start from:** Blank document, or a copy of a published template.
  - Commit: **Create and open studio**.

### 10.2 Layout
```
Studio top bar 56px
[withdrawal bar] [view-only bar]
Left 272px │ Canvas 1fr (#E9ECF1): toolbar row + A4 page │ Inspector 328px
```
- **Below 1280px:** the left panel starts closed and opens as a fixed overlay.
- **Below 1100px:** the inspector does the same. Overlays sit at top 86px with a shadow, so the canvas never drops below ~600px.
- The rail auto-collapses below 1280px.

### 10.3 Top bar
- **Breadcrumb:** Documents / Document templates / **{name}**. It keeps `min-width:110px` with ellipsis; below 1200px it becomes "← {name}".
- **Version tag:** mono, 1px #D5DBE1.
- **Save status:** a 7px dot (saved #1F7A4D · unsaved #946011 · saving #2C6FB3) with "Saved · HH:MM:SS", "Autosaved · …", "Unsaved changes" or "Saving…".
- **Mode:** segmented **Edit | Preview**.
- **Readiness pill:**
  - Green "Ready to publish" (#E3F1EA / #17603C), otherwise amber "N issues before publishing".
  - It shows 8 mini segments, hidden below 1200px.
  - Clicking it opens Checks.
- **Buttons:**
  - **Compare** (⇄ below 1200px)
  - **Save draft** ("Save" below 1200px)
  - **Publish vN…** (terracotta; 50% opacity while not ready, and clicking it then opens Checks)
  - **⋯** menu: Withdraw template…, Cancel withdrawal…, Autosave drafts On/Off, Keyboard shortcuts, Download as PDF (data gap)
  - Account menu (§3.4), which warns about unsaved changes and saves before leaving

### 10.4 Editor
- **Implementation:**
  - **Reuse the in-house block editor** in `libs/document-templates-web` (`dt-block-editor.tsx`, `RtrDraftEditor.tsx`). There is no rich-text dependency in `package.json`; adding one (TipTap, Lexical, Slate) is a separate decision.
  - The schema is **exactly** the allowed set: paragraph, heading level 2, bold, italic, underline, bullet list, ordered list, hard break, and an atomic `variable` node.
  - Serialise to the draft API's HTML subset with `{{key}}`. Round-trip tests are required.
- **Page:**
  - 794px (A4), white, 3px radius, shadow `0 1px 3px rgba(15,25,40,.08), 0 8px 28px rgba(15,25,40,.08)`, padding 56px 72px 72px 76px.
  - The **Document title** field sits at the top: label 10.5px uppercase #93A0A8, input 24px/700, borderless.
- **Blocks:**
  - Paragraph 14.5px/1.65; Heading 19px/700 with margin 18px 0 6px; bulleted and numbered lists.
  - Selected block: #FAFBFF background, ring `0 0 0 1px #DCE3F7`, and the type tag in the right margin.
- **Margin controls** (−58px; shown on hover or selection):
  - **+** adds a paragraph below.
  - **⋮⋮** is the drag handle. Clicking it opens the block menu: Turn into (Paragraph, Heading, Bulleted list, Numbered list), Duplicate, Move up ⌥↑, Move down ⌥↓, Delete block.
- **Drag and drop:**
  - A 3px #022AC0 line marks the drop point above or below the target.
  - While dragging, a "Drop here to add at the end" zone appears.
  - Sources: blocks, Outline rows, Sections and Variables.
- **Toolbar:**
  - One row that never wraps (it scrolls sideways).
  - Contents, in order: outline toggle · block type select · B / I / U (active: #E9EDFB fill, #C9D2F5 border) · bulleted · numbered · line break · **+ Variable** (#E6EAFA / #011F8D, mono) · + Section · undo / redo · inspector toggle.
  - A disabled dashed group shows **Table · H3 · Align · Conditional** (data gaps).
- **Floating toolbar:** appears on a non-empty selection, 46px above it. A midnight pill with B I U and "+ Variable" in #7FB0FF.
- **Variable chip:**
  - Atomic, mono 12.5px, 5px radius, padding 0 6px. Tooltip: "Label · e.g. sample".

| State | Fill | Text | Border |
|---|---|---|---|
| Known | #E6EAFA | #011F8D | #C9D2F5 solid |
| Inactive | #FAF0DC | #6B4609 | #E7D3A8 solid |
| Unknown | #F8E9E6 | #7A2E21 | #D9A396 dashed |

- **Keyboard:**
  - `/` on an empty block opens the slash menu: Paragraph, Heading, Bulleted list, Numbered list, Variable…, Section…; Subheading (H3) and Table shown disabled.
  - `{{` opens the variable popover at the caret (330px; label, group, key, sample). Enter picks the first match, and the `{{` is replaced by the chip.
  - Enter splits the block into a new paragraph.
  - Backspace on an empty block deletes it and focuses the previous block.
- **Paste:** reduced to the allowed set, with the toast "Pasted as plain text. Formatting outside the allowed set is removed."
- **Empty document:** a dashed #C9D2F5 card, "Start this template", with **Add a heading**, Add a paragraph, Browse sections and Copy published version.

### 10.5 Left panel (Outline · Sections · Versions)
- **Outline:**
  - Stats line "N headings · N blocks · N variables".
  - Numbered rows (mono 10px). Headings 13px/700; body rows 12.5px #5C6770, indented 22px under their heading.
  - Selected row: #E9EDFB with a 2px #022AC0 left bar.
  - Clicking a row scrolls to the block and focuses it. Drag rows to reorder.
- **Sections:**
  - Cards with a ⋮⋮ grip, name, description and "N variables · used in N templates", plus **Insert**.
  - Drag onto the page, or Insert after the selected block. Inserted content becomes ordinary draft content.
  - *Data gap:* storage and usage counts.
- **Versions:**
  - The Draft row plus one row per version: mono vN, pill, "date · N blocks", and a **Diff** button.
  - Clicking a version opens the version view.

### 10.6 Inspector (Variables · Properties · Checks)
- **Variables:**
  - Search, then group chips: All · Talent · Requisition · Offer · Organization · Document.
  - Cards grouped by group: label, INACTIVE flag, key (mono), type, "e.g. sample", "N× in draft" (#022AC0) and **Insert** (active variables only). Cards can be dragged onto the page.
  - An alert lists any unknown variables used.
  - Link: "Manage template variables ↗".
- **Properties:**
  - Name (≤ 120 with a counter), Description (≤ 500), Product tags.
  - Document type, "set at creation". Kind: Generated (*data gap:* the UPLOADED_PDF and HYBRID kinds).
  - Template ID (mono), Created, Updated.
  - A Withdrawal box with its pill, a status line and Withdraw… / Cancel withdrawal….
- **Checks:**
  - The tab badge shows the issue count (#A8412F). Each row has a ✓ / ! / × badge.

| Check | Severity | Fix |
|---|---|---|
| Document title is set | required | — |
| Draft has content | required | — |
| Unknown variable {{key}} | required | **Remove from draft** |
| Inactive variable {{key}} | warning (doesn't block) | **Remove from draft** |
| Only allowed formatting | required | — |
| Draft saved | required | — |
| Previewed after the last save | required | — |
| Template is not withdrawn | required | — |

- Readiness is derived, never stored: `ready = no failing required checks`, and `previewed = !dirty && previewedRev === savedRev`.

### 10.7 Workflow
- **Save draft:**
  - ⌘S or the button; uses the existing endpoint.
  - **Autosave:** 3 seconds after the last edit (debounced), toggled in the ⋯ menu.
- **Preview:**
  - Uses the existing preview endpoint with sample values. Entering Preview saves the draft first if it has unsaved edits.
  - Toolbar: **Standard samples / Long values** · Highlight variables (#FFF1CC; a missing variable renders as "[missing: key]" on #F8E9E6) · "N pages · A4" · zoom 60–150% in steps of 10.
  - Pages are 794×1123 with a 24px gap on #DDE1E7. Each has a header (organization legal name · document title, 11px), the H1 title on page 1, and a footer (template ID · version in mono · "Page n of N").
  - *Data gap:* exact PDF pagination. Page breaks are estimated in the client.
- **Publish vN:**
  - The dialog shows a from → to Change box and the consequence: "vN becomes the platform default for every tenant that uses this template. Documents already sent are not changed. vN−1 is marked Replaced and stays viewable."
  - Four stat tiles: Added · Changed · Removed · Variables.
  - A warning line appears if inactive variables are used. Commit is terracotta.
- **Version view:**
  - A blue bar (#E6EFF8): "Viewing vN", pill, date and "read only".
  - Actions: **Compare with draft** · **Restore into draft…** (replaces the draft content; published versions are untouched) · **Back to draft**.
- **Compare (NEW `VersionDiff`):**
  - Modal `min(1180px,96vw)` × `min(860px,92vh)`.
  - Header: left select ⇄ right select (Draft and every version), stat pills (Added #D3EBDD/#17603C · Changed #FAF0DC/#6B4609 · Removed #F6D9D2/#7A2E21 · Unchanged), and a **Changes only** toggle.
  - Body: a 44px marker column (+ / − / ~) and two content columns.
  - Algorithm: LCS over block plain text. Adjacent removed and added blocks pair up as "changed" and are word-diffed (LCS on whitespace tokens). Removed words are struck through on #F6D9D2; added words sit on #D3EBDD.
- **Withdraw:**
  - Fields: Notice period (0–365 days, default 7) and Reason* ("Shown to tenant admins with the notice."), with the live line "Takes effect {date}". 0 withdraws immediately.
  - While a withdrawal is pending, an amber bar sits under the header with **Cancel withdrawal**.
- **View-only (`:read`):** the published version shows in Preview only, with the bar "**View only.** You're seeing the published version…". *Data gap:* draft preview for `:read`.

### 10.8 Shortcuts (sheet opened with `?` or from the ⋯ menu)
⌘S save draft · ⌘⇧P toggle preview · ⌘B / I / U · `/` block menu · `{{` variable · Enter new paragraph · ⌥↑ / ⌥↓ move block · Backspace delete empty block · ⌘Z / ⌘⇧Z undo / redo · ⌘\\ collapse sidebar · ? this sheet · Esc close menus and dialogs.

## 11. Auth
- **Sign-in (`SignInPage`):**
  - 50/50 grid. The brand panel is #022AC0.
  - The card is 420px: "Aramo Platform administration" / "Sign in with your Aramo staff account.", with 44px Microsoft and Google buttons.

Use the **existing** `/login?error=CODE` codes handled in `libs/fe-foundation/src/auth/SignInPage.tsx` (`TENANT_ACCESS_DENIED`, plus the `reason=idp_not_permitted_for_tenant` variant, `INSUFFICIENT_PERMISSIONS`, `TENANT_CAPABILITY_NOT_ENTITLED`, `TENANT_SUSPENDED`, `TENANT_CLOSED`, `VALIDATION_ERROR`, `INTERNAL_ERROR`). Pass the platform copy through the existing `errorCopy` prop; don't edit SignInPage and don't add codes.

| Code (existing) | Title | Body | Action |
|---|---|---|---|
| `TENANT_ACCESS_DENIED` | You're signed in with an account that can't use Platform administration. | Use your Aramo staff account (@aramo.ai). Last account: {email} | **Use a different account** |
| session-expired code (existing) | Your session ended. | Sign in again to continue. | — |
| provider-failure code (existing) | The sign-in provider didn't respond. | Try again, or use the other provider. | — |

- **Platform variant (flag, NEEDS RULING):** a #0B1022 panel with a 6px terracotta top bar and a PLATFORM ADMIN chip.
- **Signed out (`SignedOut`):** "You've signed out securely" / "Your Platform administration session has ended on this device.", with **Sign in again** and **Sign in with a different account**.

## 12. Components
- `fe-foundation/src/components` is **frozen** (DDR v1.2 §6): no new variants there. Build NEW items in `platform-web`.
- `src/ui` changes (rail midnight theme, StatusPill `muted` tone) are allowed but affect every app: ship them in their **own PR** with platform-web regression coverage.

| Element | Component | Status |
|---|---|---|
| Shell, rail, top bar, breadcrumb | AppShell · Rail · RailNavSection/Item · TopBar · Breadcrumb | EXISTING; the rail gets the midnight theme |
| Environment bar | — | NEW |
| PLATFORM marker | — | NEW, local to platform-web (`fe-foundation/src/components` is frozen, DDR v1.2 §6) |
| Account menu | UserMenu | EXISTING; adds "Sign in with a different account" |
| Command palette | CmdKSearch | EXISTING; grouped results NEW |
| Status tiles | KpiCard | EXISTING; clickable |
| Tables | DataTable | EXISTING |
| Filter bar | — | NEW |
| Status pill | StatusPill | EXISTING; adds the `muted` tone |
| Lifecycle action menu | — | NEW |
| Confirm dialog | Dialog + FormField + Select / TextArea / Checkbox | EXISTING; from → to + consequence pattern NEW |
| Confirm by typing | Input | NEW `TypedConfirm` |
| Timeline · Skeleton · Empty state · Detail drawer · Diff view · Stepper · One-time secret | — | NEW |
| View-only note, info/warning alerts | — | NEW, local to platform-web (InlineAlert frozen; compose, don't modify) |
| Tag input | TagList + Input (composed, no Tag changes) | NEW, local |
| Template editor, paginated preview, readiness pill, checks list, version diff | — | NEW |
| Access denied · Sign-in · Signed out | ForbiddenState · WrongAccountRecovery · SignInPage · SignedOut | EXISTING |
| Toast | Toast | EXISTING |

## 13. Endpoints used (existing)
- **Dashboard and tenants:**
  - `GET /platform/dashboard`
  - `GET` / `POST /platform/tenants`
  - `GET /platform/tenants/:id`, `/audit`, `/sign`, `/domain`
  - lifecycle transitions
  - resend owner invite
  - invite tenant users
  - domain promote / release / grant exception / revoke exception
- **Sign Personal:**
  - `GET /platform/personal-review`, its actions and report decisions
  - `POST /platform/personal-invites`
- **Platform admins:** platform admin invite.
- **Skills (main API):**
  - registry, detail, aliases, versions and relationships
  - merge, override
  - review queue
  - proposals accept / reject
- **Document templates (main API):**
  - create
  - update name / description / tags
  - save draft, preview, publish
  - versions and view a version
  - withdraw / cancel withdrawal
- **Template variables (main API):** create, update.
- **Matching policy (main API):** versions, create draft, activate.

## 14. Data gaps (list in the PR)
| Gap | Where |
|---|---|
| Pilot seat usage (no read endpoint; cap only via `personal_pilot_full`) | Pilot invites |
| Labels to confirm against real enum values: alias types, relationship sources, skill version states, queue "first seen", registry "aliases"/"updated" columns, template "Start from a copy" | Skills, Template library |
| Operator name and email in the session | Account menu, environment bar, access denied |
| `kind` in the tenant list DTO; `slug` in tenant detail | Tenants list, tenant header |
| Server paging and sorting | Tenants, skills, templates, variables |
| Unified tenant timeline (domain and Personal events) | Tenant › Lifecycle & audit |
| Tenant members list; platform admins list | Tenant › People; Platform admins |
| Template preview for `:read` | Template detail, Studio view-only |
| Section library storage and usage counts | Studio › Sections |
| Tables, H3, alignment, conditional blocks | Studio toolbar, slash menu |
| Server-rendered PDF pagination and download | Studio preview, ⋯ menu |
| UPLOADED_PDF / HYBRID authoring | Studio › Properties |

**Product decisions:** per-action lifecycle reason-code lists (§7); Sign Personal report categories and how long records are kept after close.
**Needs ruling:** the platform sign-in panel variant (§11); any top-nav alternative (OPEN-UI-4, not proposed).
**Out of scope:** changing plans, subscriptions or capabilities; billing operations; tenant-side apps; public signup; any tenant health or rating metric.

## 15. Accessibility
- One skip link and one `main`. `aria-current="page"` on nav items and the last breadcrumb item.
- Dialogs and drawers trap focus, close on Esc and return focus to the opener.
- **ARIA roles:**
  - Tabs: `role="tab"` / `aria-selected`.
  - Segmented filters and toggles: `aria-pressed`.
  - Sortable headers: `aria-sort`.
  - The Studio toolbar: `role="toolbar"`.
- Feedback uses `role="status"` / `role="alert"`; save status is `role="status"`.
- Colour is never the only cue (pill text, ✓ / ! / ×, the active rail bar, + / − / ~ markers).
- Visible focus: 2px #022AC0 at offset 2px (#7FB0FF on dark).
- Hit targets are at least 30px in dense toolbars and at least 36px elsewhere. Respect reduced motion.

## 16. Acceptance
1. Every screen matches the design files at 1440px and 900px: same tokens, spacing, copy and states.
2. The environment bar and account menu always show the signed-in identity. Access denied renders inside the shell with the account, the missing permission, and **Sign in with a different account** (journey 10).
3. Each action is gated by the permission in §2. An auditor (read-only) sees view-only notes, never silently missing buttons.
4. Dashboard tiles open the filtered tenant list. Errors are per panel. There is no rating metric anywhere.
5. Provision walks through all 3 steps, maps every error in §6.2, and lands on the tenant detail with a toast.
6. Lifecycle menus offer only the transitions in §7. Each dialog shows from → to and the consequence, and writes a timeline event.
7. Sign Personal drawer actions follow the state table. Reports stay viewable on closed accounts. `until_in_past` is handled.
8. Proposals handle a 409 gracefully. Matching activation shows the impact diff.
9. Studio:
   - Publish stays locked until every required check passes.
   - Removing the unknown variable from Checks unlocks it after save and preview.
   - Drag and drop works for blocks, outline rows, sections and variables.
   - `/` and `{{` work.
   - Compare, restore and withdraw behave as described in §10.7.
   - Serialisation round-trips exactly.
10. No prototype-only element ships, and every data gap is visibly degraded and listed in the PR.
