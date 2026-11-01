# Aramo — Box Deploy Runbook v2.6

**Status:** Canonical operational runbook — v2.6
**Scope:** Planned-window deploys to the single prod box (`/opt/aramo`), build-on-box model
**Operating model:** `origin/main` = continuously integrated; production = deliberately released on
planned windows. The box is NOT expected to track every head — deploy a *known* commit in a managed
window.
**Canonical home:** repo `doc/runbooks/RELEASE-box.md` (tracked — **canonical**) + OneDrive
`…/Aramo/locked/` (**mirror**).
*[v2.1 INVERSION, per PO ruling: the repo-tracked file is now the source of truth — matching the six
sibling runbooks already in `doc/runbooks/`. OneDrive is the mirror. This reverses v2.0's
declaration.]*

**Changelog v2.5 → v2.6** (2026-11-01, Sign production operations)
- **Per-service database logins (CP-10 / Sign Domain Isolation LC-4).** Every application service connects
  with its own login, never the `POSTGRES_*` owner: `docker-compose.prod.yml` builds each service's
  `DATABASE_URL` from its own pair — api and talent-intake-worker `ATS_DB_USER`/`ATS_DB_PASSWORD`
  (`aramo_api`), auth-service `AUTH_DB_*` (`aramo_auth`), sign-service `SIGN_DB_*` (`aramo_sign`),
  platform-admin `PLATFORM_DB_*` (`aramo_platform`); talent-intelligence-service uses
  `INTELLIGENCE_DATABASE_URL` (`aramo_intelligence`, own database). Each pair is a required interpolation
  (`${…:?}`): compose refuses to start a service whose pair is missing from the sourced `.env`. `POSTGRES_*`
  stays the migration / seed / backup owner only. Example names: `.env.prod.example`.
- **`migrate-prod.sh` re-runs `deploy/db-roles/aramo-domain-roles.sql`** (`apply_domain_roles`) as the owner
  after the zero-pending gate and before the Talent Intelligence step, so a table a migration just created is
  granted to the group roles before new code meets it. STEP 3's gate now includes its success line.
  (The SQL file's own header still says "Nothing in the deploy or migration tooling runs it" — stale since
  CP-10; the script is the source of truth.)
- **Container topology corrected** to the current `docker-compose.prod.yml`: the Sign service is compose
  service `sign-service`, container `aramo-prod-sign` (formerly `esign-service`); 6 governed images; 10
  containers (table under "How to use"). `talent-intake-worker` runs the api image: an api rebuild must
  recreate it too.
- **`deploy/build-images.sh` takes the full 40-hex SHA** (argument or `AUTHORIZED_SHA`): exit 2 = not a 40-hex
  SHA, 3 = `HEAD` ≠ SHA, 4 = dirty tree. It builds all 6 images `--no-cache`, stamps `GIT_REVISION`, and
  bakes the public Turnstile site key from `.env` into the nginx image.
- **STEP 4 read-back fixed:** the postgres container has no `DATABASE_URL`; queries use
  `psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"` (the same defect the STEP 2 history records).
- **STEP 7 adds** the per-service login check and the monitoring probe (`doc/runbooks/sign/monitoring-and-alerts.md`).
- **STEP 8 is now deterministic:** the image revision label written by `build-images.sh` is compared with
  TARGET_SHA for every recreated container (the "future" provenance marker already exists).
- Rollback-floor pin loop covers all 6 images.

**Changelog v2.4 → v2.5**
- **STEP 2 encrypted only (M-A8 §1.2.3–§1.2.4).** The pre-deploy backup is
  `deploy/backup/aramo-backup.sh --label pre-<sha>` (age + SSE-KMS, heartbeat); the interim plaintext
  `pg_dump > /opt/aramo-backups/pre-<sha>-backup-*.sql` path is removed, and a window without an
  encrypted backup stops before STEP 3. `.env` edits are preceded by an encrypted snapshot
  (`deploy/backup/aramo-env-snapshot.sh`), never a plaintext copy. ROLLBACK DB restores go into a new
  standalone container and pass deletion reconciliation first. Procedure: `RUNBOOK-backups.md`.

**Changelog v2.3 → v2.4**
- **nginx ⊥ esign-service HARD STARTUP COUPLING (post-mortem, `e176db48`).** The nginx image's
  baked `sign.aramo.ai` server block renders `proxy_pass http://esign-service:3003` and nginx
  resolves that upstream **at config-load** — so recreating nginx while `esign-service` is NOT a
  running container aborts nginx with `[emerg] host not found in upstream "esign-service"` and
  **crash-loops the front door** (true even when `NGINX_SIGN_SERVER_NAME` is unset — the empty
  server block still parses). **The prod app topology is 5 containers: api · auth-service ·
  platform-admin · esign-service · nginx.** `SERVICES` MUST include `esign-service` whenever it
  includes `nginx`, and `esign-service` must be built + running BEFORE nginx is recreated.
  `deploy/build-images.sh` now builds all 5 images (was 4 — the miss that enabled the incident).
  esign-service is container-internal only (never port-published; externally unreachable while
  `NGINX_SIGN_SERVER_NAME` is unset). See the HARD STOP below.

**Changelog v2.2 → v2.3**
- **BUILD precedes SEED (ordering change).** STAGE C (the requisition-lifecycle
  policy-package publish) now runs the **COMPILED** seed from the built api image,
  not host-jiti — jiti 2.6.1 cannot transform the seed's transitive
  `@aramo/requisition` NestJS + class-validator graph (legacy
  `experimentalDecorators`; the L1-A `CreateRequisitionRequestDto` first exposed
  it). `deploy/seed-prod.sh`'s STAGE C guard fails closed if the api image is
  absent. **So for any RUN_SEED=yes release the order is STEP 3 (migrate) → STEP 5
  (build) → STEP 4 (seed) → STEP 6 (recreate).** (Migrate still first; recreate
  still last — E22 intact. STAGE A/B/B2/D remain host-jiti; only STAGE C moved to
  the compiled image.)

**Changelog v2.1 → v2.2**
- **E22 guardrail (HARD STOPS):** any window that rebuilds/recreates an application container is a
  release and runs this procedure — STEP 2 and STEP 3 included — regardless of what it is called.
- **STEP 2 dump-first correction:** `migrate-prod.sh` does NOT self-dump; the pre-migration backup is
  always taken explicitly here, and its size verified (the 0-byte silent-failure caveat).

**Changelog v2.0 → v2.1**
- **Canonical-home inverted** (repo canonical / OneDrive mirror); filed as `doc/runbooks/RELEASE-box.md`
  to match the `RELEASE-<track>.md` sibling convention (`RELEASE-platform-console.md`).
- **Added STEP 0 — RELEASE ELIGIBILITY (off-box):** merge_group = gate of record; local-prepush
  roots caveat (auth-service portal-session); `override:ok-to-merge` range scan; provider-verification
  split. (Substrate audit baseline `a6ef61f`; F-P4b-1 session lessons.)
- **Deliberately NOT folded** (recorded so the omissions are conscious): per-env secret name
  enumeration (belongs to the *provisioning* path, not steady-state deploy; per-tenant Anthropic
  keys are onboarded at runtime via the admin surface — `tenant-llm-key-onboarding.md` — since
  TENANT-LLM-1 retired the platform secret) and the nginx R14 host nuance (out of v2.0's current smoke scope —
  STEP 9 smokes the tenant front door, which carries on-demand TLS).
- The on-box procedure (PRE-FLIGHT, STEP 1–9, ROLLBACK, HARD STOPS, REPORT, Backlog) is **unchanged
  from v2.0**.

---

## How to use

This is run by **Claude Code on the box** (STEP 1 onward). STEP 0 is the **operator's off-box
eligibility check** (on the Mac), performed before the window opens. For each planned window,
complete STEP 0, fill in the header block, then hand the whole thing to Claude Code. Every on-box
step is GATED — Claude Code STOPS and reports on any failure rather than proceeding. Nothing is
assumed; everything is verified.

```
═══ FILL IN BEFORE RUNNING ═══
TARGET_SHA   = <exact 40-hex commit to deploy>   ← what main should be at; build-images.sh refuses a short SHA
SERVICES     = <compose services to recreate, e.g. api talent-intake-worker auth-service>   ← NOT nginx
                 unless a UI/SPA change requires it (the SPAs are baked into the nginx image — STEP 5 note).
                 ← api ⇒ also talent-intake-worker (same image, ARAMO_API_IMAGE).
                 ← If SERVICES includes nginx, sign-service must be built AND running first (nginx resolves
                   the sign-service upstream at config-load; recreating nginx without it crash-loops the
                   front door — see HARD STOPS).
RUN_MIGRATE  = <yes/no>   ← yes if this batch includes new DB migrations
RUN_SEED     = <yes/no>   ← yes if this batch needs seed backfills/assertions
NOTES        = <anything special for THIS deploy, or "none">   ← e.g. the specific proof to run
═════════════════════════════
```

Production topology (`docker-compose.prod.yml`; verify with `docker ps` in PRE-FLIGHT):

| Compose service | Container | Image (built by `deploy/build-images.sh`) | DB login |
|---|---|---|---|
| `nginx` | `aramo-prod-nginx` | `aramo/nginx:local` (SPAs baked in) | — |
| `api` | `aramo-prod-api` | `aramo/api:local` | `ATS_DB_*` (`aramo_api`) |
| `talent-intake-worker` | `aramo-prod-talent-intake-worker` | `aramo/api:local` (same image) | `ATS_DB_*` |
| `auth-service` | `aramo-prod-auth` | `aramo/auth-service:local` | `AUTH_DB_*` (`aramo_auth`) |
| `platform-admin` | `aramo-prod-platform-admin` | `aramo/platform-admin:local` | `PLATFORM_DB_*` (`aramo_platform`) |
| `sign-service` | `aramo-prod-sign` | `aramo/sign-service:local` | `SIGN_DB_*` (`aramo_sign`) |
| `talent-intelligence-service` | `aramo-prod-intelligence` | `aramo/talent-intelligence-service:local` | `INTELLIGENCE_DB_*` (`aramo_intelligence`, own DB) |
| `postgres` | `aramo-prod-postgres` | `pgvector/pgvector:pg17` | owner `POSTGRES_*` |
| `redis` | `aramo-prod-redis` | `redis:7` | — |
| `certbot` | `aramo-prod-certbot` | `certbot/dns-route53:v3.1.0` | — |

---

## The procedure

### STEP 0 — RELEASE ELIGIBILITY (off-box — establishes TARGET_SHA is safe to ship)
> Performed by the **operator on the Mac, NOT Claude Code on the box.** v2.0 assumed a "known
> commit"; STEP 0 makes "known-**good**" explicit. It gates whether the window opens at all.

- **TARGET_SHA is CI-green on the `merge_group` lane — the gate of record.** A green *local* run is
  necessary-not-sufficient: local Docker saturation flakes the integration lane (F-P4b-1). Do not
  judge eligibility off a local run.
- **Local prepush is not authoritative for portal-session coverage:** auth-service integration is in
  `ci-integration.sh` ROOTS but **not** `prepush.ts` roots — real-portal-session tests do not run in
  local prepush. Confirm those in the `merge_group` lane, not locally.
- **Override scan (the manual operator IS the deploy gate — there is NO CI deploy stage):** scan the
  SHA range from the box's current HEAD to TARGET_SHA for any commit merged via
  **`override:ok-to-merge`** (bypasses the deployment-gate aggregator with an `Override-Justification:`).
  Any such commit merged *without* the full green gate — **clear each one individually** before it
  ships. (`contract-update-approved` appears in `doc/04-risks.md` / `doc/06-lead-review-checklist.md`
  but is **prose-only / unwired** — do not rely on it.)
- **"pact green" means BOTH providers:** `aramo-core` verifies 4 consumers (INGESTION, PROHIBITED,
  PORTAL_THIN, ATS_WEB); `auth-service-consumer` is verified by a **separate** provider
  (`aramo-auth-service`). Confirm both, not just core.

**GATE:** if TARGET_SHA is not `merge_group`-green, or an `override:ok-to-merge` commit in range is
not individually cleared, **do NOT open the window.** STEP 1 does not begin.

### PRE-FLIGHT (read-only — establish state before changing anything)
```
cd /opt/aramo
date -u +%FT%TZ
git fetch origin
git log --oneline -1                 → current box HEAD (record it)
git log --oneline -1 origin/main     → where main is
git status --short                   → MUST be clean of TRACKED changes.
```
**GATE:** if ANY *tracked* file shows `M/A/D`, **STOP and report.** A dirty tree silently blocks
`--ff-only` pulls — this is the #1 cause of "deployed but ran stale code." Do NOT force past it;
surface the specific file for a decision. (Untracked `.ROLLBACK`/`.sql` backup files are expected —
ignore those; only tracked changes block.)

### STEP 1 — Land TARGET_SHA
```
git checkout main && git pull --ff-only
git log --oneline -1
```
**GATE:** HEAD MUST equal `TARGET_SHA`. If not (pull failed, behind, wrong commit), **STOP and
report.** Do NOT proceed on the wrong code.

### STEP 2 — DB BACKUP (precondition for migrate)
Before any migration, **take a fresh DB backup here — `migrate-prod.sh` does NOT take one.**

**M-A8 §1.2.3 (encrypted only):** use the encrypted backup script. It dumps every database
(`aramo`, `aramo_intelligence`) plus roles, encrypts with `age` before anything touches the disk,
writes `0600` files in a `0700` root-only directory with a manifest, uploads to the encrypted bucket
with SSE-KMS named explicitly, and writes a heartbeat (`doc/runbooks/RUNBOOK-backups.md` §6):
```
cd /opt/aramo
sudo sh -c 'set -a; . /etc/aramo/backup.conf; set +a; deploy/backup/aramo-backup.sh --label "pre-'"${TARGET_SHA:0:8}"'"'
# stdout: the run directory; stderr: one line per database with bytes / tables / ledger rows
```
**GATE:** exit 0 and a non-zero byte count for every database. The script fails closed on a failed or
empty dump, a missing database, an unsafe directory, a recipients file holding a private key, a missing
KMS key id or an upload whose checksum does not match. Record the printed `run_id` in the window report.

**No plaintext dump.** The deploy procedure no longer writes `pre-<sha>-backup-*.sql` (or any raw
`pg_dump` output) anywhere. If the encrypted backup cannot run (box enablement, M-A8 §4.2, not done
yet, or the script fails), **STOP**: the window does not proceed to STEP 3 without an encrypted backup.

**`.env` changes:** before editing `/opt/aramo/.env` in any window, take an encrypted snapshot, never a
plaintext copy (`cp .env …` is retired):
```
sudo sh -c 'set -a; . /etc/aramo/backup.conf; set +a; deploy/backup/aramo-env-snapshot.sh --label "pre-'"${TARGET_SHA:0:8}"'"'
# → /var/backups/aramo-r15/env/env-pre-<sha>.age (0600; 3 newest kept) + s3://…/historic/env/
```

**GATE:** a verified, complete pre-migration backup must exist before STEP 3. A failed migration
with no backup is the one genuinely unrecoverable scenario. (Skip only if RUN_MIGRATE=no.)
> **Defect history:** the `pg_dump "$DATABASE_URL"` form silently produced a 0-byte file in
> the 2026-09-02 window (DATABASE_URL absent from the container env → fell back to role
> `root` → failed). The script uses `-U "$POSTGRES_USER"` inside the container, never `DATABASE_URL`.
> **History (G-1 / M-A8 recon, 2026-10-28):** 58 plaintext dumps, 3 non-dump `.sql` files and 37
> `.env` copies had accumulated on the box, 56 of the dumps group- or world-readable, with no expiry.
> Hence the encrypted script above; the historic files each get one disposition under
> RUNBOOK-backups.md §10.

### STEP 3 — MIGRATE (only if RUN_MIGRATE=yes)
```
bash deploy/migrate-prod.sh
```
**GATE (pending-set, orphan-immune):** applies the expected migration(s) OR reports them
already-applied — **both are fine** (a prior interrupted run may have applied them). The gate
passes iff **zero on-disk migrations remain unapplied** (`db:sync:local pending — 0 …`) **and** the
per-domain grants converge: `[migrate] OK — per-domain role grants converged (postcondition passed).`
(`apply_domain_roles` re-runs `deploy/db-roles/aramo-domain-roles.sql`, which also re-checks that no ATS
role can touch a `sign` table and that the Sign role has full privilege on every one), followed by the
Talent Intelligence gate and `[migrate] Safe to build + recreate containers.` It does
NOT compare recorded-vs-on-disk counts, so an orphan ledger row (a migration deleted from disk but
still recorded — e.g. a retired net-zero pair) can never false-FATAL the deploy; only a genuinely
unapplied on-disk migration blocks. On ERROR, **STOP** — do NOT build/recreate on a half-migrated DB.

**Bounded apply — `--until` (expand-before-restrict releases).** When a release carries a
*restrict* migration (`SET NOT NULL`, a new uniqueness constraint, a trigger) that may only be
applied AFTER the upgraded writers are the running image, the migrate step is split in two:
```
bash deploy/migrate-prod.sh --until <migration-dir-name>   # Release A: expand + backfill ONLY
```
The name is the exact migration directory name (e.g. `--until 20261015000001_ic1_user_tenant_owner_backfill`).
The runner resolves it against the ordered on-disk manifest — exactly one match, or it refuses with
nothing applied — applies every pending migration at-or-before that position, and verifies against
the ledger that nothing beyond it was applied. The gate for a bounded run passes iff
`db:sync:local pending-before-stop — 0 …`; the `deferred — N` migrations stay pending **on purpose**.
Continue with STEP 5–8 and the release's verification queries, then apply the remainder:
```
bash deploy/migrate-prod.sh                                 # Release B: the deferred restrict files
```
(or a later `--until` to bound Release B too). A plain run's behaviour is unchanged. Precedent:
IC-1 (PR #937), Lead Architect ruling 2026-10-14 — the two-release sequence is MANDATORY there.

### STEP 4 — SEED (only if RUN_SEED=yes)
> ⚠ **ORDER (v2.3):** STAGE C runs the policy seed from the **built api image**, so
> **STEP 5 (BUILD) MUST complete before this step.** Run order for a RUN_SEED=yes
> release: STEP 3 (migrate) → **STEP 5 (build)** → **STEP 4 (seed)** → STEP 6
> (recreate). If the api image is absent, STAGE C fails closed with a clear message.
```
bash deploy/seed-prod.sh
```
**GATE:** passes including any post-seed assertions. On error, **STOP and report.**
Verify the data directly (read-only), e.g.:
```
docker exec aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name,slug,identity_provider,is_active FROM identity.\"Tenant\";"'
```
Confirm the expected backfilled values are present. If a required value is NULL, **STOP** (seed
didn't take — the feature depending on it won't work).

### STEP 5 — REBUILD the SERVICES
Builds are **slow on this 4GB box.** Run each build to completion and **explicitly verify exit 0** —
do NOT run in a foreground where a tool-timeout obscures whether the build finished. If a build
appears to "hang," it is almost certainly grinding (especially `--no-cache`), not stuck — let it
finish or run it backgrounded and poll, but DO confirm the actual exit status before STEP 6.
```
# T2-F1-H2: the governed build guard resolves the repo root, validates the
# authorized SHA against a CLEAN checkout, and stamps every image with
# --build-arg GIT_REVISION (an unstamped governed image crash-loops at api boot).
# The SHA argument is REQUIRED and must be the full 40-hex commit:
#   exit 2 = missing / not 40-hex, exit 3 = HEAD != SHA, exit 4 = dirty tree.
# Builds 6 images, all --no-cache: api, auth-service, platform-admin, sign-service,
# talent-intelligence-service, nginx (SERVICES only limits what STEP 6 recreates).
AUTHORIZED_SHA="$(git rev-parse HEAD)"   # after STEP 1 proved HEAD = TARGET_SHA
deploy/build-images.sh "$AUTHORIZED_SHA"
# last line on success: [build] OK — 6 images stamped <sha> from /opt/aramo
```
**PIN THE ROLLBACK FLOOR FIRST (before a `--no-cache` build):** `build-images.sh` tags images
only `:local`, so a `--no-cache` rebuild overwrites the `:local` tag of the currently-running
images and a killed build can GC their layers — destroying the rollback floor (STEP 11/ROLLBACK
would fall back to a weeks-old tag). Before building, pin the running images to the CURRENT box
SHA so they survive the rebuild:
```
CURRENT_SHA=$(git rev-parse --short HEAD)   # run BEFORE STEP 1's checkout, or use the pre-flight HEAD
for svc in api auth-service platform-admin sign-service talent-intelligence-service nginx; do
  docker tag "aramo/$svc:local" "aramo/$svc:$CURRENT_SHA" 2>/dev/null || true
done
docker images 'aramo/*' | grep "$CURRENT_SHA"   # confirm the prior images are now SHA-pinned
```
**GATE:** each build exits 0 (zero TS2307 — the `^build` fix is in-tree on any recent SHA). If any
fails, **STOP** — do NOT recreate. Report the failure.

**SPA / UI note:** `ats-web` (the frontend SPA) is **baked into the nginx image** (`/srv`), not a
standalone service. So a **UI-only change requires rebuilding the nginx image** and recreating nginx.
If your deploy includes a UI change, SERVICES must include `nginx`, and you accept a nginx recreate
(safe — env/TLS config unchanged, only the baked static files change). If you did NOT intend to touch
nginx but the batch contains a UI change, **STOP and confirm scope** before rebuilding nginx.

### STEP 6 — RECREATE the rebuilt SERVICES (only those listed — NOT postgres/redis)
```
set -a && source .env && set +a
docker compose -p aramo-singlebox -f docker-compose.prod.yml up -d --force-recreate <SERVICES>
```

### STEP 7 — VERIFY HEALTHY
```
sleep 15
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E '<SERVICES pattern>'
```
**GATE:** each recreated service is `Up (healthy)`. If any is `Restarting`/`unhealthy`/bouncing
`Up X seconds`, **STOP**, capture `docker logs --tail 40 <container>`, and consider ROLLBACK (below).
(`aramo-prod-talent-intake-worker` reports `unhealthy` by design — it inherits the api image's TCP
healthcheck but serves no port; for it the gate is `Up` without restarts.)

Per-service logins in use (read-only; one row per login, no secrets printed):
```
docker exec aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT usename, count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1 ORDER BY 1;"'
```
Expect `aramo_api`, `aramo_auth`, `aramo_platform`, `aramo_sign` (plus the owner for this query). A service
connecting as the owner, or a missing login, is a STOP: the `.env` pair or the role grant is wrong.

Monitoring (once installed, `doc/runbooks/sign/monitoring-and-alerts.md`): run the probe once and confirm no
FAIL rows — `sudo sh -c 'set -a; . /etc/aramo/monitoring.conf; set +a; deploy/monitoring/aramo-health-probe.sh --dry-run'`.
Recreated containers have new ids, so the probe does not report the release as restarts.

### STEP 8 — VERIFY RUNNING CODE = TARGET_SHA (provenance — "healthy ≠ new code")
Container health does NOT prove the running code is current. Every governed image carries the SHA it
was built from (`deploy/build-images.sh` passes `GIT_REVISION`; each `apps/<service>/Dockerfile` and
`deploy/nginx/Dockerfile` set the label `org.opencontainers.image.revision`, and the five Node images also
set `ARAMO_RELEASE_REVISION`). Check every recreated container:
```
for c in aramo-prod-api aramo-prod-talent-intake-worker aramo-prod-auth aramo-prod-platform-admin \
         aramo-prod-sign aramo-prod-intelligence aramo-prod-nginx; do
  printf '%-34s %s\n' "$c" "$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$c")"
done
```
**GATE:** each container in SERVICES shows TARGET_SHA (40-hex). `unknown` = an image not built by
`build-images.sh`; another SHA = not recreated. Also spot-check one symbol/file this batch added inside
the container's `/app/dist`, and report how you confirmed.

**Do NOT declare success on container-health alone.**

### STEP 9 — SMOKE / PROOF (per NOTES)
```
curl -sI https://astre.aramo.ai | head -2        → HTTP 200 (front door healthy; the front
                                                    door may answer HTTP/1.1 or HTTP/2 — the
                                                    health signal is the 200, not the version)
```
Plus the deploy-specific proof from NOTES — verify the thing this batch actually changed (a new
endpoint, a routing change, a UI element). Prove the *change*, not just that the app is up.

---

## ROLLBACK (if STEP 7 shows recreated services crash-looping and they won't recover)

1. **Capture first:** `docker logs --tail 60 <container>` — record why it's failing.
2. **Restore prior images if available:** the previous working images may still be tagged
   (`docker images aramo/*`). Recreate from the prior tag to restore service.
3. **If prior images are gone** (e.g. GC'd after a `--no-cache` build): the fallback is
   `git checkout <previous known-good SHA>` + rebuild + recreate — slower, but restores service.
4. **DB:** if a migration is implicated, the STEP-2 encrypted backup (`routine/<run_id>`) is the
   restore point. Restoring DB is a deliberate, last-resort operation — surface options to the PO, do
   not auto-execute. A restore goes into a new standalone container and passes deletion
   reconciliation before it serves traffic (RUNBOOK-backups.md §8).
5. **Astre was serving before STEP 6** — restoring the prior images/SHA restores it.
6. **S2 write-guard triggers (S2 release onward):** these live in the DATABASE — an image
   rollback does NOT remove them. If normal talent writes fail with an `s2_guard_*` / trigger error,
   follow `doc/runbooks/talent-rtbf-erasure.md` → "S2 write-guard triggers — break-glass recovery"
   (level A disables only the 45 guards; restore re-applies the idempotent S2 migration).

> **Known gap (build-on-box):** a previously *killed* `--no-cache` build can GC image layers that
> later block a clean rollback snapshot of the prior api/auth images. Until build-off-box/ECR lands,
> the reliable rollback floor is: older tagged images (if present) + the DB backup + `git checkout`
> previous SHA + rebuild. (This is one of the reasons build-off-box is backlogged.)

---

## HARD STOPS / GUARDRAILS (always)
- **Any window that rebuilds or recreates an application container** (`api`, `talent-intake-worker`,
  `auth-service`, `platform-admin`, `sign-service`, `talent-intelligence-service`, or `nginx`, whose image
  bakes the SPAs) **IS a release — run THIS procedure,
  STEP 2 (backup) and STEP 3 (migrate) included — regardless of what the window is called or what
  motivated it.** An infra-labelled window (a Terraform apply, a compose edit, an image bump, a
  front-door cutover) is still a release the moment it recreates app containers. (E22: the 2026-07-28
  front-door cutover recreated the app containers without migrating; two merged migrations went
  unapplied and requisitions returned 500 until `migrate-prod.sh` was run manually.)
- **NEVER** run bare `npx nx` on the box (rewrites `nx.json`, EACCES on root-owned generated files).
  Containers only.
- Do **NOT** touch Terraform / Route53 / the firewall in a routine deploy — separate deliberate ops.
- Do **NOT** touch nginx unless a UI/SPA change requires the nginx rebuild (STEP 5 note) — and then
  only with that scope confirmed.
- Do **NOT** `git reset --hard` / `git clean` (nukes `.env` + backups). If the tree has tracked
  changes, STOP and report the specific file.
- **STOP at any failed gate** and report the exact output. Never proceed past a failure "to see if
  it works."
- Recreate **ONLY** the listed services — never postgres/redis unless NOTES explicitly says so.
- **nginx ⊥ sign-service coupling — recreating nginx REQUIRES sign-service built + running first.**
  The nginx image bakes the `sign.aramo.ai` block with `proxy_pass http://sign-service:3003`; nginx
  resolves that upstream at config-load, so a recreate with `sign-service` absent fails
  `[emerg] host not found in upstream "sign-service"` and crash-loops the front door (DOWN).
- **Per-service logins:** never point a service at the `POSTGRES_*` owner to "get it working"; a missing
  grant is fixed by re-running `deploy/migrate-prod.sh` (it converges the grants) or escalated.
  `build-images.sh` builds sign-service (6 images in all); before cutting nginx to the new image, confirm
  `aramo-prod-sign` is Up on `aramo-singlebox_default`. Recovery if it bounces: pin the new nginx to
  `aramo/nginx:<sha>`, restore `:local` from the rollback-floor image, recreate nginx (front door
  back in seconds), bring sign-service up, then cut nginx forward. (Service renamed from `esign-service`;
  the v2.4 entry above keeps the name it had then.)
- `migrate`/`seed` reporting **already-applied is FINE** (a prior interrupted run may have done
  them); only ERRORS stop you.

---

## REPORT (what Claude Code returns)
- STEP 0 eligibility result (merge_group-green + override-scan clear) — recorded by the operator.
- Pre-flight HEADs (box + origin/main).
- Each gate's result.
- The DB backup confirmation (STEP 2).
- The running-code provenance confirmation (STEP 8) — how it was verified.
- The smoke/proof results (STEP 9).
- A clear verdict: **SUCCESS** (box on TARGET_SHA, services healthy, code verified, change proven,
  Astre serving) — or **STOPPED-AT-STEP-N** (with the exact failure and, if relevant, rollback state).

---

## Backlog upgrade path (not now)
- ~~SHA-provenance marker~~ — **done** (T2-F1-H2): the image label `org.opencontainers.image.revision`
  and `ARAMO_RELEASE_REVISION`; STEP 8 uses it (v2.6).
- **ECR / build-off-box** — CI builds + publishes SHA-tagged images; box pulls instead of builds.
  Eliminates the build-on-box risks (stale-code, GC'd-rollback-layers, prod build strain). Backlog,
  second-tenant trigger.

---

*End — Aramo Box Deploy Runbook v2.6.*
