# Runbook — Stuck envelopes

v1.0, 2026-11-01. Conventions (PGRO, container names): [README.md](README.md).

An envelope is "stuck" when a sender or signer expects it to move and it does not: no invitation email,
the next signer in a sequential envelope never got theirs, a completed envelope has no executed copy, or
an application (the ATS) never heard that it completed. **Nothing in this runbook writes to the
database.** Every fix is either a user action in the Sign app, a worker that retries by itself, or a
recorded escalation.

## 1. Facts to collect first

Ask for: the envelope id (shown in the Sign app URL / sender console), the sender tenant, what the
person expected, and when. Never ask for document content.

```bash
PGRO -v env=<envelope uuid> <<'SQL'
SELECT id, tenant_id, status, execution_mode, routing_mode, source_application,
       created_at, sent_at, completed_at, declined_at, voided_at, expires_at, deleted_at,
       purge_state, purge_due_at
  FROM sign."SignatureEnvelope" WHERE id = :'env';
-- recipients: role/order/status only (no names or emails in the output)
SELECT id, signing_order, recipient_kind, status, viewed_at, signed_at, declined_at
  FROM sign."Signer" WHERE envelope_id = :'env' ORDER BY signing_order, id;
-- invitation / notification mail attempts
SELECT notification_kind, status, attempts, left(last_error, 120) AS last_error, created_at, sent_at, claimed_at
  FROM sign."NotificationDelivery" WHERE envelope_id = :'env' ORDER BY created_at;
-- lifecycle events (the hash-chained ledger)
SELECT occurred_at, event_type, actor_type FROM sign."SignatureEvent" WHERE envelope_id = :'env' ORDER BY occurred_at, id;
SQL
```

Statuses (`libs/sign/prisma/schema.prisma`): envelope `DRAFT | SENT | IN_PROGRESS | COMPLETED | DECLINED | VOIDED | EXPIRED`;
recipient `PENDING | VIEWED | SIGNED | DECLINED` (kind `SIGNER | IN_PERSON_SIGNER | RECEIVES_COPY`);
notification `PENDING | DISPATCHING | SENT | FAILED | CANCELLED`.

## 2. Symptom → cause → action

| Symptom | Check | Cause | Action |
|---|---|---|---|
| Signer got no email | `NotificationDelivery` row `FAILED` with `last_error` | Mail provider refused (SES). Historic cause: sign-service using the instance role instead of the SES key (`docker-compose.prod.yml` sign-service comment) | Confirm `docker exec aramo-prod-sign printenv MAILER_PROVIDER SES_FROM_ADDRESS AWS_REGION` (never print the key values). If the cause is fixed, the sender uses **Remind** in the Sign app (`POST /v1/sign/sender/envelopes/:id/remind`, rate-limited per signer). |
| Signer got no email, row `PENDING` / `DISPATCHING` | `claimed_at` older than a few minutes | Invitation worker not running | `docker logs --since 2h aramo-prod-sign 2>&1 | grep -E 'invitation tick failed|delivered .* pending signing invitation'`. The worker retries every 60 s unless `SIGN_INVITATION_WORKER_ENABLED=0` (`apps/sign-service/src/app/signing-invitation.worker.ts`); stale claims are reclaimed. |
| No row at all for the signer | — | Sequential envelope: the next signer is invited only after the previous one signs | Expected. Show the sender the order in the Sign app. |
| Email arrived in spam / link "can't be used" | — | Link expired or envelope no longer open | Envelope `EXPIRED` (default window 30 days, `SIGN_ENVELOPE_TTL_DAYS`; expiry sweep every 5 min, `apps/sign-service/src/app/esign-expiry.worker.ts`) or `VOIDED` / `DECLINED`. The sender sends a new envelope. Expired envelopes are not reopened. |
| `SENT` long past `expires_at` | `expires_at < now()` and status still `SENT`/`IN_PROGRESS` | Expiry sweep disabled or failing | `docker logs --since 1h aramo-prod-sign 2>&1 | grep -E 'expiry tick failed|expired [0-9]+ envelope'`; `docker exec aramo-prod-sign printenv SIGN_EXPIRY_WORKER_ENABLED` (`0` disables). Escalate to engineering if failing. |
| Everyone signed, status not `COMPLETED` | last events in the ledger | Completion failed mid-way | `docker logs --since 6h aramo-prod-sign 2>&1 | grep -E "ERROR|sign_artifact_custody.completion_failed"`. Escalate with the envelope id; do not edit rows. If custody failed, see [kms-and-custody-incidents.md](kms-and-custody-incidents.md). |
| `COMPLETED`, no executed copy for a party | `GET /v1/sign/sender/envelopes/:id/executed` from the sender console | Custody upload pending, or envelope purged (`purge_state = EXECUTED` → 410 `ENVELOPE_PURGED`) | Custody: the reconcile job retries every 10 min (`custody/sign-artifact-reconcile.worker.ts`). Purged: explain retention ([purge-and-party-deletion.md](purge-and-party-deletion.md)). |
| ATS (or another application) never saw completion | `PGRO`: `SELECT event_type, attempt_count, next_attempt_at, last_error_code, published_at FROM sign."OutboxEvent" WHERE event_payload::text LIKE '%' || :'env' || '%' ORDER BY created_at;` and `SELECT status, attempt_count, last_error_code, delivered_at FROM sign."SignWebhookDelivery" WHERE envelope_id = :'env';` | Delivery retrying (`OutboxEvent` backoff, `esign-delivery.worker.ts`, every 15 s) or webhook `DEAD` | Retrying: wait for `next_attempt_at`. `DEAD`: the receiving application must pull the envelope; escalate to the integration owner. Before any purge of such an envelope, the `sign:purge-r13` alert fires ([purge-and-party-deletion.md](purge-and-party-deletion.md) §4). |
| In-app notification feed / push missing | `SELECT count(*) FROM sign."SignNotificationOutbox" WHERE processed_at IS NULL;` | The notification worker is **paused in production** (`SIGN_NOTIFICATION_WORKER_ENABLED=0`, Privacy Notice 1.1 safeguard; `docker-compose.prod.yml`) — events accumulate and are processed when re-enabled | Expected while paused. Email is unaffected. Re-enabling is a PO decision. |
| Sender cannot edit, "changed elsewhere" (412) | — | Revision conflict (ETag `{id}.{revision}`, Sign Mobile M-A3 §6) | Reload the envelope in the app and retry. |

## 3. Things not to do

- No `UPDATE`/`DELETE` on `sign.*` tables. `SignatureEvent` and the redaction ledger are append-only by
  database trigger; envelope state belongs to sign-service.
- Do not resend or void on a sender's behalf. Void is the sender's action (`POST /v1/sign/sender/envelopes/:id/void`).
- Do not restart sign-service to "unstick" one envelope; workers retry on their own interval. A restart is
  for a sign-service fault and follows [incident-response-and-rollback.md](incident-response-and-rollback.md).

## 4. Escalation record

Record in `Aramo/documents/`: envelope id, tenant id, symptom, the query outputs above (ids and statuses
only), the log lines' timestamps and event names, and the action taken.
