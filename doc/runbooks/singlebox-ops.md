# Aramo Single-Box — Ops & Production-Readiness Runbook

**Single-Box Directive 3 deliverable.** Baseline: `4c885f4`. The operator's
manual for running **one Lightsail box** as Astre's live ATS: reboot survival,
backups + a **proven** restore, firewall posture, TLS renewal, secrets hygiene,
and the **§5 Cognito checklist** to run against the real pool on the box.

This is the last repo piece before the box is deployable. It builds on:
- **Directive 1** — `docker-compose.prod.yml` (nginx front-door + D1 containers +
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
#    Use deploy/migrate-prod.sh — it applies migrations in a postgres:17
#    container on the compose network (the box host has no psql; the same step
#    every redeploy runs) and GATES on zero-pending.
deploy/migrate-prod.sh        # apply every module migration + assert zero-pending
# Then deploy/seed-prod.sh — it (A) regenerates the host-side Prisma client in a
# node:22-bookworm container (so a migration-added column is in the client) and
# (B) runs the seed in a node container ON the compose network (the box host has
# no psql + can't resolve the 'postgres' hostname, so the bare `npm run
# prisma:seed-astre` CANNOT run here), then ASSERTS the Astre tenant landed.
deploy/seed-prod.sh           # regen client + seed (catalog + Astre + purush@astreinc.com, no sub) + assert

# 3. Verify the front door, then run the §5 Cognito checklist (§G) — login links
#    the owner's real Cognito sub to the seeded no-sub owner (reconcile scenario 3).
```

> **Amendment v1.2 (per-consumer redirect derivation) — next release.** Add
> `AUTH_PUBLIC_BASE_URL=https://astre.aramo.ai` to `/opt/aramo/.env`. auth-service
> now derives the hosted-UI callback per consumer as
> `${AUTH_PUBLIC_BASE_URL}/auth/<consumer>/callback` at both authorize and token
> exchange. The recruiter derivation is `https://astre.aramo.ai/auth/recruiter/callback`
> — identical to the currently-registered prod callback, so **no Cognito change is
> needed** for the existing recruiter flow. `AUTH_COGNITO_REDIRECT_URI` remains a
> fallback (its origin is used if `AUTH_PUBLIC_BASE_URL` is unset) but should be
> retired once the new var is in place.

> **Required at provision — Microsoft 365 "Connect" (D-INT-1).** The personal
> delegated-OAuth START path reads **two** vars from the api container; set BOTH in
> `/opt/aramo/.env` as part of first-provision (and re-confirm on any reprovision /
> fresh `.env` authoring). They are **lazily validated** — the api boots clean with
> them empty and only 500s when a recruiter clicks *Connect account*
> (`MSGRAPH_REDIRECT_URI is not configured`), so no boot crash-loop flags a miss.
> That is exactly how the original hotfix got silently dropped; this requirement
> closes the re-drop gap. Full surface + rationale: `.env.prod.example` (the
> committed enumeration) and backlog `D-INT-1` (§B1).
>
> - `MSGRAPH_REDIRECT_URI=https://astre.aramo.ai/v1/integrations/microsoft/callback`
>   — must **byte-match** a Web redirect registered on the Entra app for the
>   tenant's `client_id`. The `astre-aramo` app registration already carries this
>   exact Web redirect (backlog D-INT-1 §B1); the callback bounces
>   `redirect_uri_mismatch` if it is ever removed. START itself works without it.
> - `MSGRAPH_OAUTH_STATE_KEY` — 32 random bytes, base64url. Generate fresh per box
>   (secret-grade — see §E; never a committed default):
>   `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`. It signs only the
>   in-flight OAuth `state` (no stored data); rotating it is safe.
>
> Code refs: `apps/api/src/microsoft/microsoft-config.resolver.ts` (`redirectUri()`
> throws when empty) · `libs/microsoft-graph/src/lib/domain/oauth-state.ts`
> (`MSGRAPH_OAUTH_STATE_KEY` must decode to exactly 32 bytes). Compose passthrough
> (bare-name, api-only) is already committed in `docker-compose.prod.yml`.

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
docker ps                                       # nginx/api/auth/postgres/redis Up
```

The launcher uses an **isolated compose project name** (`aramo-singlebox`,
override `ARAMO_COMPOSE_PROJECT`) so it never collides with any other compose
project sharing the checkout. The nginx cert volume persists across restarts, so
a reboot does **not** re-request a Let's Encrypt cert (avoids the rate limit).

**Locally provable:** `ARAMO_DIR=$PWD ARAMO_ENV_FILE=$PWD/.env
deploy/systemd/singlebox-compose.sh up|status|down` exercises the exact
compose-bring-up logic the unit runs (verified: stack up, all containers
`unless-stopped`, smoke green). **Box-only:** the unit on the real box +
true reboot survival.

---

## B. Backups + restore (the one that actually matters)

A scheduled `pg_dump` of the box Postgres → S3, **with a proven restore path**.

> **Superseded by M-A8 §1 (2026-10-28; was R-15 / M-A7 §2).** The original Directive-3 job
> (`pg-backup.sh`, unencrypted `pg_dump -Fc`, a `PutObject`-only user on `astre-aramo-backups`) was run
> by hand (2 files in `/var/backups/aramo`) but never scheduled and its bucket was never created. It is
> replaced by the encrypted tooling below. Full procedure: **`doc/runbooks/RUNBOOK-backups.md`**.

### The backup job

- **`deploy/backup/aramo-backup.sh`** — `pg_dump -Fc` of `aramo` + `aramo_intelligence` (and roles,
  without password hashes) streamed through `age` to the PO's two offline-held public recipients →
  `0600` files in the `0700` root-only `/var/backups/aramo-r15/routine/<run_id>/` with `manifest.tsv` →
  single-PUT uploads to `s3://aramo-prod-db-backups-use1/routine/<run_id>/` naming SSE-KMS and the bucket
  key, checksum-verified (30-day lifecycle) → `heartbeat/<run_id>.json` (OK/FAILED, counts only). Also
  the pre-deploy backup: `--label pre-<sha>` (RELEASE-box.md STEP 2).
- **`deploy/backup/aramo-backup-prune.sh`** — local 7-day retention (`routine/` and heartbeats only;
  never `legal-hold/`, `historic/` or the pre-M-A8 plaintext locations).
- **`deploy/systemd/aramo-pg-backup.{service,timer}`** — daily at 03:30 UTC: backup, then prune;
  `OnFailure=aramo-pg-backup-failed.service` uploads a FAILED heartbeat. Enabled only at the M-A8 §4.2
  checkpoint (RUNBOOK-backups §5).
- **`deploy/backup/aramo-env-snapshot.sh`** — `age`-encrypted `.env` snapshot before any env change
  (3 kept locally, each uploaded to `historic/env/`).
- **Terraform:** its own root `infrastructure-backups/` (state key `backups/terraform.tfstate`): bucket
  with Object Lock (no default retention), KMS key with an explicit policy, lifecycle, bucket policy,
  writer + restorer users, daily freshness check (EventBridge → Lambda → SNS email). Applied from the
  Mac only.

### ★ Restore test — REQUIRED, not optional

A backup you haven't restored is a hope, not a backup. **`deploy/backup/aramo-restore-test.sh`**
(run on the Mac, which holds the age identity, with the restorer profile) verifies the manifest hashes,
restores every database into a throwaway `pgvector/pgvector:pg17` container (`--rm --network none`,
erasure roles pre-created), checks table + migration-ledger counts, removes the container with its
volumes and uploads a PASS/FAIL report to `restore-checks/`. Run it after every storage change and at
least monthly (RUNBOOK-backups §7); the freshness check alerts after 35 days without a PASS.

**Proven in CI:** the `backup-tooling` job runs `deploy/backup/aramo-backup.test.sh` (seed → encrypted
backup → restore test → negatives → uploads to a fake S3 that enforces the bucket policy → heartbeats →
`.env` snapshot → prune → historic encryption → deletion replay against a ledger fixture) and
`deploy/backup/aramo-historic-disposition.test.sh`.

**Real rollback:** restore into a NEW standalone container with `deploy/backup/pg-restore.sh`
(`*.dump.age` with `AGE_IDENTITY_FILE`), then `deploy/backup/aramo-deletion-replay.sh` must exit 0
(empty or verified replay of privacy deletions executed after the backup) before that database serves
traffic. The replay refuses the live container (RUNBOOK-backups §8).

---

## C. Firewall (Lightsail posture)

- **Inbound: only 80/443** (nginx). `docker ps` shows **only nginx** publishing
  ports; Postgres (`5432/tcp`) and Redis (`6379/tcp`) are **container-internal —
  never host-published** (confirmed in `docker-compose.prod.yml`: neither has a
  `ports:` mapping). Verify on the box:
  ```bash
  docker ps --format '{{.Names}}\t{{.Ports}}'   # only aramo-prod-nginx has 0.0.0.0:80/443
  sudo ss -ltnp | grep -E ':(5432|6379)\b' || echo "DB/Redis NOT host-exposed (correct)"
  ```
- **Lightsail firewall:** allow **TCP 80 + 443** from anywhere; **SSH (22)
  restricted** — key-only, and source-IP-limited to the operator's address where
  practical. Remove the default "SSH from anywhere" if a fixed IP is available.
- **Hardening:** SSH keys not passwords (`PasswordAuthentication no`); keep the
  box patched (`unattended-upgrades`); `.env` is `chmod 600`, deploy-user-owned.

---

## D. TLS renewal confidence

The certbot sidecar obtains **and auto-renews** the `*.aramo.ai` Let's Encrypt
wildcard cert via DNS-01/Route53 (12h renew loop; nginx reloads every 6h to pick
up a renewed cert). The cert lives in the persisted `aramo-prod-letsencrypt`
volume (certbot rw, nginx ro), so renewals survive restarts.

The `/.well-known/acme-challenge/*` path stays free for the HTTP-01 challenge:
the nginx config matches JWKS by the **exact path** `/.well-known/jwks.json`, not
`/.well-known/*` (confirmed in `deploy/nginx/templates/aramo.conf.template`).

```bash
# Check cert + renewal (ON THE BOX)
docker exec aramo-prod-nginx nginx list-certificates 2>/dev/null   # if available
journalctl -u aramo-singlebox.service | grep -i 'certificate\|acme\|renew'
docker logs aramo-prod-nginx 2>&1 | grep -i 'certificate obtained\|renew'
echo | openssl s_client -connect astre.aramo.ai:443 -servername astre.aramo.ai 2>/dev/null \
  | openssl x509 -noout -issuer -dates    # issuer=Let's Encrypt; notAfter ~90d out
```

**Box-only** (real LE needs the public domain + reachable :80 for HTTP-01).
Locally there is no public cert — mount an mkcert pair at `NGINX_CERT_DIR` (same config, laptop-trusted).

---

## E. Secrets hygiene on the box

- **`.env.prod`** is `chmod 600`, deploy-user-owned; **never committed, never in
  an image layer** (the D1 images take secrets at runtime via env, not baked).
- The **only** AWS credential on the box is the **narrowly-scoped S3-backup** one
  (§B) — R-15: `s3:PutObject` on `routine/` + `historic/` and `s3:ListBucket` on those
  prefixes (`aramo-prod-backup-writer`), nothing broader.
- The **Anthropic key is env-fed** (PR #297) — no Secrets-Manager AWS credential
  needed for it.
- **`MSGRAPH_OAUTH_STATE_KEY` is secret-grade box env material** (D-INT-1): it keys
  the AES-256-GCM envelope over the in-flight Microsoft OAuth `state`. Generate it
  **fresh per box** (`openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`) — never a
  committed/plaintext default (`.env.prod.example` ships it empty by design). It
  lives only in the `chmod 600` `/opt/aramo/.env` above; it is NOT an AWS
  Secrets-Manager secret (the per-recruiter delegated *tokens* are — those sit under
  `aramo/<env>/msgraph-delegated/*`, a different artifact). Rotating the state key is
  safe (no data is stored under it). `MSGRAPH_REDIRECT_URI` is non-secret config.
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

The migration step is **MANDATORY and ordered** — it runs AFTER `git pull` (so
the new `migration.sql` files are present) and BEFORE containers are rebuilt /
recreated (so a container never starts against a schema missing the columns its
code reads). This is the fix for the incident where Invite-S2's migration shipped
in code but was never applied — the Users list then threw "Internal error" on the
new `invite_status` column until it was applied by hand.

```bash
cd /opt/aramo && git pull --ff-only   # new code + new migration files
                                       # (or drop new image tags ARAMO_API_IMAGE/…)

# ONE-TIME (first deploy after the Core-Talent tombstone removal): the two
# deleted libs/talent migrations leave orphan rows in public._local_migrations
# that would fail the count-gate below. Reconcile ONCE first — see
# doc/runbooks/core-talent-ledger-reconciliation.md.

# >>> migration step + GATE — NEVER SKIP. <<<
# Applies pending migrations (idempotent; an in-sync DB is a no-op) and then
# asserts ZERO pending. On a failed/partial apply it exits non-zero — STOP:
# do NOT recreate containers (the old image keeps serving the old-but-consistent
# schema; recreating now would serve code against a half-migrated DB).
deploy/migrate-prod.sh

# >>> regen + seed step + ASSERT — NEVER SKIP. <<<
# (A) Regenerates the HOST-SIDE Prisma client (a migration that added a column
# leaves the committed client stale → host-side tools fail "Unknown argument
# <field>"; the api/auth images regenerate on build, so this is only the repo
# client). (B) Runs the idempotent Astre seed on the compose network (the box
# host has no psql + can't resolve 'postgres', so a bare `npm run prisma:seed-astre`
# can't run on the host). Then ASSERTS the Astre tenant + backfilled domain
# exist. On a failed regen/seed/assert it exits non-zero — STOP: do NOT recreate.
deploy/seed-prod.sh

# Only if BOTH migrate-prod.sh AND seed-prod.sh exited 0 (gates passed): rebuild
# (if building on the box) + recreate. The launcher restart triggers compose up -d.
sudo systemctl restart aramo-singlebox.service

# Smoke (§B step 5 / §G).
```

**Rules (do not break):**
- **NEVER skip the migration step.** Every redeploy runs `deploy/migrate-prod.sh`,
  even when you "think" there's no schema change — it's idempotent and cheap, and
  the alternative (a missed migration) is a prod outage.
- **NEVER recreate containers if the migration gate fails** (non-zero exit). The
  gate failing means the schema is NOT in sync with the pulled code; proceeding
  ships broken reads. Fix the migration apply first.
- **NEVER skip the regen + seed step.** Every redeploy runs `deploy/seed-prod.sh`
  after the migration gate — regen is idempotent and cheap, and a stale host-side
  client breaks the seed (and any host-side tool) the moment a migration adds a
  column. The seed itself is idempotent and post-login-safe (upserts; the owner's
  linked Cognito sub is untouched), so running it every deploy is a no-op when
  already in sync.
- **NEVER recreate containers if the seed assertion fails** (non-zero exit). It
  means the Astre tenant/domain is not confirmed in the DB — fix the regen/seed
  first.

### Adding a NEW REQUIRED env var (the 3-place checklist)

A new **required** env var (one a fail-loud config loader throws on when unset —
e.g. `loadDnsConfig` / `loadMailerConfig`) needs **THREE** things to be
deploy-safe. Miss any one and the container crash-loops on the next recreate:

1. **box `.env`** — the real value set on the box (`/opt/aramo/.env`), and
   documented in `.env.prod.example` (committed) so the next operator knows it's
   required.
2. **`docker-compose.prod.yml` service `environment:` block** — a **bare-name
   passthrough** entry (`- THE_VAR`) on the service(s) that load the config,
   **committed to the repo**. Without this, the var lives in the box shell but
   never reaches the container, so the loader sees it unset and throws.
3. **container recreated** — `sudo systemctl restart aramo-singlebox.service`
   (compose `up -d`) so the new env reaches a fresh container.

> Real incident (P2b): `DNS_PROVIDER` was added to the box `.env` (1) and the
> container was recreated (3), but the compose `environment:` block (2) was never
> updated **in the repo** — the api crash-looped `env_missing: DNS_PROVIDER`. It
> was hotfixed directly on the box's compose file, then committed back so box and
> repo agree. **Always do all three, and commit step 2.**

### How `deploy/migrate-prod.sh` works (and the manual fallback)

It runs the idempotent `tools/db-sync-local.sh` runner inside a `postgres:17`
container joined to the compose network (`aramo-singlebox_default`): the box host
has **no `psql`**, and the `postgres` service hostname only resolves **on** the
compose network. The repo is mounted so the runner can read
`libs/*/prisma/migrations/`. `DATABASE_URL` is built from the `.env` parts
(`POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB`) exactly as compose builds it
for the api/auth containers — **read without shell-sourcing so a `$` in the
password survives verbatim** (a sourced or double-quoted password loses its `$`;
that gotcha is why the manual recipe single-quotes the URL).

If `deploy/migrate-prod.sh` is unavailable, the proven manual one-liner — note the
**single-quoted** `DATABASE_URL` (the password's `$`) — is:

```bash
docker run --rm \
  --network aramo-singlebox_default \
  -v /opt/aramo:/repo -w /repo \
  -e DATABASE_URL='postgresql://aramo:<pw-with-$-single-quoted>@postgres:5432/aramo?schema=public' \
  postgres:17 \
  bash tools/db-sync-local.sh           # apply; add --status for a read-only check
```

### How `deploy/seed-prod.sh` works (and the manual fallback)

It is a **sibling** to `deploy/migrate-prod.sh` and reuses its scaffolding
(`read_env` / `build_dburl` / the `on_exit` trap / the overridable config /
the source-guard / the numeric gate). Run it **after** the migration gate, in
two stages plus an assertion:

- **Stage A — regen (no DB):** `npm run prisma:generate` inside a
  **`node:22-bookworm`** container with the repo mounted. **NON-SLIM on purpose**
  — `node:22-slim` omits `openssl`, which Prisma's generator probes (the api
  Dockerfile `apt-get`s openssl for the same reason). No `--network`, no
  `DATABASE_URL`: generate reads only the schema files. It relies on the mounted
  repo's `node_modules` (`jiti` / `.bin/prisma` / `@prisma/adapter-pg`, present
  from the box `npm ci`) — no `npm ci` needed.
- **Stage B — seed (DB, on-network):** `npm run prisma:seed-astre` inside the
  same node image joined to the compose network, with the **$-safe** `DATABASE_URL`
  (built the same way as migrate-prod.sh). The seed reads plain
  `process.env['DATABASE_URL']` and is idempotent + post-login-safe.
- **Assertion (the gate):** a read-only `psql` count (run in `postgres:17`, which
  has psql — the node image does not) confirming the Astre tenant row exists with
  its backfilled `allowed_domain`. **Numeric `== 1`** or the deploy aborts.

If `deploy/seed-prod.sh` is unavailable, the proven manual fallback — again with a
**single-quoted** `DATABASE_URL` — is the three steps it automates:

```bash
# A. regen the host-side client (no DB, NON-SLIM node for openssl)
docker run --rm \
  -v /opt/aramo:/repo -w /repo \
  node:22-bookworm \
  npm run prisma:generate

# B. run the seed on the compose network ($-safe DATABASE_URL, single-quoted)
docker run --rm \
  --network aramo-singlebox_default \
  -v /opt/aramo:/repo -w /repo \
  -e DATABASE_URL='postgresql://aramo:<pw-with-$-single-quoted>@postgres:5432/aramo?schema=public' \
  node:22-bookworm \
  npm run prisma:seed-astre

# C. assert the Astre tenant landed (psql lives in postgres:17, NOT the node image)
docker run --rm \
  --network aramo-singlebox_default \
  -e DATABASE_URL='postgresql://aramo:<pw-with-$-single-quoted>@postgres:5432/aramo?schema=public' \
  postgres:17 \
  psql 'postgresql://aramo:<pw-with-$-single-quoted>@postgres:5432/aramo' -t -A -c \
  "SELECT count(*) FROM identity.\"Tenant\" WHERE id='019000a0-0000-7000-8000-000000000001' AND allowed_domain='astreinc.com';"
  # expect exactly: 1
```
