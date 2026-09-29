# Aramo — Email & Notifications: Reusable Email Templates V1 — Implementation Directive

| Field | Value |
|---|---|
| **ID** | D-EMAIL-TPL-1 |
| **Version** | v1.0 |
| **Weight** | **FULL** — touches tenant data, DB schema, external contracts (Pact/OpenAPI), RBAC scopes. |
| **Status** | **RATIFIED (PO, 2026-09-28)** — decisions D-1…D-10 ratified in relay; formal ratification = merge of this directive's PR (Directive Standard v2, Part 4). |
| **Target path** | `libs/communications`, `apps/api/src/communications`, `apps/ats-web/src/settings`, `apps/ats-web/src/microsoft`, `libs/identity` (scope catalog), `openapi/`, `pact/` |
| **Pin** | `130bfb6550ba7b00123fea2f83cd7b5fd8739faa` (origin/main tip) |
| **Governing artifacts** | `00-DIRECTIVE-STANDARD-v2.md`; `doc/02-claude-code-discipline.md`; `doc/05-conventions.md`; `scripts/verify-vocabulary.sh`; CLAUDE.md engineering laws |
| **Dev branch** | `feat/email-templates-v1` |
| **Parent directive** | none (new increment). Behaviourally continuous with COMM-C4 requisition-contextual email (#846/#848). |

---

## Problem

`Settings → Communication → Email & notifications` is a `soon` seam (`apps/ats-web/src/settings/sections/SeamSections.tsx:78-99`, nav `apps/ats-web/src/settings/SettingsShell.tsx:157-170`) whose copy is **stale/false**: it claims "no email engine yet… only Cognito's built-in invite email… nothing here would send anything." In fact Aramo already sends email via two live paths (see Grounding). What is genuinely **absent** is a **reusable, tenant-configurable, recruiter-selectable email-template layer** — today there is exactly one hard-coded, code-owned draft generator (`system.requisition-contact.v1`) and **no reusable email-template Prisma model, no picker, no tenant editing, and no merge-field engine**.

This directive adds a **tenant-scoped reusable email-template capability** with a **closed, server-side merge-field system**, converting the code-owned requisition-contact default into the first governed template — **without building a new email engine** and **without duplicating provider configuration** (which stays in Integrations).

## Grounding ledger

**Read by path** (verified at pin `130bfb65`; audited email/template/settings surfaces are byte-identical to recon baseline `2c88a3f1` — `git diff --stat 2c88a3f1..130bfb65` empty across these trees):

| Fact | Evidence |
|---|---|
| Platform mailer engine exists: SES (prod) / stub (dev), env-selected, fixed FROM | `libs/mailer/src/lib/mailer.port.ts:31` (`MailerPort.send`), `:8-10` (FROM not a caller param); `libs/mailer/src/lib/ses-mailer.adapter.ts:45-47`; `libs/mailer/src/lib/stub-mailer.adapter.ts:22`; `libs/mailer/src/lib/mailer.config.ts:25,38-49` (`MAILER_PROVIDER` required); factory `libs/mailer/src/lib/mailer.module.ts:47-56` |
| Recruiter email sends via Microsoft Graph `/me/sendMail` through the recruiter's own delegated M365 mailbox | `libs/microsoft-graph/src/lib/ports/microsoft-graph.port.ts:41`; `apps/api/src/microsoft/microsoft-email.service.ts:124,142` |
| Recruiter draft/send flow (COMM-C4) — draft endpoint (ids only), deterministic default, send endpoint, consent+idempotency+recipient authority, evidence | draft ctrl `apps/api/src/communications/requisition-contact-draft.controller.ts:21-46`; DTO `apps/api/src/communications/dto/requisition-contact-draft.dto.ts:3-16`; default svc `apps/api/src/communications/system-requisition-contact-template.service.ts:66-142`; port `apps/api/src/communications/requisition-contact-template.port.ts:2-6,13-27,39-42`; send ctrl `apps/api/src/microsoft/microsoft-authorization.controller.ts:126-157`; send svc `apps/api/src/microsoft/microsoft-email.service.ts:80-198` (idempotency `:85`, consent `:94`, recipient resolve `:105`); evidence persisted `:135-148` |
| Sent-email SoR = `CommunicationInteraction`, persists final subject/body | `libs/communications/prisma/schema.prisma:144,178-182`; repo `libs/communications/src/lib/communications.repository.ts:75-111` |
| Communications schema model set (placement for the new model) | `libs/communications/prisma/schema.prisma:144,209,230,251,282` (5 models + enums `:40-132`) |
| No reusable email-template model anywhere; only DOC-2 PDF `DocumentTemplate` family | absence verified across all `libs/*/prisma/schema.prisma`; DOC-2 at `libs/documents/prisma/schema.prisma:223-317` |
| Merge-field context fields (V1 allowlist source) | `apps/api/src/communications/requisition-contact-template.port.ts:13-27` (`RequisitionContactContext`), label maps `:25-35` |
| Scope catalog + existing `communication:*` scopes | `libs/identity/src/lib/dto/scope.dto.ts` (`communication:read`, `communication:email:send`, `communication:disposition:write`, `communication:meeting:create`, `communication:notes:write`, `communication:voice:call`) |
| Provider config lives in Integrations (do not duplicate) | `apps/ats-web/src/settings/sections/SeamSections.tsx:150-194`; tenant M365 `apps/api/src/microsoft/microsoft-config.resolver.ts:76-110`; creds on `IntegrationConnection` `libs/integration/prisma/schema.prisma:77` |
| Settings nav integration point + stale seam copy | `apps/ats-web/src/settings/SettingsShell.tsx:157-170` (`key:'email'`, `status:'soon'`); route `apps/ats-web/src/App.tsx:617-618`; seam `apps/ats-web/src/settings/sections/SeamSections.tsx:78-99` |
| ats-web Pact already asserts the draft template constant | `pact/consumers/ats-web/src/communications.consumer.test.ts:412-444` (`template_id: like('system.requisition-contact.v1')` `:438`); provider `pact/provider/src/verify-api.ts:5178` |
| Notification preferences absent (V1 defers) | no model/API/scope/settings-key; `NotificationDelivery` (`libs/esign/prisma/schema.prisma:193`) is an esign delivery log; bell decorative `libs/fe-foundation/src/ui/AppShell.tsx:444`, `apps/ats-web/src/shell/RecruiterShell.tsx:259` |

**No unverified rows** — every design-load-bearing claim above is a path:line read at the pin. **NOT VERIFIED — runtime:** the prod value `MAILER_PROVIDER=ses` is asserted from `.env.prod.example:159` + `docker-compose.prod.yml:172` passthrough, not live-container inspection; V1 does not depend on it (V1 reuses whichever delivery path already runs).

## Decision

Add a **tenant-scoped reusable `EmailTemplate`** in the **communications domain** (no new top-level domain — ADR-0017 boundary respected; the existing `requisition-contact-template.port.ts` was already shaped for a backing store, `:4-6`), plus a **closed server-side merge-field renderer**, template CRUD/preview APIs, two new RBAC scopes, a real tenant Settings management page, and a recruiter composer template picker. The existing deterministic `system.requisition-contact.v1` becomes the **code-owned fallback** behind the port, overridable per tenant.

**Ratified decisions (PO, 2026-09-28):**

- **D-1 — Storage = code-owned default + tenant override rows (Option C).** No per-tenant seed fan-out; a tenant with no override row uses the existing deterministic code default verbatim (behaviour preserved for every current tenant). Additive only.
- **D-2 — Plain-text templates only in V1.** No HTML/WYSIWYG; minimizes XSS/sanitization surface.
- **D-3 — Only `requisition_initial_contact` is wired to a live compose flow in V1.** The category enum may carry a small set, but **no unwired category is exposed as recruiter-selectable** (no-dead-knobs). RTR/consent/rejection deferred.
- **D-4 — Mutable tenant rows, no versioning in V1** (`updated_at`/`updated_by` only).
- **D-5 (tightened) — Provenance on `CommunicationInteraction` = additive nullable `template_key` (always the stable logical key) + `template_id` (UUID → the tenant `EmailTemplate` row when a tenant override produced the content; `NULL` when the code default was used).** **`template_version` is DEFERRED** until a versioning increment exists (consistent with D-4). Final user-edited subject/body remain the authoritative persisted content.
- **D-6 — Email signature deferred.**
- **D-7 — Preview only (server renders vs sample/authoritative context); no test-send in V1.**
- **D-8 — No personal recruiter templates (tenant templates only).**
- **D-9 — Notification preferences deferred to a separate increment.**
- **D-10 — Page stays `soon` until the template-management UI (ET-6) lands; ET-0 corrects the stale copy immediately; flip `soon→live` at ET-6.**

### Data model (additive; `libs/communications/prisma/schema.prisma`, `communications` schema)

```prisma
model EmailTemplate {
  id               String   @id @default(uuid()) @db.Uuid
  tenant_id        String   @db.Uuid
  template_key     String                         // stable logical key, e.g. "requisition-contact"
  category         EmailTemplateCategory
  name             String
  subject_template String   @db.Text              // plain-text with {{group.field}} tokens (D-2)
  body_template    String   @db.Text
  is_active        Boolean  @default(true)        // deactivate = soft (D-4; no hard delete V1)
  created_by_id    String?  @db.Uuid
  updated_by_id    String?  @db.Uuid
  created_at       DateTime @default(now())  @db.Timestamptz
  updated_at       DateTime @updatedAt       @db.Timestamptz

  @@unique([tenant_id, template_key])             // one tenant override per key (D-1 Option C)
  @@index([tenant_id, category])
  @@schema("communications")
}

enum EmailTemplateCategory { requisition_initial_contact  @@schema("communications") }
```
Provenance columns (additive nullable) on `CommunicationInteraction`: `template_key String?`, `template_id String? @db.Uuid` (D-5). Strict tenant isolation (every read `WHERE tenant_id`); no untyped JSON; `CommunicationInteraction` remains the only sent-email SoR.

### Merge-field model (closed, server-side)

- Syntax `{{group.field}}`; **no Handlebars/Mustache/EJS** — a hand-written resolver over an **explicit allowlist**.
- V1 allowlist keys derive from `RequisitionContactContext` (`requisition-contact-template.port.ts:13-27`): `talent.first_name`, `requisition.title`, `requisition.location`, `requisition.engagement_type`, `requisition.work_arrangement`, `recruiter.display_name`, `recruiter.email`, `role.summary_excerpt` (capped 400), and `company.name` **iff** an authoritative source is confirmed at ET-3 (else omit from V1 allowlist — HALT-and-report if ambiguous, do not guess).
- Rules: unknown token → **rejected at save-time validation** (no `{{…}}` survives to send); values resolved **server-side from authoritative reloaded context**, never client-supplied; unresolved **optional** field → omit block + closed-vocabulary `<field>_unavailable` warning (mirrors current `:89,102,117,127`); **plain text only**; subject ≤ 998, body ≤ 100000 (mirrors `SendMicrosoftEmailRequestDto`); no arbitrary code.

### API surface

```
GET    /v1/communications/email-templates                    scope communication:template:read
GET    /v1/communications/email-templates/:id                scope communication:template:read
POST   /v1/communications/email-templates                    scope communication:template:manage
PATCH  /v1/communications/email-templates/:id                scope communication:template:manage
POST   /v1/communications/email-templates/:id/deactivate     scope communication:template:manage
POST   /v1/communications/email-templates/:id/preview        scope communication:template:read
POST   /v1/communications/email-drafts/requisition-contact   (EXTEND: optional template_key; scope communication:email:send unchanged)
```
The draft endpoint accepts **`template_key`** (stable across the code-default↔tenant-override boundary), not `template_id`. Server resolves the effective template by key, renders with reloaded authoritative context, returns editable subject/body. Recipient/business truth never come from the browser (preserve `requisition-contact-draft.dto.ts:3-16`).

### RBAC

New scopes following the `communication:*` convention in `libs/identity/src/lib/dto/scope.dto.ts`: **`communication:template:read`**, **`communication:template:manage`**. Existing `communication:email:send` unchanged.

## Rejected alternatives

- **New email engine / SMTP / SendGrid** — rejected: two delivery paths already exist (`@aramo/mailer` SES; Graph). Building a third is unjustified.
- **D-1 Option A (seed rows per tenant)** — rejected: mass fan-out, migration/seed churn, and diverges current behaviour for tenants that never customize.
- **D-1 Option B (global immutable system rows + overrides)** — rejected for V1: adds a system-rows table + platform-edit surface with no product demand yet; Option C is strictly smaller and preserves the code default as the single source of default wording.
- **HTML/WYSIWYG templates (D-2)** — rejected for V1: sanitization/XSS cost with no product requirement; recruiter Graph mail is plain-text-assembled today.
- **Versioned templates (D-4) / `template_version` column (D-5)** — rejected for V1: no versioning exists; a version column with no version semantics is an unguarded value (Standard Rule B). Deferred until a versioning increment.
- **Handlebars/Mustache/EJS** — rejected: arbitrary template execution; a closed allowlist is the safe form.
- **Tenant SPF/DKIM/DMARC sending-domain** — rejected/out-of-scope: recruiter mail rides the recruiter's M365 mailbox; platform mail rides Aramo's own SES domain; a tenant sending-domain is a third model with no requirement. (Distinct from the org-trust `DomainVerificationPanel`, which "gates nothing".)
- **Notification preferences / in-app center in this increment (D-9)** — rejected: needs a separate event/subscription + durable in-app model.
- **Provider config on the Email page** — rejected: it is live under Integrations → Communications; duplication is a second source of truth.

## Scope

**In scope:** `EmailTemplate` model + additive migration; provenance columns on `CommunicationInteraction`; template repository/service; closed merge-field renderer; template CRUD + preview APIs; two RBAC scopes; extend the requisition-contact draft to accept `template_key`; tenant Settings template-management page; recruiter composer template picker; OpenAPI + Pact + scope-catalog + migration-harness + repo-map updates; ET-0 stale-copy correction.

**Out of scope (deliberate):** tenant SPF/DKIM/DMARC; new SMTP/SendGrid; replacing Graph or `@aramo/mailer`; notification-preference/event engine; persisted in-app notification center; recruiter personal templates; LLM-generated bodies; HTML/WYSIWYG; bulk/marketing/drip/unsubscribe; provider credentials on this page; test-send; email signature; reply-to; versioning.

## Acceptance criteria (falsifiable)

1. `EmailTemplate` migration applies additively; a cross-tenant read is denied (integration spec, negative control: seeded other-tenant row not returned).
2. Merge-field renderer: a template with an **unknown token fails save-time validation** (negative control shown failing, then passing after the token is corrected); a valid template renders authoritative context server-side; no `{{…}}` survives to output.
3. `GET/POST/PATCH/deactivate/preview` templates enforce `communication:template:read|manage`; scope-denied returns 403 (negative control per scope).
4. The requisition-contact draft, given `template_key`, returns the tenant override's rendered content when a row exists, else the code default verbatim (behaviour-preservation test with no tenant row).
5. Recipient remains server-authoritative and locked; consent gate + idempotency retained (existing specs still green).
6. A sent email persists `template_key` (+ `template_id` when a tenant override was used) on `CommunicationInteraction`; final subject/body unchanged as SoR.
7. Tenant admin can list/create/edit/deactivate/preview templates under `Settings → Communication → Email & notifications`; no provider-config control appears on the page.
8. No tenant sending-domain control exists on the page.
9. `bash scripts/verify-vocabulary.sh` exits 0; OpenAPI lint green; contract-parity classifies every new route; ats-web Pact updated (consumer then provider); repo-map regenerated + staged; full affected unit/integration/FE green; `merge_group` `deployment-gate` green.

## Standing HALT clause

> If, during execution, you discover that this change touches files, contracts, or behaviour not covered by this directive — or that its stated scope is wrong — HALT and report to Lead. Do not widen scope. Do not reconcile a contradiction on your own.

## Base-SHA gate

**Tier 1 (HALT if changed on `origin/main` vs pin `130bfb65`):** the design-load-bearing surfaces — `apps/api/src/communications/requisition-contact-template.port.ts`, `system-requisition-contact-template.service.ts`, `requisition-contact-draft.{controller,service}.ts`, `apps/api/src/microsoft/microsoft-email.service.ts`, `libs/communications/prisma/schema.prisma`, `libs/identity/src/lib/dto/scope.dto.ts`, `apps/ats-web/src/settings/{SettingsShell.tsx,sections/SeamSections.tsx}`. `git merge-base --is-ancestor 130bfb65 origin/main` must hold; a Tier-1 diff → HALT and reconcile before implementing.
**Tier 2 (REPORT and continue):** curated migration-harness lists, `repo-map` json, Pact fixtures — self-derived at build; regenerate against the true base.

## Build sequence (RED-first)

ET-0 stale-copy correction (page stays `soon`) · ET-1 `EmailTemplate` model + additive migration · ET-2 repo/service + code-default fallback (D-1 C) · ET-3 closed merge-field renderer + allowlist · ET-4 template CRUD + preview APIs + 2 scopes · ET-5 integrate `template_key` into requisition-contact draft · ET-6 tenant Settings management UI (flip `soon→live`, D-10) · ET-7 recruiter composer picker · ET-8 provenance columns on `CommunicationInteraction` (D-5) · ET-9 full E2E + CI. Each slice: objective · RED proof · implementation · GREEN proof · affected contracts · migration · security invariant · stop condition.

## Trap register (from CLAUDE.md memory)

New scope = ~5 seed touchpoints + catalog↔id-map bijection + `seed-scrub` two constants (run full affected identity integration). New migration → repo-wide grep of filename → add to EACH curated spec + `verify-api.ts` as a **separate `resolve()` const** (never a 2nd arg → ENOTDIR). New live route → register in `api-surface-manifest` + `verify-orphan-scopes` or merge_group FAILs. `repo-map` = 3 json staged as a SET (`git add` new src first). FE: `ui/ui.css` token exclusivity; **G1 raw-element guard** (native inputs need the escape-hatch); `aramo-ats-web` project ≠ dir; `<ToastProvider>` in specs. Pact: consumer generated before provider; aramo-core verifies 7 consumers.

## Gate discipline

RED-first chronological per boundary; Gate-5 stops at local verified diff (no commit/push/PR); Gate-6 = separate commit-plan turn; PO-authorized merge only. Every proof by name (file:line + test). Deviations reported as typed divergences.

---
*Baseline pin: `130bfb6550ba7b00123fea2f83cd7b5fd8739faa`. Canonical: `doc/directives/` (this file) + OneDrive `Aramo/locked/` mirror. Ratification = PR merge.*
