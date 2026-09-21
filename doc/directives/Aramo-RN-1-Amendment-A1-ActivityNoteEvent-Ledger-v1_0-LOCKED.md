# RN-1 — Amendment A1 — ActivityNoteEvent Ledger

> **Status: RATIFIED / LOCKED — 2026-09-21.** Narrow amendment to the LOCKED
> directive `Aramo-RN-1-Requisition-Enterprise-Notes-Directive-v1_0`. Produced by
> the Code Executor from the Architect ruling of 2026-09-21 ("ARCHITECT RULING —
> RN-1 AUDIT HALT") and ratified by the Architect the same day. Amends **only**
> D-10 and AC-12; no other RN-1 architectural ruling is modified. The HALT is
> **CLEARED** — RN-1 implementation is authorized to resume.
>
> **Ratified content SHA-256 (of the DRAFT as approved):**
> `8a3a91b8e043b2dad0c63ed88cf4d1e6c536372d4970f852b57b7d60f2171bf0`
> This LOCKED copy differs from that hash **only** by the status stamps in this
> banner and the header table; the substantive amendment (§§1–8) is byte-identical.

---

## Header

| Field | Value |
|---|---|
| **Amendment ID** | RN-1-A1 |
| **Parent directive** | `Aramo-RN-1-Requisition-Enterprise-Notes-Directive-v1_0-LOCKED.md` |
| **Version** | v1.0 |
| **Weight** | FULL (adds a DB table + enum + immutability trigger to `libs/activity`) |
| **Status** | RATIFIED / LOCKED — 2026-09-21 (HALT cleared) |
| **Scope of amendment** | D-10 and AC-12 **only** |
| **Pin** | `4a18aa24d067ea586e7b6f35e4eddfcc6aed67fa` (unchanged from parent) |
| **Dev branch** | `feat/rn-1-requisition-enterprise-notes` (unchanged) |

---

## 1. Why this amendment exists (the validated HALT)

The parent directive's D-10/AC-12 required the four note transitions to *emit*
`NOTE_CREATED / NOTE_PINNED / NOTE_UNPINNED / NOTE_REDACTED` into an audit
substrate. Recon proved that substrate **does not exist**:

- `libs/audit/src/lib/audit.module.ts` is an empty `@Module({})`.
- `libs/audit/prisma/schema.prisma` states verbatim: *"PR-1 scaffolding only …
  Zero models exist yet."*
- No audit table, repository, or emitter exists anywhere; `libs/activity`
  create/redact emit nothing today.

The HALT is valid. The four alternatives were weighed and rejected:

- **Build a generic platform-wide `libs/audit` subsystem in RN-1** — unjustified
  scope expansion.
- **Silently drop D-10/AC-12** — weakens a LOCKED requirement.
- **Claim current-state columns alone satisfy audit** — rejected: a single
  `is_pinned`/`pinned_at`/`pinned_by_id` row **cannot preserve both PINNED and
  UNPINNED history**; overwriting the columns erases the earlier transition.
- **Defer audit entirely to RN-2** — weakens a LOCKED RN-1 requirement.

**Ruling:** RN-1 owns a narrow, append-only **note-lifecycle ledger inside
`libs/activity`** — `ActivityNoteEvent`. This is *not* `libs/audit` and *not* a
platform audit framework; it is the minimal append-only history that makes
RN-1's own note semantics truthful. Activity/ActivityNote remain the
authoritative current state; `ActivityNoteEvent` preserves the transition
history.

```
ActivityNote
     │
     ├── current state (authoritative)
     │      is_pinned · pinned_at · pinned_by_id
     │
     └── ActivityNoteEvent[]  (append-only history)
            CREATED · PINNED · UNPINNED · REDACTED
```

---

## 2. Exact D-10 delta

**BEFORE (parent D-10, verbatim):**

> ### D-10 — Audit
>
> Server-authoritative `tenant_id`, `site_id`, `created_by_id`, `created_at` —
> never from the browser (already true for create; preserved). Audit the state
> transitions `NOTE_CREATED`, `NOTE_PINNED`, `NOTE_UNPINNED`, `NOTE_REDACTED`
> (and `NOTE_VISIBILITY_CHANGED` only if/when visibility change is ever allowed —
> not in RN-1). Audit carries **IDs and transitions, not full bodies** (the
> `ActivityNote`/`Activity` row is already the authoritative persisted record).

**AFTER (amended D-10):**

> ### D-10 — Audit (amended by RN-1-A1)
>
> Server-authoritative `tenant_id`, `activity_id`, `actor_user_id`, `created_at`
> — never from the browser. RN-1 records note-lifecycle transitions in an
> **append-only `ActivityNoteEvent` ledger owned by `libs/activity`**. **No
> platform-wide audit subsystem is created**, and RN-1 takes **no dependency on
> `libs/audit`**. A future canonical audit service MAY project or consume these
> events, but RN-1 does not depend on one.
>
> `Activity`/`ActivityNote` remain the authoritative **current state**;
> `ActivityNoteEvent` is **historical transition evidence only**. Exactly one
> event is appended, **transactionally with** its state transition, for each of:
> `CREATED`, `PINNED`, `UNPINNED`, `REDACTED`. (`NOTE_VISIBILITY_CHANGED` remains
> out of RN-1 — visibility is not mutable in RN-1.) An event carries **IDs,
> enums, booleans and counts only — never a note body, preview, transcript,
> provider payload, secret, or arbitrary prose.** Event rows are **immutable and
> append-only, enforced at the DB level**. A duplicate/replayed command MUST NOT
> create a duplicate semantic event (a transition that is a no-op appends
> nothing). Tenant isolation applies to event writes and reads.

---

## 3. Exact AC-12 delta

**BEFORE (parent AC-12, verbatim):**

> - **AC-12** Audit: creating, pinning, unpinning, and redacting a note emits
>   exactly `NOTE_CREATED`, `NOTE_PINNED`, `NOTE_UNPINNED`, `NOTE_REDACTED`
>   respectively, each carrying IDs/transition state and **no** full body.

**AFTER (amended AC-12):**

> - **AC-12** Note-lifecycle ledger: creating, pinning, unpinning, and redacting
>   a requisition note appends **exactly one** corresponding `ActivityNoteEvent`
>   — `CREATED`, `PINNED`, `UNPINNED`, `REDACTED` respectively. Each event row
>   contains only: event `id`, `tenant_id`, `activity_id`, `event_type`,
>   `actor_user_id`, `created_at`, and bounded non-content `metadata`
>   (IDs/enums/booleans/counts). It contains **no** note body, edited text,
>   transcript text, provider payload, secret, or other content — asserted by a
>   test that the persisted row shares no substring with the note body. The event
>   row is **append-only**: a DB-level guard rejects `UPDATE` and `DELETE`
>   (**negative control:** a seeded `UPDATE`/`DELETE` against `ActivityNoteEvent`
>   is shown raising, per Rule F). A no-op transition (re-pin an already-pinned
>   note, re-redact) appends **no** event (idempotency). Each event is written in
>   the **same transaction** as its state mutation — if the event insert fails,
>   the mutation rolls back.

---

## 4. Migration / schema impact

Folded into the **same un-applied RN-1 migration**
`libs/activity/prisma/migrations/20260921160000_rn1_activity_note_extension/migration.sql`
(nothing has shipped; keeping RN-1 to one migration). Additions:

1. **Enum** `activity."NoteEventType"` = `('CREATED','PINNED','UNPINNED','REDACTED')`.
2. **Table** `activity."ActivityNoteEvent"`:
   - `id UUID PK DEFAULT gen_random_uuid()`
   - `tenant_id UUID NOT NULL` — event-local tenant isolation (rule 13), not via join
   - `activity_id UUID NOT NULL` — FK → `activity."Activity"(id)`, `ON DELETE RESTRICT` (history is never cascade-wiped; Activity has no delete path regardless)
   - `event_type activity."NoteEventType" NOT NULL`
   - `actor_user_id UUID NOT NULL` — server-derived (`AuthContext.sub`)
   - `created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`
   - `metadata JSONB` — nullable; IDs/enums/booleans/counts only (never content)
3. **Indexes**: `(tenant_id, activity_id, created_at)` for per-note history reads; `(tenant_id, created_at)` for the tenant stream.
4. **Immutability trigger** (DB-level, rule 4): a `BEFORE UPDATE OR DELETE`
   trigger on `ActivityNoteEvent` that unconditionally `RAISE EXCEPTION`. It does
   **not** compare `OLD`/`NEW` (avoids the `NULL = NULL` immutability-trigger
   trap) — every `UPDATE`/`DELETE` is rejected outright.

**`schema.prisma`** gains the `NoteEventType` enum, the `ActivityNoteEvent`
model, and a back-relation `noteEvents ActivityNoteEvent[]` on `Activity`. (The
trigger is migration-owned; Prisma does not model it.)

No change to the already-authored `ActivityNote` table, its enums, the backfill,
or the `Activity.notes` body location (Q2).

---

## 5. Transaction design (one atomic unit per transition)

All three mutating paths move from single Prisma calls to a `prisma.$transaction`:

- **CREATED** — `Activity.create` + `ActivityNote.create` + `ActivityNoteEvent(CREATED)` in one transaction (rule 9). Replaces the current single `activity.create`.
- **PINNED / UNPINNED** — read current `is_pinned`; **only if it transitions**, update pin columns + append `ActivityNoteEvent(PINNED|UNPINNED)` in one transaction (rules 10, 12). A re-pin/re-unpin is a no-op and appends nothing.
- **REDACTED** — the existing redact-never-delete update (null body, set redaction columns; R3 type=note, R5 no re-redact) + append `ActivityNoteEvent(REDACTED)` in one transaction (rule 11). R5 guarantees at most one REDACTED event.

If any event insert throws, the enclosing transaction rolls back the state mutation — no orphaned state, no orphaned event.

---

## 6. Immutability enforcement

- **DB level (authoritative):** the `BEFORE UPDATE OR DELETE` trigger rejects all
  mutations of `ActivityNoteEvent` rows.
- **App level (defence-in-depth):** the repository exposes only an append method
  for the ledger — no update/delete method exists on the events surface.
- **Negative control (Rule F / AC-12):** an integration test issues a raw
  `UPDATE` and a raw `DELETE` against a seeded event row and asserts both raise;
  the same test shows an `INSERT` (append) succeeding.

---

## 7. Test plan

- **CREATED** — creating a note appends exactly one `CREATED` event with the 7
  fields; assert `metadata`/row carry no note-body substring.
- **PINNED/UNPINNED** — pin → exactly one `PINNED`; unpin → exactly one
  `UNPINNED`; re-pin an already-pinned note → **zero** new events (idempotency,
  rule 12); the current-state columns reflect the latest, the ledger preserves
  both transitions.
- **REDACTED** — redact → exactly one `REDACTED`; re-redact rejected (R5) → no
  second event.
- **Immutability** — raw `UPDATE`/`DELETE` on an event row raises (DB trigger);
  negative control per Rule F.
- **Transactionality** — a forced event-insert failure rolls back the state
  mutation (no orphaned pin/redaction).
- **Tenant isolation** — events are written with and read by `tenant_id`; a
  second tenant never reads another tenant's events.
- **No-content** — the event row (all columns incl. `metadata`) shares no
  substring with the note body / redaction free-text.

These extend the parent AC set; AC-12 is replaced by §3 above. AC-8 (pin/unpin)
now additionally asserts the corresponding ledger events.

---

## 8. HALT

Per the Architect ruling, implementation of pin/unpin/redaction is **HALTED**
pending ratification of this amendment. The already-completed, un-applied RN-1
data layer (`ActivityNote` table + 3 enums + backfill + schema, generated
client) is **not** rolled back — it is unaffected by this amendment and is a
strict subset of the ratified design. On ratification, the Executor will: fold
§4 into the RN-1 migration, apply the §2/§3 deltas into the parent LOCKED
directive body, and resume the build per §5–§7.
