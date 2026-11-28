# Runbook — Privacy requests (Aramo Sign)

v1.0, 2026-11-01. Conventions (PGRO, container names): [README.md](README.md).
Governing text: Aramo-Sign-Mobile-Amendment-M-A7 §3 (privacy requests), M-A8 §2 (deletion), §1.3.2
(deletion replay after a restore). Code: `libs/identity/src/lib/privacy/`,
`apps/sign-service/src/app/privacy/`, `apps/platform-admin/src/app/platform/platform-privacy-requests.controller.ts`.

## 1. Lifecycle (from code)

`RECEIVED → IDENTITY_VALIDATED → DATA_INVENTORY → (REFERRED_TO_ORGANIZATION | EXECUTING) → COMPLETED`,
or `DENIED_WITH_REASON` / `CANCELLED`. Types: `DELETION | ACCESS | EXPORT | CORRECTION`. Channels:
`IN_APP | WEB | OPERATOR`. Every request gets a public reference (`PR-XXXX-XXXX-XXXX`) and a due date
30 days after creation (`PRIVACY_REQUEST_DUE_MS`, `libs/identity/src/lib/privacy/privacy-request.model.ts`).
Rows are never deleted; `PrivacyRequestEvent` is append-only (database guards).

| Arrives as | What the system does by itself |
|---|---|
| In-app, Personal account owner, DELETION | Account close runs first (risk state closed, convenience data purged). If execution is **enabled** the request moves to `EXECUTING` and runs at once; otherwise it waits in the queue. |
| In-app, Business member, any type | `REFERRED_TO_ORGANIZATION` + Aramo privacy queue. **Never executed by self-service** (M-A8 §2.2); only an operator approval runs the member's own part. |
| Web form (no sign-in): `POST /v1/sign/privacy-requests/start` → emailed one-time link → `verify` | `RECEIVED → IDENTITY_VALIDATED → DATA_INVENTORY`, then waits for an operator. Never executed without an operator. |
| ACCESS / EXPORT / CORRECTION | Wait for the privacy team. |

Deletion execution is gated by `SIGN_PRIVACY_DELETION_EXECUTION_ENABLED=1` on sign-service and
platform-admin; **production state: unset = OFF** (2026-10-28 deployment record; enabling needs a separate
PO authorization). While OFF, the `execute` route answers 409 `privacy_execution_disabled`, and
`aramo-deletion-replay.sh` always reports `verdict=EMPTY`.

## 2. Operator surface — console: Privacy › Requests (PRIV-ADMIN-1)

admin.aramo.ai → **Privacy › Requests** (scope `platform:tenant:lifecycle:manage`, super_admin). The queue
filters by status, type, subject kind, channel, assigned to me, overdue and reference, flags overdue and
"Failing" requests, and shows whether deletion execution is on. The request page shows the inventory, the
completion evidence ("not verified" where a count could not be read), the impact preview for a deletion and
the full history. Every action is confirmed in a dialog; Execute deletion needs the request reference typed.
The contact email stays hidden until **Reveal contact**, which is recorded with the operator's id.

Rules the console and API enforce (PRIV-ADMIN-1, LOCKED 76abfbb5):
- A DELETION completes only by execution (`complete` answers 409 `privacy_deletion_completes_by_execution`).
  Close a referred Business deletion with Execute (member path) or Deny.
- ACCESS / EXPORT / CORRECTION are closed with **Record outcome** from DATA_INVENTORY or a referral; the note
  is shown to the requester. **Add note** is internal and never shown.
- Refer only to the subject's own organization (409 `privacy_referral_tenant_mismatch` otherwise).
- A failing execution retries after 1, 5, 15 and 60 minutes; after the 5th failure it returns to the queue
  (`EXECUTION_GAVE_UP`). **Return to queue** does the same by hand.
- A Business member's execution no longer removes Sign roles (organization-administered, M-A8 §2.3).
- A web Business-member DELETION is referred to the member's organization on verify, as in-app.

The API behind it, all under `https://admin.aramo.ai/platform/privacy-requests` (OpenAPI `platform.yaml`):

| Route | Effect |
|---|---|
| `GET /…?status=&request_type=&include_closed=&limit=&channel=&subject_kind=&assigned=me&overdue=&reference=` | Queue; items carry `failing`; response says `execution_enabled` |
| `GET /:id` | Detail, events, `contact_present`, `attempts` (no contact email) |
| `POST …/:id/reveal-contact` | The contact email; writes `CONTACT_REVEALED` |
| `POST …/:id/note` `{note}` | Internal note (`NOTE`) |
| `GET …/:id/preview` | Read-only impact preview for a deletion: `path`, `reasons`, `dependencies`, `unknown_sources` |
| `POST …/:id/return-to-queue` `{note}` | `EXECUTING → DATA_INVENTORY` (`RETURNED_TO_QUEUE`) |
| `POST /…` | Record a request received by email/post |
| `POST …/:id/assign` · `validate` · `inventory` · `refer` · `execute` · `complete` · `deny` · `cancel` | As before, with the rules above |

## 3. Daily queue procedure (privacy team; staffing is a PO item)

1. List open requests (oldest due first). Read-only alternative on the box:
   ```bash
   PGRO <<'SQL'
   SELECT reference, request_type, subject_kind, channel, status, due_at,
          (due_at < now() + interval '7 days') AS due_within_7_days, assigned_operator_id
     FROM identity."PrivacyRequest"
    WHERE status NOT IN ('COMPLETED','DENIED_WITH_REASON','CANCELLED')
    ORDER BY due_at;
   SQL
   ```
2. Assign each new request to a named operator (`assign`).
3. **Validate identity.** In-app and verified-web requests arrive validated by the system. An operator-
   recorded request (email/post/representative) is validated only with proof proportionate to the request;
   record what was checked in the note, never the proof itself.
4. **Inventory** (`inventory`): counts only.
5. Decide by type:
   - **DELETION, Personal owner:** if execution is enabled, `execute`; otherwise leave it in
     `DATA_INVENTORY`, tell the requester the request is recorded and on hold, and escalate the backlog to
     the PO (the due date still runs).
   - **DELETION, Business member:** `refer` to the organisation; the organisation decides about its
     documents. The member's own Aramo data part runs only on operator approval (`execute`, when enabled).
   - **ACCESS / EXPORT:** prepare the export with engineering (no self-service export tool is cited in
     code — **gap**); deliver through the requester's verified channel; `complete` with a note.
   - **CORRECTION:** most profile data is user-editable; otherwise engineering performs a reviewed change;
     `complete`.
   - **Not possible / not the requester's data:** `deny` with the reason.
6. Requests within 7 days of `due_at`: escalate to the PO the same day.

## 4. Legal hold

If the organisation is on legal hold (`identity."Tenant".legal_hold`), `execute` is refused
(`privacy_legal_hold`) and purges do not run. Tell the requester the request is recorded and why it is
paused, if counsel allows. Holds are PO decisions.

## 5. Alert `sign:privacy` and stuck `EXECUTING`

`privacy request <ref> execution failed: <ErrorName>` or `privacy execution of <ref> failed` in sign-service:

```bash
docker logs --since 6h aramo-prod-sign 2>&1 | grep -E 'privacy (request|execution)'
PGRO -v ref=<PR-reference> <<'SQL'
SELECT r.reference, r.status, r.updated_at, e.event_type, e.from_status, e.to_status, e.payload, e.created_at
  FROM identity."PrivacyRequest" r JOIN identity."PrivacyRequestEvent" e ON e.request_id = r.id
 WHERE r.reference = :'ref' ORDER BY e.created_at;
SQL
```

The execution worker retries requests in `EXECUTING` (`sign-privacy-execution.worker.ts`). An
`EXECUTION_FAILED` event with a repeating error name ⇒ escalate to engineering with the reference.
Recorded open item (deployment record 2026-10-28, not re-verified here): the platform IAM principal lacks
`cognito-idp:AdminUserGlobalSignOut`, which account deletion needs — a blocker to enabling execution.

## 6. After a database restore

Privacy deletions executed after the backup must be replayed before the restored database serves traffic:
`deploy/backup/aramo-deletion-replay.sh` (`RUNBOOK-backups.md` §8). See [backup-restore-test.md](backup-restore-test.md).
