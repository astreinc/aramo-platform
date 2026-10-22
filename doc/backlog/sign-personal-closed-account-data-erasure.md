# Backlog: Aramo Sign Personal — automatic deletion of a closed account's data

**Status:** OPEN. It needs Lead and PO authorization under the data-retention and erasure program before any implementation.

**Raised by:** `Aramo-Sign-Personal-Free-Launch-Directive-v1_1-Amendment-A1-v1_0-LOCKED` §A1-9 (Lead Architect ruling, 2026-10-22).

## What

A Personal account owner can close their account: Settings → Close account, or the operator closes it. On close:
- sending stops;
- the workspace shows only "account closed";
- envelopes already sent stay signable by their signers.

**Nothing deletes the account's data afterwards.** The following stay indefinitely:
- the tenant;
- its users and documents;
- signed records;
- the audit trail;
- the stored PDFs.

Today the only deletion route is manual. A person asks privacy@aramo.ai (or grievance@aramo.ai in India), and someone deletes what Aramo is not required to keep, within 30 days.

## Why this is backlog and not built

The Lead ruled (A1-9) that broad, irreversible tenant deletion must not be added to the Personal Free PRs just to match wording in the Terms. It could destroy records Aramo may have to keep:
- signed documents and completion certificates;
- audit evidence;
- legal acceptances;
- security and abuse records.

So the approved texts promise only what exists:
- closing stops access, so people must download their documents first;
- data is deleted or anonymised "under our data-retention program";
- deletion on request within 30 days.

## What exists already

**Close mechanics:**
- `PersonalRiskService.close` sets risk state `closed`;
- the audit event is `identity.personal.risk.closed`;
- the self-service route is `POST /v1/sign/account/close`.

**Retention schedule:** the approved table is in `doc/legal/aramo/privacy-notice.md` §9.

**Fields no job uses yet:**
- `Tenant.retention_delete_after` is set only on OFFBOARDING (`libs/identity/src/lib/tenant.service.ts`). No job reads it.
- No S3 lifecycle rule exists for Sign document storage.

**Related program:** the erasure program (S2 erasure integrity, PR #949) covers talent erasure. Its activation is not authorized.

## What a governed implementation must decide

1. **Data classes.** For a closed Personal tenant, list each data class:
   - account and profile;
   - envelopes and documents;
   - signed PDFs;
   - completion certificates;
   - the audit trail;
   - legal acceptances;
   - abuse reports;
   - security logs;
   - email-delivery records.

   For each, decide delete, anonymise or keep, and for how long. Legal hold and dispute exceptions must be explicit.
2. **The clock.** The trigger is the close time from risk state `closed`. Decide the grace period, any warning email, and whether closing can be undone within the grace period.
3. **Other parties' copies.** Signers and other parties keep their copies. The design must not delete evidence that belongs to someone else's completed agreement.
4. **Storage.** Object deletion in S3 and the document store, and backup expiry. Any promise about backup removal needs a real backup retention setting behind it.
5. **Safety.**
   - Idempotent and resumable.
   - Audited with counts only.
   - Dry-run mode.
   - A per-tenant ledger.
   - Never touches an active tenant or a bound identity.
   - Never runs on a tenant under legal hold.
6. **Legal text.** When it ships, publish a new document version with a dated promise, and require re-acceptance (A1-11 item 6). Version 1.0 must not be silently edited.
7. **Business accounts.** They follow their organization agreement; this backlog item is Personal only.

## Acceptance

- A LOCKED directive under the erasure program.
- An integration test proving that retained classes survive and deleted classes are gone.
- Updated legal texts, versioned with re-acceptance.
- PO authorization for production activation.
