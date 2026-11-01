# Runbook — Incident response and rollback (production box)

v1.0, 2026-11-01. Conventions: [README.md](README.md). Release and rollback mechanics are owned by
[../RELEASE-box.md](../RELEASE-box.md) (v2.6); this page is the order of operations when something is
already wrong.

## 1. Severity

| Level | Examples | Who is told, how fast |
|---|---|---|
| SEV-1 | Front door down (`url:*` all failing), sign-service down, data integrity (`BROKEN` chain, custody `CONTENT_MISMATCH`), suspected breach or key compromise | PO immediately (phone), Lead Architect |
| SEV-2 | One product route failing, KMS/custody errors with the service up, purge or privacy execution failing, TLS < 7 days | PO same day |
| SEV-3 | Disk > 85 %, single restart, backup older than limit, abuse spike | Next working day |

## 2. First 15 minutes

1. **Acknowledge** in the alert thread (who is on it, UTC time). Open an incident note in `Aramo/documents/`
   (timeline in UTC, ids only, no personal data).
2. **Look, do not change:**
   ```bash
   ssh -i ~/.ssh/astre-aramo-prod <box>      # designated key (key custody D-2)
   cd /opt/aramo
   git log --oneline -1                      # what is deployed
   docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
   sudo cat /var/lib/aramo-monitoring/last-status.tsv
   df -h /; free -m
   docker logs --tail 80 <failing container>
   ```
3. **Decide the path:**
   - Caused by the last release (started right after STEP 6) → §3 rollback.
   - A single crashed container, no release involved → §4 restart.
   - Data integrity or security → §5; **no restarts, no rollbacks** until evidence is preserved.
   - Box unreachable (watchdog `probe-heartbeat` + every `url:*`) → Lightsail console: instance state,
     metrics; reboot from the console only with the PO. The stack comes back by itself
     (`deploy/systemd/aramo-singlebox.service`).

## 3. Rollback of a release

Owned by `RELEASE-box.md` → ROLLBACK. In short:

1. Capture `docker logs --tail 60 <container>` for each failing service.
2. Recreate the failing services from the **rollback-floor images** pinned before the build
   (`aramo/<svc>:<previous sha>` or `:rollback-<previous sha>`; list with `docker images 'aramo/*'`).
   Retag the floor image to `:local` and recreate only those services:
   ```bash
   docker tag aramo/<svc>:<previous sha> aramo/<svc>:local
   set -a && source .env && set +a
   docker compose -p aramo-singlebox -f docker-compose.prod.yml up -d --force-recreate <service>
   ```
   **nginx ⊥ sign-service:** if nginx is involved, sign-service must be up first (nginx resolves
   `sign-service` at config load).
3. **Database:** migrations are not rolled back by an image rollback. Additive migrations are compatible with
   the previous image by design (expand-before-restrict). If a migration is implicated, restoring the STEP-2
   encrypted backup is a last resort, decided by the PO, into a new standalone container with deletion replay
   first (`RUNBOOK-backups.md` §8) and the Sign purge check ([backup-restore-test.md](backup-restore-test.md) §4).
4. Verify (`RELEASE-box.md` STEP 7–9) and watch the next probe run; record the window report.

## 4. Restarting one service (no release involved)

```bash
docker logs --tail 100 aramo-prod-<name>        # capture first
set -a && source .env && set +a
docker compose -p aramo-singlebox -f docker-compose.prod.yml restart <service>
```
A `restart` keeps the same image and container (this is not a release; it does not trigger the E22 rule,
which is about rebuild/recreate). If it crash-loops again, do not loop restarts: read the first error line.
Common Sign causes: KMS key or credential ([kms-and-custody-incidents.md](kms-and-custody-incidents.md)),
database login (`SIGN_DB_USER` / `SIGN_DB_PASSWORD`, per-service login since CP-10 — `RELEASE-box.md`),
Postgres down.

Never restart `postgres` or `redis` without the PO (the volume is the production database).

## 5. Security and integrity incidents

1. Preserve: encrypted backup now (`RELEASE-box.md` STEP 2, label `incident-<date>`); keep the containers
   running unless they are actively causing harm; copy relevant logs into the incident folder (they rotate at
   50 MB per container, `x-aramo-logging`).
2. Credential exposure: rotate the affected secret (Sign-only key: [kms-and-custody-incidents.md](kms-and-custody-incidents.md) §4;
   others per `doc/runbooks/singlebox-ops.md` §E), then revoke the old one.
3. Key compromise suspicion: PO disables nothing on KMS until the Lead decides (disabling the evidence key
   stops all completions and makes sign-service refuse to boot).
4. Personal-data breach: the PO owns notification decisions and deadlines.

## 6. Close-out

Within 2 working days: timeline, cause, what changed, which alert fired (or why none did), follow-ups.
If no alert fired for a real incident, add the missing check to `deploy/monitoring/aramo-health-probe.sh` or the
watchdog in a follow-up PR.
