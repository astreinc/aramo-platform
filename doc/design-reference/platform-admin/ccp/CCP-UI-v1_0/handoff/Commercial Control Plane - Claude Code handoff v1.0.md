# Aramo Platform Admin: Commercial Control Plane (CCP Phase B) — Claude Code handoff

**Status: CCP-UI v1.0 design release — a pinned INPUT to CCP Phase B slices under Aramo-CCP-Program-Build-Directive-v1_0 (LOCKED). Not a directive; authorizes no build by itself.** Each CCP UI slice pins this release by SHA-256 (`MANIFEST.sha256`) in its pre-execution record (PLATFORM-UX-1 Amendment A1-5; Program Build Directive §2, §6.2).

## Design files
| Role | File |
|---|---|
| Design authority | `ccp/CCP-UI-v1_0/Commercial Control Plane v1.0.dc.html` |
| Mock data and pure helpers | `ccp/CCP-UI-v1_0/ccp-data.js` (prototype only, never ship) |
| Runtime | `ccp/CCP-UI-v1_0/support.js` (byte-identical copy of the PLATFORM-UX-1 pinned `platform/support.js`) |
| Handoff | `ccp/CCP-UI-v1_0/handoff/Commercial Control Plane - Claude Code handoff v1.0.md` (this file) |
| Design amendments log | `ccp/CCP-UI-v1_0/handoff/Commercial Control Plane - design amendments log v1.0.md` |
| Manifest | `ccp/CCP-UI-v1_0/MANIFEST.sha256` — SHA-256 of every file above |

The `platform/` working copies are superseded by `ccp/CCP-UI-v1_0`. Later design changes go in as numbered entries in the amendments log, or as a v1.1 release with a new manifest — never as edits to this release.

The values in these files are normative. Where this document and a file disagree, the file wins; record the difference.

## Relationship to PLATFORM-UX-1 (pinned, unchanged)
- `Platform Admin.dc.html`, `Template Studio.dc.html` and their handoffs are **not modified**. The CCP design lives in its own release because PLATFORM-UX-1 forbids in-place edits.
- **Shell:** the CCP file reproduces the pinned shell. It uses the same midnight rail tokens, environment bar, top bar, account menu, page header, card, table, pill, dialog and toast specs (PLATFORM-UX-1 handoff §3). Everything in that section still applies here; this document lists only the deltas.
- **Rail:** items that belong to existing screens open the pinned console and are marked ↗ in the prototype. In production there is **one console and one rail** (inside CCP slice scope per PLATFORM-UX-1 Amendment A1-4 and A1-6; no PLATFORM-UX-1 amendment needed): the Commercial group and the tenant Commercial tab are added to the existing app (see §2).
- **Order of authority:** CCP Program Build Directive › PLATFORM-UX-1 Amendment A1 › this handoff's amendments › CCP design file › this handoff. PLATFORM-UX-1 rulings still govern everything outside the commercial scope.

## Scope
**Scope rules:**
- **Front end only.** The CCP backend contract isn't defined in this project. Every endpoint below is **NEEDS BACKEND / NEEDS CONTRACT** until the Architect publishes it.
- **Mock data only in the prototype.** Prices and plan names are SAMPLE. ATS, Portal and Intelligence have no plans ("No commercial plans yet — pricing not set").

**Out of scope:**
- real Stripe screens (link out only)
- invoices and payment-method editing
- tax
- revenue charts (no MRR/ARR)
- tenant-facing self-service UI
- the dashboard commercial panel (deferred)
- any change to existing non-commercial screens beyond the new rail group, the tenant tab and the Platform admins roles

**Don't build these prototype-only elements:**
- the dashed "PROTOTYPE — NOT AUTHORIZED FOR BUILD" chip in the environment bar
- the retired pilot policy **v0** and requests created under it (CR-1039, CR-1046, CR-1047, CR-1048, CR-1050, CR-1038 show v0) — policy numbering starts at **v1** (Q12)
- the account-menu persona switcher
- Tweaks: `persona`, `bootstrap`, `demoState`, `startRoute`
- the "Prototype: simulate Stripe webhook" button
- the Prototype rail group (Screen inventory, Open questions)
- the ↗ link-out rail items
- the reduced Tenants list (use the real list; only the Commercial tab is new)
- `ccp-data.js`, a fixed `NOW`, and the simulated 900 ms apply delay

## 1. Flow
```
Commercial role signs in ─▶ Commercial › Approvals ("Waiting on me")
   └─ row ─▶ Change request drawer ─ Approve / Reject (reason) ─▶ next step | APPROVED ─▶ APPLYING ─▶ APPLIED
                                                                  └─ Stripe-side ─▶ "Sent to Stripe — awaiting confirmation" ─ webhook ─▶ APPLIED
Tenants ─ tenant ─▶ Commercial tab ─ action ─▶ dialog (diff, chain preview) ─▶ new CR (PENDING_APPROVAL or DRAFT) ─▶ drawer
Support extension ─ within bounds ─▶ applied now as EXCEPTION (0 approvals, audited)
                  └ out of bounds ─▶ CR, PENDING_APPROVAL
Catalog / Policy / Platform admins / Contracts ─ action ─▶ CR (same lifecycle)
Super admin ─ any Commercial route ─▶ in-shell AccessDenied naming the commercial roles
```

## 2. Navigation and access
- **Rail:** a new **Commercial** group sits between Documents and Platform, in this order:
  - Approvals
  - Subscriptions
  - Catalog
  - Contracts
  - Policy
  - Audit
- **Tenant detail tabs:** Overview · Lifecycle · Sign · **Commercial** (NEW, after Sign) · Domain · People.
- **Active item:** Tenant › Commercial highlights **Tenants**. The change request drawer opens over its page and doesn't change the active item.
- **Breadcrumb:** Commercial / {page}; Operations / Tenants / {tenant name}.
- **Hidden groups:** a group with no visible items is hidden (unchanged rule).

| Persona | Rail groups visible |
|---|---|
| super_admin | All existing groups. **No Commercial group.** Platform admins shows roles read-only. Tenant tabs as today, without Commercial. |
| platform_owner | Operations (Tenants), Commercial (all), Platform admins |
| finance_admin, commercial_ops, catalog_manager, support_admin | Operations (Tenants), Commercial (all) |
| read_only_auditor | Operations (Tenants), Commercial (all, view only), Platform admins (view only) |

- **Assumption: commercial roles get read-only tenant access** (OPEN Q-11). The Dashboard and the other operations groups are hidden for them.
- **Deep links:** a super_admin deep link to any Commercial route renders **AccessDenied in the shell**, with no redirect. The card contains:
  - "No access" pill
  - title "This account can't open Commercial {page}"
  - body "Super admin holds no commercial authority. Commercial screens are open only to people with a commercial role."
  - signed-in email, current role, and the six roles that grant access as chips
  - actions: "Sign in with a different account" and "Back to tenants"
  - footnote "Tenant operations are unchanged for this account."
- **Read without change:** every page uses the PLATFORM-UX-1 view-only note, e.g. "**View only.** You can view the catalog. Drafting, publishing and retiring versions needs the **Catalog manager** role." Disabled buttons carry the reason in their tooltip. Domain reasons (e.g. "Managed in Stripe…") are also listed inline under the card's actions.

## 3. Roles, scopes and chains
| Role | Can make | Can sign |
|---|---|---|
| platform_owner | Role change, Policy activation / rollback | Owner step |
| finance_admin | Policy activation / rollback | Finance step |
| commercial_ops | Plan change, Cancel, Grant / Revoke product, Credit, Discount, Reconciliation release, Contract amendment / end | — |
| catalog_manager | Plan version draft, Publish, Retire | — |
| support_admin | Support extension | — |
| read_only_auditor | — (read and export audit) | — |

**Approval chains** come from the policy version a request was created under, and that version is shown on the request:

| Chain | Steps | When |
|---|---|---|
| Above threshold | Finance → Owner (ordered) | discount > policy %, credit > policy $, MANUAL cancel, contract amend / end |
| Below threshold | Finance | everything else commercial_ops / support_admin make (incl. escalated extensions, reconciliation release) |
| Catalog publish | Finance → Owner | publish and retire |
| Role change (privileged) | a distinct Platform owner | all role changes (OPEN Q-2) |
| Policy change | Finance → Owner | activation and rollback (OPEN Q-1) |

### 3.1 Eligibility (per distinct person, not per role)
Evaluate in this order; the first match wins. The drawer shows the verdict inline, the Approve and Reject buttons stay disabled, and the footer repeats the reason.

| # | Code | Label | Why line |
|---|---|---|---|
| 1 | NOT_PENDING | Not pending | This request is {state}. |
| 2 | EXPIRED | Expired | The approval window closed {relative}. |
| 3 | NOT_HUMAN | Not a human actor | Service accounts can't sign approval steps. |
| 4 | SELF | You requested this | The person who made a request can't approve it. |
| 5 | DUP | You already approved a step | One person can sign only one step, even when they hold two roles. |
| 6 | ORDER | Out of order | The {Finance} step must be signed first. (The user holds a later step's role but not the current one.) |
| 7 | SCOPE | Missing the scope for this step | The {Finance} step needs the {Finance admin} role. / The {role} was removed {date}, before approving. |
| ok | OK | You can sign the {Finance} step | Approving records your name and current roles in the audit log. |

- The drawer also lists **every other admin's verdict** for the current step ("Who can sign the Finance step") as ✓ Can sign or the reason label.
- Roles are evaluated at the time of the action. A signature already made isn't voided if the signer later loses the role (OPEN Q-5).

### 3.2 Bootstrap gate
- **Fulfillable rule (assumed, OPEN Q-3):** a chain is fulfillable when the roster contains a human maker with one of the chain's maker roles **and** a different human for each step, all distinct.
- **When any chain is unfulfillable**, an amber banner appears under the top bar on every Commercial page (`role="alert"`): "**Commercial approvals unavailable: not enough distinct approvers for** {Chain (Finance → Owner)}, …" · "Approvals on these chains return `409 CCP_NOT_BOOTSTRAPPED`." · **View chains** (goes to Platform admins).
- Approve on an unfulfillable chain shows a drawer alert: "**Approval refused.** The {chain} chain doesn't have enough distinct eligible approvers yet. (409 CCP_NOT_BOOTSTRAPPED)". It is audited as *Approval refused*.
- **Creating requests is still allowed** (OPEN Q-4).

### 3.3 Last owner
- In the role-change dialog, removing Platform owner from the only owner shows the alert "Refused: {name} is the last Platform owner. Grant Platform owner to another person first, then remove it here.", and commit is disabled.
- The roster note reads "Last Platform owner — removing this role is refused."

## 4. Change request lifecycle
- **States:**

| State | Tone |
|---|---|
| DRAFT | neutral |
| PENDING_APPROVAL | info |
| APPROVED | info |
| APPLYING | info |
| APPLIED | ok |
| APPLY_FAILED | danger (retryable) |
| REJECTED | muted (terminal) |
| EXPIRED | muted (terminal) |
| WITHDRAWN | muted (terminal) |

- **Labels:** Draft, Pending approval, Approved, Applying, Applied, Apply failed, Rejected, Expired, Withdrawn.
- **Stepper (NEW `CrStepper`):**
  - Chips 28px tall, 14px radius, one per main state: Draft → Pending approval → Approved → Applying → Applied.
  - Marks: done ✓ (#E3F1EA / #17603C), current ● (#E6EFF8 / #1E4E80), not reached ○ (white, #E5E9ED).
  - Terminal states mark the reached chip ✕ (#F8E9E6 / #7A2E21), dim later chips to 45%, and append a terminal chip.
  - While a Stripe-side request is Applying, that chip reads "Sent to Stripe — awaiting confirmation".
- **Applied means both sides.** Tenant-scoped requests show an **Apply** panel with Subscription and Entitlement rows:

| Value | Label | Colour |
|---|---|---|
| done | ✓ Applied | #1F7A4D |
| failed | ✕ Failed | #A8412F |
| sent | … Sent to Stripe — awaiting confirmation | #2C6FB3 |
| applying | … Applying | #2C6FB3 |
| na | — No change on this side | #5C6770 |
| unchanged | — Unchanged | #5C6770 |
| pending | ○ Waiting for the other side | #5C6770 |

- **Sides by type** (subscription · entitlement):

| Type | Subscription | Entitlement |
|---|---|---|
| Plan change | ✓ | ✓ |
| Cancel | ✓ | ✓ |
| Grant | — | ✓ |
| Revoke | — | ✓ |
| Credit | ✓ | — |
| Discount | ✓ | — |
| Extension | ✓ | — |
| Reconciliation release | ✓ | — |
| Contract amend | ✓ | — |
| Contract end | ✓ | ✓ |

- APPLIED appears only when every side that applies is done.
- **Stripe-side commands** never show "Done" before the webhook: credits on self-service tenants (OPEN Q-6) and reconciliation release.
- APPLY_FAILED shows "Failed with `{CODE}`. The request stays Apply failed until a retry succeeds." **Retry apply** is available to commercial_ops and platform_owner.
- **TTL:** the approval window is the creation policy's TTL (72 h in v1). Rows show "{n} h left" (amber under 12 h) or "Expired {relative}".
- **Requester actions:** Submit for approval (from Draft) and Withdraw (from Draft or Pending).
- **One open request per tenant × product.** Other actions on that product are disabled with the note "Open request {CR} · {type} · {state}. Other requests on this product wait until it closes." (prototype rule; confirm.)

## 5. Screens

### 5.1 Approvals inbox (`/commercial/approvals`)
- **Header:** H1 "Approvals". Intro: "Every commercial change is a change request. It applies only after each step in its chain is signed by a different person, within the approval window set by the policy it was created under."
- **Tabs** (count badge mono on #EEF1F4):
  - **Waiting on me:** pending and my verdict is OK. Default tab.
  - **All pending**
  - **Requested by me**
  - **History:** everything except pending and drafts.
- **Columns:**

| Column | Content |
|---|---|
| Request | ID mono #022AC0 600, then the type |
| Tenant · product | Tenant name, or "Platform" |
| Change | Summary, then "by {name} · {relative}" |
| Chain | "Finance ✓ › Owner ○" (signed in #1F7A4D) |
| State | Pill |
| Expires | Countdown |
| Policy | vN mono, with "older version" in #946011 when the request is open and was created under a non-active version |

- **Sort:** pending rows by soonest expiry, the rest newest first. A row click opens the drawer.
- **Empty states per tab:**

| Tab | Title | Body |
|---|---|---|
| Waiting on me | Nothing waiting on you | Requests appear here when you can sign their current step. |
| All pending | No pending requests | New change requests appear here until every step is signed. |
| Requested by me | You haven't made any requests | Requests you create from tenants, the catalog, policy or roles appear here. |
| History | No history yet | Applied, rejected, expired and withdrawn requests appear here. |

### 5.2 Change request drawer (NEW, on `DetailDrawer`)
- **Size:** `min(640px,96vw)`, right side, overlay rgba(15,25,40,.32). Esc closes it and focus returns to the opener.
- **Header:** ID (mono 13px 600), state pill, then H2 "{Type} · {summary}" (18px 700).
- **Body, in order:**
  1. **Facts:** Tenant · product; Requested by (name · roles); Created (mono UTC); Approval window ("Expires … · n h left"); Policy ("vN (active is vM)" · chain {label: steps} (fixed at creation)).
  2. **Stepper.**
  3. **Alerts:** 409 refusal; request note (amber, e.g. the older-policy explanation or the escalation reason).
  4. **Effect · before → after (DiffView):** three columns; before struck through on #F6D9D2/#7A2E21, after on #D3EBDD/#17603C 600.
  5. **Reason** and **Evidence.**
  6. **Approval chain:** one row per step with a 22px badge (✓ or the step number), "Finance · Finance admin", and "Signed by {name} · {UTC}" / "Waiting" / "Not started" / "Not signed".
  7. **Your eligibility** (pending only): green box (#F1F8F4 / #BFDCCB) for OK; otherwise grey with "You can't approve: {label}" and the why line.
  8. **Who can sign the {step} step** (pending only).
  9. **Apply panel** (§4).
  10. **Timeline** (Timeline): submitted, steps signed, terminal or Stripe events, newest first, each with UTC mono and actor · role.
- **Footer** (#FAFBFC):
  - **Approve** (terracotta) and **Reject…** (secondary), both disabled unless eligible.
  - Submit for approval / Withdraw for the requester; Retry apply.
  - Footnote with the refusal label.
- **Reject dialog:** "Reason (required)", danger commit **Reject request**.

### 5.3 Subscriptions workbench (`/commercial/subscriptions`)
- **Intro:** "Every open base subscription across tenants. MANUAL rows are governed contracts; SELF-SERVICE rows are owned by Stripe and read-only here."
- **Filters:**
  - Status segmented with counts: All · Active · Past due · In grace · Suspended · Ended. "In grace" = past due with a grace date.
  - Product, Source (Manual (contract) / Self-service (Stripe)), Plan version, Commitment ending (30 / 60 / 90 days).
  - "Has reconciliation flag" checkbox, and a result count "n of N".
- **Columns:**

| Column | Content |
|---|---|
| Tenant | Name, then slug (mono) |
| Product · plan | Plan with a SAMPLE tag |
| Version | vN mono, plus "· grandfathered" when the version is retired |
| Source | Badge: **Managed in Stripe** (#E9EDFB / #011F8D / #C9D2F5) or **MANUAL · {contract}** (white / #3F4A55 / #D5DBE1) |
| Status | Pill: Active ok · Past due (· in grace) warn · Suspended danger · Ended muted |
| Period · grace | Period, then "Grace ends {date} ({rel})" / "Suspended {date} after grace" / "Ended {date}" |
| Commitment end | Date, then "in n days" |
| Flags | Reconciliation flag (#FAF0DC/#6B4609), Extension · exception (#FBE7DF/#8A3A1F) |

- A row click opens Tenant › Commercial.
- **Empty:** "No subscriptions match these filters" with **Clear filters**.

### 5.4 Catalog (`/commercial/catalog`)
- **Product cards:** Aramo Sign ("5 plans · SAMPLE"). ATS, Portal and Intelligence read "No commercial plans yet — pricing not set"; selecting one shows the dashed empty card "{Product} is granted as an entitlement only. Plans appear here once pricing is decided."
- **Plans list:** "Aramo Sign plans" with a "SAMPLE NAMES AND PRICES" tag. Each row shows name, latest price, version states and "n on v1, m on v2". The selected row has a 3px midnight left bar.
- **Versions panel:** version chips (mono vN, state pill Published ok / Draft neutral / Retired muted, "n pinned") and the grandfathering line "n tenant(s) on v1 · … Subscriptions keep their pinned version."
- **Version editor** fields: Price per month (USD), Envelopes per month, Seats, Storage (GB).
  - **Locked fields:** Currency = USD and Billing interval = Monthly. Dashed border, "🔒 v1 limit", tooltip "v1 release limitation — the schema supports more".
  - **Published versions are read-only:** "Published versions are immutable. To change pricing or allowances, create a new draft."
  - Enterprise is contract-priced; its price field is disabled.
- **Draft diff** against the latest published version: changed rows get "~", a #FFFBF2 background, the before value struck through and the after value in 700.
- **Pinned tenants:** "Tenants pinned to this version" lists names, with "(grandfathered; no new subscriptions)" on retired versions.
- **Actions:**
  - Draft: **Request publish…** (Catalog chain; disabled while a publish request is open, with an info link "Publish request {CR} is {state}").
  - Published: **Create new draft from vN** (only one draft per plan), **Request retire…** (TypedConfirm "{Plan} vN").

### 5.5 Contracts (`/commercial/contracts`)
- **Intro:** "Enterprise MANUAL subscriptions recorded with their evidence. This is a record of what was agreed, not a quoting tool; changes go through change requests."
- **Layout:** list (ID mono, Active/Ended pill, tenant, "n months · ends {date}") beside a detail panel.
- **Detail panel:**
  - ID, then "{tenant} · Sign {plan}", plus a "Migrated — provenance: migration" badge where it applies.
  - Facts: Commitment, Ends, Source, Provenance.
  - Negotiated terms list.
  - Documents table (name, hash `sha256:…` mono, recorded by · date).
  - Amendments Timeline.
- **Actions:** **Record amendment…** (Above-threshold chain) and **End contract…** (danger, TypedConfirm = contract ID).

### 5.6 Policy (`/commercial/policy`)
- **Intro:** "Thresholds and windows that decide which approval chain a request gets. Exactly one version is active. Activating or rolling back a version is itself a change request, and existing requests keep the chain they were created with."
- **Versions list:** vN, note, pill (Active / Draft / Retired), "Created {date} by {name} · activated · retired".
- **Settings table:** columns Setting · Active · This version, with a "~" mark on changed rows.

| Setting | Active v1 value | Allowed range |
|---|---|---|
| Discount approval threshold | 20% | 0–100 |
| Credit approval threshold | $500 | 0–100,000 |
| Support extension, per use | 14 days | 1–60 |
| Support extension frequency | once per tenant per 90 days | 30–365 |
| Support extension, cumulative cap | 30 days | 1–120 |
| Approval window (TTL) | 72 h | 12–168 |
| Past-due grace | 7 days | 0–30 |

- **Editing:** values are editable inline only on a Draft, by platform_owner or finance_admin.
- **Actions:**
  - Draft: **Request activation…**
  - Retired: **Request rollback to vN…**
  - Active with no draft: **Create draft from vN**
  - Only one policy request can be open at a time.

### 5.7 Audit (`/commercial/audit`)
- **Intro:** "An append-only record of every commercial event. Entries can't be edited or deleted — corrections are new events."
- **Filters:** Actor, Tenant, Product, Event type, a "Change request" text field, and "Exceptions only".
- **Columns:**

| Column | Content |
|---|---|
| Time | UTC mono, then event ID mono |
| Event | Label, plus an EXCEPTION tag where it applies |
| Actor · roles at the time | Name, then roles |
| Tenant · product | Tenant, then product |
| Request | CR link (opens the drawer) |
| Detail | Free text |

- **Footer:** "Append-only · N events · newest first". No row actions.
- **Export CSV ({n}):** exports the filtered rows with columns `id,time_utc,event,actor,roles,tenant,product,change_request,exception,detail`. **The export is itself an audit event.**
- **Event labels:**
  - Change request submitted / drafted / rejected / expired / withdrawn
  - Approval step signed
  - Change applied · Apply failed · Apply retried
  - Sent to Stripe · Stripe confirmed (webhook)
  - Support extension applied (exception)
  - Role removed · Subscription migrated · Reconciliation flag raised
  - Approval refused · Audit exported · Plan version drafted

### 5.8 Platform admins: commercial roles (extends the existing page)
- **Approval chains panel:** one cell per chain with its label, "Maker: {roles} → {steps}" and a Fulfillable (ok ✓) / Not fulfillable (warn ✕) pill. Help line: "A chain is fulfillable when one person can make the request and different people hold each step's role."
- **Roster:** person (avatar, name, email mono), role chips, notes, **Request role change…** (platform_owner only).
  - Chips: privileged roles (Platform owner, Finance admin) use #FBE7DF / #8A3A1F / #D97757; others are white with a #D5DBE1 border.
  - Super admin shows "Super admin · no commercial roles".
  - Notes: last owner · "Holds two roles. Can still sign only one step per request." · role removed · pending role CR.
- **Role change dialog:** toggle chips for the six roles, Reason*, Evidence*. Diff of current → new roles. Privileged-role chain. Last-owner refusal (§3.3).

### 5.9 Tenant › Commercial tab (NEW)
- **Cards:** one per product (Aramo Sign, ATS, Portal, Intelligence).
- **Card header:** product name, entitlement pill (Entitlement active ok / Revoked muted / Not granted neutral) and source badge.
- **Provenance, right-aligned:**
  - "Granted by provisioning · {date}"
  - "Granted by change request {CR} · {date}"
  - "Migrated — provenance: migration · {date}"
  - "Revoked {date} · {CR} · was …"
- **Subscription facts:**
  - Plan (SAMPLE)
  - Plan version "vN · pinned" ("Retired — grandfathered")
  - Status with its grace or suspension line
  - Current period
  - Commitment end (contract ID, or "Self-service, no commitment")
  - Allowance bar: 6px, midnight fill, #946011 at 90% or more, "n of N envelopes"
- **No subscription:** "No open base subscription." Products without plans: "No commercial plans yet — pricing not set. This product is granted as an entitlement only."
- **Self-service box:** "**Managed in Stripe.** The tenant pays through self-service checkout. Aramo doesn't edit this subscription." with link-outs Invoices ↗ · Payment methods ↗ · Proration ↗ · Cancellation ↗.
- **Reconciliation flag** (`role="alert"`, amber): "**Reconciliation flag · self-service checkout blocked.** {detail} The MANUAL subscription was not replaced." It is followed by the release state with a CR link, or **Request reconciliation release…** (commercial_ops, Below-threshold chain, Stripe-side).
- **Exception overlay:** 1.5px terracotta border; header #FBE7DF "EXCEPTION · +n day support extension · applied with zero approvals · EXT-id". Rows:
  - Actor · time
  - Roles at the time
  - Policy clause
  - Uses in 90-day window
  - Cumulative days (before → after, cap)
  - Stripe billing: "Overlay only — Stripe period and invoices unchanged"
- **Actions** (disabled with a tooltip; domain reasons are also listed under the actions):

| Action | Domain reason when disabled |
|---|---|
| Request plan change… | No commercial plans yet · No open subscription · Managed in Stripe. The tenant changes plans in Stripe checkout. · Enterprise is contract-priced; record a contract amendment instead. |
| Request cancel… (danger, TypedConfirm = tenant name) | No open subscription · Managed in Stripe. Cancellation happens in Stripe. |
| Grant product… (when not active) / Revoke product… (when active; danger, TypedConfirm) | — |
| Request support extension… | No open subscription |

- **Plan change dialog:** plan select (latest published versions with SAMPLE prices) and discount %, with the help line "Above {n}% needs Finance → Owner (policy vN)." Live diff of plan, version, price, discount and allowance. Live chain preview. Reason* and Evidence*. **Save as draft** or **Submit for approval**.
- **Support extension dialog:** days and reason*, plus the clause help line. A live preview box (`role="status"`) shows one of two paths:
  - **Within bounds** (green): "Within bounds — applies now as an exception, with zero approvals". It lists the actor and roles, the policy clause, uses n → n+1 in the window, cumulative days with the cap, and "Recorded in audit with the exception flag". Commit: **Apply extension (exception)**.
  - **Out of bounds** (amber): "Out of bounds — escalates to approval (Finance)" with the reason (more than the per-use days, already used inside the window, or the cumulative cap). Commit: **Submit for approval**.

### 5.10 Dialog pattern (extends PLATFORM-UX-1 §3.8)
- **Size:** `min(600px,94vw)`.
- **Body, in order:** fields → Before → after diff → preview box → **chain preview** strip ("Approval chain · {label} · Finance → Owner · policy vN · 72 h window", with "· not fulfillable yet" when bootstrapping) → TypedConfirm → refusal alert.
- **Footer:** Cancel · Save as draft (where offered) · commit.
- **Commit tones:**
  - terracotta for privileged requests
  - danger (#A8412F, white) for cancel, revoke, retire, end contract and reject
  - midnight otherwise

### 5.11 ⌘K
Results are grouped as PAGE · TENANT · REQUEST (ID · type, state), filtered by what the persona can see.

## 6. Components
| Element | Component | Status |
|---|---|---|
| Shell, rail, top bar, env bar, account menu | PLATFORM-UX-1 shell | EXISTING (Commercial group added; NEW tag shown only in the prototype) |
| Pills | StatusPill | EXISTING (muted tone from PLATFORM-UX-1) |
| Tabs, tables, filters | Tabs · DataTable · FilterBar | EXISTING / PLATFORM-UX-1 NEW |
| Drawer | DetailDrawer | PLATFORM-UX-1 NEW |
| Diff | DiffView | PLATFORM-UX-1 NEW (three-column before/after variant) |
| Timeline, Stepper, TypedConfirm, ConfirmDialog, ViewOnlyNote, EmptyState, Skeleton, AccessDenied | — | PLATFORM-UX-1 NEW |
| CR state stepper | `CrStepper` | NEW |
| Approval chain list + chain progress inline | `ApprovalChain` | NEW |
| Eligibility verdict box + roster verdict list | `EligibilityVerdict` | NEW |
| Apply-sides panel | `ApplyStatus` | NEW |
| Chain preview strip | `ChainPreview` | NEW |
| Bootstrap banner | InlineAlert (warning) full-width | NEW usage |
| Exception overlay card | `ExceptionOverlay` | NEW |
| Source badge (Managed in Stripe / MANUAL) | Tag | NEW variant |
| Locked v1 field | Input (disabled, dashed) + tooltip | NEW variant |
| Allowance bar | — | NEW (reuse the Sign usage bar from PLATFORM-UX-1 §6.3) |

## 7. Endpoints (all NEEDS CONTRACT)
| Area | Calls |
|---|---|
| Change requests | list (filters: state, requester, eligible-for-me), get, create, submit, withdraw, approve step, reject, retry apply. Must return the per-step verdict for the caller and for every admin, or the UI computes it from roster plus roles |
| Policy | versions list, draft create / update, chain resolution for a draft request (preview) |
| Subscriptions / entitlements | per-tenant product state with source, pinned version, period, grace, suspension, usage, provenance, reconciliation flags, extensions |
| Catalog | products, plans, versions (draft edit), version pin counts |
| Contracts | list, get (terms, document hashes, amendments) |
| Audit | append-only query (filters above), CSV export (audited) |
| Roles | roster with commercial roles, chain fulfillability |
| Stripe | webhook confirmation reflected in CR apply state |

Error codes surfaced in the UI: `CCP_NOT_BOOTSTRAPPED` (409), `ENTITLEMENT_REVOKE_TIMEOUT` (example apply failure), plus the 7 eligibility codes in §3.1.

## 8. Open questions (PO = product owner, A = Architect)
| # | Question | Status | Answer / assumption |
|---|---|---|---|
| 1 | Which chain governs policy activation and rollback? | **Awaiting PO** | *Assumed:* Finance → Owner. |
| 2 | Do non-privileged role changes also need a distinct Platform owner? | **Awaiting PO** | *Assumed:* yes. |
| 3 | Bootstrap: does the maker count toward the "two distinct humans"? | Resolved (A9) | The chain must be fillable by a maker plus a distinct approver per step. |
| 4 | When not bootstrapped, is creation refused too? | Resolved | Creation allowed; approval returns 409 `CCP_NOT_BOOTSTRAPPED`. |
| 5 | If an approver loses a role after signing, is the signature voided? | **Awaiting Architect** (relates to NC-4) | *Assumed:* the signature stands. Reviewer recommendation: re-check the chain at apply time. |
| 6 | Credits and discounts on self-service tenants? | Resolved (C4) | Stripe-side commands through maker-checker. |
| 7 | Which chain applies to an out-of-bounds extension? | **Awaiting PO** | *Assumed:* Below threshold (Finance). |
| 8 | Is the 90-day extension window rolling or a calendar quarter? | **Awaiting PO** | *Assumed:* rolling. |
| 9 | Is moving grandfathered tenants to a newer version a bulk change request? | **Awaiting PO** (may be deferred) | Not designed. |
| 10 | Can an expired or rejected request be cloned and resubmitted? | **Awaiting PO** (may be deferred) | Not shown. |
| 11 | Do commercial roles get read access to tenants? | Resolved (A0-C5) | Yes, read-only, with authorization tests. |
| 12 | Policy numbering (prototype shows a pilot v0). | Resolved | Starts at **v1**; v0 is prototype-only (see Don't build). |
| 13 | Dashboard commercial panel. | Resolved (A0-C6, D2) | Counts only on the dashboard; money only on Finance screens. |
| 14 | One open request per tenant × product? | **Awaiting PO** | *Assumed:* yes. |
| 15 | One console vs a separate file. | Resolved (A1-4, A1-5, A1-6) | Commercial lives in the existing console; no PLATFORM-UX-1 amendment. |

Note: "revenue charts (no MRR/ARR)" is out of scope for this release. Program Build Directive slice D2 includes revenue reporting on Finance screens; D2 needs its own design release later.

## 9. Accessibility
Follow PLATFORM-UX-1 §15. In addition:
- **ARIA:**
  - the drawer is `role="dialog" aria-modal`
  - the bootstrap banner and refusals are `role="alert"`
  - extension previews and toasts are `role="status"`
  - the stepper is an `<ol aria-label="Request state">`
  - persona-free tab lists use `role="tablist"/"tab"` with `aria-selected`
- **Colour is never the only cue:** ✓ / ○ / ✕ / ● marks, "~" diff markers, text labels on every pill, and the EXCEPTION text tag.

## 10. Acceptance (checked per CCP Phase B UI slice, §11)
1. Super admin never sees Commercial. A deep link shows AccessDenied in the shell naming the six roles. Tenant operations are unchanged.
2. Every commercial action creates a CR that follows §4, with the stepper, diff, chain, policy version and TTL shown.
3. All 7 eligibility reasons render inline with Approve disabled. The combined Finance + Owner person is refused the second step with "You already approved a step".
4. A chain comes from the creation policy. An open request created under an older version shows "older version" and its note.
5. Bootstrap banner, 409 refusal and chain fulfillability all derive from the live roster. Removing the last owner is refused.
6. Applied appears only when both sides have applied. Stripe-side requests show "Sent to Stripe — awaiting confirmation" until the webhook. Apply failed can be retried.
7. Self-service rows are read-only with Stripe link-outs. A reconciliation flag blocks rather than replaces the MANUAL subscription.
8. Within-bounds extensions apply with zero approvals as an exception, with full context. Out-of-bounds extensions escalate.
9. Published plan versions are immutable; edits create a draft. Pin counts, grandfathering and the v1 locks are visible.
10. Audit is append-only, filterable and exportable, and the export is audited.
11. Every screen has loading (skeleton), empty and access-denied states.
12. No prototype-only element ships (see Scope).

## 11. Screen-to-slice map
Backend slices provide the contract; UI slices build the screen. A UI slice's pre-execution record pins this release's `MANIFEST.sha256` and lists the rows it covers.

| Screen / action | Handoff § | Backend slice(s) | UI slice |
|---|---|---|---|
| Commercial rail group, role-based visibility, super_admin AccessDenied | 2 | A1 | B1 |
| Approvals inbox (tabs, chain progress, TTL countdown, policy version per row) | 5.1 | A3, A2 | B1 |
| CR drawer: stepper, diff, chain, timeline | 5.2 | A3, A2 | B1 |
| Eligibility verdict (7 reasons) + roster verdicts | 3.1, 5.2 | A3, A1 | B1 |
| Approve / Reject / Submit / Withdraw | 4, 5.2 | A3 | B1 |
| Bootstrap banner and 409 `CCP_NOT_BOOTSTRAPPED` | 3.2 | A9 | B1 |
| Apply panel (both sides), Apply failed + Retry apply | 4 | A6 | B1 |
| "Sent to Stripe — awaiting confirmation" | 4 | C1 | B1, B3 |
| ⌘K request results | 5.11 | A3 | B1 |
| Catalog: products, "No commercial plans yet" | 5.4 | A4 | B2 |
| Catalog: plan versions, draft from version, edit draft, pin counts, grandfathering, v1 locks | 5.4 | A5 | B2 |
| Catalog: Request publish / Request retire | 5.4 | A5, A3 | B2 |
| Subscriptions workbench (filters, source badge, status, grace, flags) | 5.3 | A4, A5, A6 | B3 |
| Commitment ending filter, past-due / in grace | 5.3 | C6 | B3 |
| Tenant › Commercial: subscription facts, pinned version, allowance | 5.9 | A4, A5 | B3 |
| Tenant › Commercial: entitlement provenance, Grant / Revoke product | 5.9 | A7, A3 | B3 |
| Tenant › Commercial: plan change, cancel, discount | 5.9 | A3, A6 | B3 |
| Tenant › Commercial: credits on self-service | 5.9 | C4, C1 | B3 |
| Tenant › Commercial: reconciliation flag (checkout hold) | 5.9 | A6 | B3 |
| Tenant › Commercial: reconciliation release | 5.9 | C2, C1, A3 | B3 |
| Tenant › Commercial: Managed in Stripe link-outs (invoices, payment methods, proration, cancellation) | 5.9 | C3 | B3 |
| Support extension: in-bounds exception and out-of-bounds escalation, exception overlay | 5.9 | A8, A3 | B6 |
| Contracts: list, terms, hashed documents, amendments timeline | 5.5 | A6 *(contract evidence store — confirm owner)* | B4 |
| Contracts: Record amendment / End contract | 5.5 | A3, A6 | B4 |
| Contracts: commitment ending | 5.5 | C6 | B4 |
| Policy: versions, draft edit, diff, activation / rollback requests | 5.6 | A2, A3 | *not named in the UI slice list — confirm (proposed B5)* |
| Audit explorer, exception flag, CSV export (audited) | 5.7 | A2 | B5 |
| Platform admins: role chips, chain fulfillability, last-owner guard, role change requests | 5.8 | A9, A1, A3 | B5 |
| Dashboard commercial panel | — | A0-C6 | Out of Phase B (D2) |

**To confirm before slicing:** which UI slice owns the Policy screen, and which backend slice owns contract evidence (terms and document hashes).
