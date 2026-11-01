# Runbook — Retention purge and per-party deletion

v1.0, 2026-11-01. Conventions (PGRO, container names): [README.md](README.md).
Governing directive: Aramo-Sign-Retention-and-Purge-DocuSign-Parity-Directive-v0_1-LOCKED (`ebd41d99`).
Code: `libs/sign/src/lib/retention/sign-purge.repository.ts`, `apps/sign-service/src/app/retention/`.

## 1. How it works (facts from code)

| Concept | Behaviour |
|---|---|
| Enablement | Everything is dark unless `SIGN_PURGE_ENABLED=1` in sign-service (every write route answers 403 `ESIGN_FEATURE_NOT_AVAILABLE`, the worker does not start). Production state per the 2026-10-31 deployment record: **enabled** — confirm with `docker exec aramo-prod-sign printenv SIGN_PURGE_ENABLED`. Run interval `SIGN_PURGE_INTERVAL_MS`. |
| Tenant retention policy | One row per tenant: `retention_days` `NULL` = keep forever, else 1–9999 days after the envelope reached `COMPLETED` / `DECLINED` / `VOIDED`, plus a purge level. Set by a tenant admin (`sign:settings:manage`) in the Sign app (`PUT /v1/sign/sender/retention-policy`); every change appended to `SignTenantRetentionPolicyEvent`. |
| Levels | `DOCUMENTS` (artifact bytes) < `DOCUMENTS_AND_METADATA` < `DOCUMENTS_AND_METADATA_AND_REDACT` (also redacts personal fields in the ledger: `title, reason, name, email, attested_name, subject, message, decline_reason`) |
| Queue | An eligible envelope is `QUEUED` with `purge_due_at = now + 14 days` (`PURGE_QUEUE_DAYS`). Reasons: `retention`, `targeted`, `all_parties_deleted`, `account_closed`, `manual`. `DEQUEUED` cancels before execution; a retention run never re-queues an envelope an administrator dequeued. |
| Execute | After the S3 versions are removed: one transaction under the envelope lock, only while `QUEUED`, due, and the tenant is **not** under legal hold (`identity."Tenant".legal_hold`). Rows, hashes and custody records stay; bytes become `NULL`; ledger events redacted per LD-2; one `ENVELOPE_PURGED` event; state `EXECUTED` (final, cannot be undone). |
| Object Lock | A version still under S3 retention cannot be removed: the envelope waits (`purge_waiting_until`) and the run logs `sign_purge.waiting_object_lock` (normal, not an error). |
| Per-party delete ("Deleted" folder) | Hides a terminal envelope for **one** party only: sender (`POST /v1/sign/sender/envelopes/:id/delete`, `/restore`) or a recipient with an Aramo account (`POST /v1/sign/inbox/:id/delete`, `/restore`). Stored in `SignEnvelopePartyDeletion`. Nothing is purged by this alone. |
| All parties deleted | When the sender **and** every bound Aramo recipient (`SignRecipientBinding`, not revoked) have deleted it, the run queues a `DOCUMENTS` purge with reason `all_parties_deleted` (14-day window). Guest signers without an Aramo account are not a "party" for this rule. |
| Targeted purge (R-9) | A tenant admin queues every terminal envelope of the tenant sent from or signed by one email (`POST /v1/sign/sender/purge/targeted`). |
| Account closure (R-11) | Closing an account queues every terminal envelope at `DOCUMENTS_AND_METADATA_AND_REDACT`. |
| Manual | `POST /v1/sign/sender/envelopes/:id/purge` / `.../purge/dequeue` (`sign:envelope:manage:all`). |

The database itself (migration `20261101100000`) refuses purge writes outside the due window.

## 2. Operator questions

Status of one envelope:
```bash
PGRO -v env=<envelope uuid> <<'SQL'
SELECT status, purge_state, purge_level, purge_reason, purge_queued_at, purge_due_at, purge_waiting_until, purge_executed_at
  FROM sign."SignatureEnvelope" WHERE id = :'env';
SELECT party_kind, deleted_at, restored_at FROM sign."SignEnvelopePartyDeletion" WHERE envelope_id = :'env';
SQL
```

Queue overview (counts only):
```bash
PGRO <<'SQL'
SELECT purge_state, purge_reason, count(*), min(purge_due_at) AS next_due
  FROM sign."SignatureEnvelope" WHERE purge_state IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2;
SELECT count(*) AS waiting_object_lock FROM sign."SignatureEnvelope"
 WHERE purge_state = 'QUEUED' AND purge_waiting_until > now();
SELECT count(*) AS tenants_on_legal_hold FROM identity."Tenant" WHERE legal_hold;
SQL
```

## 3. Requests from users

| Request | Answer / action |
|---|---|
| "Delete this envelope for me" (sender) | Sender uses Delete in the Sign app; it hides the envelope for them only. Restore is possible until a purge executes. |
| "Delete this for me" (recipient with an account) | Same, from their inbox. |
| "Delete it for everyone" | Only the sending organisation decides: its admin queues a manual or targeted purge, or sets a retention policy. Aramo operators do not purge on a user's behalf. A privacy deletion request from an individual goes to [privacy-requests.md](privacy-requests.md). |
| "Stop the purge" | Before `purge_due_at`: the tenant admin dequeues it in the app. After `EXECUTED`: not possible; the bytes are gone (backups age out per `RUNBOOK-backups.md` retention; a restore from backup is never used to undo a purge without the PO). |
| Legal hold on a tenant | `identity."Tenant".legal_hold = true` blocks every purge execution and privacy deletion for that tenant. Setting it is a PO decision; there is no console action today — **open item** (the column is described as "a future deletion-suspend marker" in `libs/identity/prisma/schema.prisma`; any write is an audited, PO-authorized SQL change). |

## 4. Alerts

| Alert | Meaning | Action |
|---|---|---|
| `sign:purge` | `sign_purge.execute_failed`, `sign_purge.queue_failed`, `purge run failed`, or a run line with `failed>0` | `docker logs --since 2h aramo-prod-sign 2>&1 | grep -E 'sign_purge|purge run'`. The envelope stays `QUEUED` and is retried on the next run (execution is one transaction; S3 deletion is per version and idempotent). Recurrent `AccessDenied` on S3 ⇒ the Sign IAM user lacks the purge statement (`SignPurgeArtifactVersions`, `infrastructure-lightsail/sign-artifacts.tf`, Retention and Purge W2): **per the 2026-10-31 deployment record W2 was not yet applied and must be applied (Mac, PO) before the first purge falls due**. Escalate any other error with the envelope id. |
| `sign:purge-r13` | `sign_purge.alert_integration_copy_unconfirmed envelope_id=…`: an envelope sent by an application (e.g. the ATS) is being purged although its executed event never got a 2xx delivery, so the application may not hold its copy | Not a failure of the purge (it proceeds). Tell the integration owner which envelope ids, check `SignWebhookDelivery` / `OutboxEvent` for them ([stuck-envelopes.md](stuck-envelopes.md) §2), record it. If the purge is still `QUEUED` and the owner needs the copy, the tenant admin may dequeue it. This alert closes the recorded R-13 alert gap. |
| `sign:retention` | `retention run failed` / `convenience-data purge failed` (the separate convenience-data retention worker, `SIGN_RETENTION_WORKER_ENABLED`) | `docker logs --since 2h aramo-prod-sign 2>&1 | grep -i retention`; retried next interval; escalate if persistent. |

## 5. Never

- Never `UPDATE` purge columns or delete S3 versions by hand. The database guards refuse early writes,
  and a hand deletion would leave custody records pointing at missing versions (the custody validator would
  then report `MISSING_CUSTODY` / `PURGE_INCOMPLETE`).
- Never use break-glass S3 credentials to remove Object Lock retention to "finish" a purge.
