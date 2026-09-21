# RN — Requisition Enterprise Notes — Program Directive (authorizes RN-1)

> **Status: LOCKED — RATIFIED 2026-09-21.** Authored by the Code Executor from
> the Lead/Architect ruling of 2026-09-21 and the substrate recon of the same
> date; ratified by the PO with the four §11 rulings resolved (Q1 RESTRICTED
> deferred to RN-2; Q2 body stays in `Activity.notes`; Q3 PRIVATE strictly
> author-only; Q4 the 7-value category set ratified as drafted). RN-1 is now
> **AUTHORIZED FOR IMPLEMENTATION**. The directive is frozen; §11 records the
> resolved rulings and the updated HALT boundary.

---

## Header

| Field | Value |
|---|---|
| **ID** | RN-1 (program: RN — Requisition Enterprise Notes) |
| **Version** | v1.0 |
| **Weight** | **FULL** — adds a DB table + enum, changes an external contract (`POST /v1/activities`), and touches a cross-tenant visibility invariant. If arguable, FULL; it is not arguable here. |
| **Status** | LOCKED — ratified 2026-09-21; RN-1 authorized for implementation |
| **Target path** | `libs/activity/*` (schema, DTO, controller, repository), `apps/ats-web/src/activity/*`, `apps/ats-web/src/requisitions/*`, `pact/*`, OpenAPI |
| **Pin** | `4a18aa24d067ea586e7b6f35e4eddfcc6aed67fa` (`origin/main` tip, #831) |
| **Governing artifacts** | `00-DIRECTIVE-STANDARD.md`; `doc/02-claude-code-discipline.md`; `doc/05-conventions.md`; `scripts/verify-vocabulary.sh`; ADR-0007 (Talent RTBF/redaction); AUTHZ-D4 (Record-Visibility); ADR-0029/I15 (Pipeline⊥ATS wall) |
| **Dev branch** | `feat/rn-1-requisition-enterprise-notes` (off `origin/main`) |
| **Parent directive** | none (net-new program). Adjacent register: `doc/requisition-ui-design-gap-register.md` |

---

## Grounding ledger

All rows verified against the recon baseline `0be901ff` and re-anchored to the
pin `4a18aa24` (activity substrate is unchanged between the two — no activity
commits in the interval).

### Read by path (verified)

| Claim | Source |
|---|---|
| Requisition notes are **not** a dedicated table — they are polymorphic rows in `activity."Activity"`, discriminated by `(subject_type, subject_id)`; a requisition note is `type='note'`, `subject_type='requisition'`, `subject_id=<reqId>` | `libs/activity/prisma/schema.prisma:52-91` |
| Note body column is `notes String?` → SQL `TEXT`, nullable, **no length bound** | `libs/activity/prisma/schema.prisma:66`; migration `libs/activity/prisma/migrations/20260602140000_init_activity_model/migration.sql:22` |
| Activity type enum = `{ pipeline_status_change, note, call, email_logged }` — the ONLY note categorization that exists today | `libs/activity/prisma/schema.prisma:39-46` |
| Create DTO is a decorator-free TypeScript `interface` (`type`, `subject_type`, `subject_id`, `notes`, `site_id`) — **no `@MaxLength`, no validators**; global `ValidationPipe` has no class metatype to bound it | `libs/activity/src/lib/dto/create-activity-request.dto.ts:8-14`; `apps/api/src/main.ts:61-67` |
| Create route: `@Post()` on `@Controller('v1/activities')`, scope `activity:create`, `@RequireSiteMatch()`; `tenant_id`/`created_by_id` taken from `AuthContext`, never body | `libs/activity/src/lib/activity.controller.ts:41`, `:102-115` |
| Visibility is **computed at read-time** from actor scope over the polymorphic subject — not a stored per-note field | `libs/activity/src/lib/activity.repository.ts:359-408` |
| Redaction is the only mutation path (redact-never-delete): clears `notes`, sets 4 redaction columns; R3 note-only, R5 no-re-redact | `libs/activity/src/lib/activity.repository.ts:96-145`; migration `20260801120000_add_activity_redaction_fields/migration.sql:9-13` |
| FE textarea: `rows={8}`, `minHeight:160px`, `resize:vertical`, **no `maxLength`**; only guard is non-empty-after-trim | `apps/ats-web/src/activity/LogNoteDialog.tsx:32-35`, `:88-94` |
| FE submit payload: `{ type:'note', subject_type:'requisition', subject_id, notes }` → `POST /v1/activities` | `apps/ats-web/src/activity/LogNoteDialog.tsx:39-44`; `apps/ats-web/src/activity/activity-api.ts:27-29` |
| FE hand-mirrors BE DTOs in `types.ts` rather than importing `@aramo/activity` (declared forbidden domain edge) | `apps/ats-web/src/activity/types.ts:1-11` |
| `POST /v1/activities` and `GET /v1/activities` are under the ats-web↔aramo-core Pact contract | `pact/pacts/ats-web-aramo-core.json:26383-26384`, `:26517-26518` |
| Activity provider verification registers the init migration + notes the redaction columns must be applied or the SELECT 500s | `pact/provider/src/verify-api.ts:567-574` |
| Requisition-lifecycle policy: `REQUISITION_NOTE` action `ADD` = `ALLOW` in every status incl. closed/canceled | `apps/api/src/policy/requisition-lifecycle.package.ts:50`; `apps/api/src/tests/requisition-lifecycle-package.spec.ts:34-39` |
| `libs/communications` (`CommunicationInteraction` SoR) is a **separate** system; the Log-a-note flow never touches it | recon: no import edge from `LogNoteDialog`/`activity-api` into communications |

### Enumerated scope (guarded by the standing HALT clause)

| Enumeration | At the pin |
|---|---|
| Activity write paths | 2 — HTTP manual (`activity.repository.ts:63-80`) and in-transaction system (`insert-activity.ts:47-78`). Only the HTTP path is the "Log a note" path; the system path is out of scope. |
| Activity migrations (canonical tree) | 2 — `20260602140000_init_activity_model`, `20260801120000_add_activity_redaction_fields` |
| Pact consumers verified by aramo-core provider | 6 (`verify-api.ts` `pactUrls`); ats-web is one. Distinct from the 8 consumer *directories* and from `auth-service-consumer` (separate provider). |

### NOT VERIFIED — assumption

| Assumption | Why it matters | Resolution |
|---|---|---|
| The prototype screenshots (Category tabs, Visibility select, Pin, "20,000 char limit", "Plain text · links auto-detected") reflect the **target** design, not any shipped code | The entire feature set is net-new; none of it exists in the substrate today | Confirmed by recon (zero hits for `noteType`/`pinned`/`visibility`/markdown in `apps/ats-web/src`). Treated as target, not baseline. |

### NOT VERIFIED — runtime

| Item | Note |
|---|---|
| Whether adding `ActivityNote` + a returned-shape change triggers 500s in each curated integration spec until its migration list includes the new migration | Runtime-derived per the curated-migration-list trap; enforced by acceptance criterion AC-11, not asserted here as a fixed count. |

---

## Problem

The shipped "Log a note" experience (`LogNoteDialog.tsx`) is a single ~160px
plain textarea writing an unbounded `TEXT` blob into the generic activity log.
For an enterprise ATS this is insufficient on five axes, each grounded above:

1. **No categorization** beyond the top-level activity `type='note'` — notes
   cannot be filtered or scanned by what they are *about*.
2. **No authored confidentiality** — visibility is computed at read-time only
   (`activity.repository.ts:359-408`); the system cannot record what the author
   *meant to be private* at the moment of writing. For a record that may capture
   client instructions, rate agreements, and hiring decisions, this is a gap.
3. **No prominence control** — nothing surfaces a key note to the requisition
   overview.
4. **A cramped editor** — 160px with no responsive growth is not fit for daily
   recruiter use.
5. **Unbounded API input** — `notes` has no length ceiling at FE, DTO, or DB
   (three independent verifications above), inviting accidental document-paste,
   payload abuse, and future index/notification cost.

The prototype is directionally right but **conflates three orthogonal
concepts** into one "General / Client call / Internal" selector:

> *What happened?* → category · *Who may see it?* → visibility · *How prominently
> should it surface?* → pin.

These must be separated. "Internal" is a **visibility** characteristic, not a
category, and must not be shipped as a category value.

---

## Decision

### D-0 — Foundation is retained; no new subsystem

Keep the polymorphic `activity."Activity"` timeline as the SoR envelope. **Do
not** create a `RequisitionNotes` subsystem. A note remains `type='note'`,
`subject_type='requisition'`. Enterprise note attributes are layered as a
**dedicated extension table** keyed 1:1 to the note's Activity row, so the
generic `Activity` table is not polluted with note-only nullable columns that
are meaningless for `call`/`email_logged`/`pipeline_status_change` rows.

```
Activity  (timeline envelope — unchanged shape)
   id, tenant_id, site_id, subject_type, subject_id, type,
   created_by_id, created_at, redaction_*

ActivityNote  (note payload — NEW, 1:1 with Activity where type='note')
   activity_id     PK/FK → Activity.id
   category        enum  NOT NULL default GENERAL
   visibility      enum  NOT NULL default TEAM
   body_format     enum  NOT NULL default plain_text   (V1: plain_text only)
   is_pinned       bool  NOT NULL default false
   pinned_at       timestamptz NULL
   pinned_by_id    uuid NULL
```

The `body` text remains where it is entrenched today (`Activity.notes`,
`TEXT`) for RN-1; the extension table adds attributes, not a body copy. This
keeps the migration **additive and backward-compatible** — existing rows read
as `category=GENERAL, visibility=TEAM, is_pinned=false`.

### D-1 — Note category (separate from ActivityType)

A dedicated `NoteCategory` enum, canonical home = the migration/`schema.prisma`
(mirrored to BE DTO and the FE `types.ts` hand-mirror per the existing
forbidden-edge pattern — the enum is one fact with one source, not duplicated
authority). V1 values, deliberately bounded (not twenty):

```
GENERAL              (default)
CLIENT_INTERACTION   client conversation, feedback, requirement clarification
HIRING_TEAM          internal recruiting / hiring-team discussion
COMMERCIAL           rate, fee, budget, commercial conversation
INTERVIEW_FEEDBACK   interview-related feedback / context
DECISION             an important decision made
RISK_BLOCKER         a risk, blocker, or escalation
```

`ActivityType` stays `note`; category is orthogonal (`ActivityType=note` ×
`NoteCategory=CLIENT_INTERACTION`). Purpose is filtering/scanning, **not**
forcing perfect classification of every sentence. Default `GENERAL`.

### D-2 — Visibility is first-class and **persisted**

The read-time model is insufficient because confidentiality is part of authorial
intent at write time. Persisted `NoteVisibility` enum. **RN-1 ships two values
(Q1/Q3 ruling):**

```
TEAM     (default) visible to users who ordinarily have requisition access
PRIVATE  visible to the AUTHOR ONLY — no implicit admin/support override (Q3)
```

`RESTRICTED` (the third value) and its `requisition:note:restricted:read` scope
are **deferred to RN-2 (Q1 ruling)** — not defined, not stored, not enforceable
in RN-1. The DB enum type is authored so RN-2 can add the value additively.

**Server-side authorization enforces visibility. UI hiding is never the security
boundary** (`doc/02-claude-code-discipline.md`; AUTHZ-D4). The existing
`buildActivityVisibilityWhere()` (`activity.repository.ts:359-408`) is extended
so note rows are additionally filtered by persisted `visibility` against the
actor: `PRIVATE` → **author-only, strictly** (no admin/support authority sees it
in RN-1); `TEAM` → existing requisition-access rules. **Talent-facing and
external APIs must never emit `PRIVATE` notes** — this is a hard read-boundary
acceptance criterion (AC-7), not a UI convenience.

> **"Internal" is not a category.** The prototype's "Internal" concept is
> realized as `visibility`, never as a `NoteCategory` value.

### D-3 — Pin to overview, with provenance

Not a bare boolean: `is_pinned` + `pinned_at` + `pinned_by_id`. Rules:
- Multiple notes may be pinned; the overview projects **at most 2–3** most-recent
  pinned notes (truncated preview + "View full note"), never full bodies.
- Pin/unpin is **separately audited** (`NOTE_PINNED` / `NOTE_UNPINNED`).
- A **redacted** note disappears from the pinned projection.
- Pinning **must not** alter the chronological activity timeline — the activity
  stays where it happened historically; pin is presentation metadata only.
- V1 permission to pin follows note-write permission.

### D-4 — Better editor (FE)

Replace the 160px textarea with: **min-height 220–260px**, responsive growth,
`resize: vertical`. Contextual helper: *"Capture decisions, client feedback,
requirement changes, risks, or next steps."* Attribution hint below:
*"Timestamped and attributed to you."* Keep the subject-confirmation line
(*"Recorded against REQ-… · <title>"*) — it prevents logging on the wrong record.

### D-5 — Body format: plain text V1; **no arbitrary Markdown**

`body_format` = `plain_text` only in RN-1. Rendering = plain text + URL
auto-linking + preserved line breaks. **Remove the prototype's "Markdown
supported" label.** Because notes become audit/business records, arbitrary
Markdown introduces sanitization/export/rendering-consistency risk without V1
business value. Controlled rich text (bold/lists/links/mentions, no arbitrary
HTML) is a governed RN-3 option, gated behind `body_format`.

### D-6 — Server-enforced size limit

DB column stays `TEXT`. API and FE both enforce **1–20,000 characters**.
FE `maxLength` + counter; DTO `@MinLength(1) @MaxLength(20000)` on a real
class-based DTO (converting the current decorator-free interface so the global
`ValidationPipe` actually bounds it — the fix for the third unbounded-layer
finding). `VALIDATION_ERROR` on violation, mapped by the existing FE
error-messages surface.

### D-7 — Immutability: create / redact / pin only — no silent edit-in-place

The redact-never-delete direction is retained and correct. RN-1 note mutations
are limited to: **create**, **redact** (existing path, extended to null the body
and hide from pin), **pin/unpin**. **No edit-in-place.** If editing is ever
required it goes through explicit revision history
(`ActivityNoteRevision`: previous/new body, editor, timestamp, reason) — an RN-3
option, not RN-1. Rationale: notes may document client instructions, rate
agreements, interview feedback, and hiring/compliance decisions; silent mutation
makes audit evidence unreliable.

### D-8 — The Note-is-not-Evidence boundary (architectural invariant)

This is the load-bearing rule for Aramo and is **explicitly asserted**, not
implied. A recruiter-authored note is *attributable human context on the
requisition timeline*. It informs the recruiter; it never becomes authoritative
state:

```
Note ≠ workflow transition        ("Client approved the submittal" does NOT create ClientSelection)
Note ≠ Talent truth               ("She accepted $85/hr" does NOT set commercial state)
Note ≠ consent
Note ≠ communication evidence      (CLIENT_INTERACTION category ≠ a verified call/email/Teams event — that stays in libs/communications)
Note ≠ commercial authorization
Note ≠ pre-start / employment state ("Can start Monday" changes nothing)
```

`NoteCategory=CLIENT_INTERACTION` means only "this human note concerns a client
interaction." Real provider-verified communication evidence remains under
`libs/communications`. A future "Related communication" link (RN-3) may connect
the two, but the note never becomes provider evidence. Any RN increment that
would let a note mutate workflow/Talent/commercial/consent state **HALTs**.

### D-9 — Permissions (staged; do not explode RBAC in RN-1)

- **RN-1 (ruled):** reuse `activity:create` for write + the existing
  requisition-access rules + the new persisted-visibility enforcement. `TEAM`
  and `PRIVATE` are enforceable with author identity + requisition access alone
  — **no new scope, no seed touchpoints, zero scope-catalog churn.**
- **RESTRICTED deferred to RN-2 (Q1 ruling).** Its narrower read gate
  (`requisition:note:restricted:read`) would trigger the ~5 seed touchpoints +
  the `seed-scrub` two-constant + D-SEED-SCOPES-1 blast radius; that work lands
  in RN-2. **If RN-1 execution finds itself needing a RESTRICTED value or a new
  note scope, HALT** — it is outside this directive's authorized surface.
- **Later (RN-2):** fine-grained `requisition:note:{read,create,pin,redact,
  restricted:read}`.

### D-10 — Audit (amended by RN-1-A1, ratified 2026-09-21)

> Superseded by Amendment A1 (`Aramo-RN-1-Amendment-A1-ActivityNoteEvent-Ledger-v1_0-LOCKED.md`).
> Reason: recon proved the assumed audit-event substrate does not exist
> (`libs/audit` is empty scaffolding). A1 replaces the emit-to-audit-subsystem
> model with an RN-1-owned append-only ledger. The pre-amendment text is
> preserved in A1 §2 as provenance.

Server-authoritative `tenant_id`, `activity_id`, `actor_user_id`, `created_at` —
never from the browser. RN-1 records note-lifecycle transitions in an
**append-only `ActivityNoteEvent` ledger owned by `libs/activity`**. **No
platform-wide audit subsystem is created**, and RN-1 takes **no dependency on
`libs/audit`**. A future canonical audit service MAY project or consume these
events, but RN-1 does not depend on one.

`Activity`/`ActivityNote` remain the authoritative **current state**;
`ActivityNoteEvent` is **historical transition evidence only**. Exactly one event
is appended, **transactionally with** its state transition, for each of:
`CREATED`, `PINNED`, `UNPINNED`, `REDACTED`. (`NOTE_VISIBILITY_CHANGED` remains
out of RN-1 — visibility is not mutable in RN-1.) An event carries **IDs, enums,
booleans and counts only — never a note body, preview, transcript, provider
payload, secret, or arbitrary prose.** Event rows are **immutable and
append-only, enforced at the DB level** (a `BEFORE UPDATE OR DELETE` trigger
rejects all mutation). A duplicate/replayed command MUST NOT create a duplicate
semantic event (a no-op transition appends nothing). Tenant isolation applies to
event writes and reads.

### D-11 — Activity timeline filtering + pinned projection (RN-2)

RN-2, not RN-1: timeline filter chips (`All / Notes / Calls / Emails / System`)
and, within Notes, category filters; plus the overview pinned-note projection
(≤3, truncated). RN-1 delivers the data model + create path that make these
possible; the read/filter UX lands in RN-2.

### D-12 — Related entities & mentions (RN-3, deferred)

A requisition note may be *about* a Talent/Contact/Company/Pipeline/Interview.
The enterprise-correct model is an association table, not IDs-in-text:

```
ActivityAssociation: activity_id, relation_type (ABOUT_TALENT|ABOUT_CONTACT|
   ABOUT_COMPANY|ABOUT_PIPELINE|ABOUT_INTERVIEW), entity_type, entity_id
ActivityMention:     activity_id, mentioned_user_id, created_at  (stored, never
   re-parsed from text as source of truth)
```

This lets one client-call note surface in Requisition + Talent + Pipeline
activity **without duplicating** the note — fitting Aramo's association-oriented
architecture and future Conversation Intelligence. **Deferred to RN-3.**

### Increment plan

| Increment | Scope | Authorization |
|---|---|---|
| **RN-1 — Enterprise Note Core** | `ActivityNote` extension table + `NoteCategory`/`NoteVisibility`/`body_format` enums (D-0…D-2), pin metadata (D-3), larger editor (D-4), plain-text V1 (D-5), 20k validation FE+API (D-6), immutable create/redact/pin (D-7), Note≠Evidence invariant (D-8), staged perms + visibility enforcement (D-9), audit events (D-10); API + OpenAPI + Pact | **AUTHORIZED by this directive on ratification** |
| **RN-2 — Requisition Note UX** | Redesigned Category+Visibility dialog controls, timeline filtering, pinned-overview projection, fine-grained note scopes, `RESTRICTED` value + scope (deferred per Q1), accessibility | **Specified; separately authorized** (own directive/amendment) |
| **RN-3 — Collaboration** | Mentions + notifications, `ActivityAssociation`, controlled rich text, attachments, revision history | **Deferred / backlog** |

---

## Rejected alternatives

1. **Ship the prototype's `General / Client call / Internal` selector as-is.**
   Rejected — it overloads category with visibility ("Internal" is a
   confidentiality tier) and omits pin/format. Conflated controls are the defect.
2. **Add `category`/`visibility`/`pin`/`body_format` directly onto `Activity`.**
   Rejected — pollutes the generic envelope with note-only nullable columns
   meaningless for `call`/`email_logged`/`pipeline_status_change`/future types.
   The 1:1 `ActivityNote` extension keeps the envelope clean (D-0).
3. **A standalone `RequisitionNotes` table/subsystem.** Rejected — abandons the
   unified timeline, forces a second query surface and a second audit path, and
   breaks reuse across talent/company/contact/pipeline notes.
4. **Keep read-time-only visibility.** Rejected — cannot answer "was this marked
   confidential when written?"; confidentiality is authorial intent, must persist
   (D-2). AUTHZ-D4 already treats record visibility as first-class.
5. **Ship arbitrary Markdown now (per prototype label).** Rejected for RN-1 —
   sanitization/export/render-consistency risk on an audit record without V1
   value (D-5); controlled rich text is a governed RN-3 item.
6. **Allow note edit-in-place.** Rejected — silent mutation destroys audit
   reliability for client/rate/hiring/compliance content (D-7).
7. **Introduce full fine-grained note RBAC in RN-1.** Rejected — RESTRICTED's
   new scope alone drags in the seed-catalog blast radius; stage it (D-9).
8. **Unbounded body (status quo).** Rejected — three unbounded layers invite
   abuse and future cost; 20k cap FE+API, `TEXT` at rest (D-6).

---

## Scope

### In scope (RN-1)
- New `ActivityNote` extension table + additive, backward-compatible migration.
- `NoteCategory`, `NoteVisibility`, `body_format` enums (canonical in migration/
  schema; mirrored to BE DTO + FE `types.ts`).
- Pin metadata columns + pin/unpin command(s).
- Convert `CreateActivityRequestDto` to a validated **class** DTO; add category/
  visibility/pin fields + `@MinLength(1)/@MaxLength(20000)`.
- Extend `buildActivityVisibilityWhere()` for persisted note visibility.
- Extend the redaction path to hide redacted notes from the pinned projection.
- Larger editor + Category + Visibility + Pin controls in `LogNoteDialog.tsx`;
  remove "Markdown supported"; 20k counter.
- OpenAPI 3.1 update (nullable via `type: [x,'null']`, never `nullable:true`);
  Pact consumer + provider updates for the changed `POST /v1/activities` shape;
  register the new migration in `pact/provider/src/verify-api.ts`.
- Audit events `NOTE_CREATED/PINNED/UNPINNED/REDACTED`.

### Out of scope (RN-1 — deliberately not done)
- Timeline filter chips + pinned-overview *rendering* (RN-2).
- `RESTRICTED` value + `requisition:note:restricted:read` scope (RN-2 per Q1
  recommendation).
- Fine-grained note scopes (RN-2).
- Mentions, `ActivityAssociation`, notifications, rich text, attachments,
  revision history (RN-3).
- Any change to `libs/communications` — the note is not provider evidence (D-8).
- The system in-transaction activity write path (`insert-activity.ts`) — notes
  are the HTTP path only.
- AI note-writing/summarization; note templates; workflow triggers from notes.

---

## Acceptance criteria (each falsifiable by observation)

- **AC-1** Migration is additive: applying it to a DB with existing `note`
  Activity rows leaves them readable as `category=GENERAL, visibility=TEAM,
  is_pinned=false`; no existing row is dropped or altered in `Activity`.
- **AC-2** `POST /v1/activities` with `type='note'` persists `category`,
  `visibility`, `body_format`, and (on pin) pin metadata into `ActivityNote`;
  omitted category/visibility default to `GENERAL`/`TEAM`.
- **AC-3** Body length: a 20,001-char body is rejected `VALIDATION_ERROR` at the
  API **and** blocked at the FE; a 20,000-char body succeeds. *(Negative control:
  the same request against the pre-change build is accepted — demonstrating the
  guard newly bites.)*
- **AC-4** DTO is class-based: removing the `@MaxLength` decorator and re-running
  the DTO validation spec turns it RED (proves the pipe now enforces, closing the
  interface-had-no-metatype gap). *(Rule F negative control.)*
- **AC-5** `PRIVATE` note: a second user with normal requisition access does
  **not** receive it from `GET /v1/activities`; the author does. Asserted before
  the value existed (baseline: all-team-visible) and exactly after.
- **AC-6** Redacted note: body is nulled, row retained, and it is absent from the
  pinned projection query. R5 no-re-redact still holds.
- **AC-7** Talent-facing and external read APIs return **zero** `PRIVATE` note
  bodies for a requisition that has them — verified by an integration test
  exercising the external read surface, not by UI inspection.
- **AC-8** Pin: pinning two notes then a third leaves the overview projection at
  ≤3 truncated entries; unpinning one audits `NOTE_UNPINNED`; the chronological
  timeline order is unchanged by any pin/unpin.
- **AC-9** Editor: `LogNoteDialog` renders Category (7 values), Visibility
  (2 values — `TEAM`/`PRIVATE`, no `RESTRICTED` control), a ≥220px resizable
  body, no "Markdown supported" label, and a live char counter;
  subject-confirmation line present.
- **AC-10** Contract: `pact:consumer` (ats-web) regenerates the new
  `POST /v1/activities` shape and `pact:provider` verifies green against a DB with
  the new migration applied; the new migration is registered in
  `verify-api.ts`. *(Provider baseline stashed on clean `origin/main` first to
  split regression from debt.)*
- **AC-11** Curated integration specs: the new migration filename appears in
  every curated migration list found by repo-wide grep; `ARAMO_RUN_INTEGRATION=1
  nx run api` is green locally (the isolated specs miss migration consumers).
  *(Guarded by the standing HALT clause if the grep count differs from what any
  spec carries — not asserted as a fixed number here, per Rule B.)*
- **AC-12** (amended by RN-1-A1) Note-lifecycle ledger: creating, pinning,
  unpinning, and redacting a requisition note appends **exactly one** corresponding
  `ActivityNoteEvent` — `CREATED`, `PINNED`, `UNPINNED`, `REDACTED` respectively.
  Each event row contains only: event `id`, `tenant_id`, `activity_id`,
  `event_type`, `actor_user_id`, `created_at`, and bounded non-content `metadata`
  (IDs/enums/booleans/counts). It contains **no** note body, edited text,
  transcript text, provider payload, secret, or other content — asserted by a test
  that the persisted row shares no substring with the note body. The event row is
  **append-only**: a DB-level guard rejects `UPDATE` and `DELETE` (**negative
  control:** a seeded `UPDATE`/`DELETE` against `ActivityNoteEvent` is shown
  raising, per Rule F). A no-op transition (re-pin an already-pinned note,
  re-redact) appends **no** event (idempotency). Each event is written in the
  **same transaction** as its state mutation — if the event insert fails, the
  mutation rolls back.
- **AC-13** `bash scripts/verify-vocabulary.sh` exits 0 (category/visibility enum
  labels introduce no Tier-2 anti-term). *(Rule E.)*
- **AC-14** OpenAPI: `openapi:lint` (redocly) green; every new nullable field
  uses `type: [x,'null']`, zero `nullable:true`.
- **AC-15** Note-is-not-Evidence: an integration test asserts that creating a
  `CLIENT_INTERACTION`/`COMMERCIAL` note creates **no** ClientSelection, no
  commercial state row, no pre-start/employment change, and no
  `CommunicationInteraction`. *(D-8 made falsifiable.)*

---

## Standing HALT clause

> If, during execution, you discover that this change touches files, contracts,
> or behaviour not covered by this directive — or that its stated scope is wrong
> — HALT and report to Lead. Do not widen scope. Do not reconcile a contradiction
> on your own.

---

## Base-SHA gate

Pin: `4a18aa24d067ea586e7b6f35e4eddfcc6aed67fa`.

**Verify pin is ancestor of main before filing:**
`git merge-base --is-ancestor 4a18aa24d067ea586e7b6f35e4eddfcc6aed67fa origin/main`

**Tier 1 — HALT if changed since pin** (the design depends on these):
- `libs/activity/prisma/schema.prisma` — the `Activity` model shape and
  `ActivityType` enum the extension table hangs off.
- `libs/activity/src/lib/activity.repository.ts` `buildActivityVisibilityWhere()`
  — the read-visibility function D-2 extends.
- `libs/activity/src/lib/dto/create-activity-request.dto.ts` — the DTO D-6
  converts.
- `libs/activity/src/lib/activity.controller.ts` — the create route.
- `apps/ats-web/src/activity/LogNoteDialog.tsx` — the editor D-4 redesigns.
- `pact/pacts/ats-web-aramo-core.json` `POST /v1/activities` interaction — the
  contract the shape change ripples into.
- `pact/provider/src/verify-api.ts` activity migration registration.

If any Tier-1 artifact moved since the pin, HALT and re-ground before
implementing.

**Tier 2 — REPORT and continue** (build self-derives at run time):
- The set of curated integration-spec migration lists (AC-11) — discovered by
  repo-wide grep at build time, not frozen here.
- The exact `pactUrls` provider list — read from `verify-api.ts` at verify time.

---

## §11 — Resolved rulings (FROZEN — ratified 2026-09-21)

All four open questions were ruled by the PO at ratification. The directive body
above has been reconciled to these; they are recorded here as the authoritative
disposition and the updated HALT boundary.

1. **Q1 — `RESTRICTED` timing → DEFERRED to RN-2.** RN-1 ships only `TEAM` +
   `PRIVATE`. `RESTRICTED` (value) and `requisition:note:restricted:read` (scope)
   are out of RN-1's authorized surface. The `NoteVisibility` DB enum is authored
   so RN-2 can add `RESTRICTED` additively (no re-migration of the type).
2. **Q2 — `body` location → STAYS in `Activity.notes` (`TEXT`).** No body
   migration in RN-1. `ActivityNote` adds attributes only; existing note rows are
   untouched in `Activity`.
3. **Q3 — `PRIVATE` visibility → STRICTLY author-only.** No implicit
   admin/support override in RN-1. `buildActivityVisibilityWhere()` filters
   `PRIVATE` to the author subject alone.
4. **Q4 — Category set → RATIFIED exactly as drafted (7 values):** `GENERAL`,
   `CLIENT_INTERACTION`, `HIRING_TEAM`, `COMMERCIAL`, `INTERVIEW_FEEDBACK`,
   `DECISION`, `RISK_BLOCKER`. Default `GENERAL`.

### Updated HALT boundary (per this freeze)

Beyond the Standing HALT clause, RN-1 execution **HALTs** if it finds it needs
any of: a `RESTRICTED` visibility value or any new note scope (Q1); a data
migration moving note bodies out of `Activity.notes` (Q2); any admin/support
path that can read a `PRIVATE` note (Q3); an eighth `NoteCategory` value (Q4).
Each is outside the authorized surface and requires an RN-2 directive or an
amendment — it is not reconciled in-flight.

---

## Pre-filing checklist (Executor)

- [x] Weight declared and defensible (FULL — schema + contract + visibility) — Rule H
- [x] Every claim cited or marked unverified — Rule A
- [x] No unguarded forward value (counts are dated observations or HALT-guarded enumerations) — Rule B
- [x] No verdict output over a categorized question (note category is classified evidence, not a computed verdict) — Rule C
- [x] No list duplicating a fact maintained elsewhere (enum canonical in migration; FE/BE are the existing forbidden-edge mirror, not new authority) — Rule D
- [ ] `bash scripts/verify-vocabulary.sh` exits 0 — Rule E *(run at implement time; AC-13)*
- [x] Every new check has a stated negative control (AC-3, AC-4) — Rule F
- [x] Every restriction claim carries a quoted source (redaction, visibility, lifecycle policy cited by path) — Rule G
- [x] Guards specified to be checked from committed state (AC-11 grep from tracked tree; repo-map order) — Rule I
- [x] Pin verified as ancestor of `origin/main` — checklist above
- [x] Parent directive: none declared
- [x] Every acceptance criterion falsifiable by observation
- [x] All Part 1 FULL sections present
