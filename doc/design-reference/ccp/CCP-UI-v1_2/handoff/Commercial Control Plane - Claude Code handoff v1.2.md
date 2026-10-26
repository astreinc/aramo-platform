# Aramo Platform Admin: Commercial Control Plane (CCP Phase B) — Claude Code handoff v1.2

**Status: CCP-UI v1.2 design release — a pinned INPUT to CCP slices under Aramo-CCP-Program-Build-Directive-v1_0 (LOCKED). Not a directive; authorizes no build by itself.** v1.0 (`ccp/CCP-UI-v1_0/`) and v1.1 (`ccp/CCP-UI-v1_1/`) stay frozen and pinned. v1.2 corrects two v1.1 assumptions, adds Finance amount visibility and adds the Withdraw of a failed policy activation (§17). Payment recording is not designed in this release. Slices pin `ccp/CCP-UI-v1_2/handoff/MANIFEST.sha256`. Sections 1–16 are carried from v1.1 with the corrections in §17.1 applied in place; where they differ, §17 wins.

## Design files
| Role | File |
|---|---|
| Design authority | `ccp/CCP-UI-v1_2/Commercial Control Plane v1.2.dc.html` |
| Mock data and pure helpers | `ccp/CCP-UI-v1_2/ccp-data.js` (prototype only, never ship) |
| Runtime | `ccp/CCP-UI-v1_2/support.js` (byte-identical copy of the PLATFORM-UX-1 pinned `platform/support.js`) |
| Handoff | `ccp/CCP-UI-v1_2/handoff/Commercial Control Plane - Claude Code handoff v1.2.md` (this file) |
| Design amendments log | `ccp/CCP-UI-v1_2/handoff/Commercial Control Plane - design amendments log v1.2.md` |
| Manifest | `ccp/CCP-UI-v1_2/handoff/MANIFEST.sha256` — SHA-256 of every file above |

The `platform/` working copies are superseded by `ccp/CCP-UI-v1_0`. Later design changes go in as numbered entries in the amendments log, or as a v1.3 release with a new manifest — never as edits to this release.

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


## 12. v1.0 → v1.1 delta

### 12.1 New screens
| Screen | Route | Read scope | Slice |
|---|---|---|---|
| Finance › Renewals | `/commercial/finance/renewals` | platform:billing:read | C6 |
| Finance › Outstanding payments | `/commercial/finance/outstanding-payments` | platform:billing:read | C6 (amount due: C3) |
| Finance › Billing reconciliation | `/commercial/finance/reconciliation` | platform:billing:read | C6 |
| Finance › Revenue | `/commercial/finance/revenue` | platform:billing:read | D2 (design only) |
| Usage › Consumption | `/commercial/usage` | platform:subscription:read | D1 |
| Operations › Alerts | `/commercial/alerts` | platform:billing:read (assumed, Q-V11-3) | D3 |
| Commercial › Support extensions | `/commercial/support-extensions` | platform:billing:read | B6 (TD-B6-1/4) |

platform:billing:read and platform:subscription:read holders: platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor. Neither scope is held by catalog_manager or super_admin.

### 12.2 Amended v1.0 screens (each is a v1.1 amendment to a v1.0 screen)
| # | v1.0 screen | Amendment | Reason |
|---|---|---|---|
| AM-1 | Shell › rail | New groups **Finance** (Renewals, Outstanding payments, Billing reconciliation, Revenue) and **Usage** (Consumption) between Commercial and Platform; **Alerts** added to Operations; **Support extensions** added to Commercial after Policy; **Contracts** now gated by platform:subscription:read, so it is hidden for catalog_manager. | New screens need a place; catalog_manager has no subscription read scope. |
| AM-2 | Access denied (in shell) | For scope-gated pages the body names the missing scope ("This page needs the platform:billing:read scope, which your role doesn't hold.") and lists only the five holder roles. | The six-role list was wrong for scope-gated pages. |
| AM-3 | Change request lifecycle | Final approval no longer applies automatically. The request goes to **Approved** with an **apply deadline** (approval + the creation policy's apply window; no deadline when the policy sets none — §17.1); the requester applies it. A new terminal state **Apply expired** (muted) replaces an unapplied Approved request after the deadline. | A6-R: apply is a separate requester action with a deadline. |
| AM-4 | Approvals inbox | "Waiting on me" also lists Approved requests you made (yours to apply); "All pending" includes Approved; History excludes Approved. The Expires column shows "Apply within n h" (amber) and "Apply expired" (danger). Escalated extensions carry an **"Outside policy bounds"** tag under the chain. | A6-R; bounded-exception requests read "Below threshold" in v1.0. |
| AM-5 | Change request drawer | New pill **Apply expired**; the stepper's Approved chip reads "Approved · apply by {UTC}"; the facts row is labelled **Apply window** once approved ("Apply by {UTC} · n h left · requester applies" / "Apply window closed {UTC} — make a new request"); the timeline adds an "Approved · apply by {UTC}" event. | A6-R. |
| AM-6 | Change request drawer › actions | **Apply** (terracotta; "Apply activation" for policy) is shown **only to the original requester** while the request is Approved and the deadline hasn't passed. **Retry apply** is also requester-only. Others see the footnote "Only the requester, {name}, can apply this request." / "…can retry." Apply expired shows "The apply window closed. Make a new request to try again." | B2/B6 apply-button rule. |
| AM-7 | Policy | Activation dialog copy changed from "becomes the active policy once approved" to "becomes active only when you, the requester, apply it after approval (within the policy's apply window, or no deadline). Then v{n} is retired." The version panel offers **Apply activation** / **Retry apply** to the requester, with hints "Approved — v{n} becomes active only when you apply it. Apply by {UTC}.", "Approved — waiting for {name} to apply it by {UTC}." and "Apply expired — request activation again." An Approved or Apply-failed activation counts as the one open policy request. | Activation takes effect on apply, not on approval. |
| AM-8 | Approval chains | New chain **Extension outside policy bounds** (Finance; maker Support admin). Used by escalated extensions, shown in the drawer, the dialog chain preview and the Platform admins chain panel (5 → 6 cells). | Label for bounded-exception requests. |
| AM-9 | Tenant › Commercial | Sign subscription facts gain **Tax · Not enabled · Pending Stripe Tax registration**. Removed extensions no longer render as active exception overlays. "One open request per tenant × product" now includes Approved. | C5 disabled state; removal flow; Approved is still open. |
| AM-10 | Catalog | "Request publish…" stays disabled while the publish request is Approved (awaiting apply). | Approved is still open. |
| AM-11 | Prototype pages | Screen inventory and Open questions gain "Added in v1.1" tables. | Prototype only; not built. |

### 12.3 Demo-data additions (prototype only)
These show up on v1.0 screens as data only, with no design change:
- **Tenant:** Lumen Analytics (Sign Team v2, self-service, entitlement not granted).
- **Extension:** Fernhill extension EXT-0047.
- **Change requests:** CR-1053 (policy v2 activation, Approved, 8 h to apply) and CR-1054 (Grant Intelligence, Apply expired). CR-1052 moves to the new chain.
- **Contract pricing:** Halcyon and Meridian are marked contract-priced.
- **Datasets:** invoices, held activations, Stripe commands, webhook inbox, usage periods and roll-up runs.

### 12.4 Prototype-only additions (don't build)
- the `usageRecon` and `invoiceReads` Tweaks
- the "Added in v1.1" prototype tables
- the toast in place of Stripe invoice link-outs

## 13. New screens

**All seven screens share:**
- the PLATFORM-UX-1 shell, page header, card, table, pill, filter bar and empty-state patterns (§3.6–3.7 there);
- a skeleton while loading;
- the empty states quoted below;
- access denied per AM-2.

**The copy is in the design file.** Every row links to its tenant (Tenant › Commercial), its change request (drawer) or its route.

### 13.1 Finance › Renewals (C6)
- **Intro:** "Commitment ends and provider period ends inside the horizon you choose. Dates already passed show as lapsed. List prices only, no totals; revenue figures are on Finance › Revenue."
- **Tax state:** the C5 box sits above the table (§13.8).
- **Filters:** Horizon select (Next 30 / 60 / 90 (default) / 180 days), an "Include lapsed" checkbox (on) and the count "n in view · m lapsed".
- **Columns:**

| Column | Content |
|---|---|
| Tenant | Link, then slug (mono) |
| Product | Sign only |
| Plan · version | Plan and version, then the subscription status |
| Source | Badge: "Manual · contract {id}" or "Self-service (Stripe)" |
| End date | Date, then "Commitment end" or "Provider period end" |
| Remaining | Pill: "n days left" (info at 30 days or fewer, neutral otherwise) or "Lapsed n d ago" (warn) |
| List price | "$n / month" with "List price · USD", or **Withheld** with "Reason: contract-priced / non-USD (EUR) / price missing" |

- **Sort:** chronological by end date. There are no totals.
- **End date source:** Manual rows with a commitment use the commitment end; everything else uses the provider period end.
- **Empty:** "No renewals in this horizon" / "Widen the horizon or include lapsed dates."

### 13.2 Finance › Outstanding payments (C6, amount due C3)
- **Intro:** "Past-due and incomplete subscriptions with their grace state. Support extensions are overlays: they add access time and never change billing dates."
- **Invoice reads unavailable** (default): an info banner (`role="status"`) reads "**Amount due not yet available.** Invoice reads are pending provider configuration: the Stripe portal settings aren't verified yet. Amounts and invoice links appear here once they are." The cell reads "Not yet available".
- **Columns:**

| Column | Content |
|---|---|
| Tenant | Link |
| Plan · version | Plan and version |
| Source | Badge |
| Status | Pill: Past due · in grace (warn), Suspended (danger), Incomplete (info, a held checkout) |
| Grace until | Date with "n days left" / "Ended {date}" with "Suspended {date}" / "No grace period" with "Checkout held behind the Manual row (C-8)" |
| Support extension | Mono link "EXT-id · +n days" to Support extensions filtered to the tenant, with "Overlay — billing dates unchanged", or "None" |
| Amount due | See below |

- **Amount due when invoice reads are available:** "$n", then "in_… · due {date}", then **View invoice in Stripe ↗** (external, read-only), or "No open invoice".
- **Empty:** "Nothing outstanding" / "No subscription is past due or incomplete."

### 13.3 Finance › Billing reconciliation (C6)
- **Header:** the page header has an **Exceptions** count tile on the right. That count is the only total on the page.
- **Section 1 · Subscriptions, pinned versions and entitlements.** Columns: Tenant · Product · Subscription · Pinned version (mono, "v2 · published" / "retired (grandfathered)") · Entitlement · Exception.
  - The exception tag is amber: **Missing entitlement** (open subscription, entitlement not granted or revoked) or **Entitlement without subscription** (subscription ended, entitlement still active). A why-line follows.
  - Empty: "No mismatches" / "Subscriptions and entitlements agree."
- **Section 2 · Held activations (C-8).** Columns: Tenant · Governed Manual row · Held self-service attempt (with UTC) · Held plan · Stripe command.
  - The Stripe command cell shows "Sent to Stripe — awaiting confirmation" or the request state, then the mono command ID and a CR link.
  - Empty: "No held activations" / "No self-service checkout is waiting behind a Manual subscription."
- **Section 3 · Stripe command and webhook-inbox exceptions.**
  - **Commands:** Command (mono ID plus kind) · Tenant · State (Failed danger / Stuck pending warn) · Sent (UTC plus relative) · Detail (error code, or "Pending past the {n} h threshold" ({n} from configuration, 24 h — §17.1)) · Request.
  - **Webhook inbox:** Event (mono ID plus type) · Tenant · State (Failed / Stuck processing) · Received · Attempts · Detail.
  - Each list has its own empty state.

### 13.4 Usage › Consumption (D1)
- **Intro:** "Sign envelope usage per tenant and period, rolled up from Sign records. Counts only: no money, and no ordering by volume."
- **Status banner (always shown):**
  - **Reconciled** (ok, `role="status"`): "Roll-ups match Sign records. Last run {UTC} · {mode}."
  - **Reconciliation pending** (info): "A run started {UTC} ({mode}). Figures may change when it finishes." The table still shows.
  - **Not reconciled · n mismatches** (warn, `role="alert"`). The period table is **replaced** by the refused card: "Usage analytics unavailable" / "The usage API refuses analytics until roll-ups reconcile (409 USAGE_NOT_RECONCILED). Nothing here is editable; the next run retries automatically." with "See the open alert →".
- **Filter:** a Period select. The page also states "Metric: Sign envelopes".
- **Columns:** Tenant · Period (with its date range) · Sent · Historical · Reserved · Plan allowance · Alignment (Aligned ok / Unaligned warn, with the reason, e.g. "Plan version changed mid-period (v1 → v2)").
- **Sort:** by tenant name, then period, newest first. There is no ranking and no "top tenants".
- **Roll-up runs card:** Run (UTC) · Mode (Full / Incremental / Rebuild) · Result. Runs are scheduled; there is no manual trigger.

### 13.5 Finance › Revenue (D2, design only)
- **Banners:** an info banner reads "**Design only.** The revenue read (D2) isn't built yet." The C5 tax box follows.
- **Tiles:**
  - **MRR:** Active and past-due subscriptions × the pinned list price.
  - **ARR:** MRR × 12.
  - **Included:** the count with a USD list price.
  - **Withheld:** the count, with tenant names and reasons.
- **Renewals by month** (next six months): month, an 8px midnight bar proportional to value, renewal count, list value per month, and the withheld count.
- **Copy:** never "pipeline" (vocabulary rule). USD only.
- **Placement:** this is the only screen with money totals. The Dashboard stays counts-only.

### 13.6 Operations › Alerts (D3)
- **Intro:** "Operational alerts raised from commercial records. They open and resolve automatically when the underlying condition changes. There are no actions here: follow the subject to where the governed action lives."
- **Filter:** segmented Open (default) · Resolved · All, with counts.
- **Columns:**

| Column | Content |
|---|---|
| Alert | Type label, then mono ID |
| Severity | Pill: **Action needed** (warn) or **Watch** (neutral), operational only |
| Subject | Link to the CR drawer, tenant or route |
| Opened | UTC |
| Status | Pill: **Open** (info) or **Resolved automatically** (ok) |
| Detail | When open, the condition. When resolved, "Became: {what the subject became}" |

- **Types:**
  - Stripe command stuck pending (threshold from configuration, 24 h)
  - Stripe command failed
  - Change request apply failed
  - Held activation open
  - Approval request near expiry (under the configured 12 h left) / past expiry
  - Approved request near / past its apply deadline
  - Usage roll-ups not reconciled
  - Inbox processing failure
- **Footer:** "Severity is operational only. Alerts never score, rate or rank tenants or people."
- **No actions:** no acknowledge, retry or resolve (PLATFORM-UX-1 A1-2).

### 13.7 Commercial › Support extensions (B6, TD-B6-1/4)
- **Intro:** "Extra access time on a tenant's subscription, applied as an overlay. Within policy bounds an extension applies at once as an exception, with zero approvals; outside bounds it becomes a request for Finance."
- **View-only note** (non–Support admin): "**View only.** You can view support extensions. Requesting and removing them needs the **Support admin** role."
- **Toolbar:**
  - **Tenant picker** (select; "All tenants" default, then tenants with an open Sign subscription).
  - With a tenant picked, the line "{tenant}: n of 1 uses · n of 30 days in the last 90 days".
  - **Request support extension…** (terracotta; disabled until a tenant is picked) opens the v1.0 extension dialog. That dialog's escalation path now uses the AM-8 chain.
  - Below the toolbar, the policy bounds line.
- **Earlier extensions table:**

| Column | Content |
|---|---|
| Extension | Mono ID, then "+n days" |
| Tenant | Link |
| Granted | UTC |
| Path | "Exception within bounds" with an EXCEPTION tag and the clause, or "Approved request" with the CR ID |
| Actor · roles at the time | Name, then roles |
| Cumulative in window | Before → after |
| Status | Pill: Active ok / Removal {state} info / Removed muted ("via CR-…") |
| Action | **Request removal…** |

- **Removal flow** (NEW dialog on the v1.0 confirm pattern):
  - Title "Request removal · EXT-id".
  - Body "Ends the extension overlay for {tenant} once approved and applied. Access returns to the subscription's own period and grace dates."
  - Fields Reason* and Evidence*; diff (extension active → Removed; cumulative after → before; Stripe billing dates unchanged).
  - Chain preview Below threshold (Q-V11-4); TypedConfirm = extension ID; danger commit **Submit for approval**.
  - It creates a CR of type **Remove support extension**. Once the requester applies it, the row shows Removed, and the extension no longer counts toward the window or cap.
- **Placement:** this standalone page is the chosen option. Tenant › Commercial keeps its exception overlay card (AM-9).

### 13.8 Tax, C5 (disabled state only)
A dashed box (#C3CBD2 on #FAFBFC) reads "**Tax not enabled — pending Stripe Tax registration.** Prices are shown before tax. Nothing is calculated or collected for tax." It appears on Renewals and Revenue, and as a facts row on Tenant › Commercial (AM-9). There is no tax calculation UI.

### 13.9 External dependencies not yet enabled
| Dependency | Designed state |
|---|---|
| Stripe invoice reads | §13.2 banner |
| Stripe Tax | §13.8 |
| Revenue read | §13.5 banner |

Refund policy, legal terms and enterprise invoicing have no surface in v1.1; when one is added it uses the §13.8 dashed pattern with its own one-line reason.

### 13.10 New components
| Component | Props (typed) | Notes |
|---|---|---|
| `NotEnabledState` | `title: string; reason: string` | Dashed C5/C3-style box |
| `ExceptionCountTile` | `count: number; label?: string` | Reconciliation header; the only total on the page |
| `RenewalRemainingPill` | `endDate: Date; now: Date` | Days left / Lapsed n d ago |
| `WithheldPrice` | `reason: 'contract-priced' \| 'non-USD' \| 'price missing'; currency?: string` | |
| `UsageReconBanner` | `status: 'RECONCILED' \| 'PENDING' \| 'NOT_RECONCILED'; mismatches?: number; lastRun: { at: Date; mode: 'FULL' \| 'INCREMENTAL' \| 'REBUILD' }` | |
| `AlertRow` | `type; severity: 'ACTION_NEEDED' \| 'WATCH'; state: 'OPEN' \| 'RESOLVED'; subject: { kind: 'cr' \| 'command' \| 'tenant' \| 'route'; id: string }; became?: string` | No action props by design |
| `ApplyDeadline` | `applyBy: Date; isRequester: boolean; state` | Drawer fact, list cell and stepper label |

## 14. Apply deadline rules (A6-R) and the apply button (B2/B6)
1. **Approval:** when the last step is signed, the state is `APPROVED` and `applyBy = approvedAt + applyWindow` of the request's creation policy (72 h when set; none under policy v1 — §17.1).
2. **Apply:** only the original requester sees **Apply**, and only while `APPROVED` and `now < applyBy`. Applying moves the request to `APPLYING` and then `APPLIED` (or `APPLY_FAILED`). For Stripe-side requests it shows "Sent to Stripe — awaiting confirmation" until the webhook.
3. **Retry apply** is requester-only.
4. **Expiry:** at `applyBy` without an apply, the state is `APPLY_EXPIRED` (terminal, muted). A new request is needed.
5. **Open requests:** Approved and Apply failed count as open for the one-open-request rules (tenant × product, catalog publish, policy activation).
6. **Audit events:** "Change request approved", "Apply started by requester" and "Apply window expired".

## 15. Screen-to-slice map (v1.1)
| Screen / element | Handoff § | Backend slice(s) | UI slice |
|---|---|---|---|
| Finance › Renewals | 13.1 | C6 | C6 UI (unblocks H-C6-1) |
| Finance › Outstanding payments (grace, extension overlay) | 13.2 | C6, A8 | C6 UI |
| Outstanding › amount due + View invoice in Stripe | 13.2 | C3 | C6 UI (state flips when C3 lands) |
| Finance › Billing reconciliation | 13.3 | C6, A6, C1, C2 | C6 UI |
| Usage › Consumption | 13.4 | D1 | D1 UI |
| Finance › Revenue | 13.5 | D2 (later) | D2 UI |
| Operations › Alerts | 13.6 | D3 | D3 UI |
| Tax not-enabled state (Renewals, Revenue, Tenant › Commercial) | 13.8, AM-9 | C5 | C6 UI, D2 UI, B3 |
| Apply deadline: Approved state, apply by, Apply expired (inbox, drawer, stepper, timeline) | 14, AM-3–AM-5 | A6-R | B1 |
| Apply button (requester only), Retry apply (requester only) | 14, AM-6 | A6-R | B2, B6 (and B1 drawer) |
| Policy Apply activation / Retry apply / Apply expired copy | AM-7 | A6-R, A2 | B5 (proposed) |
| Support extensions page frame + removal flow | 13.7 | A8, A3 | B6 |
| Bounded-exception chain label | AM-8 | A8, A2 | B1, B6 |
| Rail: Finance, Usage, Alerts, Support extensions; Contracts hidden for catalog_manager | AM-1 | A1 | B1 |
| Scope-aware access denied | AM-2 | A1 | B1 |

## 16. v1.1 open questions and acceptance

### 16.1 Open questions
| # | For | Question | Prototype assumes |
|---|---|---|---|
| Q-V11-1 | Architect | How long is the apply window after final approval, and is it a policy setting? | **Resolved (Aramo-CCP-Charter-Amendment-A1-Apply-Deadline-v1_0):** a policy setting; 72 h when set; policy v1 sets none |
| Q-V11-2 | PO | catalog_manager has no subscription read: hide the Subscriptions workbench and Tenant › Commercial too? | Only Contracts hidden (as briefed) |
| Q-V11-3 | PO | Who sees Operations › Alerts? | platform:billing:read holders |
| Q-V11-4 | PO | Which chain removes a support extension, and who makes it? | **Confirmed:** Support requests, Finance approves |
| Q-V11-5 | PO | Revenue: are past-due subscriptions in MRR? Suspended ones? | **Assumption, pending PO confirmation:** MRR counts active and past-due; suspended out |
| Q-V11-6 | Architect | Stuck-command threshold; approval near-expiry threshold | **Resolved:** 24 h; under 12 h left. Both are configuration values |
| Q-V11-7 | PO | Renewals include monthly provider period ends: keep, or commitments only? | Kept, labelled by end type |

Open questions from §8 still apply.

### 16.2 Acceptance (per slice)
1. Every v1.0 screen matches v1.0 except for the amendments AM-1 to AM-10.
2. The Finance, Usage and Alerts screens are visible only to their scope holders. catalog_manager and super_admin get scope-aware access denied, and Contracts is hidden for catalog_manager.
3. Renewals shows withheld prices with their reason and never shows totals. Revenue is the only screen with money totals, and the Dashboard stays counts-only.
4. Outstanding shows the designed "not yet available" amount state until C3 is delivered.
5. Reconciliation flags both entitlement mismatches, held activations and command/inbox exceptions, with a single exception count.
6. When usage is Not reconciled, the table is replaced by the refused state (409). Usage shows counts only, with no ordering by volume.
7. Alerts have no actions. They resolve automatically and show what the subject became.
8. Apply is requester-only and deadline-bound. Apply expired is terminal. Policy activation takes effect only on apply.
9. Tax shows the not-enabled state everywhere it would appear.
10. All copy passes `scripts/verify-vocabulary.sh`. No "pipeline" or ranking language is used.


## 17. v1.1 → v1.2 delta

### 17.1 Changes
| # | Change | Where | Reason |
|---|---|---|---|
| D-1 | **Apply window is a policy setting.** It's a new Policy field, "Apply window (TTL)": editable on a draft, **Not set** when absent, range 1–336 h. When the request's creation policy sets it, the request shows "Approved · apply by {UTC}" and "Apply within {n} h" (amber under 12 h), and ends in **Apply expired**. When the policy doesn't set it, the request shows "No apply deadline (policy v{n})": no countdown and no apply-by. Policy v1 sets none; the draft v2 sets 72 h. | Policy, Approvals inbox, CR drawer (fact, stepper, timeline), approval toast, activation dialog copy | §3.1, Aramo-CCP-Charter-Amendment-A1-Apply-Deadline-v1_0 (LOCKED); replaces the v1.1 "24 h, fixed" assumption |
| D-2 | **Alert thresholds from configuration:** stuck-pending Stripe command after **24 h**; approval or apply window near expiry under **12 h**. Labels read "threshold {n} h" from config. | Alerts details, Billing reconciliation (commands card subtitle and detail), Approvals inbox amber | §3.2; replaces 6 h and 36 h |
| D-3 | **Finance amount visibility.** Tenant-specific monetary figures need `platform:billing:amount:read` (holders: platform_owner, finance_admin, read_only_auditor). commercial_ops and support_admin see `WithheldAmount` in each figure, plus `PaymentDueIndicator` where a due status applies. Catalog list prices and policy thresholds stay visible. | Renewals, Outstanding payments, Billing reconciliation, Revenue, Tenant › Commercial, CR drawer, Approvals inbox, Alerts, Audit + CSV export, Contracts terms, plan-change dialog diff | §4, Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0 (LOCKED) |
| D-4 | **Withdraw a failed policy activation.** The requester sees **Withdraw…** beside **Retry apply** while the request is Apply failed (policy activations only). It opens a danger ConfirmDialog ("Apply failed → Withdrawn") with a required reason. The dialog shows two refusals inline. A successful withdrawal ends the request as **Withdrawn** (terminal), and the timeline keeps the approvals and the failure. | Policy version panel, CR drawer | §5, Architect ruling TD-ACC-1 |

### 17.2 Amount visibility, per screen
| Screen | Holder (amount-read) | Non-holder (billing read only) |
|---|---|---|
| Finance › Renewals | List price per interval | `WithheldAmount` (cell) in List price. Contract-priced, non-USD and missing-price rows keep v1.1's `WithheldPrice` with its reason. |
| Finance › Outstanding payments | Amount due (or "Not yet available" until C3) + `PaymentDueIndicator` | Note "**Amounts withheld for your role.** You can see whether each payment is due or overdue. Amounts need Finance access (amount-read)." The invoice-read banner is hidden. Amount due shows `WithheldAmount` plus `PaymentDueIndicator`. |
| Finance › Billing reconciliation | Command amount ("Amount $120.00") under the command kind | `WithheldAmount` under the command kind. Other columns carry no money. |
| Finance › Revenue | MRR, ARR and value per month; bar length shows list value | Page-level ViewOnlyNote "**View only.** Revenue figures require Finance access. Counts stay visible; every figure is withheld." MRR and ARR show `WithheldAmount` (stat); Included, Withheld and renewal counts stay visible; each month's value shows `WithheldAmount` (cell); bars switch to renewal **count** (with the line "Bar length shows the number of renewals."). The chart is never empty or broken. |
| Tenant › Commercial (Sign card facts) | **Payment** (`PaymentDueIndicator`); **Amount due** when due or overdue | **Payment** (`PaymentDueIndicator`, "Due status only"); **Amount due** shows `WithheldAmount` with "Finance access required". |
| Change request drawer | All amounts | For tenant-scoped requests, the summary, note, reason and evidence mask amounts as "[withheld]" (summary with a `WithheldAmount` chip), and diff rows with money render `WithheldAmount` on both sides. Platform-scoped requests (policy thresholds, catalog list prices) are never masked. |
| Approvals inbox | Summary as v1.1 | Masked summary plus a `WithheldAmount` chip |
| Alerts | Subject and detail as is | When the subject or detail holds money, it is masked plus a `WithheldAmount` chip (e.g. AL-0414 account credit, AL-0418 subject) |
| Audit | Detail as is | Masked detail plus a `WithheldAmount` chip |
| Audit › Export CSV | Confirmation dialog: "Export n events as CSV" | The same dialog with the warning box "**Amounts are omitted for your role**". The CSV writes "[withheld]" in place of amounts, and the toast repeats it. |
| Contracts (negotiated terms) | Terms as recorded | Amounts in terms masked as "[withheld]" (the contract is tenant-specific) |
| Plan-change dialog diff | Prices | Tenant prices masked as "[withheld]"; the plan select keeps catalog list prices |

catalog_manager still has no billing read, so the billing screens stay hidden for it. super_admin still has no commercial access.

**Due state rule (prototype):** a subscription that is past due and inside grace is **Due**; past due beyond grace (suspended) is **Overdue**; anything else is **Not due**. A held, incomplete checkout is Not due.

### 17.3 Withdraw a failed policy activation (TD-ACC-1)
- **Who and when:** the action is offered only when the viewer is the original requester and the request is `APPLY_FAILED` and of type Activate policy version. In the demo the requester is Priya Shah (Finance admin), on CR-1053.
- **ConfirmDialog (danger):**
  - Title "Withdraw {CR} · Activate policy v{n}".
  - Consequence "This request ends. Activating this version again needs a new request."
  - Change box "Request state: Apply failed → Withdrawn".
  - Field: Reason (required).
  - Commit: **Withdraw request** (danger).
- **Outcomes:**

| Server answer | UI |
|---|---|
| Withdrawn | Dialog closes. The state becomes **Withdrawn**, and the stepper keeps Approved done with the terminal chip after Applying. The timeline reads: Submitted → steps signed → Approved → **Apply failed** (System · reason) → **Withdrawn by requester after failed apply** ({name} · reason). The toast is "{CR} withdrawn. Activating this version again needs a new request." The policy hint reads "Withdrawn after a failed apply — activating v{n} again needs a new request." |
| Committed but unacknowledged | Inline refusal (`role="alert"`): "This activation was applied. It can't be withdrawn." Commit stays disabled. The request is reconciled to **Applied**, with the timeline event **Reconciled to applied**, and the policy version becomes active. |
| Apply still in progress | Inline refusal: "An apply is still in progress. Try again shortly." No state change. Audited as *Withdrawal refused*. |

### 17.4 New components
| Component | Props (typed) | Notes |
|---|---|---|
| `WithheldAmount` | `reason: 'FINANCE_SCOPE_REQUIRED'; size: 'cell' \| 'stat'` | "Withheld" with a lock glyph, muted tone (#5C6770 on #F4F6FA, 1px dashed #C3CBD2). Tooltip "Finance access required (amount-read)"; aria-label "Amount withheld: finance access required". Cell: 12px/600, 6px radius. Stat: 17px/700, 8px radius. Distinct from `WithheldPrice` (plain text "Withheld" plus "Reason: …", no chip, no lock). |
| `PaymentDueIndicator` | `state: 'NOT_DUE' \| 'DUE' \| 'OVERDUE'` | StatusPill tones muted / warn / danger, with the labels "Not due" / "Due" / "Overdue" (text is the non-colour cue). Never takes an amount prop. |
| `WithdrawFailedActivationDialog` | `request: ChangeRequest; onWithdraw: (reason: string) => Promise<'WITHDRAWN' \| 'ALREADY_APPLIED' \| 'APPLY_IN_PROGRESS'>` | Built on ConfirmDialog (danger); renders the refusals inline |
| `ApplyDeadline` (v1.1, now with nullable props) | `applyBy: Date \| null; policyVersion: number; isRequester: boolean; state` | `null` renders "No apply deadline (policy v{n})" |

### 17.5 Demo data changes (prototype only)
| Item | Change |
|---|---|
| Policy | v0 = 72 h, v1 = Not set (or 72 h with the switch), v2 draft = 72 h |
| CR-1053 | Activate policy v2, requested by Priya, **Apply failed** |
| CR-1054 | Grant Intelligence to Atlas, policy v0, **Approved**, 8 h to apply (amber; open alert AL-0419) |
| CR-1055 | Grant Portal to Oakridge, policy v0, **Apply expired** |
| CR-1039 | Created 62 h ago (10 h to expiry, alert AL-0418 open) |
| cmd_5498 | Now an "Apply account credit" of $120 |
| cmd_5521 | Pending 30 h |
| Alerts | New alert AL-0421 (CR-1053 apply failed) |
| Config | `ALERT_CFG = { stuckPendingH: 24, nearExpiryH: 12 }` |

### 17.6 Don't build (prototype-only, added in v1.2)
- the `amountRead` role switch (byRole / holder / nonHolder)
- the `applyWindow` policy switch (none / set)
- the `withdrawOutcome` switch (success / alreadyApplied / inProgress)
- the 17.5 demo data
- the updated prototype Open questions cells

### 17.7 Screen-to-slice map additions
| Screen / element | § | Backend slice(s) | UI slice |
|---|---|---|---|
| Apply window as a policy field; "No apply deadline (policy v{n})"; Apply expired only when set | 17.1 D-1 | A6-R, A2 | B1 (inbox, drawer), B5 (policy) |
| Alert thresholds from configuration | 17.1 D-2 | D3 | D3 UI, C6 UI (reconciliation) |
| `WithheldAmount` / `PaymentDueIndicator` on Renewals, Outstanding payments, Billing reconciliation | 17.2 | **R3**, C6 | C6 UI |
| `WithheldAmount` on Revenue (page ViewOnlyNote, count bars) | 17.2 | **R3**, D2 | D2 UI |
| `WithheldAmount` / `PaymentDueIndicator` on Tenant › Commercial | 17.2 | **R3**, A4 | B3 |
| `WithheldAmount` in the CR drawer and Approvals inbox | 17.2 | **R3**, A3 | B1 |
| `WithheldAmount` in Alerts | 17.2 | **R3**, D3 | D3 UI |
| `WithheldAmount` in Audit rows; export notice and omitted amounts | 17.2 | **R3**, A2 | B5 |
| Contracts terms masking | 17.2 | **R3**, A6 | B4 |
| Withdraw failed policy activation (action, dialog, refusals, timeline) | 17.3 | **ACC-1** | **B5** |

### 17.8 Not in this release
Payment recording (awaiting ratification).
