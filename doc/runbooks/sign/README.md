# Aramo Sign — production operations runbooks

v1.0, 2026-11-01 (PO instruction 2026-11-01: monitoring, alerts and support runbooks before the next
deployment). Every command below is taken from a script or route in this repository and cites it.
Anything not observed on the production box is marked **UNVERIFIED**; confirm it the first time it is
used and record the result in `Aramo/documents/`.

| Runbook | Use when |
|---|---|
| [monitoring-and-alerts.md](monitoring-and-alerts.md) | Installing monitoring; any alert email |
| [stuck-envelopes.md](stuck-envelopes.md) | A sender or signer reports an envelope that does not move |
| [evidence-verification-and-disputes.md](evidence-verification-and-disputes.md) | A signer disputes a signature; someone asks to verify the evidence |
| [purge-and-party-deletion.md](purge-and-party-deletion.md) | Retention purge, a per-party "Deleted" folder question, targeted purge, purge alerts |
| [privacy-requests.md](privacy-requests.md) | A privacy request (deletion, access, export, correction) arrives or is overdue |
| [kms-and-custody-incidents.md](kms-and-custody-incidents.md) | `sign:kms` / `sign:custody` alerts; sign-service will not start; S3 custody questions |
| [abuse-reports-and-personal-review.md](abuse-reports-and-personal-review.md) | Abuse reports; the Personal review queue |
| [backup-restore-test.md](backup-restore-test.md) | Monthly restore test; Sign-specific checks after a restore |
| [incident-response-and-rollback.md](incident-response-and-rollback.md) | Production is down or degraded; rolling back a release |

Release procedure: [../RELEASE-box.md](../RELEASE-box.md). Backups: [../RUNBOOK-backups.md](../RUNBOOK-backups.md).

## Conventions used in these runbooks

On the box (`/opt/aramo`, compose project `aramo-singlebox`, `docker-compose.prod.yml`):

```bash
# Read-only SQL as the migration owner, every statement in a read-only transaction.
# (Same psql form as RUNBOOK-ccp-*.md; the box host has no psql, it runs inside the postgres container.)
PGRO() { sudo docker exec -i aramo-prod-postgres sh -c 'PGOPTIONS="-c default_transaction_read_only=on" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"' sh "$@"; }
# usage: PGRO -v env=<envelope uuid> <<'SQL' … SQL     (psql variables, :'env' inside the SQL)
```

The `PGRO` form was exercised on 2026-11-01 against a local `postgres:17` container: `-v` variables reach
the heredoc SQL and a write is refused ("cannot execute … in a read-only transaction"). Not yet run on the
box.

| Container | Service | Port |
|---|---|---|
| `aramo-prod-nginx` | nginx (front door; SPAs baked in) | 80/443 published |
| `aramo-prod-api` | api | 3000 |
| `aramo-prod-auth` | auth-service | 3001 |
| `aramo-prod-platform-admin` | platform-admin (admin.aramo.ai console API) | 3002 |
| `aramo-prod-sign` | sign-service (sign.aramo.ai API) | 3003 |
| `aramo-prod-intelligence` | talent-intelligence-service | 3004 |
| `aramo-prod-talent-intake-worker` | api image, intake worker | — |
| `aramo-prod-postgres`, `aramo-prod-redis`, `aramo-prod-certbot` | infrastructure | — |

Operator surfaces: the platform console at `https://admin.aramo.ai` (platform-web) — Review queue
`/personal-review`, Pilot invites `/personal-invites`, Abuse reports `/sign-abuse-reports`
(`apps/platform-web/src/shell/nav.ts`). Every operator route needs `platform:tenant:lifecycle:manage` on a
platform session. Privacy requests have **no console page yet** (API only; see privacy-requests.md).

Never paste personal data (emails, names, document content) into tickets or alert threads; use envelope
ids, request references (`PR-…`) and tenant ids.
