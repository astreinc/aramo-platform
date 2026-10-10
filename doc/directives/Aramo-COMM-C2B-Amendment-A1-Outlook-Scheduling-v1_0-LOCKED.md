# Aramo — COMM-C2B Amendment A1: Outlook Calendar Scheduling

| Field | Value |
|---|---|
| **Amendment ID** | COMM-C2B-A1 |
| **Parent directive** | `Aramo-COMM-C2B-Microsoft-Email-Teams-Delegated-Authorization-Directive-v1_0-LOCKED.md` |
| **Amends rulings** | R8 (delegated least-privilege scope set), R15 (no attendees), R17 (no invitation / meeting-create consent posture) |
| **Program** | M365-SCHED-1 — Outlook / Teams scheduling from the Requisition Talent drawer |
| **Version** | v1.0 |
| **Status** | LOCKED — Ratified |
| **Ratified** | 2026-10-10 |
| **Reference baseline** | `origin/main@0332e210` |
| **Authority** | Architect ratification of the COMM-C2B Outlook Scheduling Amendment A1 and its design reconciliation |
| **Supersedes** | Nothing. Extends COMM-C2B v1.0; the create-link-only and send-only capabilities remain valid. |

## 0. Purpose and relationship to COMM-C2B

COMM-C2B v1.0 established a delegated Microsoft 365 provider restricted to outbound email
(`Mail.Send`) and create-link-only Teams online meetings (`OnlineMeetings.ReadWrite`), with no
calendar-wide Graph permission (**R8**), no meeting attendees (**R15**), and no invitation and no
contacting-consent gate on meeting creation — because no outbound contact occurred (**R17**).

Those restrictions were correct for that capability and **remain in force as the default**. This
amendment does not retract them. It introduces an **additional, separately authorized capability** —
Outlook calendar scheduling with attendee invitations — delivered under the M365-SCHED-1 program.
Where the two capabilities differ, this amendment governs the **scheduling capability only**; the
create-link-only and send-only capabilities are unchanged.

This amendment is grounded on the M365-SCHED-1 technical reconciliation (reconciliation return A–J
plus the design and contract reconciliation C-1 through C-8) accepted by the Architect against
`origin/main@0332e210`.

## 1. Preserved invariants (unchanged by this amendment)

- Tenant-owned Microsoft Entra application registration (per-tenant client id / authority held on
  the provider-neutral integration connection).
- Per-recruiter delegated OAuth authorization-code flow with PKCE.
- AWS Secrets Manager token custody; Postgres never holds a provider token.
- Existing send-only (`Mail.Send`) and create-link-only (`OnlineMeetings.ReadWrite`) capabilities.
- Tenant isolation and backend authorization as the authority — never a disabled frontend control.
- Domain-owned recruiting workflow authority. An external Teams or Outlook artifact never replaces
  an authoritative Aramo business record and never independently advances the recruiting Pipeline.

## 2. Amended rulings

### 2.1 R8 — delegated scope least-privilege (amended)
The baseline delegated scope set is unchanged for all recruiters. A **separate scheduling scope set**
is defined that adds `Calendars.ReadWrite`. `Calendars.*` remains fail-closed-forbidden on the
baseline set. The scheduling scope set is requested only when a recruiter explicitly enables the
scheduling capability (§3, R4). No baseline permission is widened and no recruiter is globally forced
to re-consent.

### 2.2 R15 — attendees (amended)
Attendee invitations are permitted, but **only** through the scheduling capability and **only** after
consent, tenant-ownership, and organizer-binding validation pass (§3, R1). The create-link-only path
retains R15 unchanged: no attendees.

### 2.3 R17 — invitation and consent posture (amended)
An Outlook calendar invitation addressed to a Talent **is** an outbound Talent-contact action and
**must** pass the contacting-consent gate before transmission (§3, R1). The create-link-only path
retains R17 unchanged: no invitation and no gate, because no contact occurs.

## 3. Ratified rulings (Architect, M365-SCHED-1)

### R1 — Consent semantics
Reuse the existing `communication → contacting` consent-policy semantics for Talent-directed
calendar invitations. The implementation must explicitly validate that the existing consent service
supports the intended invitation operation and **fail closed** if consent is missing, stale, or
invalid. No invitation may be transmitted before authorization and consent validation. Do not
introduce a separate consent domain or operation without evidence that the existing semantics are
insufficient.

### R2 — Meeting authorization scopes
Authorize these scope additions: `communication:meeting:read`, `communication:meeting:edit`,
`communication:meeting:cancel`. Retain the existing `communication:meeting:create`. Implement all
required scope-catalog, seed, grant, and contract changes. Mutation authorization must **also**
enforce organizer ownership and tenant isolation: a scope alone does not authorize modification of
another recruiter's meeting.

### R3 — Provider-side idempotency (with refinement)
Use the Microsoft Graph event `transactionId` **where supported** as the provider-side
duplicate-create protection mechanism. Persist a durable scheduling operation identity **before**
calling Graph. Do **not** assume that Graph provides an arbitrary lookup-by-`transactionId` API or
guarantees indefinite de-duplication; verify the documented semantics and design recovery for
ambiguous provider outcomes. The implementation must not blindly create another invitation after a
timeout when the original provider outcome is unknown — use reconciliation and an explicit
**unresolved-operation state** where necessary. Reschedule and cancellation must target the existing
provider event identity.

### R4 — Elevated OAuth scopes
Preserve the current baseline delegated scope set. Introduce a separately authorized scheduling scope
set that adds `Calendars.ReadWrite`. Calendar access must be explicitly enabled and consented to by
the recruiter. Recruiters who do not enable scheduling must retain their existing send-only and
create-link-only functionality. Do not globally force calendar reauthorization and do not expand
baseline permissions.

### R5 — Durable audit ownership
Authorize the smallest appropriate durable audit model within the Communications domain, using the
existing `@@schema("audit")` precedent. Record scheduling creation, rescheduling, cancellation, and
provider failures with appropriate actor, tenant, outcome, and correlation information. Do not store
OAuth tokens, secrets, or unnecessary personal information in audit records. Do not introduce a new
audit service solely for this increment.

### R6 — External calendar consistency
Aramo scheduling reads may return the last-known synchronized provider state. Do not represent those
reads as guaranteed live Outlook state. Outlook remains authoritative for the external event.
Outlook-originated changes and broader bidirectional synchronization may be delivered in a later
increment, provided the initial implementation clearly communicates its synchronization limitations.

## 4. Domain ownership (ratified)

- **Recruiter screening, qualification calls, and follow-up meetings** belong to **Communications**,
  with Talent and Requisition associations.
- **Client interviews** remain governed by the existing **Client Selection / InterviewSession**
  aggregate and its lifecycle. Do not build a competing interview state machine.
- **Outlook** is the external calendar authority. Aramo stores the minimum provider references,
  synchronization state, and business associations needed to operate the workflow reliably.
- The existing internal **CalendarEvent** CRUD domain must not be repurposed as the Outlook
  synchronization authority without separate architectural approval.
- Scheduling does not independently advance Pipeline recruiting stages.

## 5. Scope, governance, and deferrals

- This amendment authorizes implementation of the M365-SCHED-1 backend (PR 1A) and frontend (PR 1B)
  increments under repository governance gates.
- **Merge authority and deployment authority are not granted** by this amendment.
- Client-interview eligibility remains backend-authoritative: a visible, non-terminal
  ClientSelectionProcess (which exists only from a valid submittal). A disabled frontend control is
  insufficient enforcement.
- Outlook-originated change synchronization is **deferred** (R6); the initial implementation must
  communicate its synchronization limitations and must not present stale local state as guaranteed
  current Outlook state.
- A consolidated Recruiting Calendar is a separately scoped future increment.
- `doc/recon/` remains frozen at its original baseline; this amendment does not modify it.
- The original LOCKED COMM-C2B directive remains unchanged.

## 6. Provenance

- Reference baseline: `origin/main@0332e210`.
- Canonical filing: this document is filed in the Aramo canonical governance store beside the parent
  COMM-C2B directive, with an identical mirror committed to the M365-SCHED-1 implementation PR under
  `doc/directives/`. The canonical-store copy is authoritative.
- Basis: the M365-SCHED-1 reconciliation return (A–J) and design/contract reconciliation
  (C-1 through C-8) accepted by the Architect.
