# Aramo Single-Box — Ops & Production-Readiness Runbook

**Single-Box Directive 3 deliverable.** Baseline: `4c885f4`. The operator's
manual for running **one Lightsail box** as Astre's live ATS: reboot survival,
backups + a **proven** restore, firewall posture, TLS renewal, secrets hygiene,
and the **§5 Cognito checklist** to run against the real pool on the box.

This is the last repo piece before the box is deployable. It builds on:
- **Directive 1** — `docker-compose.prod.yml` (Caddy front-door + D1 containers +
  persisted Postgres + Redis); see [`run-layer.md`](run-layer.md).
- **Directive 2** — `seed-astre.ts` (catalog + Astre tenant + owner).
- The **dev-fixtures scrub** (Directive 3 §F, PR #298) — lands **before** the box
  is seeded for real so the first prod DB is `catalog + Astre + owner` ONLY.

> **Box layout assumption.** The repo/artifact is at **`/opt/aramo`** on the box,
> the env file at **`/opt/aramo/.env`** (chmod 600, deploy-user-owned). Adjust
> the `Environment=ARAMO_DIR=…` lines in the systemd units if your layout differs.

---

## 0. First-time provision (the order that matters)

```bash
# 0. Box prerequisites: Docker Engine + compose plugin, the repo at /opt/aramo,
#    the real .env at /opt/aramo/.env (chmod 600), the prod images available
#    (built on the box or pulled from ECR — set ARAMO_API_IMAGE / ARAMO_AUTH_IMAGE).

# 1. Bring the stack up once to create the Postgres volume.
sudo systemctl enable --now aramo-singlebox.service        # see §A

# 2. Apply the schema, then seed Astre (catalog + Astre + owner ONLY — the
#    scrub PR makes seed-astre skip the dev fixtures). Run against the box DB.
#    (DATABASE_URL points at the prod Postgres; see db-sync notes in run-layer.md.)
npm run db:sync:local         # replays every module migration
npm run prisma:seed-astre     # catalog + Astre tenant + purush@astreinc.com (no sub)

# 3. Verify the front door, then run the §5 Cognito checklist (§G) — login links
#    the owner's real Cognito sub to the seeded no-sub owner (reconcile scenario 3).
```

**Seed once, cleanly.** The dev-fixtures scrub (§F) must be merged before step 2
so Astre's first prod DB is clean from creation — never seeded-then-scrubbed.

---

## A. Restart-on-reboot (systemd)

The stack must return automatically after a reboot or power-cycle. Two layers:
1. Each service carries **`restart: unless-stopped`** in `docker-compose.prod.yml`
   — Docker restarts a crashed container while `dockerd` runs.
2. **`aramo-singlebox.service`** brings the whole compose **project** up on boot
   (`Type=oneshot` + `RemainAfterExit=yes`; `ExecStop` runs `down` on shutdown).
   It calls **`deploy/systemd/singlebox-compose.sh`**, which sources the
   multi-line-PEM `.env` into the shell and runs compose with
   `--env-file /dev/null` (compose's env_file parser can't read multi-line PEM).

```bash
# Install
sudo cp deploy/systemd/aramo-singlebox.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aramo-singlebox.service

# Operate
systemctl status aramo-singlebox.service        # active (exited) = stack up
journalctl -u aramo-singlebox.service -f        # bring-up logs
sudo systemctl restart aramo-singlebox.service

# Reboot-survival proof (ON THE BOX)
sudo reboot
# … after boot:
systemctl status aramo-singlebox.service        # active
docker ps                                       # caddy/api/auth/postgres/redis Up
```

The launcher uses an **isolated compose project name** (`aramo-singlebox`,
override `ARAMO_COMPOSE_PROJECT`) so it never collides with any other compose
project sharing the checkout. The Caddy cert volume persists across restarts, so
a reboot does **not** re-request a Let's Encrypt cert (avoids the rate limit).

**Locally provable:** `ARAMO_DIR=$PWD ARAMO_ENV_FILE=$PWD/.env
deploy/systemd/singlebox-compose.sh up|status|down` exercises the exact
compose-bring-up logic the unit runs (verified: stack up, all containers
`unless-stopped`, smoke green). **Box-only:** the unit on the real box +
true reboot survival.

---

## B. Backups + restore (the one that actually matters)

A scheduled `pg_dump` of the box Postgres → S3, **with a proven restore path**.

### The backup job

- **`deploy/backup/pg-backup.sh`** — `pg_dump -Fc` (custom format, all schemas)
  of the prod Postgres container → local staging → **S3 PUT**.
- **`deploy/systemd/aramo-pg-backup.{service,timer}`** — daily at 03:30 UTC,
  `Persistent=true` (catches up a missed run after downtime).

```bash
# Config — the narrow S3 credential lives here, chmod 600, root-owned.
sudo install -d -m 700 /etc/aramo
sudo install -m 600 /dev/stdin /etc/aramo/backup.conf <<'EOF'
BACKUP_S3_URI=s3://astre-aramo-backups/box/pg
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=AKIA…          # the s3:PutObject-ONLY user
AWS_SECRET_ACCESS_KEY=…
EOF

# Install the timer
sudo cp deploy/systemd/aramo-pg-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now aramo-pg-backup.timer

# Verify / run on demand
systemctl list-timers aramo-pg-backup.timer
sudo systemctl start aramo-pg-backup.service      # run one now
journalctl -u aramo-pg-backup.service
aws s3 ls s3://astre-aramo-backups/box/pg/        # confirm the object landed
```

**Retention.** Local staging keeps the last `BACKUP_LOCAL_KEEP` (default 7).
**S3-side retention is a bucket lifecycle rule, not a script delete** — so the
box credential stays `PutObject`-only (no `ListBucket`/`DeleteObject`):

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket astre-aramo-backups \
  --lifecycle-configuration file://deploy/backup/s3-backup-lifecycle.json   # expire box/pg/ after 30d
```

The IAM user attached to the box: **`deploy/backup/s3-backup-iam-policy.json`**
— `s3:PutObject` on `…/box/pg/*` and nothing else (the ONE legitimate AWS
credential on the box; §E).

### ★ Restore drill — REQUIRED, not optional

A backup you haven't restored is a hope, not a backup. **`deploy/backup/pg-restore.sh`**
restores a dump (local path or `s3://…`) into a target Postgres with
`pg_restore --clean --if-exists --no-owner` (repeatable into a fresh OR
rollback target).

**Box rollback (real):**
```bash
# Stop writers, restore the latest dump into the prod Postgres, bring writers back.
deploy/backup/pg-restore.sh s3://astre-aramo-backups/box/pg/aramo-pg-<ts>.dump
# verify, then re-run the §G smoke
```

**Proven LOCALLY (this exact drill, end-to-end):**
```bash
# 1. A seeded "source" Postgres stands in for the box DB.
docker run -d --name src -e POSTGRES_USER=aramo -e POSTGRES_PASSWORD=aramo \
  -e POSTGRES_DB=aramo -p 5433:5432 postgres:17
export DATABASE_URL='postgresql://aramo:aramo@localhost:5433/aramo?schema=public'
npm run db:sync:local && npm run prisma:seed-astre

# 2. Back it up (local-only mode — S3 PUT is the box-only step).
PG_CONTAINER=src BACKUP_DIR=/tmp/drill deploy/backup/pg-backup.sh

# 3. Bring the REAL prod stack up on a fresh (empty) Postgres volume.
ARAMO_DIR=$PWD ARAMO_ENV_FILE=$PWD/.env deploy/systemd/singlebox-compose.sh up

# 4. Restore the dump INTO the running prod stack's Postgres.
PG_CONTAINER=aramo-prod-postgres deploy/backup/pg-restore.sh /tmp/drill/aramo-pg-<ts>.dump

# 5. The stack now serves on the restored data.
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost/.well-known/jwks.json   # 200
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost/v1/tenant/settings      # 401
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost/                        # 200 (SPA)
```
Result (verified): empty prod DB → after restore `scopes=85 roles=14 grants=468`
+ Astre + owner, and the stack serves (`jwks 200 / settings 401 / SPA 200`).
The data is small (fresh start) but it's Astre's live system — backups are
**non-negotiable from day one**.

---

## C. Firewall (Lightsail posture)

- **Inbound: only 80/443** (Caddy). `docker ps` shows **only Caddy** publishing
  ports; Postgres (`5432/tcp`) and Redis (`6379/tcp`) are **container-internal —
  never host-published** (confirmed in `docker-compose.prod.yml`: neither has a
  `ports:` mapping). Verify on the box:
  ```bash
  docker ps --format '{{.Names}}\t{{.Ports}}'   # only aramo-prod-caddy has 0.0.0.0:80/443
  sudo ss -ltnp | grep -E ':(5432|6379)\b' || echo "DB/Redis NOT host-exposed (correct)"
  ```
- **Lightsail firewall:** allow **TCP 80 + 443** from anywhere; **SSH (22)
  restricted** — key-only, and source-IP-limited to the operator's address where
  practical. Remove the default "SSH from anywhere" if a fixed IP is available.
- **Hardening:** SSH keys not passwords (`PasswordAuthentication no`); keep the
  box patched (`unattended-upgrades`); `.env` is `chmod 600`, deploy-user-owned.

---

## D. TLS renewal confidence

Caddy auto-provisions **and auto-renews** the Let's Encrypt cert (renews ~30 days
before expiry) when `CADDY_TLS` is an ACME email (box: `admin@aramo.ai`;
`CADDY_SITE_ADDRESS=astre.aramo.ai`). The cert/ACME state lives in the persisted
`caddy-data` volume, so renewals survive restarts.

The `/.well-known/acme-challenge/*` path stays free for the HTTP-01 challenge:
the Caddyfile matches JWKS by the **exact path** `/.well-known/jwks.json`, not
`/.well-known/*` (confirmed in `deploy/caddy/Caddyfile`).

```bash
# Check cert + renewal (ON THE BOX)
docker exec aramo-prod-caddy caddy list-certificates 2>/dev/null   # if available
journalctl -u aramo-singlebox.service | grep -i 'certificate\|acme\|renew'
docker logs aramo-prod-caddy 2>&1 | grep -i 'certificate obtained\|renew'
echo | openssl s_client -connect astre.aramo.ai:443 -servername astre.aramo.ai 2>/dev/null \
  | openssl x509 -noout -issuer -dates    # issuer=Let's Encrypt; notAfter ~90d out
```

**Box-only** (real LE needs the public domain + reachable :80 for HTTP-01).
Locally Caddy uses its internal CA (`CADDY_TLS=internal`) — same config, no public cert.

---

## E. Secrets hygiene on the box

- **`.env.prod`** is `chmod 600`, deploy-user-owned; **never committed, never in
  an image layer** (the D1 images take secrets at runtime via env, not baked).
- The **only** AWS credential on the box is the **narrowly-scoped S3-backup** one
  (§B) — `s3:PutObject` on the backup prefix, nothing broader.
- The **Anthropic key is env-fed** (PR #297) — no Secrets-Manager AWS credential
  needed for it.
```bash
sudo chmod 600 /opt/aramo/.env /etc/aramo/backup.conf
sudo chown deploy:deploy /opt/aramo/.env
docker history aramo/api:local --no-trunc | grep -i 'AUTH_\|SECRET\|KEY' && echo "LEAK" || echo "no secrets in layers"
```

---

## F. Dev-fixtures scrub (separate PR — #298)

`runIdentitySeed` gained `includeDevFixtures` (default `true` → every existing
caller unchanged); `seed-astre` passes `false`, so the box DB is
`catalog + Astre + owner` ONLY. The catalog (85 scopes / 14 roles / 468 grants)
is byte-identical regardless of the flag. **Land #298 before step 2 of §0** so
the first prod DB is clean from creation. (Detail in that PR; this runbook only
needs the ordering.)

---

## G. ★ The §5 Cognito checklist — run on the box against the REAL pool

The auth-hardening verification (D1–D6) we deferred all along is box-only: it
needs the real Cognito pool + hosted UI. Run it once after the first seed.

| # | Check | Expected |
|---|---|---|
| 1 | **Login** — open `https://astre.aramo.ai`, sign in as `purush@astreinc.com` via Cognito hosted UI | Redirects back authenticated; lands in the ATS as the tenant owner |
| 2 | **Reconcile (scenario 3 — LINKS)** — first login resolves the seeded **no-sub** owner | The real Cognito sub links to the seeded owner by IdP-verified email; **no duplicate** user; owner keeps `tenant_id` + `tenant_owner`. Verify: `SELECT count(*) FROM identity."User" WHERE email='purush@astreinc.com';` = **1**, and an `ExternalIdentity` row now exists for that user |
| 3 | **MFA** — Cognito-native users are TOTP-required (D6); federated users are IdP-MFA'd | Hosted UI enrolls/challenges TOTP before issuing the code; app needs no MFA logic |
| 4 | **Authorized surface** — owner sees tenant-owner scopes | Owner-only admin surfaces resolve; under-privileged actions 403 |
| 5 | **Logout (SSO)** — `GET /auth/<consumer>/logout` (D3) | 302 → Cognito hosted-UI `/logout`; local session cleared; re-access requires fresh login |

```bash
# Reconcile assertion (on the box, against the prod Postgres)
docker exec aramo-prod-postgres psql -U aramo -d aramo -tA -c \
  "SELECT u.email, count(ei.id) AS subs
     FROM identity.\"User\" u
     LEFT JOIN identity.\"ExternalIdentity\" ei ON ei.user_id = u.id
    WHERE u.email='purush@astreinc.com' GROUP BY u.email;"
# expect: purush@astreinc.com | 1   (single user, sub linked — not duplicated)
```

---

## H. Provability summary

| Item | Local | Box-only (honest boundary) |
|---|---|---|
| systemd compose-bring-up logic | ✅ launcher up/status/down | unit on the real box; true reboot survival |
| backup → restore drill | ✅ dump → restore → stack serves (proven) | S3 PUT with the real narrow credential |
| firewall (80/443; DB/Redis internal) | ✅ compose has no DB/Redis host ports | the actual Lightsail firewall + SSH lockdown |
| TLS renewal | config (internal CA) | real Let's Encrypt provision + auto-renew |
| dev-fixtures scrub | ✅ catalog+Astre+owner only, idempotent | — |
| §5 Cognito checklist | — | login / reconcile / MFA / authz / logout |

---

## Update / redeploy the stack

```bash
cd /opt/aramo && git pull          # or drop new image tags (ARAMO_API_IMAGE/…)
sudo systemctl restart aramo-singlebox.service
# schema change? apply migrations, then smoke (§B step 5).
```
