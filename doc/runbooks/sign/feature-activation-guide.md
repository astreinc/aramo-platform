# Aramo Sign — Feature Activation Guide (production)

| | |
|---|---|
| Version | v1.0, 2026-11-01 |
| Audience | The PO (decides, signs vendor contracts, arranges counsel, authorizes each flip) and the Claude Code session that does the engineering part of each flip |
| Code baseline | `origin/main` `394ffcc0` (PR #1056, the consolidated feature build). Usage metering is read from branch `feat/sign-usage-metering` (`0d9944c7`); ToS v2.0 from branch `feat/sign-tos-v2` (PR #1057). Neither branch is on `main` yet. |
| Governing | `Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED.md` (SHA-256 `2bd74ca5…`) and its Amendments A1 (vendor features), A2 (templates platform-only), A3 (metering D1/D3), A4 (metering D2), A5 (Personal stays Personal), all in OneDrive `Aramo/locked/` |
| Readiness work | `Aramo/documents/Aramo-Sign-Feature-Activation-Readiness-Directive-v0_1-DRAFT.md` (filed to `Aramo/locked/` as v1.0 LOCKED once approved). It builds the missing pieces listed in §7 (screens, nginx routes, console entitlement, plan limits, TSA login) so each feature is ready to switch on when its external prerequisites are done. Its item ids (AR-n) are referenced in each feature section below. |
| References | Vendor pack `Aramo/documents/Aramo-Sign-Vendor-Onboarding-Pack-20261101.md`; go-live list `Aramo/documents/Aramo-Sign-GoLive-Todo.md`; release runbook [`../RELEASE-box.md`](../RELEASE-box.md) |

**This guide is the master checklist** for switching each Sign feature on in production: what must happen
outside the code (vendor, registration, counsel, settings, entitlement) and the engineering step. A feature
is switched on only when its section's prerequisites are done, its readiness items (AR-n) are merged, and
the PO authorizes the flip.

**Switch-on status (PO R-8 authorization 2026-11-01, shipped in PR #1057):** `sign.templates`,
`sign.reports` and `sign.access_code` are AVAILABLE. Access code works through the API and the signer
page only until AR-2 adds the sender control. Every other key below is still `NOT_AVAILABLE`.

This guide does not authorize anything. Every flip below needs its own PO authorization (directive
§4 R-8; Amendment A1 §A1.2 item 4). Prices and lead times come from the vendor pack: they are
**references only, verify at signing**. Code facts carry `path:line` on `origin/main` unless a branch
is named. Where the code does not show something, the guide says **"confirm in code at flip time"**
and names what to look for.

---

## 1. How a Sign feature turns on

### 1.1 Production state at the time of writing

- The feature build (PR #1056) is merged to `main` but, as of 2026-11-01, **not deployed**. The go-live
  list item 4 plans a release window for it. Before any flip, confirm the deployed SHA with
  RELEASE-box STEP 8 (`docker inspect` image revision label). Every flip below assumes production runs a
  SHA that contains `394ffcc0`.
- Every feature in this guide is `NOT_AVAILABLE` today
  (`libs/subscription/src/lib/feature-availability.ts:21-78`), and every vendor setting is unset.

### 1.2 The switches that must all be "on"

A feature reaches a user only when **every** applicable switch below is on. They are independent: one
being on never turns another on.

| # | Switch | Where it lives | Who changes it | How |
|---|---|---|---|---|
| L1 | **Launch switch** (launch availability) | `libs/subscription/src/lib/feature-availability.ts` — one line per key, `'NOT_AVAILABLE'` → `'AVAILABLE'` | Engineering, only after the PO authorizes (R-8) | A one-line PR off `origin/main`, then a release ([`../RELEASE-box.md`](../RELEASE-box.md)) |
| L2 | **Server settings** | `/opt/aramo/.env` on the box, passed to the container by `docker-compose.prod.yml` | Engineering on the box, with values the PO obtained from the vendor | Encrypted `.env` snapshot, edit, recreate the service (section 1.4) |
| L3 | **Plan entitlement** | The subscription's pinned plan version, or a rule in code (varies per feature; table 1.3) | PO through the Platform Console (Catalog → Finance → Owner) where a console path exists; otherwise engineering | See 1.3 — for several features **no console path exists today** |
| L4 | **Organization type** | `Tenant.kind` (`BUSINESS` or `PERSONAL`) | Nobody at flip time — it is a fixed rule in code | Several features refuse every Personal account |
| L5 | **Outside prerequisites** | Vendor contract and production account, registrations, counsel review (A1.2 items 1–3) | PO | Per feature, section 3 |

How the launch switch is enforced: `isFeatureAvailable` returns true only for `'AVAILABLE'`; an unknown
key is unavailable (`feature-availability.ts:81-84`). `SignFeatureGate.assertAvailable` refuses with HTTP
403 `ESIGN_FEATURE_NOT_AVAILABLE` (`apps/sign-service/src/app/sign-feature.gate.ts:54-61`). The workspace
learns what to show from `GET /v1/sign/sender/context`
(`apps/sign-service/src/app/sender/esign-sender.controller.ts:67`), whose `features` block is computed in
`apps/sign-service/src/app/sender/sender-context.service.ts:230-242`.

### 1.3 Plan entitlement — what the code actually checks

The PO's model is "the plan version lists the feature, approved Catalog → Finance → Owner". The code
does that for **three** features only. The others use a fixed rule. This table is the ground truth for
each flip.

| Feature | Plan / organization rule in code | Evidence |
|---|---|---|
| Templates | Any open, sending, **paid** Sign subscription (every plan whose `sales_model` is not `FREE`, including Standard $10 Personal); Free never | `libs/subscription/src/lib/sign-template-entitlement.service.ts:33-47` (Free refused at `:43`); used by `apps/sign-service/src/app/sender/sender-templates.service.ts:117-135` |
| Branding | The subscription's **pinned plan version** has feature `sign.branding` enabled | `apps/sign-service/src/app/branding/sign-branding.service.ts:65-72` |
| Custom roles | BUSINESS, and the pinned plan version has `sign.custom_roles` enabled | `apps/sign-service/src/app/custom-roles/sign-custom-roles.gate.ts:48-70` |
| Payments | Plan key is `aramo-sign-standard-professional-v1` or `aramo-sign-enterprise-v1`, **or** the pinned plan version has `sign.payments` enabled | `apps/sign-service/src/app/payments/sign-payments.gate.ts:21`, `:43-46` |
| Reports | BUSINESS only; no plan check | `apps/sign-service/src/app/sender/sender-reports.service.ts:98-112`; `sender-context.service.ts:241` |
| Witness, delegate | BUSINESS only; no plan check | `apps/sign-service/src/app/sender/sender-envelope.service.ts:748-753` (used at `:723` and `:907`) |
| ID verification, KBA | BUSINESS only; no plan check | `sender-envelope.service.ts:1035-1039` |
| QES, India e-stamp | BUSINESS only (`assertBusiness`); no plan check | `apps/sign-service/src/app/regulated/regulated-signing.service.ts:74`, `:90`, `:102` |
| Access code | Every plan, including Free | `sender-envelope.service.ts:1001`; `sender-context.service.ts:236` |
| SMS, WhatsApp, SMS OTP | **No organization-type or plan check found** — only the launch switches | `apps/sign-service/src/app/messaging/sender-messaging.service.ts` (the `assertAnyAvailable` and per-channel checks); confirm in code at flip time |
| Trusted timestamp, document seal | **No plan check** — once on, applied to every completed envelope of every organization | `apps/sign-service/src/app/trusted-timestamp/rfc3161-tsa.adapter.ts:115-135`; `apps/sign-service/src/app/document-seal/remote-hash-signing.provider.ts:248-260` |

**Console limits that affect L3 (important).**

1. The console's draft editor can change only the price, envelopes per month and storage of a DRAFT
   version. It **cannot add a feature key** (`libs/subscription/src/lib/commercial/commercial-catalog.ts:11-15`).
2. Console plan creation (`PLAN_CREATE`, PR #1050, merged, not deployed) can include feature rows, but
   **refuses any key that is not `AVAILABLE`** (`libs/subscription/src/lib/commercial/commercial-plan-create.ts:89`).
   So the launch switch must ship **before** a plan that includes the feature can be created.
3. Publishing a new version **never moves an existing subscription**: subscribers keep their pinned
   version (`libs/subscription/src/lib/commercial/commercial-catalog-apply.service.ts:44`; features are
   read from the pinned version at `libs/subscription/src/lib/billing/subscription-lifecycle.service.ts:478-479`).
4. No migration on `main` gives any plan a `sign.branding`, `sign.custom_roles` or `sign.payments`
   feature row (search of every `*.sql` on `main`: the only hit is a comment in
   `libs/sign/prisma/migrations/20261101130000_sign_tenant_branding/migration.sql:5-7`).

Consequence: for **branding** and **custom roles**, no existing subscriber can be entitled through the
console today. Before those two flips are useful, the Lead and PO must choose one path (open decision
OD-1, section 6): a governed migration that adds the feature row to the current versions; a new console
action that adds feature rows to a draft version plus a way to move subscribers to it; or new plans via
`PLAN_CREATE` that new subscribers buy. Payments avoids this because of the plan-key fallback.

### 1.4 Standard flip procedure

Use this for every feature. Section 3 says which steps apply.

**Step A — PO prerequisites (before any engineering).**
1. Vendor contract signed and production account open (A1.2 item 1).
2. Registrations done (A1.2 item 2: 10DLC, DLT, Meta verification and templates, Stripe Connect platform
   profile, AATL CA subscriber agreement).
3. Counsel review done, including the Privacy Notice and sub-processor list (A1.2 item 3; section 4.2).
4. The PO writes the flip authorization naming the key(s), the plans, and the go-live date (A1.2 item 4).
   The authorization cites the directive by document ID and section.

**Step B — Launch switch PR (engineering).**
1. Branch off `origin/main`. Change only the authorized key(s) in
   `libs/subscription/src/lib/feature-availability.ts` and the comment above each line (record the PO
   authorization date). Update any test that pins the dark state (search the specs for the key).
2. Run the targeted tests for `sign-service` and `libs/subscription`; CI runs the full gate.
3. PO approves the merge.

**Step C — Release (engineering on the box).** Follow [`../RELEASE-box.md`](../RELEASE-box.md) exactly.
`libs/subscription` is built into sign-service and platform-admin (console plan creation re-reads the
registry at apply time, `commercial-plan-create.ts:110-112`), so SERVICES includes at least
`sign-service` and `platform-admin`; confirm the full list from the project graph at flip time. A UI change
also needs `nginx`, with `sign-service` running first (RELEASE-box HARD STOPS).

**Step D — Server settings (engineering on the box, only for features with env vars).**
1. Take the encrypted `.env` snapshot first — never a plaintext copy (RELEASE-box STEP 2 note):
   ```
   sudo sh -c 'set -a; . /etc/aramo/backup.conf; set +a; deploy/backup/aramo-env-snapshot.sh --label "pre-<flip-name>"'
   ```
2. Edit `/opt/aramo/.env`. Secrets are pasted by the PO or read from the vendor console during the
   session; they are never written to Git, a report, a chat log or `Aramo/documents/`.
3. Recreate the service that reads the variable. All feature variables in this guide are passed only to
   `sign-service` (`docker-compose.prod.yml:456` onward), except `SIGN_SMS_PROVIDER`, which also goes to
   `platform-admin` (`docker-compose.prod.yml:855`).
4. Recreating an application container **is a release** under RELEASE-box HARD STOPS: run the procedure
   with TARGET_SHA = the SHA already deployed, SERVICES = the services above, and its backup and migrate
   steps (migrate reports "already applied", which is fine).
5. The env change and the launch-switch release may share one window. Recommended order: set the env
   first while the feature is still dark (the adapters log their state, and an invalid seal or TSA setting
   refuses boot, so mistakes surface while nothing is live), then release the switch.

**Step E — Plan entitlement (PO in the Platform Console, only where table 1.3 says a plan check exists).**
`catalog@aramo.ai` drafts → `finance@aramo.ai` approves → the owner approves (the existing
PLAN_VERSION_PUBLISH / PLAN_CREATE chain). Remember the limits in 1.3.

**Step F — Verify in production (section 3, per feature),** then record the result in `Aramo/documents/`
(not in `locked/`).

**Turning a feature off.** Fastest: unset its env var(s) and recreate `sign-service` (vendor features go
dark at once). Complete: a PR that sets the key back to `NOT_AVAILABLE`, then a release. Envelopes already
sent keep their recorded evidence.

---

## 2. Summary table

Lead times and costs are references from the vendor pack (estimates unless marked documented). "Plans"
is the directive's placement (F Free, S Standard $10 Personal, B Standard Business $15, P Standard
Professional $20, E Enterprise; B+ = B, P, E) next to what the code enforces today.

| Feature | Launch key(s) | Vendor? | External lead time | Plans (directive) / code rule | Env vars (sign-service) | Blocking items now |
|---|---|---|---|---|---|---|
| Templates | `sign.templates` | No | None | S (PO to decide), B+; never F / any paid plan | — | PO decision on Standard (OD-2); Standard is entitled by code today |
| Reports | `sign.reports` | No | None | B+ / BUSINESS | — | PO authorization only |
| Branding | `sign.branding` | No | None | B+ / plan feature row | — | No console path to entitle existing plans (OD-1) |
| Custom roles | `sign.custom_roles` | No | None | P, E / BUSINESS + plan feature row | — | Same as branding (OD-1) |
| Witness signing | `sign.witness_signing` | No | None | B+ / BUSINESS | — | Sender UI built (B2; section 3.5) |
| Delegate signing | `sign.delegate_signing` | No | None | B+ / BUSINESS | — | Sender and signer UI built (B2/B3; section 3.6) |
| Access code | `sign.access_code` | No | None | All incl. F / all | — | Sender UI built (B2; section 3.7) |
| Personal → Business upgrade | — | — | — | — | — | REMOVED from the code (A5); not offered (section 3.8) |
| Personal paid checkout | none (env only) | Stripe live | 1–3 weeks for Stripe live setup (estimate) | S (US only) | `SIGN_PERSONAL_PAID_CHECKOUT_ENABLED` | Stripe live, ToS v2.0 effective, Standard price |
| Trusted timestamp | `sign.trusted_timestamp` | TSA | 2–6 weeks (estimate) | paid tiers / everyone | `SIGN_TSA_URL`, `SIGN_TSA_TIMEOUT_MS`, `SIGN_TSA_RETRY_INTERVAL_MS`, optional `SIGN_TSA_USERNAME` / `_PASSWORD` / `_CLIENT_CERT` / `_CLIENT_KEY` | Commercial TSA contract (basic or client-certificate authentication supported, section 3.10) |
| Document seal (AATL) | `sign.document_seal` | GlobalSign DSS (or CSC CA) | 4–8 weeks (estimate) | B+ / everyone | `SIGN_SEAL_*` (14 vars) | CA agreement, OV vetting, mTLS cert |
| SMS delivery (US) | `sign.sms_delivery` | AWS End User Messaging | 4–7 weeks (documented steps) | B+ metered / no check | `SIGN_SMS_PROVIDER`, `SIGN_SMS_AWS_*` (incl. `SIGN_SMS_AWS_INBOUND_TOPIC_ARN`), `SIGN_MESSAGING_*` | 10DLC, sandbox exit, TCPA review; two-way SNS topic for STOP; no plan check (OD-3) |
| SMS delivery (India) | `sign.sms_delivery` | MSG91 + DLT | 3–8 weeks (estimate; longer if an Indian entity is needed) | B+ metered / no check | `SIGN_SMS_PROVIDER`, `SIGN_SMS_MSG91_*` | Indian entity question; DLT |
| WhatsApp delivery | `sign.whatsapp_delivery` | Meta Cloud API | 1–4 weeks (estimate) | B+ metered / no check | `SIGN_WHATSAPP_*`, `SIGN_MESSAGING_*` | Meta verification; nginx route added (B1, deploys with nginx); sender UI built (B2) |
| SMS one-time code | `sign.sms_otp` | Same as SMS | Same as SMS | B+ metered / no check | Same as SMS | Same as SMS; sender UI and web signer screen built (B2), mobile signer screen missing |
| ID verification | `sign.id_verification` | Stripe Identity | Days to 2 weeks (estimate) | P, E metered / BUSINESS | `SIGN_ID_VERIFICATION_PROVIDER`, `SIGN_STRIPE_IDENTITY_*`, `SIGN_ID_VERIFICATION_MAX_ATTEMPTS` | BIPA/DPDP counsel; nginx route added (B1, deploys with nginx); sender UI not found; sender UI built (B2) |
| KBA | `sign.kba` | None selected | 6–12 weeks (estimate) | P, E metered / BUSINESS | `SIGN_KBA_PROVIDER` (no adapter) | No vendor, no adapter |
| Payments | `sign.payments` | Stripe Connect | 1–3 weeks (estimate) | P, E / plan key or feature row | `SIGN_STRIPE_CONNECT_*` | Connect platform profile, counsel |
| QES | `sign.qes` | QTSP (none selected) | 3–6 months (estimate) | E metered / BUSINESS | `SIGN_QES_PROVIDER`, `SIGN_QES_CSC_*` | No vendor; deferred (R-1); web signer step and callback page built (B3); no sender level control |
| India e-stamp | `sign.india_estamp` | Aggregator (none selected) | 2–4 months (estimate) | E (India) metered / BUSINESS | `SIGN_ESTAMP_PROVIDER` (no adapter) | No vendor, no adapter; deferred |
| Usage metering | none (env only) | Stripe meters | Part of Stripe live | metered units | `SIGN_USAGE_BILLING_ENABLED` (branch) | Branch not merged; D4 Stripe meters; live-mode hold in code |
| ToS v2.0 release day | none (registry dates) | Counsel | Counsel answers | all | `SIGN_POST_TERMINATION_EXPORT_DAYS` (to match B7.5) | Counsel Q1–Q7; PR #1057 |

Keys that exist but are **not built** (no activation path; flipping them would advertise something that
does not exist): `sign.forms` (`feature-availability.ts:24`), `sign.ai_assist_summary` (`:25`),
`sign.advanced_analytics` (`:26`), `sign.custom_domain` (`:31`). A Catalog v2 migration guard refuses any
Sign plan that enables `sign.ai_assist_summary`, `sign.advanced_analytics` or `sign.custom_domain`
(`libs/subscription/prisma/migrations/20261101120000_sign_catalog_v2/migration.sql:107-109`).

---

## 3. Feature sections

Each section has the same parts: What it does · Launch key(s) · Plan entitlement · External prerequisites
· Legal/counsel · Secrets & settings · Webhooks/DNS/nginx · Engineering flip steps · Production
verification · Rollback/turn-off · Open decisions.

### 3.1 Templates (adopted from platform defaults)

> **Status:** SWITCHED ON (AVAILABLE) by PO authorization 2026-11-01, live with the release of PR #1057. Standard is included as coded (OD-2; AR-10 only if the PO says no). Organizations see templates only after a platform default is published and they adopt it.

- **What it does.** A sender lists the templates the organization has **adopted** from the Aramo platform
  defaults, previews one, and creates and sends an envelope from it. Sign never creates, saves or edits a
  template; the organization adopts and edits its copy in Template Studio / Org Home (Amendment A2 §A2.1).
- **Launch key.** `sign.templates` (`feature-availability.ts:23`), enforced first in
  `sender-templates.service.ts:118`.
- **Plan entitlement.** Code: any open, sending, paid Sign subscription; Free never
  (`sign-template-entitlement.service.ts:33-47`). The caller also needs the `document_template:read` scope
  (`sender-templates.service.ts:119-124`). Directive: B+, Standard only if the PO decides (A2 §A2.1:
  "The PO decides whether Standard ($10, PERSONAL tenant) is entitled before the feature is turned on").
  **Today the code already includes Standard.** If the PO decides "no", a code change in
  `sign-template-entitlement.service.ts` is needed before the flip. No console step.
- **External prerequisites.** None. The platform default templates must exist and be published at platform
  level (TEMPLATE-STUDIO-1); an organization sees nothing until it adopts one.
- **Legal/counsel.** None (directive §1.1).
- **Secrets & settings.** None.
- **Webhooks/DNS/nginx.** None (sender routes are under `/v1/sign/sender/`, already proxied).
- **Engineering flip steps.** Step B (one key) → Step C. No env.
- **Production verification.**
  1. As a Business owner on a paid plan: `GET /v1/sign/sender/context` shows `features.templates: true`;
     the Templates page lists the organization's adopted templates; create an envelope from one and send it
     to a test address.
  2. As a Free Personal account: template routes answer 403 with `reason: templates_not_in_plan`
     (`sender-templates.service.ts:129-133`).
  3. As the organization with nothing adopted: the list is empty (not an error).
- **Rollback/turn-off.** Key back to `NOT_AVAILABLE` + release.
- **Open decisions.** OD-2: does Standard ($10 Personal) get templates? (go-live list item 38).

### 3.2 Reports

> **Status:** SWITCHED ON (AVAILABLE) by PO authorization 2026-11-01, live with the release of PR #1057.

- **What it does.** Organization reports: volume, turnaround, completion rate, by sender and template,
  CSV export and envelope audit export (directive §1.13; routes `GET /v1/sign/sender/reports/overview`,
  `/export`, `/envelopes/export`, `apps/sign-service/src/app/sender/esign-sender-reports.controller.ts:20,40,46,52`).
- **Launch key.** `sign.reports` (`feature-availability.ts:30`).
- **Plan entitlement.** BUSINESS only, no plan check (`sender-reports.service.ts:98-112`); the user needs
  `sign:report:read` (`sender-context.service.ts` permissions block). Directive: B+.
- **External prerequisites.** None.
- **Legal/counsel.** None.
- **Secrets & settings.** None.
- **Webhooks/DNS/nginx.** None.
- **Engineering flip steps.** Step B → Step C.
- **Production verification.** As a Business admin: the Reports page loads; the CSV export downloads and its
  totals match the envelope list for a known date range. As a Personal account: no Reports entry, and the
  routes answer 403 `business_plans_only`.
- **Rollback/turn-off.** Key back + release.
- **Open decisions.** None.

### 3.3 Branding

- **What it does.** Per-organization logo, colours and sender display name on signing pages, emails and
  the certificate (directive §1.10). Settings → Branding (`apps/sign-web/src/workspace/pages/Settings.tsx:41`);
  routes `GET/PUT /v1/sign/sender/branding`, `PUT /v1/sign/sender/branding/logo`
  (`apps/sign-service/src/app/branding/sign-branding.controller.ts:77,87,102`).
- **Launch key.** `sign.branding` (`feature-availability.ts:35`).
- **Plan entitlement.** The subscription's pinned plan version must enable `sign.branding`
  (`sign-branding.service.ts:65-72`); edits also need the settings-manage scope
  (`sign-branding.controller.ts:83`). **Blocked by OD-1:** no plan has this row and the console cannot add
  it to an existing plan (section 1.3).
- **External prerequisites.** None.
- **Legal/counsel.** None in the directive. Suggest the ToS cover subscriber-supplied logos (marks the
  subscriber has the right to use) — counsel to confirm.
- **Secrets & settings.** None.
- **Webhooks/DNS/nginx.** None.
- **Engineering flip steps.** Resolve OD-1 first → Step B → Step C → entitlement per the chosen OD-1 path.
- **Production verification.** On an entitled test organization: upload a logo and colours; send a test
  envelope; check the signing page, the invitation email and the completion certificate. On a
  non-entitled organization: the read shows `entitled: false` and a save answers 403 `plan_not_entitled`
  (`sign-branding.controller.ts:133-136`).
- **Rollback/turn-off.** Key back + release (stored branding stays in the table and is ignored).
- **Open decisions.** OD-1.

### 3.4 Custom roles

- **What it does.** Organization-defined Sign roles built from existing Sign scopes; a role can never
  exceed its creator's scopes (directive §1.21). Page `/sign/roles`
  (`apps/sign-web/src/workspace/App.tsx:211`); routes under `/v1/sign/sender/custom-roles`
  (`apps/sign-service/src/app/custom-roles/sign-custom-roles.controller.ts:33`).
- **Launch key.** `sign.custom_roles` (`feature-availability.ts:39`).
- **Plan entitlement.** BUSINESS, and the pinned plan version enables `sign.custom_roles`
  (`sign-custom-roles.gate.ts:48-70`). Directive: P, E. **Blocked by OD-1.**
- **External prerequisites.** None.
- **Legal/counsel.** None.
- **Secrets & settings.** None.
- **Webhooks/DNS/nginx.** None.
- **Engineering flip steps.** Resolve OD-1 → Step B → Step C → entitlement.
- **Production verification.** On an entitled Professional test organization: create a role with a subset
  of scopes, assign it to a test member, sign in as that member and confirm only the granted actions work.
  Try to create a role with a scope the creator lacks: refused. On a Business ($15) organization: 403
  `not_in_plan`.
- **Rollback/turn-off.** Key back + release. Confirm in code at flip time what happens to members who hold
  a custom role when the key goes back (look in `sign-custom-roles.gate.ts` and the identity scope
  resolution for custom-role scopes).
- **Open decisions.** OD-1.

### 3.5 Witness signing

- **What it does.** A WITNESS recipient tied to a signer attests after that signer; recorded on the
  certificate (directive §1.17).
- **Launch key.** `sign.witness_signing` (`feature-availability.ts:48`); checked when a WITNESS recipient
  is added (`sender-envelope.service.ts:907`).
- **Plan entitlement.** BUSINESS only (`sender-envelope.service.ts:748-753`). Directive: B+.
- **External prerequisites.** None.
- **Legal/counsel.** Counsel to confirm the certificate wording for witness attestations (what Aramo
  records: identity by email link only, unless a verification method is set).
- **Secrets & settings.** None.
- **Webhooks/DNS/nginx.** None.
- **Engineering flip steps.** Sender UI exists (Consolidated Directive B2, branch `feat/sign-rw-screens`):
  web Role "Witnesses a signer" + "Witnesses" picker in `apps/sign-web/src/workspace/pages/EnvelopeWizard.tsx` (Recipients step); mobile "Witness" chip + picker in
  `mobile/sign/src/screens/send/RecipientOptions.tsx` / `RecipientsStep.tsx`. Both appear only when `GET /v1/sign/sender/context` reports `features.witness_signing`
  (BUSINESS + key AVAILABLE), so the flip shows them. Step B → Step C (with `nginx` in SERVICES for the web
  bundle) and a mobile release.
- **Production verification.** Business test organization: create an envelope with signer A and witness W
  bound to A; W cannot act before A; after A and W act, the certificate lists W as witness for A. Personal
  account: adding a witness answers 403 `plan_not_eligible`.
- **Rollback/turn-off.** Key back + release.
- **Open decisions.** None.

### 3.6 Delegate signing

- **What it does.** If the sender allows it, a signer reassigns their role to someone else; an audit event
  is recorded and the delegate gets a new session (directive §1.17).
- **Launch key.** `sign.delegate_signing` (`feature-availability.ts:49`); checked when the sender sets
  `allow_delegation` (`sender-envelope.service.ts:723`) and on the signer's delegate call
  (`apps/sign-service/src/app/esign-http.controller.ts:300`).
- **Plan entitlement.** BUSINESS only (`sender-envelope.service.ts:748-753`). Directive: B+.
- **External prerequisites.** None.
- **Legal/counsel.** Counsel to confirm the ToS and signer disclosure cover delegation (the delegate signs
  in their own name; the original signer's consent to delegate is recorded).
- **Secrets & settings.** None.
- **Webhooks/DNS/nginx.** None (signer calls go through `/v1/sign/signing/`, already proxied).
- **Engineering flip steps.** UI exists (B2/B3): sender "Let signers hand off to someone else" (web
  `apps/sign-web/src/workspace/pages/EnvelopeWizard.tsx` (Recipients step); mobile `RecipientsStep.tsx`), shown only with `features.delegate_signing`; signer "Ask someone else
  to sign" (web `apps/sign-web/src/guest/App.tsx` DelegateDialog; mobile
  `mobile/sign/src/features/signing/SigningFlow.tsx`), shown only when the signer document view returns
  `can_delegate` (new field: sender allowed it + key AVAILABLE + the recipient may still hand off;
  `esign-http.controller.ts` `document`). Step B → Step C (`nginx` for web) and a mobile release.
- **Production verification.** Business test organization: envelope with delegation allowed; the signer
  delegates to a second address; the new address receives a link and signs; the activity log and
  certificate show the delegation. With delegation not allowed: the delegate call is refused.
- **Rollback/turn-off.** Key back + release.
- **Open decisions.** None.

### 3.7 Access code (per recipient)

> **Status:** SWITCHED ON (AVAILABLE) by PO authorization 2026-11-01, live with the release of PR #1057. Usable through the API and the signer page; the sender control (set / change / remove) ships with Consolidated Directive B2 (`feat/sign-rw-screens`) and is visible as soon as that release is deployed.

- **What it does.** The sender sets a code that the recipient must enter before signing (directive §1.9).
- **Launch key.** `sign.access_code` (`feature-availability.ts:50`); `sender-envelope.service.ts:1001`.
- **Plan entitlement.** Every plan, including Free (`sender-context.service.ts:236`).
- **External prerequisites.** None (the code is shared by the sender outside Aramo).
- **Legal/counsel.** None beyond describing it accurately on the certificate.
- **Secrets & settings.** None.
- **Webhooks/DNS/nginx.** None.
- **Engineering flip steps.** Signer entry screen: `apps/sign-web/src/guest/App.tsx` (AccessCodeCard).
  Sender control (B2): web `apps/sign-web/src/workspace/pages/EnvelopeWizard.tsx` (Recipients step) (AccessCodeControl: 4 to 32 printable characters, sent once, never shown
  again); mobile `mobile/sign/src/screens/send/RecipientOptions.tsx` / `RecipientsStep.tsx`. Shown with `features.access_code`. The key is already AVAILABLE: deploying the B2 web
  bundle (`nginx`) and the mobile release makes the control visible; no key change.
- **Production verification.** Send to a test address with a code; the signing page asks for it; a wrong
  code is refused and repeated wrong codes lock (`SIGNER_ACCESS_CODE_LOCKED`); the right code opens the
  document; the certificate records the method. Repeat from a Free Personal account.
- **Rollback/turn-off.** Key back + release. Confirm at flip time how envelopes already sent with a code
  behave once the key is off (look for the access-code check in the signer path).
- **Open decisions.** None.

### 3.8 Personal → Business upgrade

> **Status:** REMOVED from the code (A5). LOCKED by `Aramo-Sign-Feature-Parity-Program-Directive-Amendment-A5-Personal-Stays-Personal-v1_0-LOCKED.md` (PO 2026-11-01): Personal stays Personal, no Personal → Business upgrade. The dark upgrade code (routes, service, identity repository, audit event, sign-web card, env variable) was removed by readiness item AR-9; there is nothing to switch on. A sole proprietor uses the Personal Standard plan (3.9); a business signs up separately as Business (work email) on Business Standard, Business Professional or Enterprise. Plan changes within an account kind (Personal Free → Standard, Business plan upgrades and downgrades) are unaffected.

### 3.9 Personal paid checkout (Standard, $10)

- **What it does.** A Personal owner buys the Standard plan through the same checkout, portal and cancel
  flow as Business (`apps/sign-service/src/app/billing/esign-billing.controller.ts:64-72`).
- **Launch key.** None. Env only.
- **Plan entitlement.** US residents only (declared residence of the Personal signup;
  `esign-billing.controller.ts:92`); a non-US user gets 409 `personal_paid_us_only`. The plan
  `aramo-sign-standard-personal-v1` comes from the Catalog v2 migration
  (`libs/subscription/prisma/migrations/20261101120000_sign_catalog_v2/migration.sql:47`).
- **External prerequisites.** Stripe live (section 4.1): a live Stripe price for Standard ($10/month,
  USD) that matches the catalog list price; the price referenced either in `STRIPE_PLAN_PRICES`
  (`aramo-sign-standard-personal-v1=price_…`) or pinned to the plan version through the console. If both
  are set they must be equal, or checkout fails with `PARITY_MISMATCH`
  (`libs/subscription/src/lib/billing/provider-price.ts:43-52`). A billing portal configuration whose
  cancellation settings match the 12-month commitment (`STRIPE_PORTAL_CONFIGURATION`).
- **Legal/counsel.** ToS v2.0 effective, including Part C paid Personal terms and counsel's answers to
  Q18 (consumer 12-month commitment, auto-renewal, refunds) in the open-questions file. Go-live list item 13
  ("after 7 + 11").
- **Secrets & settings.** `SIGN_PERSONAL_PAID_CHECKOUT_ENABLED=1` (sign-service; not secret;
  `docker-compose.prod.yml:635`; `.env.prod.example:715-720`). Only exactly `1` enables
  (`esign-billing.controller.ts:86-89`). Stripe variables in section 4.1.
- **Webhooks/DNS/nginx.** Uses the existing billing webhook
  `https://sign.aramo.ai/v1/sign/billing/webhook/stripe` (`.env.prod.example:386-388`; nginx
  `location /v1/sign/billing/`, `deploy/nginx/templates/aramo.conf.template:371`).
- **Engineering flip steps.** After Stripe live is authorized and working for Business: Step D.
- **Production verification.** A US test Personal account sees the upgrade offer; checkout completes with a
  real card; the account shows Standard; Stripe shows the subscription; cancel from the portal; refund per
  policy. A non-US test account sees no offer.
- **Rollback/turn-off.** Unset + recreate. Existing paid subscriptions continue; manage them in Stripe.
- **Open decisions.** Counsel Q18.

### 3.10 RFC 3161 trusted timestamp (TSA)

- **What it does.** At completion, each executed document's SHA-256 and the evidence manifest are
  time-stamped by an RFC 3161 TSA; the certificate shows it. A TSA failure never blocks completion
  ("timestamp pending", retried) (`.env.prod.example:500-507`). The same TSA also stamps the document seal
  signature when the seal is on (`apps/sign-service/src/app/app.module.ts:275-278`).
- **Launch key.** `sign.trusted_timestamp` (`feature-availability.ts:43`). The adapter is bound only when the
  key is AVAILABLE **and** `SIGN_TSA_URL` is set (`rfc3161-tsa.adapter.ts:115-135`).
- **Plan entitlement.** None in code: every completed envelope of every organization is stamped once on.
  Directive: all paid tiers (§1.18).
- **External prerequisites.** D-3: a public TSA for build and test; a **commercial TSA (DigiCert or
  GlobalSign) before GA**. Vendor pack item 8: ask GlobalSign whether DSS includes a timestamp endpoint
  (simplest if the seal also uses GlobalSign); ask DigiCert and Sectigo for a contract with an uptime SLA.
  Get the TSA certificate chain and policy OID. Lead time 2–6 weeks (estimate); no public price found.
- **Legal/counsel.** Reliance limits and liability caps in the TSA terms (vendor pack item 8).
- **Secrets & settings (sign-service).**

  | Variable | Secret? | Example / default | Notes |
  |---|---|---|---|
  | `SIGN_TSA_URL` | No | the vendor's RFC 3161 URL | http or https; **no credentials in the URL** (refused, `rfc3161-tsa.adapter.ts:106`) |
  | `SIGN_TSA_TIMEOUT_MS` | No | `5000` | 500..60000, else boot is refused (`:123-129`) |
  | `SIGN_TSA_RETRY_INTERVAL_MS` | No | `60000` | minimum 10000 (`trusted-timestamp-retry.worker.ts:9,21`) |
  | `SIGN_TSA_USERNAME` / `SIGN_TSA_PASSWORD` | **Yes** | unset | optional HTTP basic credentials (both or neither); https URL only |
  | `SIGN_TSA_CLIENT_CERT` / `SIGN_TSA_CLIENT_KEY` | **Yes** | unset | optional TLS client certificate and private key, PEM, **base64-encoded** (both or neither; the key must match); https URL only |

  TSA authentication (Remaining-Work Directive B4): unset = an unauthenticated POST (the behaviour
  before B4). Basic credentials and a client certificate may be used alone or together; a partial,
  invalid or http-only setting **refuses boot** (`tsaAuthFromEnv`, `rfc3161-tsa.adapter.ts`), even while the
  key is NOT_AVAILABLE. An API-key header scheme is **not** supported (no TSA asking for one has been named);
  the vendor pack's `SIGN_TSA_POLICY_OID` and `SIGN_TSA_TRUST_CHAIN` still do not exist (the token is
  verified against the certificate the TSA returns).
- **Webhooks/DNS/nginx.** None (outbound only). If the box has an outbound firewall allow-list, add the TSA
  host (confirm at flip time; none is documented in the release runbook).
- **Engineering flip steps.** Step D first (TSA URL and any credentials set while dark: the log line
  "`SIGN_TSA_URL is set but sign.trusted_timestamp is not available`" confirms the settings parse,
  `rfc3161-tsa.adapter.ts`) → Step B → Step C. The probe check `sign:tsa-seal` alerts when a timestamp is
  still pending after 10 attempts (section 4.4).
- **Production verification.** Complete a test envelope; the certificate shows the timestamp; the
  sign-service log has no "timestamp pending" retries for it; the TimeStampResp validates against the TSA
  chain (e.g. with `openssl ts -verify` on an exported token — confirm the export path at flip time).
- **Rollback/turn-off.** Unset `SIGN_TSA_URL` + recreate (envelopes completed while off get no timestamp).
- **Open decisions.** Which TSA (D-3 says DigiCert or GlobalSign); whether only paid tiers should be stamped
  (code stamps everyone).

### 3.11 AATL document seal (PAdES)

- **What it does.** A PAdES signature (seal) on each executed PDF, with a certificate that chains to an
  Adobe Approved Trust List CA, so Acrobat shows a trusted signature (directive §1.15). One vendor-neutral
  remote hash-signing adapter; `SIGN_SEAL_PROVIDER` picks the vendor profile. **Never marketed as an
  advanced or qualified signature (R-2).**
- **Launch key.** `sign.document_seal` (`feature-availability.ts:72`). Bound only when the key is AVAILABLE
  and `SIGN_SEAL_PROVIDER` is set (`remote-hash-signing.provider.ts:248-260`).
- **Plan entitlement.** None in code (every executed PDF). Directive: B+.
- **External prerequisites.** D-3 default: **GlobalSign DSS**. Vendor pack item 6: request a quote; pass
  organization validation (OV) of Astre Consulting Services Inc; sign the DSS agreement; enroll an mTLS
  certificate and obtain the API key and secret in the Atlas portal; give written evidence of AATL
  technical-requirements compliance at setup and every year. Lead time 4–8 weeks (estimate). Cost: no
  public US price; UK G-Cloud lists £3,212 per licence per year (order-of-size only). Contract points: 1-year
  auto-renewing term (30 days' notice), 7-year record-keeping duty, audit right. Confirm the legal name shown
  on the seal (go-live list item 35). A CA that exposes the CSC API v2 can use the `csc` profile instead.
- **Legal/counsel.** The DSS agreement and DPA; the 7-year record duty; marketing limits (R-2).
- **Secrets & settings (sign-service; `docker-compose.prod.yml:601-614`; `.env.prod.example:551-580`).**
  Profiles: `globalsign-dss` and `csc` are enabled; `ssl-com-esigner` and `digicert` are TODO profiles that
  **refuse boot** (`apps/sign-service/src/app/document-seal/seal-provider-profiles.ts:100,134,169,188`).
  Any invalid setting refuses boot even while dark (`remote-hash-signing.provider.ts:80-125`).

  | Variable | Secret? | globalsign-dss | csc |
  |---|---|---|---|
  | `SIGN_SEAL_PROVIDER` | No | `globalsign-dss` | `csc` |
  | `SIGN_SEAL_ENDPOINT` | No | DSS API base, https | CSC base, https |
  | `SIGN_SEAL_AUTH_TYPE` | No | optional (profile default `mtls,api_key_login`) | optional (default `oauth_client_credentials`) |
  | `SIGN_SEAL_AUTH_API_KEY` / `SIGN_SEAL_AUTH_API_SECRET` | **Yes** | required | — |
  | `SIGN_SEAL_AUTH_MTLS_CERT` / `SIGN_SEAL_AUTH_MTLS_KEY` | key **Yes** (cert sensitive) | required, PEM base64-encoded | only if mTLS is added |
  | `SIGN_SEAL_AUTH_CLIENT_ID` / `SIGN_SEAL_AUTH_CLIENT_SECRET` | secret **Yes** | — | required |
  | `SIGN_SEAL_AUTH_TOKEN_URL` | No | — | optional (default `<endpoint>/oauth2/token`) |
  | `SIGN_SEAL_CERT_SUBJECT_DN` | No | required, a JSON object | — |
  | `SIGN_SEAL_CERT_CREDENTIAL_ID` | No | — | required |
  | `SIGN_SEAL_CERT_CHAIN` | No | optional extra intermediates, PEM base64 | optional |
  | `SIGN_SEAL_RETRY_INTERVAL_MS` | No | default `300000`, minimum 60000 | same |

  Vendor pack names differ (it proposed `SIGN_SEAL_GLOBALSIGN_BASE_URL`, `…_API_KEY`, `…_MTLS_CERT`, etc.);
  use the names above.
- **Webhooks/DNS/nginx.** None (outbound only). Add the DSS host to any outbound allow-list (confirm).
- **Engineering flip steps.** Commercial TSA first (LTV needs the timestamp; section 3.10). Step D while dark
  (boot proves the settings parse; the log says the seal stays off while the key is unavailable,
  `remote-hash-signing.provider.ts:255`) → Step B → Step C.
- **Production verification.** Complete a test envelope; open the executed PDF in Adobe Acrobat Reader: the
  signature panel shows the seal as valid and trusted, signed by the expected organization name, with an
  embedded timestamp. Check sign-service logs for seal retries.
- **Rollback/turn-off.** Unset `SIGN_SEAL_PROVIDER` + recreate. Already-sealed PDFs stay sealed.
- **Open decisions.** Seal on every plan or B+ only (code: every plan). Organization name shown on the seal.

### 3.12 SMS delivery — US (AWS End User Messaging, 10DLC)

- **What it does.** Sends the signing link (invitation and reminders) by SMS, with STOP opt-out, quiet hours
  in the recipient's time zone and per-organization hourly and daily limits
  (`apps/sign-service/src/app/messaging/sign-messaging.service.ts` header, policy steps 1–6). The SMS text is
  fixed in code (`apps/sign-service/src/app/messaging/messaging-adapters.ts`, `smsText`): "<sender> sent you a
  document to sign with Aramo Sign: <link> Reply STOP to opt out." The AWS adapter sends to every number
  except +91.
- **Launch key.** `sign.sms_delivery` (`feature-availability.ts:56`).
- **Plan entitlement.** **None found in code** (only the launch key; `sender-messaging.service.ts`). This
  means any organization, including Free Personal, could send SMS once on. Directive: B+ metered. See OD-3.
- **External prerequisites (vendor pack item 1).** In the AWS console, us-east-1:
  1. Register the 10DLC brand (company) — brand first, then vetting, then campaigns.
  2. Optional brand vetting ($41.50 one-time).
  3. Register the campaign: transactional, "signing request links and one-time passcodes", with 2 or more
     sample messages (use the exact text above), the opt-in description, HELP and STOP replies.
  4. Request a 10DLC number and associate it with the campaign (AWS says about 14 days).
  5. Exit the SMS sandbox: AWS Support case "Service limit increase" → "SMS Production Access".
  6. Raise the spend quota (`TextMessageMonthlySpend`), then set a lower enforced spend limit.
  7. Optional: a configuration set for delivery events.
  8. IAM: allow `sms-voice:SendTextMessage` for the identity sign-service uses.
  Documented times: brand 1–2 business days, vetting 1–2 business days, campaign up to 4 weeks, number up to
  10 days. Costs (reference): brand $4.50 one-time, campaign $10/month (or $2 low volume), number $1/month,
  per-message price from the AWS per-country list.
- **Legal/counsel.** TCPA: who consents (the sender collects the number, not the signer) and what the sender
  attests; CTIA principles; whether one Aramo brand and campaign covers all subscribers; Privacy Notice and
  sub-processor list (AWS SMS; phone numbers).
- **Secrets & settings (sign-service; `docker-compose.prod.yml:636-663`; `.env.prod.example:721-764`).**

  | Variable | Secret? | Value |
  |---|---|---|
  | `SIGN_SMS_PROVIDER` | No | `aws` (or `aws,msg91` with India); values: `log`, `aws`, `msg91`; unknown values are ignored with an error log (`messaging-adapters.ts:302-314`) |
  | `SIGN_SMS_AWS_ORIGINATION_IDENTITY` | No | the 10DLC number, pool id or ARN — **required** |
  | `SIGN_SMS_AWS_REGION` | No | `us-east-1` (falls back to `AWS_REGION`) |
  | `SIGN_SMS_AWS_CONFIGURATION_SET` | No | optional |
  | `SIGN_SMS_AWS_ACCESS_KEY_ID` / `SIGN_SMS_AWS_SECRET_ACCESS_KEY` | **Yes** | optional dedicated IAM user; unset ⇒ the SDK default chain |
  | `SIGN_SMS_AWS_INBOUND_TOPIC_ARN` | No | the SNS topic ARN of the number's two-way channel; unset ⇒ the inbound route answers 404 |
  | `SIGN_MESSAGING_QUIET_HOURS` | No | default `21-8`; `off` disables |
  | `SIGN_MESSAGING_DEFAULT_TIMEZONE` | No | default `UTC` |
  | `SIGN_MESSAGING_TENANT_HOURLY_LIMIT` / `SIGN_MESSAGING_TENANT_DAILY_LIMIT` | No | defaults `100` / `500` |

  `SIGN_SMS_PROVIDER` is **shared** with platform-admin's Personal phone verification
  (`docker-compose.prod.yml:855`); only `log` turns that on, so `aws` leaves it disabled
  (`messaging-adapters.ts:18-20`). Recreate both `sign-service` and `platform-admin` after changing it.
  Vendor pack name check: its `SIGN_SMS_AWS_REGION`, `SIGN_SMS_AWS_ORIGINATION_IDENTITY` and
  `SIGN_SMS_AWS_CONFIGURATION_SET` match the code.
- **Webhooks/DNS/nginx.** Inbound STOP / START (Remaining-Work Directive B5): route
  `POST /v1/sign/messaging/sms/inbound/aws` (`SignSmsInboundWebhookController`,
  `apps/sign-service/src/app/messaging/sign-messaging.controller.ts`; nginx location
  `/v1/sign/messaging/sms/inbound/`, session-less, raw body). It answers 404 unless
  `SIGN_SMS_AWS_INBOUND_TOPIC_ARN` is set, `SIGN_SMS_PROVIDER` includes a configured `aws` and the launch key
  is AVAILABLE. AWS setup: enable two-way SMS on the 10DLC number with an **Amazon SNS topic** as the
  destination, subscribe `https://sign.aramo.ai/v1/sign/messaging/sms/inbound/aws` to it (protocol HTTPS) and
  set the topic ARN in `SIGN_SMS_AWS_INBOUND_TOPIC_ARN`; sign-service verifies each SNS signature (certificate
  from an `sns.<region>.amazonaws.com` https URL only) and confirms the subscription itself (log line
  "`sms inbound: SNS subscription confirmed`"). A STOP / START reply updates the same opt-out list every send
  checks (service header step 3). AWS also keeps its own opt-out list; a vendor-reported opt-out on a failed
  send is still added (step 6). **Confirm at flip time** that the topic policy lets End User Messaging
  publish to it (AWS console) — not verifiable from code.
- **Engineering flip steps.** Sender UI exists (B2): "Send the link by: Email and text message (SMS)" with a
  mobile number checked as E.164, web `apps/sign-web/src/workspace/pages/EnvelopeWizard.tsx` (Recipients step) (TextMessageControl) and mobile `mobile/sign/src/screens/send/RecipientOptions.tsx` / `RecipientsStep.tsx`; saved through
  `PUT /v1/sign/sender/envelopes/:id/recipients/:signerId/messaging`. Shown with the new sender-context key
  `features.sms_delivery` (availability only — no plan rule, OD-3). Resolve OD-3. Step D → Step B → Step C.
  Decide whether metering (section 3.21) must be on first so SMS is billed.
- **Production verification.** Send to a US test phone; the SMS arrives with the link; the delivery row and
  ledger event exist (`SIGNER_MESSAGE_SENT`); reply STOP and confirm the next send is suppressed
  (`opted_out`); send during quiet hours and confirm suppression; the log shows only masked numbers.
- **Rollback/turn-off.** Unset `SIGN_SMS_PROVIDER` + recreate both services (email delivery continues).
- **Open decisions.** OD-3 (plan restriction); OD-4 (metering before first SMS).

### 3.13 SMS delivery — India (MSG91 + TRAI DLT)

- **What it does.** Same as 3.12 for +91 numbers only; MSG91 sends DLT-registered templates.
- **Launch key.** `sign.sms_delivery` (and `sign.sms_otp` for codes).
- **Plan entitlement.** As 3.12.
- **External prerequisites (vendor pack item 2).** First ask MSG91 in writing whether a US company with no
  Indian PAN or GST can register as a DLT Principal Entity. Then: register the entity on one DLT portal;
  register a 6-character header (for example `ARAMOS`); register each content template (invitation,
  reminder, OTP) with exact text; whitelist `sign.aramo.ai` for URLs; declare the delivery chain; map the
  entity, header and template ids in MSG91. Lead time 3–8 weeks (estimate), more if an Indian entity is
  formed. Cost reference: SmartPing DLT entity fee INR 5,000 plus GST; per-SMS price by quote.
- **Legal/counsel.** TRAI TCCCPR 2018; DPDP Act 2023; the Indian entity or partner question (one decision
  covers SMS and e-stamp, go-live list item 36); Privacy Notice and sub-processors (MSG91, DLT operator).
- **Secrets & settings (sign-service).**

  | Variable | Secret? | Value |
  |---|---|---|
  | `SIGN_SMS_PROVIDER` | No | `msg91` or `aws,msg91` |
  | `SIGN_SMS_MSG91_AUTH_KEY` | **Yes** | MSG91 auth key |
  | `SIGN_SMS_MSG91_TEMPLATE_INVITATION` / `_REMINDER` / `_OTP` | No | the DLT template id per purpose; a purpose without one is not sent |

  Template variables the code fills: `##sender##`, `##link##`, `##otp##`, `##minutes##`
  (`.env.prod.example`, MSG91 block). The DLT templates must use exactly these. MSG91 is off unless the auth
  key and at least one template id are set (`messaging-adapters.ts:306`).
  | `SIGN_SMS_MSG91_SENDER_ID` | No | optional: the DLT-registered 6-letter header, sent with every request |
  | `SIGN_SMS_MSG91_DLT_ENTITY_ID` | No | optional: the DLT Principal Entity id (digits), sent with every request |

  The header and entity id (Remaining-Work Directive B5) are sent as the Flow API body fields `sender` and
  `DLT_PE_ID` (`MSG91_SENDER_FIELD` / `MSG91_DLT_ENTITY_FIELD`, `messaging-adapters.ts`); unset ⇒ the MSG91
  account's own mapping applies; an invalid value leaves MSG91 off with an error log. **Confirm both field
  names with MSG91 in writing at onboarding** (their public Flow API page does not list them); a different
  name is a one-line change. **Name differences from the vendor pack:** `SIGN_SMS_MSG91_TEMPLATE_IDS` and
  `SIGN_SMS_ROUTING` do not exist. Routing is automatic (+91 → MSG91, others → AWS).
- **Webhooks/DNS/nginx.** None in code (no MSG91 delivery-report or inbound route). India opt-out is by the
  TRAI DLT preference registry, not keyword replies to a 6-letter header (which cannot receive replies); MSG91
  inbound needs a long code or virtual number and documents no request signature, so no MSG91 inbound route
  was built (Remaining-Work Directive B5 gap).
- **Engineering flip steps.** As 3.12.
- **Production verification.** Send to an Indian test number: the DLT template arrives with the link; a +1
  number in the same envelope goes through AWS (if configured).
- **Rollback/turn-off.** Remove `msg91` from `SIGN_SMS_PROVIDER` + recreate.
- **Open decisions.** Indian entity or partner (go-live list item 36).

### 3.14 WhatsApp delivery (Meta Cloud API)

- **What it does.** Sends the signing link by an approved WhatsApp template; inbound STOP keywords and
  delivery statuses come back through a webhook (`sign-messaging.controller.ts:127-196`).
- **Launch key.** `sign.whatsapp_delivery` (`feature-availability.ts:57`).
- **Plan entitlement.** None found in code (OD-3). Directive: B+ metered.
- **External prerequisites (vendor pack item 3).** Meta Business portfolio in the legal name "Astre Consulting
  Services Inc"; business verification in Security Center (official documents; names and addresses must
  match exactly); a developer app with the WhatsApp product and a WhatsApp Business Account; a phone number
  not on any WhatsApp app, display name "Aramo Sign"; a system user and permanent access token; templates
  in the utility category (invitation, reminder) with body `{{1}}` = sender name, `{{2}}` = link
  (`.env.prod.example`, WhatsApp block); a payment method; the webhook. Lead time 1–4 weeks (estimate).
  Price reference: per message by country and category (US authentication about $0.0034; verify on Meta's
  rate card).
- **Legal/counsel.** Meta Business Messaging and Commerce policies; opt-in capture; Meta Business Tools terms
  and data processing terms; DPDP for India; Privacy Notice and sub-processors (Meta).
- **Secrets & settings (sign-service).**

  | Variable | Secret? | Value |
  |---|---|---|
  | `SIGN_WHATSAPP_PROVIDER` | No | `meta` (or `log` for tests) |
  | `SIGN_WHATSAPP_PHONE_NUMBER_ID` | No | from the WhatsApp Business Account — required |
  | `SIGN_WHATSAPP_ACCESS_TOKEN` | **Yes** | system user token — required |
  | `SIGN_WHATSAPP_TEMPLATE_INVITATION` | No | approved template name — required |
  | `SIGN_WHATSAPP_TEMPLATE_REMINDER` | No | optional; falls back to the invitation template |
  | `SIGN_WHATSAPP_TEMPLATE_LANGUAGE` | No | default `en_US` |
  | `SIGN_WHATSAPP_GRAPH_VERSION` | No | default `v21.0` |
  | `SIGN_WHATSAPP_APP_SECRET` | **Yes** | verifies `X-Hub-Signature-256` |
  | `SIGN_WHATSAPP_VERIFY_TOKEN` | **Yes** (a shared value you invent) | answers Meta's subscription check |

  Vendor pack names that differ: `SIGN_WHATSAPP_BUSINESS_ACCOUNT_ID` (not used), `SIGN_WHATSAPP_WEBHOOK_VERIFY_TOKEN`
  (actual: `SIGN_WHATSAPP_VERIFY_TOKEN`), `SIGN_WHATSAPP_TEMPLATE_NAMES` (actual: per-purpose variables),
  `SIGN_WHATSAPP_GRAPH_API_VERSION` (actual: `SIGN_WHATSAPP_GRAPH_VERSION`).
- **Webhooks/DNS/nginx.** Webhook URL to register at Meta:
  `https://sign.aramo.ai/v1/sign/messaging/whatsapp/webhook` (route: `sign-messaging.controller.ts:127`; GET
  for the verify handshake, POST for events). It answers 404 unless the app secret, the verify token **and**
  the launch key are all set. nginx: location `/v1/sign/messaging/whatsapp/webhook` on the Sign host
  (`deploy/nginx/templates/aramo.conf.template`, Remaining-Work Directive B1) proxies to `sign-service:3003`
  session-less with the body untouched (the signature is over the raw body), rate-limited in `sign_workspace`;
  the release that carries it rebuilds and recreates nginx (with sign-service running first). Because the
  handshake needs the launch key, register the webhook at Meta **after** the flip release.
- **Engineering flip steps.** Step D → Step B → Step C (SERVICES includes `nginx` if the B1 nginx change is not yet
  deployed) → register the webhook at Meta. The sender choice "Email and WhatsApp" exists (B2, web and mobile,
  shown with the new context key `features.whatsapp_delivery`).
- **Production verification.** Meta's "Verify and save" succeeds; a test envelope sends the template to a test
  WhatsApp number; delivered and read statuses update the delivery row; replying STOP suppresses the next
  send.
- **Rollback/turn-off.** Unset `SIGN_WHATSAPP_PROVIDER` + recreate (the webhook then answers 404).
- **Open decisions.** OD-3, OD-4.

### 3.15 SMS one-time code (recipient verification)

- **What it does.** The signer must enter a code sent by SMS before signing: 10-minute codes, 5 attempts per
  code, 60 s between sends, 5 sends a day; a code whose attempts are used up locks
  (`apps/sign-service/src/app/messaging/recipient-otp.service.ts:37-39`). Signer routes
  `POST /v1/sign/signing/verification/sms-otp/send` and `/verify` (`sign-messaging.controller.ts:64,87,94`).
- **Launch key.** `sign.sms_otp` (`feature-availability.ts:58`), plus a working SMS provider (3.12 / 3.13).
- **Plan entitlement.** None found in code (OD-3). Directive: B+ metered.
- **External prerequisites.** As SMS; the OTP text must be in the 10DLC campaign samples and, for India, a DLT
  OTP template (`SIGN_SMS_MSG91_TEMPLATE_OTP`).
- **Legal/counsel.** As SMS; certificate wording for "verified by SMS code".
- **Secrets & settings.** As 3.12 / 3.13.
- **Webhooks/DNS/nginx.** None (signer routes under `/v1/sign/signing/` are proxied).
- **Engineering flip steps.** Sender: "Ask for a code sent by SMS before signing" (web `apps/sign-web/src/workspace/pages/EnvelopeWizard.tsx` (Recipients step); mobile
  `mobile/sign/src/screens/send/RecipientOptions.tsx` / `RecipientsStep.tsx`), shown with the new context key `features.sms_otp`; the old disabled "Link + passcode (proposal)"
  option is gone. Signer (web): `apps/sign-web/src/guest/App.tsx` SmsCodeCard (text me a code → enter it;
  locked → its own end screen). **Gap:** the mobile signer has no SMS-code screen — a recipient with the code
  set who opens the link in the Aramo Sign app gets an error screen; ship that screen before the flip or
  accept web-only signing for these recipients. Then Step B → Step C (after SMS is live).
- **Production verification.** Signer receives the code, a wrong code is refused, the right code opens the
  document, the certificate records the method; exhaust attempts and confirm the lock message.
- **Rollback/turn-off.** Key back + release, or remove the SMS provider.
- **Open decisions.** OD-3, OD-4.

### 3.16 ID verification (Stripe Identity)

- **What it does.** The sender requires a signer to pass a government-ID document check before signing.
  The code requests **document checks only**: no matching selfie, no ID number, no date of birth
  (`libs/sign/src/lib/identity-verification/stripe-identity.adapter.ts:24-27`, `:160-165`); only the
  outcome, the issuing country and (transiently) the name are read (R-5: raw images stay at Stripe). Routes:
  signer `POST /v1/sign/signing/identity-verification/start` and `/status`, webhook
  `POST /v1/sign/identity-verification/webhook/stripe`
  (`apps/sign-service/src/app/identity-verification/sign-identity-verification.controller.ts:36,47,59`).
- **Launch key.** `sign.id_verification` (`feature-availability.ts:63`); checked at start (`:51` of the
  controller) and when the sender sets the method (`sender-envelope.service.ts:1035-1036`).
- **Plan entitlement.** BUSINESS only, no plan check (`sender-envelope.service.ts:1037-1039`). Directive: P, E
  metered.
- **External prerequisites (vendor pack item 4).** Decide: the existing Aramo Stripe account or a separate one
  (go-live list item 33). Activate Identity and answer Stripe's use-case questions; set retention and
  redaction; create a **restricted key** with Identity read/write and verified-outputs access only; add the
  webhook endpoint. Lead time days to 2 weeks (estimate). Price reference: $1.50 per completed verification
  as listed for document plus selfie (the code does not request a selfie — confirm the document-only price
  with Stripe); first 50 free.
- **Legal/counsel.** BIPA (Illinois) and other state biometric laws — counsel to confirm whether a
  document-only check without selfie matching still engages them; DPDP if used for India; Stripe's Identity
  terms and DPA (controller and processor roles); retention of results; Privacy Notice, sub-processor list and
  signer disclosure (section 4.2).
- **Secrets & settings (sign-service; `.env.prod.example:517-534`).**

  | Variable | Secret? | Value |
  |---|---|---|
  | `SIGN_ID_VERIFICATION_PROVIDER` | No | `stripe_identity` (anything else = disabled, `libs/sign/src/lib/identity-verification/identity-gate.ts:76-80`) |
  | `SIGN_STRIPE_IDENTITY_SECRET_KEY` | **Yes** | restricted key `rk_…` — never the billing `STRIPE_SECRET_KEY` |
  | `SIGN_STRIPE_IDENTITY_WEBHOOK_SECRET` | **Yes** | `whsec_…` of the identity endpoint |
  | `SIGN_ID_VERIFICATION_MAX_ATTEMPTS` | No | default `3`, 1..10 |

  Vendor pack names that differ: `SIGN_IDV_PROVIDER`, `SIGN_IDV_STRIPE_SECRET_KEY`,
  `SIGN_IDV_STRIPE_PUBLISHABLE_KEY` (no publishable key is used), `SIGN_IDV_STRIPE_WEBHOOK_SECRET`.
- **Webhooks/DNS/nginx.** Register at Stripe: `https://sign.aramo.ai/v1/sign/identity-verification/webhook/stripe`,
  events `identity.verification_session.verified`, `.requires_input`, `.canceled`
  (`stripe-identity.adapter.ts:33-37`). nginx: location `/v1/sign/identity-verification/webhook/` on the Sign
  host (Remaining-Work Directive B1) proxies to `sign-service:3003` session-less with the body untouched
  (modelled on `/v1/sign/payments/webhook/`), rate-limited in `sign_workspace`; the release that carries it
  rebuilds and recreates nginx.
- **Engineering flip steps.** Step D → Step B → Step C. Signer screens exist
  (`apps/sign-web/src/guest/App.tsx`, identity screen). Sender control exists (B2): web "Verification →
  Secure link + photo ID check" in `apps/sign-web/src/workspace/pages/EnvelopeWizard.tsx` (Recipients step); mobile "ID check" in `mobile/sign/src/screens/send/RecipientOptions.tsx` / `RecipientsStep.tsx`; shown with the new context key
  `features.id_verification` (BUSINESS + key AVAILABLE).
- **Production verification.** Business test envelope with ID verification on a signer: the signer is sent to
  Stripe, completes with a real document, returns, and can sign; the certificate shows the result; Stripe's
  dashboard shows the session; a failed attempt counts toward the limit and locks after
  `SIGN_ID_VERIFICATION_MAX_ATTEMPTS`; confirm Aramo stored no images.
- **Rollback/turn-off.** Unset `SIGN_ID_VERIFICATION_PROVIDER` + recreate (starts are refused 503); then the key
  back.
- **Open decisions.** Same or separate Stripe account; OD-4 (metering).

### 3.17 KBA (knowledge-based authentication)

- **What it does.** US-only identity questions before signing.
- **Launch key.** `sign.kba` (`feature-availability.ts:64`).
- **Plan entitlement.** BUSINESS only (`sender-envelope.service.ts:1035-1039`).
- **External prerequisites.** **No vendor selected** (D-3). Options: LexisNexis InstantID Q&A, GBG IDology
  ExpectID IQ; credentialing, GLBA/DPPA permissible-use certification, master agreement; 6–12 weeks
  (estimate); price by quote.
- **Legal/counsel.** FCRA (must not drive credit, insurance or employment decisions), GLBA/DPPA permissible
  purpose, NIST 800-63-3 weakness (market as an extra check only), US only.
- **Secrets & settings.** `SIGN_KBA_PROVIDER` exists, but **every value resolves to the disabled adapter**
  (`libs/sign/src/lib/identity-verification/kba.port.ts:71-79`). The vendor pack's `SIGN_KBA_BASE_URL`,
  `SIGN_KBA_ACCOUNT_ID`, etc. do not exist.
- **Webhooks/DNS/nginx.** Unknown until an adapter exists.
- **Engineering flip steps.** **Not activatable.** Needs a vendor choice, then an adapter PR (directive D-4),
  then this guide's steps. The sender choice exists (B2: "Secure link + identity questions (US)" on web,
  "Questions" on mobile, shown with the new context key `features.kba`), but there is **no signer KBA
  screen** (web or mobile); build it with the adapter.
- **Production verification.** N/A.
- **Rollback/turn-off.** N/A.
- **Open decisions.** Vendor selection (go-live list item 37).

### 3.18 Payments (Stripe Connect)

- **What it does.** A PAYMENT field: the signer pays the **organization** on Stripe's hosted Checkout page.
  Each payment is a direct charge on the organization's own Standard connected account; Aramo never holds
  funds (R-6) and card data never touches Aramo
  (`apps/sign-service/src/app/payments/stripe-connect-payment.provider.ts:19-35`). Organizations connect in
  Settings → Payments (`Settings.tsx:46`, shown only when `features.payments`).
- **Launch key.** `sign.payments` (`feature-availability.ts:67`).
- **Plan entitlement.** All three must hold: key AVAILABLE; Connect enabled with both keys; the plan is
  Professional or Enterprise **or** its pinned version enables `sign.payments`
  (`sign-payments.gate.ts:10-17`, `:21`, `:43-46`, `:61-67`). Professional and Enterprise work with **no
  console step**.
- **External prerequisites (vendor pack item 5).** Same-or-separate Stripe account decision; complete the
  Connect **platform profile** (Stripe blocks live connected accounts until done); acknowledge platform
  responsibilities; use Standard accounts; choose "Stripe handles pricing" unless Aramo charges a fee; add
  the Connect webhook ("Events on Connected accounts"). Lead time 1–3 weeks (estimate). Cost reference:
  "Stripe handles pricing" = no platform fees.
- **Legal/counsel.** ToS payment, refund and dispute terms; the Stripe Connected Account Agreement reference;
  no money-transmitter exposure; PCI stays with Stripe.
- **Secrets & settings (sign-service; `docker-compose.prod.yml:594-597`; `.env.prod.example:535-550`).**

  | Variable | Secret? | Value |
  |---|---|---|
  | `SIGN_STRIPE_CONNECT_ENABLED` | No | `1` (only exactly `1`, `sign-payments.config.ts:32`) |
  | `SIGN_STRIPE_CONNECT_SECRET_KEY` | **Yes** | the Connect **platform** key; separate from `STRIPE_SECRET_KEY` |
  | `SIGN_STRIPE_CONNECT_WEBHOOK_SECRET` | **Yes** | `whsec_…` of the Connect endpoint |
  | `SIGN_STRIPE_CONNECT_APPLICATION_FEE_AMOUNT` | No | Aramo's fee per payment in cents; default `0` |

  Unlike Aramo's own billing, the Connect adapter has **no live-mode hold** in code: a live key works once
  set. Vendor pack names that differ: `SIGN_PAYMENTS_PROVIDER`, `SIGN_PAYMENTS_STRIPE_SECRET_KEY`,
  `…_PUBLISHABLE_KEY`, `…_CONNECT_WEBHOOK_SECRET`, `…_CONNECT_CLIENT_ID` (none exists; onboarding uses
  Account Links, not OAuth).
- **Webhooks/DNS/nginx.** Register at Stripe (Connect endpoint):
  `https://sign.aramo.ai/v1/sign/payments/webhook/stripe` (route `sign-payments-public.controller.ts:60`;
  nginx location exists, `aramo.conf.template:376-384`). Events handled: `account.updated`,
  `account.application.deauthorized`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`
  (`stripe-connect-payment.provider.ts:251-262`). Signature tolerance 300 s (`:39`). Return URLs built by
  the server: onboarding `https://sign.aramo.ai/sign/settings/payments?onboarding=return|refresh`
  (`sign-payment.service.ts:159-160`); payer return `/s/payment-return` (`apps/sign-web/src/guest/App.tsx:93`).
- **Engineering flip steps.** Step D → Step B → Step C.
- **Production verification.** A Professional test organization connects a real Standard account; a test
  envelope with a PAYMENT field; the signer pays a small amount; the field shows PAID; funds appear in the
  connected account (not Aramo's); refund from the envelope; the evidence records payment status. A Business
  ($15) organization does not see Payments.
- **Rollback/turn-off.** Unset `SIGN_STRIPE_CONNECT_ENABLED` + recreate. Refunds of earlier payments need the
  keys (`sign-payments.gate.ts:56-59`), so keep the keys set if refunds may be needed.
- **Open decisions.** Application fee (default 0); same or separate Stripe account.

### 3.19 QES (qualified electronic signature through a QTSP)

- **What it does.** A signer signs with a qualified signature issued by an EU Qualified Trust Service
  Provider over the CSC API v2. **Aramo is not a QTSP and must never claim to be one (R-1); not marketed or
  sold (R-2).**
- **Launch key.** `sign.qes` (`feature-availability.ts:77`).
- **Plan entitlement.** BUSINESS only (`regulated-signing.service.ts:74`). Directive: E metered.
- **External prerequisites.** **No vendor selected**; the directive recommends deferring until EU demand.
  Options: InfoCert, Namirial, Swisscom, D-Trust; RFP, EU Trusted List check, partner agreement and DPA;
  3–6 months (estimate).
- **Legal/counsel.** eIDAS (EU 910/2014 as amended by 2024/1183); GDPR transfers; marketing limits.
- **Secrets & settings.** `SIGN_QES_PROVIDER=csc` plus all four of `SIGN_QES_CSC_BASE_URL`,
  `SIGN_QES_CSC_OAUTH_URL` (https), `SIGN_QES_CSC_CLIENT_ID`, `SIGN_QES_CSC_CLIENT_SECRET` (**secret**);
  incomplete ⇒ disabled with a warning (`apps/sign-service/src/app/regulated/csc-qes-signing.adapter.ts:178-190`).
  Vendor pack names that differ: `SIGN_QES_OAUTH_CLIENT_ID`, `SIGN_QES_OAUTH_CLIENT_SECRET`,
  `SIGN_QES_OAUTH_REDIRECT_URI` (derived, not set), `SIGN_QES_MTLS_*` (not supported).
- **Webhooks/DNS/nginx.** The redirect URI registered at the QTSP is `https://sign.aramo.ai/qes/callback`
  (`regulated-signing.service.ts:36-45`). The page exists (B3): `/qes/callback` is a guest page
  (`apps/sign-web/src/zones.ts`; `QesCallback` in `apps/sign-web/src/guest/App.tsx`); it finishes each step
  with the signing token kept in the browser tab (never sent to the QTSP) and returns the signer to
  `/s/qes-return` → Review & finish. The SPA `location /` already serves it; no nginx change.
- **Engineering flip steps.** **Not activatable as built:** needs a vendor and a CSC sandbox test. Signer
  web UI exists (B3): Review & finish shows "Qualified electronic signature → Continue to sign" while the
  signer's QES row is not SIGNED, and Finish waits for it. **Gaps:** no sender control for
  `PUT /v1/sign/sender/envelopes/:id/signers/:signerId/signature-level` (not in B2's list) and no mobile
  signer QES step. Then Step D → Step B → Step C.
- **Production verification.** N/A until built.
- **Rollback/turn-off.** Unset `SIGN_QES_PROVIDER` + recreate.
- **Open decisions.** Whether QES is in scope at all (directive §3 item 4).

### 3.20 India e-stamp

- **What it does.** Buy and attach state e-stamp paper to an envelope through an aggregator (directive §1.19).
  Sender routes exist under `/v1/sign/sender/envelopes/:id/estamp`
  (`apps/sign-service/src/app/regulated/esign-sender-regulated.controller.ts:18-20`).
- **Launch key.** `sign.india_estamp` (`feature-availability.ts:78`).
- **Plan entitlement.** BUSINESS only (`regulated-signing.service.ts:90`, `:102`).
- **External prerequisites.** **No vendor selected**; defer until India Business demand. Options: Digio,
  Leegality, SHCIL-based APIs; Indian entity likely needed; 2–4 months (estimate).
- **Legal/counsel.** Indian Stamp Act 1899 and state acts; Aramo email signatures are not IT-Act e-signatures;
  DPDP.
- **Secrets & settings.** `SIGN_ESTAMP_PROVIDER` exists but **no adapter exists; any value stays disabled**
  (`apps/sign-service/src/app/regulated/estamp-adapter.ts:8-10`).
- **Webhooks/DNS/nginx.** Unknown until an adapter exists.
- **Engineering flip steps.** **Not activatable.** Vendor → adapter PR → UI → this guide.
- **Open decisions.** Indian entity (go-live list item 36); vendor.

### 3.21 Usage metering and add-on billing (branch `feat/sign-usage-metering`)

- **What it does.** Records each billable add-on event (SMS, WhatsApp, SMS OTP, ID verification, KBA, QES
  signature, India e-stamp) once, prices it at the unit price of the organization's plan version in effect,
  and reports it to Stripe meters every 5 minutes; Stripe puts the period's usage on one consolidated
  invoice (Amendment A3). No prepaid credits.
- **Status.** On branch only (`0d9944c7`), not on `main`; it adds migration
  `20261101300000_sign_usage_metering` (needs Lead migration approval at release). On `main` today the usage
  port is a no-op (`apps/sign-service/src/app/app.module.ts:293`, `NoopSignUsageRecorder`): **features flipped
  before metering ships are delivered unbilled.**
- **Launch key.** None. Env flag `SIGN_USAGE_BILLING_ENABLED=1` (sign-service only on the branch's
  `docker-compose.prod.yml:523`); only exactly `1` (`libs/subscription/src/lib/usage/metered-units.ts:34-39`
  on the branch). Off: nothing is recorded and the report worker does not run. Recording never blocks the
  signer's flow (`apps/sign-service/src/app/billing/sign-metering-usage-recorder.ts` on the branch).
- **Plan entitlement (A4 D2).** The catalog role enters add-on unit prices on a DRAFT plan version in the
  Platform Console; Finance then Owner approve through the existing PLAN_VERSION_PUBLISH chain; the content
  fingerprint covers the prices; published prices are immutable (Amendment A4). Unit keys:
  `sign.sms_message`, `sign.whatsapp_message`, `sign.sms_otp`, `sign.id_verification`, `sign.kba`,
  `sign.qes_signature`, `sign.india_estamp` (`metered-units.ts:13-21` on the branch). A unit with no price on
  the version is "not sold" (the ledger refuses the event and logs the reason). Reminder from 1.3: existing
  subscribers stay on their pinned version, so they are billed at their version's prices (none) until moved
  — confirm the subscriber-move path at flip time (OD-1 applies here too).
- **External prerequisites (D4, PO, still open per A4).** In Stripe (test first, then live):
  1. Create one **Billing Meter** per unit with the event name the code sends:
     `aramo_sign_sms_message`, `aramo_sign_whatsapp_message`, `aramo_sign_sms_otp`,
     `aramo_sign_id_verification`, `aramo_sign_kba`, `aramo_sign_qes_signature`, `aramo_sign_india_estamp`
     (`meterEventNameOf`, `metered-units.ts:46-48` on the branch). An event with no meter is refused by Stripe
     and recorded `FAILED PROVIDER_REFUSED`.
  2. Create a metered price per meter at the approved unit price.
  3. Make sure each billed organization's Stripe subscription carries those metered prices; Stripe invoices
     meter usage only through a subscription price linked to the meter. **Confirm in code at flip time**
     whether checkout or a command adds them; the branch reports events against the organization's billing
     account (`libs/subscription/src/lib/billing/usage-meter.port.ts:13-22` on the branch) and nothing found
     there adds metered prices to subscriptions.
- **Legal/counsel.** ToS and order pages must state the add-on prices and monthly billing; the unit prices
  approved in the console must match the published price list.
- **Secrets & settings.** `SIGN_USAGE_BILLING_ENABLED=1` (not secret). Uses the existing `STRIPE_SECRET_KEY`.
  **Live-mode hold in code:** the report worker holds every report while the Stripe key is live
  (`libs/subscription/src/lib/usage/usage-provider-report.service.ts:67`, `:75` on the branch), like the CCP
  command worker on `main` (`libs/subscription/src/lib/billing/billing-command.service.ts:416-420`). Live
  usage billing therefore needs a separately authorized code change that lifts the hold.
- **Webhooks/DNS/nginx.** None new (meter events are outbound).
- **Engineering flip steps.** Merge the branch (Lead + PO) → release with its migration → console unit prices
  approved → Stripe meters and prices (D4) → lift the live hold (separate authorization) → Step D.
- **Production verification.** In test mode first: send one SMS on an organization whose version prices
  `sign.sms_message`; the ledger has one entry; the report row turns REPORTED; Stripe's meter shows 1 event;
  the upcoming invoice shows the charge; the Billing page "usage charges" panel matches.
- **Rollback/turn-off.** Unset the flag + recreate (recorded entries stay; nothing more is reported).
- **Split periods (Remaining-Work Directive B10, done).** A plan change inside a billing period ends the
  subscription row and opens a new one on the same anchor; the period is now reconciled **once** over every
  row with the same billing link (provider, account, provider subscription) and recorded on the latest row
  (`periodSegments`, `libs/subscription/src/lib/usage/usage-reconciliation.ts`; reconciling through the
  earlier row returns the same record). Each event keeps its own version's price, so a version change on
  one row needs nothing more. **Still open (D4):** the Stripe invoice read that feeds the reconciliation;
  how Stripe invoices a period whose metered price changed mid-period must be checked when the meters and
  prices exist (a whole period billed at one price is reported as a mismatch, correctly). KBA usage
  recording waits for a KBA vendor.
- **Open decisions.** D4 (go-live list item 43); OD-4 (which features may go live unbilled).

### 3.22 ToS v2.0 release day (branch `feat/sign-tos-v2`, PR #1057)

- **What it does.** Makes the combined Business + Personal Terms of Service v2.0 effective. On that instant it
  replaces Personal Terms 1.0 for Personal accounts and becomes the terms Business users accept at sign-up and
  next sign-in. Until then v2.0 is registered with `effective_from: null` and never offered
  (`libs/subscription/src/lib/legal/legal-documents.ts:93-98` on the branch;
  `apps/sign-web/src/workspace/legal/catalog.ts:45` on the branch).
- **Why it matters for other features.** Business sign-up currently has no approved terms in production
  (go-live list item 1). The Personal paid checkout (3.9) needs v2.0 effective.
- **External prerequisites (counsel).** Answers to the blocking questions in
  `Aramo/documents/Aramo-Sign-Terms-v2_0-Counsel-Open-Questions-20261101.md`:
  - Q1 the effective-date wording (`[Date of publication]`);
  - the four bracketed periods: Q2 B4.3 failed-payment grace `[7] days`, Q3 B4.4 dispute window `[30] days`,
    Q4 B5.1 cancellation notice `[5 business days]` (plus the B5.1 body: does the 12-month commitment
    auto-renew), Q7 B7.5 export window `[90] days`;
  - Q5 B5.3 Refunds (empty clause) and Q6 B9.1 Warranty (empty clause).
  The publication-readiness test fails CI while any placeholder or empty clause remains once a date is set
  (`libs/subscription/src/tests/legal-publication-readiness.spec.ts:8-19` on the branch). Q8–Q21 do not block
  CI but are open counsel decisions.
- **Secrets & settings.** `SIGN_POST_TERMINATION_EXPORT_DAYS` (sign-service, not secret;
  `docker-compose.prod.yml:535`; `.env.prod.example:632-636`) must equal counsel's B7.5 answer (Q7); unset
  today means no time limit. `BILLING_PAST_DUE_GRACE_DAYS` (default 7, `.env.prod.example`) should match
  B4.3 — confirm at flip time.
- **Engineering flip steps (release-day PR).**
  1. Apply counsel's answers to `doc/legal/aramo-sign/terms-of-service-2.0.md`; update the `sha256` in the
     registry entry to the new file hash (confirm which spec checks the hash).
  2. Set the **same** `effective_from` instant (ISO 8601 with offset) in both
     `libs/subscription/src/lib/legal/legal-documents.ts` and `apps/sign-web/src/workspace/legal/catalog.ts`
     (a sign-web spec keeps them equal).
  3. Mobile: the Personal Terms link is hard-coded to `/legal/personal-terms`
     (`mobile/sign/src/config/env.ts:79` on the branch). Point it at `/legal/terms-of-service` and ship an app
     update; until then the old link opens Personal Terms 1.0 with a "no longer in effect" banner.
  4. Release (SERVICES includes `nginx` for sign-web, `sign-service`, `platform-admin` for sign-up flows);
     Step D for `SIGN_POST_TERMINATION_EXPORT_DAYS`.
- **Production verification.** `https://sign.aramo.ai/legal/terms-of-service/2.0` serves the text;
  `/legal/personal-terms` shows the superseded banner; a new Business sign-up and a new Personal sign-up each
  record acceptance of v2.0; an existing Personal user is asked to re-accept; an existing Business user is
  asked at next sign-in.
- **Rollback/turn-off.** A PR that moves `effective_from` (only before the instant passes); after that, a
  correction is a new version. Acceptances are history and are not deleted.
- **Open decisions.** Counsel Q1–Q21; go-live list item 2 (Personal account-close purge vs Personal Terms
  1.0 §12.3).

---

## 4. Cross-cutting prerequisites

### 4.1 Stripe live (Aramo's own billing)

Needed by: Personal paid checkout (3.9), Business plan purchase, usage billing (3.21).
Go-live list items 11–12.

1. **Keys (sign-service; `docker-compose.prod.yml:512-514`).** `STRIPE_SECRET_KEY` (**secret**, live
   `sk_live_…`), `STRIPE_WEBHOOK_SECRET` (**secret**, `whsec_…` of the live endpoint), `STRIPE_PLAN_PRICES`
   (not secret; `plan_key=price_…` pairs, `.env.prod.example:389-391`).
2. **Products and prices** in live mode for Business $15, Professional $20, Standard $10 (monthly, USD),
   equal to the console list prices (go-live list item 5: catalog drafts Business $15 and Professional $20 →
   Finance → PO). A console-pinned provider price and `STRIPE_PLAN_PRICES` must agree (`provider-price.ts:47`).
3. **Webhook** in live mode: `https://sign.aramo.ai/v1/sign/billing/webhook/stripe`
   (`.env.prod.example:386-388`). Subscribe to the subscription, invoice and checkout-session events the
   billing code handles; confirm the exact list at flip time in `libs/subscription/src/lib/billing/`.
4. **Billing portal.** `STRIPE_PORTAL_CONFIGURATION` (`bpc_…`, `docker-compose.prod.yml:542`) whose
   cancellation settings match the approved commitment terms; unset ⇒ the portal is refused for
   12-month-commitment plans (`.env.prod.example`, "STRIPE_PORTAL_CONFIGURATION" block).
5. **Workers.** `SIGN_BILLING_COMMANDS_ENABLED` and `SIGN_BILLING_RECONCILE_ENABLED` as authorized.
6. **Live-mode holds in code.** The CCP command worker refuses to dispatch with a live key
   (`billing-command.service.ts:416-420`), and the metering branch's billing-status read and usage reporting
   hold live keys too. Going live therefore includes a code PR that lifts the holds, with its own
   authorization. Confirm at flip time which flows (checkout, portal, webhook) work with a live key as-is.
7. **Tax.** Stripe Tax is not enabled and has no setting (CCP-C5, `.env.prod.example:392-393`).
8. **Test** buy, cancel, refund and reconcile in live mode with a real card (go-live list item 12).
9. **Checkout disclosure (Remaining-Work A1).** Business and Personal checkouts show the renewal disclosure at
   the Stripe submit button (`custom_text[submit][message]`, built by `businessCheckoutDisclosure` /
   `personalCheckoutDisclosure` in `subscription-lifecycle.service.ts`); the Business plan cards and the
   required Terms checkbox on Settings → Billing say the same. No setting; verify it on the first live
   checkout.
10. **Renewal notices (Remaining-Work A3).** Two layers:
    - **Primary — the Aramo renewal notice (sign-service job).** Once an hour, one email to the subscribing
      owner (else the tenant owner) of each open self-service subscription whose 12-month commitment ends
      within `SIGN_RENEWAL_NOTICE_DAYS` (default 30, 1 to 90): the commitment end date, that it then
      continues month to month at the monthly price plus tax, how to cancel (link to the workspace billing
      settings) and when a cancellation takes effect. One notice per subscription and commitment end
      (evidence in `subscription."RenewalNoticeDelivery"`, migration `20261102100000_sign_renewal_notice`;
      a refused send is retried up to 5 times; an unrecorded outcome is never resent). Dark unless
      `SIGN_RENEWAL_NOTICES_ENABLED=1` (sign-service; `docker-compose.prod.yml` passthrough,
      `.env.prod.example`). Needs the mailer (`MAILER_PROVIDER=ses`) and counsel's approval of the email
      wording (`renderRenewalNotice`, `libs/subscription/src/lib/billing/renewal-notice.ts`) before the
      flip. A later annual-term schedule (A2) adds a notice kind and reuses the job and table.
    - **Interim — Stripe's own email.** Stripe Dashboard → Settings → Billing → Subscriptions and emails →
      "Send emails about upcoming renewals" ON (live mode), with the reminder lead time set; record a
      screenshot in `Aramo/documents/`. Confirm in the dashboard which billing intervals Stripe sends these
      reminders for (record it with the screenshot); counsel confirms it is sufficient while the Aramo job
      is dark. Stripe's email does not mention the commitment end; the Aramo job does.
11. **Cancel (Remaining-Work A4).** Settings → Billing → "Cancel subscription" (Business `/sign/settings/billing`,
    Personal `/personal/settings/billing`; the mobile account screen links there as "Manage billing or
    cancel") uses the existing self-service cancel (`POST /v1/sign/billing/self-service/cancel`, at period
    end, CCP-C1 command). It is offered only when the backend allows it: never inside the commitment
    before its last month (DR-C2-1), and only while the Sign Terms have an APPROVED version. Its
    confirmation states the end date (end of the current monthly period), no further charge, and the data
    rule (Business: 90 calendar days to download completed documents and evidence, ToS B7.5; Personal:
    back to Free). The command worker (`SIGN_BILLING_COMMANDS_ENABLED=1`) must run for the cancel to reach
    Stripe. **Undo:** "Keep my subscription" opens the Stripe billing portal, which must allow renewing a
    subscription set to cancel; configure `STRIPE_PORTAL_CONFIGURATION` so cancellation is at period end
    (never immediate) and renewing is allowed, and record a screenshot in `Aramo/documents/`. The link is
    labelled "Manage billing or cancel".

Stripe Identity and Stripe Connect use **their own** keys and webhooks (3.16, 3.18); they never reuse
`STRIPE_*`.

### 4.2 Privacy Notice, e-signature disclosure and sub-processors

Any feature that brings a new vendor or new personal data needs, **before its flip** (A1.2 item 3; go-live
list item 8):

| Feature | New personal data | Documents to update |
|---|---|---|
| SMS delivery, SMS OTP | Signer phone numbers, delivery status, opt-out list | Privacy Notice (data, purpose, retention), sub-processors (AWS; MSG91 and the DLT operator for India), signer e-signature disclosure (texts, STOP), SMS terms and opt-in wording (10DLC requires a public policy that mentions SMS) |
| WhatsApp | Phone numbers, WhatsApp delivery and read status, inbound keywords | Same, plus Meta |
| ID verification | ID document result, issuing country, name match (images stay at Stripe) | Privacy Notice, biometric notice if counsel says BIPA applies, sub-processors (Stripe), signer disclosure and consent text, retention schedule |
| KBA | Identity questions and outcome | Same, plus GLBA/DPPA wording |
| Payments | Payment status (card data stays at Stripe) | Sub-processors (Stripe Connect), ToS payment terms |
| Seal, TSA | Document hashes sent to the CA / TSA | Sub-processors (CA, TSA) |
| QES | Signer identity proofing by the QTSP | Privacy Notice, sub-processors, transfer terms |

The signer disclosure version is `SIGN_DISCLOSURE_VERSION` (default v1; v2 is the legal-pending draft;
`docker-compose.prod.yml:534`). A new disclosure text is a code and legal change, not just an env value.

### 4.3 Data processing agreements

Sign a DPA (or confirm the vendor's standard DPA applies) with each vendor that touches personal data: AWS
(already in place for SES/KMS/S3 — confirm End User Messaging is covered), MSG91, Meta, Stripe (Identity and
Connect), the AATL CA, the TSA, the QTSP, the KBA vendor, the e-stamp aggregator. Record each in
`Aramo/documents/` and in the sub-processor list.

### 4.4 Monitoring and alerts

The production probe ([`monitoring-and-alerts.md`](monitoring-and-alerts.md) §1.1) watches containers, disk,
memory, HTTP, TLS, nginx 5xx and the Sign KMS, custody, purge, retention and privacy log patterns, and (Remaining-
Work Directive B9) four vendor checks: `sign:webhooks` (WhatsApp, inbound SMS, Stripe Identity, Stripe Connect
and Stripe billing webhook refusals and failures), `sign:messaging` (SMS / WhatsApp provider errors),
`sign:tsa-seal` (a timestamp pending after 10 attempts, a seal failing for good) and `sign:metering` (usage
reports that will never reach Stripe, the live-mode hold). They read lines sign-service writes only when the
feature's provider is configured, so they stay at 0 while dark. The probe change reaches the box with the next
`deploy/monitoring/install.sh` run (box install, Workstream C). Vendor-side alerts are still set at each flip:
AWS SMS spend limit, Stripe failed-webhook emails, Meta quality rating, GlobalSign certificate expiry, TSA
availability.

### 4.5 Abuse and review queue

SMS and WhatsApp let any sender put Aramo's number in front of strangers. Before the messaging flips: staff
the abuse and Personal review queue (go-live list item 20; [`abuse-reports-and-personal-review.md`](abuse-reports-and-personal-review.md)),
decide whether Personal accounts may text at all (OD-3), and review the per-organization limits
(`SIGN_MESSAGING_TENANT_HOURLY_LIMIT` 100, `SIGN_MESSAGING_TENANT_DAILY_LIMIT` 500 by default).

---

## 5. Recommended order of activation

1. **Deploy the feature build** (`main` ≥ `394ffcc0`) with everything dark (go-live list item 4).
2. **ToS v2.0 effective** (3.22) — unblocks Business terms and the paid Personal plan.
3. **No-vendor features**, each with a PO authorization and, where noted, a UI or entitlement step:
   1. Reports (3.2) — no blockers.
   2. Templates (3.1) — after OD-2.
   3. Access code (3.7, already AVAILABLE; its sender control ships with B2), witness (3.5), delegate (3.6) — sender UI built (B2/B3).
   4. Branding (3.3) and custom roles (3.4) — after OD-1.
4. **Stripe live** (4.1), then **Personal paid checkout** (3.9).
5. **Trusted timestamp** (3.10) — as soon as a commercial TSA that fits the code is contracted (2–6 weeks).
6. **Vendor features by lead time** — start every contract now (vendor pack "Do first this week": items 4–7):
   1. Stripe Identity (days to 2 weeks) and Stripe Connect (1–3 weeks) — payments (3.18) first (no metering
      needed), then ID verification (3.16) after its nginx route and counsel review.
   2. WhatsApp (1–4 weeks) — after its nginx route.
   3. US SMS and SMS OTP (4–7 weeks) — after OD-3 and OD-4.
   4. AATL seal (4–8 weeks) — after the commercial TSA.
   5. India SMS (3–8 weeks or more) — after the Indian entity decision.
7. **Usage metering** (3.21) — before or with the first metered feature if the PO wants it billed from day
   one (OD-4).
8. **Deferred:** KBA, QES, India e-stamp — vendor selection, adapters and UI first.

---

## 6. Open decisions collected

| ID | Decision | Owner | Blocks |
|---|---|---|---|
| OD-1 | How a plan becomes entitled to `sign.branding` / `sign.custom_roles` (and metered unit prices for existing subscribers): governed migration, a new console action that adds feature rows to a draft and moves subscribers, or new plans via `PLAN_CREATE` | Lead + PO | 3.3, 3.4, 3.21 |
| OD-2 | Does Standard ($10 Personal) get templates? Code says yes today | PO | 3.1 |
| OD-3 | Should SMS, WhatsApp and SMS OTP be limited to B+ (directive) — the code has no plan or organization-type check | PO, then engineering | 3.12–3.15 |
| OD-4 | May a metered feature go live before usage billing is on (delivered unbilled)? | PO | 3.12–3.16, 3.21 |
| OD-5 | Trusted timestamp and seal for every plan (code) or paid / B+ only (directive) | PO | 3.10, 3.11 |
| OD-6 | Same or separate Stripe account for Identity and Connect | PO | 3.16, 3.18 |
| OD-7 | Indian entity or partner (India SMS and e-stamp) | PO + counsel | 3.13, 3.20 |
| OD-8 | Vendors for KBA, QES, e-stamp | PO | 3.17, 3.19, 3.20 |
| D4 | Stripe meters and metered prices | PO | 3.21 |

## 7. Engineering gaps found while writing this guide (fix before the related flip)

Each gap is a work item in the Feature Activation Readiness Directive (AR-n in brackets); OD-9 (the
Personal → Business upgrade) was ruled by Amendment A5: not offered, and the code is removed (AR-9).

1. [AR-1, B1] Done: nginx locations for the WhatsApp (3.14), Stripe Identity (3.16) and inbound SMS (3.12)
   webhooks.
2. [AR-2, AR-3] **Closed by Consolidated Directive B2/B3** (`feat/sign-rw-screens`): sender UI (web + mobile) for
   witness, delegate, access code, SMS/WhatsApp channel, SMS code and identity check; signer delegation (web +
   mobile); web QES step and `/qes/callback`; web signer SMS-code screen. Still open: a sender control for the
   QES signature level, mobile signer QES and SMS-code screens, and a signer KBA screen (with a KBA vendor).
3. [AR-4, B4] Done: optional TSA basic credentials and client certificate (3.10).
4. [AR-6] No console path to add a feature key to an existing plan (1.3, OD-1).
5. [AR-7] Messaging has no plan or organization-type gate (OD-3).
6. Live-mode holds in the billing command worker and the metering branch (4.1, 3.21).
7. [AR-11, B9] Done in code: probe checks for webhooks, messaging, TSA / seal and metering (4.4); reaches the
   box with the next monitoring install.
8. [B5] Done: inbound SMS STOP for AWS (through SNS) and the MSG91 DLT header and entity id (3.12, 3.13).
   Open: no MSG91 inbound route (3.13); the MSG91 field names to confirm with MSG91.
9. [B10] Done: split-period reconciliation (3.21). Open (D4): the Stripe invoice read; KBA usage call site.
10. [A4] No in-product resume of a scheduled cancel: the provider adapter has no "resume" command, so
   "Keep my subscription" goes through the Stripe billing portal. After such a renewal, a second in-product
   cancel of the same subscription replays the first (recorded) request instead of issuing a new command
   (`SelfServiceBillingRequest` is unique per subscription and action); the owner cancels again through the
   portal. Fix together with A2.
