# Runbook — Backup restore test (with Aramo Sign checks)

v1.0, 2026-11-01. The backup system, its keys and the generic restore test are owned by
[../RUNBOOK-backups.md](../RUNBOOK-backups.md) (M-A8); this page adds what Aramo Sign needs on top. Run it
**monthly**, after any backup or storage change, and before enabling privacy deletion execution.

## 1. What a database backup does and does not contain for Sign

| Data | In the DB backup (`deploy/backup/aramo-backup.sh`, databases `aramo` + `aramo_intelligence` + roles) | Elsewhere |
|---|---|---|
| Envelopes, recipients, fields, ledger (`sign."SignatureEvent"`), redaction records, custody rows (version ids + hashes), privacy requests, abuse reports | yes | — |
| Executed document / certificate **bytes** in PostgreSQL before custody and until a purge NULLs them | yes | — |
| Custodied artifacts (executed PDFs, certificate, evidence snapshot) | no — only their key, version id and hash | S3 `aramo-prod-sign-artifacts-use1`, versioned, Object Lock enabled (`infrastructure-lightsail/sign-artifacts.tf`) |
| Evidence-signing key | no | KMS `alias/aramo-sign-evidence` (never exportable) |

A DB restore therefore never restores S3 objects, and S3 objects are never "rolled back" by a DB restore.

## 2. Monthly restore test (Mac, restorer profile)

Exactly `RUNBOOK-backups.md` §7:

```bash
export AWS_PROFILE=aramo-backup-restorer BACKUP_KMS_KEY_ID=<backup_kms_key_arn>
AGE_IDENTITY_FILE=~/path/aramo-backup-identity-primary.txt \
  deploy/backup/aramo-restore-test.sh s3://aramo-prod-db-backups-use1/routine/<run_id> \
  --report ~/aramo-restore-test-<run_id>.txt
```

PASS = sizes and SHA-256 match the manifest, every database restores into a throwaway
`--network none` container, and table + migration-ledger counts match. The script removes the container
and its volumes and uploads the counts-only report to `restore-checks/` (the daily freshness Lambda alerts
after 35 days without a PASS). File the local report in `Aramo/documents/`.

**Precondition (state per the 2026-10-28 deployment record, UNVERIFIED now):** the M-A8 box enablement
(`RUNBOOK-backups.md` §5: `age`, recipients, `/etc/aramo/backup.conf`, the timer, Terraform of
`infrastructure-backups/`) was not yet installed. Until it is, there is no routine run to test; the monitoring
`backup` check stays informational (`MON_BACKUP_REQUIRED=0`).

## 3. Sign checks during a drill restore (optional, quarterly)

The restore test above deletes its container. For a deeper Sign check, restore one run into a **standalone**
container on the Mac (never into `aramo-prod-postgres`), per `RUNBOOK-backups.md` §8 step 1:

```bash
docker run -d --name aramo-drill --network none -e POSTGRES_USER=aramo -e POSTGRES_DB=aramo -e POSTGRES_PASSWORD=drill pgvector/pgvector:pg17
PG_CONTAINER=aramo-drill AGE_IDENTITY_FILE=… deploy/backup/pg-restore.sh <run dir>/aramo.dump.age
```

Then, read-only against `aramo-drill` (`docker exec -i aramo-drill psql -U aramo -d aramo`):

```sql
-- the Sign schema is present and populated
SELECT count(*) AS envelopes FROM sign."SignatureEnvelope";
SELECT count(*) AS events FROM sign."SignatureEvent";
-- chain links intact for every envelope (0 rows = no link break)
WITH e AS (SELECT envelope_id, previous_event_hash,
                  lag(event_hash) OVER (PARTITION BY envelope_id ORDER BY occurred_at, id) AS prior_hash
             FROM sign."SignatureEvent")
SELECT envelope_id, count(*) AS broken_links FROM e
 WHERE previous_event_hash IS DISTINCT FROM prior_hash GROUP BY envelope_id;
-- custody coverage: executed rows not yet custodied in S3 (and not purged)
SELECT count(*) FROM sign."ExecutedDocument" WHERE custody_version_id IS NULL AND purged_at IS NULL;
```

Columns per `libs/sign/prisma/schema.prisma` (`model ExecutedDocument`). **UNVERIFIED** (not yet drilled):
`pg-restore.sh` needs the role names pre-created as the restore test does; if it fails on a
missing role, create it (`CREATE ROLE <name>`) in the drill container. Remove the drill container with
`docker rm -f -v aramo-drill` and record the counts.

## 4. A real restore (production) — Sign-specific steps

Follow `RUNBOOK-backups.md` §8 (new standalone container → deletion replay → PO decision to switch). Sign adds:

1. **Privacy deletions** after the backup: `deploy/backup/aramo-deletion-replay.sh` (exit 0 `EMPTY`, or exit 4
   `REQUIRED` → `--stage`, run the privacy execution worker against the restored DB, `--verify`).
2. **Purges executed after the backup are NOT replayed by any script (gap).** In the restored database those
   envelopes are again `QUEUED` (or not yet queued) and their executed bytes may be back in PostgreSQL while the
   S3 versions are already gone. Before the restored database serves traffic, list them by comparing with the
   current database (read-only, both sides):
   ```sql
   -- run on the CURRENT database; keep the output
   SELECT id, tenant_id, purge_executed_at FROM sign."SignatureEnvelope"
    WHERE purge_state = 'EXECUTED' AND purge_executed_at > '<backup created_at>';
   ```
   Each such envelope must be purged again in the restored database before go-live; the mechanism is a PO /
   Lead decision (no tool exists). Record the list in the window report.
3. **Custody after restore:** run the custody validator (`kms-and-custody-incidents.md` §3) for each active
   tenant; `FETCH_FAILED` on a version purged after the backup is expected and belongs to step 2.
4. **Evidence:** manifests are signed by KMS, not stored keys; nothing to restore. Spot-check one envelope's
   evidence route.
