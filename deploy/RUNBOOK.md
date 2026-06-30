# Aramo — Box Deploy Runbook v2.0

**Status:** Canonical operational runbook
**Scope:** Planned-window deploys to the single prod box (`/opt/aramo`), build-on-box model
**Operating model:** `origin/main` = continuously integrated; production = deliberately released on
planned windows. The box is NOT expected to track every head — deploy a *known* commit in a managed
window.
**Place this file:** OneDrive `…/Aramo/locked/` (canonical) + repo `deploy/RUNBOOK.md` (working mirror).

---

## How to use

This is run by **Claude Code on the box**. For each planned window, fill in the header block, then
hand the whole thing to Claude Code. Every step is GATED — Claude Code STOPS and reports on any
failure rather than proceeding. Nothing is assumed; everything is verified.

```
═══ FILL IN BEFORE RUNNING ═══
TARGET_SHA   = <exact commit to deploy, e.g. bb1954e>   ← what main should be at
SERVICES     = <which to rebuild/recreate, e.g. api auth-service>   ← NOT caddy unless a UI/SPA
                 change requires it (the SPA is baked into the caddy image — see note in STEP 4)
RUN_MIGRATE  = <yes/no>   ← yes if this batch includes new DB migrations
RUN_SEED     = <yes/no>   ← yes if this batch needs seed backfills/assertions
NOTES        = <anything special for THIS deploy, or "none">   ← e.g. the specific proof to run
═════════════════════════════
```

---

## The procedure

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
Before any migration, **confirm a fresh DB backup exists.** `migrate-prod.sh` may take one
automatically — confirm it did. If it does NOT, take one explicitly:
```
docker exec aramo-prod-postgres sh -c 'pg_dump "$DATABASE_URL"' > /opt/aramo/pre-migration-backup-$(date +%Y%m%d-%H%M%S).sql
# verify the dump completed (non-trivial size, ends cleanly)
```
**GATE:** a verified, complete pre-migration backup must exist before STEP 3. A failed migration
with no backup is the one genuinely unrecoverable scenario. (Skip only if RUN_MIGRATE=no.)

### STEP 3 — MIGRATE (only if RUN_MIGRATE=yes)
```
bash deploy/migrate-prod.sh
```
**GATE:** applies the expected migration(s) OR reports already-applied (N==M) — **both are fine**
(a prior interrupted run may have applied them). Ends clean. On ERROR, **STOP** — do NOT build/
recreate on a half-migrated DB.

### STEP 4 — SEED (only if RUN_SEED=yes)
```
bash deploy/seed-prod.sh
```
**GATE:** passes including any post-seed assertions. On error, **STOP and report.**
Verify the data directly (read-only), e.g.:
```
docker exec aramo-prod-postgres sh -c 'psql "$DATABASE_URL" -c "SELECT name,slug,identity_provider,is_active FROM identity.\"Tenant\";"'
```
Confirm the expected backfilled values are present. If a required value is NULL, **STOP** (seed
didn't take — the feature depending on it won't work).

### STEP 5 — REBUILD the SERVICES
Builds are **slow on this 4GB box.** Run each build to completion and **explicitly verify exit 0** —
do NOT run in a foreground where a tool-timeout obscures whether the build finished. If a build
appears to "hang," it is almost certainly grinding (especially `--no-cache`), not stuck — let it
finish or run it backgrounded and poll, but DO confirm the actual exit status before STEP 6.
```
for each S in SERVICES:
  docker build --no-cache -f apps/$S/Dockerfile -t aramo/$S:local .
```
**GATE:** each exits 0 (zero TS2307 — the `^build` fix is in-tree on any recent SHA). If any fails,
**STOP** — do NOT recreate. Report the failure.

**SPA / UI note:** `ats-web` (the frontend SPA) is **baked into the caddy image** (`/srv`), not a
standalone service. So a **UI-only change requires rebuilding the caddy image** and recreating caddy.
If your deploy includes a UI change, SERVICES must include `caddy`, and you accept a caddy recreate
(safe — env/TLS config unchanged, only the baked static files change). If you did NOT intend to touch
caddy but the batch contains a UI change, **STOP and confirm scope** before rebuilding caddy.

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

### STEP 8 — VERIFY RUNNING CODE = TARGET_SHA (provenance — "healthy ≠ new code")
Container health does NOT prove the running code is current. Confirm the recreated image actually
contains TARGET_SHA's code:
- **Build-on-box model (now):** the rebuild in STEP 5 ran against the STEP-1-verified tree, so the
  primary proof is: box HEAD = TARGET_SHA (STEP 1) AND the rebuild happened after the pull AND a
  spot-check that a known new symbol/file from this batch is present in the recreated container's
  `/app/dist`. Report how you confirmed.
- **Future (registry / build-off-box era):** once the SHA-provenance marker is added (backlog,
  paired with ECR), this becomes a deterministic one-liner:
  `docker exec <svc> cat /app/VERSION` → must equal TARGET_SHA. Replace this step with that check
  when the marker lands.

**Do NOT declare success on container-health alone.**

### STEP 9 — SMOKE / PROOF (per NOTES)
```
curl -sI https://astre.aramo.ai | head -2        → still HTTP/2 200 (front door healthy)
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
4. **DB:** if a migration is implicated, the STEP-2 backup is the restore point. Restoring DB is a
   deliberate, last-resort operation — surface options to the PO, do not auto-execute.
5. **Astre was serving before STEP 6** — restoring the prior images/SHA restores it.

> **Known gap (build-on-box):** a previously *killed* `--no-cache` build can GC image layers that
> later block a clean rollback snapshot of the prior api/auth images. Until build-off-box/ECR lands,
> the reliable rollback floor is: older tagged images (if present) + the DB backup + `git checkout`
> previous SHA + rebuild. (This is one of the reasons build-off-box is backlogged.)

---

## HARD STOPS / GUARDRAILS (always)
- **NEVER** run bare `npx nx` on the box (rewrites `nx.json`, EACCES on root-owned generated files).
  Containers only.
- Do **NOT** touch Terraform / Route53 / the firewall in a routine deploy — separate deliberate ops.
- Do **NOT** touch Caddy unless a UI/SPA change requires the caddy rebuild (STEP 5 note) — and then
  only with that scope confirmed.
- Do **NOT** `git reset --hard` / `git clean` (nukes `.env` + backups). If the tree has tracked
  changes, STOP and report the specific file.
- **STOP at any failed gate** and report the exact output. Never proceed past a failure "to see if
  it works."
- Recreate **ONLY** the listed services — never postgres/redis unless NOTES explicitly says so.
- `migrate`/`seed` reporting **already-applied is FINE** (a prior interrupted run may have done
  them); only ERRORS stop you.

---

## REPORT (what Claude Code returns)
- Pre-flight HEADs (box + origin/main).
- Each gate's result.
- The DB backup confirmation (STEP 2).
- The running-code provenance confirmation (STEP 8) — how it was verified.
- The smoke/proof results (STEP 9).
- A clear verdict: **SUCCESS** (box on TARGET_SHA, services healthy, code verified, change proven,
  Astre serving) — or **STOPPED-AT-STEP-N** (with the exact failure and, if relevant, rollback state).

---

## Backlog upgrade path (not now)
- **SHA-provenance marker** — stamp the commit SHA into the image at build (`/app/VERSION`). Makes
  STEP 8 a deterministic one-liner. **Pairs with ECR/build-off-box; same trigger: second-tenant
  onboarding.** Not valuable while building on the box (use `git log -1` + clean-tree check instead).
- **ECR / build-off-box** — CI builds + publishes SHA-tagged images; box pulls instead of builds.
  Eliminates the build-on-box risks (stale-code, GC'd-rollback-layers, prod build strain). Backlog,
  second-tenant trigger.

---

*End — Aramo Box Deploy Runbook v2.0.*
