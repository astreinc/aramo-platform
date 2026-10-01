# Aramo — PROD pgvector Enablement Runbook v1.0

Enable Enterprise Search **GS-2 semantic** (Talent GS-2A + Requisition GS-2B) in production by
upgrading the PROD PostgreSQL 17 runtime to a **pgvector-capable PG17 image** (same major, same data
volume), applying the two vector migrations, and only then flipping the dark flag.

> **This runbook is a PLAN. It performs NO production change by itself.** Every PROD mutation runs
> **on the box** by an operator, from the Mac/SSH session — **never from the development box**
> (CLAUDE.md: infra runs from the Mac; Terraform/`docker` against prod never from dev). There is an
> explicit **HUMAN APPROVAL GATE** (§8) immediately before the first PROD mutation.

**Authority / scope.** Runbook only — no feature code, no GS-2C, no UPDATE-trigger work. Semantic
stays **dark** until infrastructure + both migrations are verified. Flag-off is the first rollback
lever. This EXTENDS `doc/runbooks/RELEASE-box.md` v2.4 (the standard box deploy) with the
pgvector-specific delta; where this runbook and RELEASE-box overlap (land SHA, backup, migrate,
build, recreate), RELEASE-box is the procedure of record and this runbook adds the ordering + the DB
runtime swap.

---

## 1. Current-state infra recon (grounded from repo @ `origin/main`)

- **Topology.** Single box `astre.aramo.ai`; `docker-compose.prod.yml` project; 6 app containers
  (`aramo-prod-api` · `auth-service` · `platform-admin` · `esign-service` · `nginx`+certbot) + `aramo-prod-postgres` + `aramo-prod-redis`. SSH: `ssh -i ~/.ssh/astre-aramo-prod ubuntu@astre.aramo.ai`.
- **Postgres service** (`docker-compose.prod.yml` postgres): `image: pgvector/pgvector:pg17` is **already the repository desired-state** (GS-2 P1), carrying the `⚠ OPS PREREQUISITE — NOT YET ATTESTED` comment. Data on the **named volume `aramo-prod-pgdata` → `/var/lib/postgresql/data`**. No published ports (container-internal). Healthcheck `pg_isready`.
  - ⚠ **`build≠recreate`:** the *declared* image being pgvector does NOT mean the *running* `aramo-prod-postgres` container is pgvector — PROD may still be running `postgres:17`. PRE-FLIGHT establishes the **running** image.
- **DB creds / backup.** `DATABASE_URL` is **not** in the postgres container's env — `pg_dump "$DATABASE_URL"` silently writes a 0-byte file. Use `$POSTGRES_USER`/`$POSTGRES_DB` (which ARE in the container env).
- **Migration mechanism.** `deploy/migrate-prod.sh` — runs the idempotent `db:sync:local` runner inside a tooling container joined to the compose network, applies every pending `libs/*/prisma/migrations/**/migration.sql` against the `postgres` service, records each in `public._local_migrations`, and **GATES** on zero-pending before build/recreate. The two vector migrations ship inside TARGET_SHA:
  - Talent: `libs/talent-embedding/prisma/migrations/20260930120000_init_talent_embedding/migration.sql`
  - Requisition: `libs/requisition/prisma/migrations/20260930130000_gs2b_requisition_embedding/migration.sql`
  - Both begin `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;` — which is why the DB container must be pgvector-capable **first**.
- **Flag.** Code reads `EMBEDDING_PROCESSING_ENABLED` (server-side, must be exactly `"true"`; absent/false ⇒ semantic worker + reconcile are no-ops; the search semantic leg is skipped). ⛔ **GAP:** `EMBEDDING_PROCESSING_ENABLED` is **NOT yet declared** in the api service `environment:` of `docker-compose.prod.yml` (only `CI_PROCESSING_ENABLED` is). Per the env-passthrough trap, a var absent from `environment:` **never reaches the container** — so §2.PRE-1 is a hard prerequisite.
- **nginx ⊥ esign coupling.** Recreating `nginx` without `esign-service` running crash-loops nginx (`host not found in upstream "esign-service"`). This runbook recreates **only `api`** (to pick up the flag) — NOT nginx — so the coupling does not apply; do not add nginx to `SERVICES`.

---

## 2. Prerequisites (must ALL hold before PRE-FLIGHT)

- **PRE-1 (flag wiring).** TARGET_SHA must include a merged change adding to the api service `environment:` in `docker-compose.prod.yml`:
  `- EMBEDDING_PROCESSING_ENABLED=${EMBEDDING_PROCESSING_ENABLED:-false}`
  This is a **separate, out-of-this-runbook config PR** (not in GS-2A/GS-2B). Without it, step 10 cannot enable the flag. Keep the default `false` so landing it changes nothing until step 10.
- **PRE-2 (app version).** TARGET_SHA contains GS-2A (`ef426fd9`) + GS-2B (`0c1f3e1b`) — verify both are ancestors of TARGET_SHA.
- **PRE-3 (image availability).** `pgvector/pgvector:pg17` is pullable on the box (or pre-pulled), and is **PostgreSQL major 17** (same major as the running DB — this is an image swap, **not** a `pg_upgrade`).
- **PRE-4 (maintenance posture).** Enablement is backfill-bearing (first reconcile embeds all live Talents + all Requisitions). Schedule a low-traffic window; the embedding worker is rate-limited by the tenant LLM key and runs on the 300s tick.
- **PRE-5 (rollback floor).** Current running api image tag is pinned/recorded (STEP 1 of RELEASE-box) so app rollback has a floor.

---

## 3. Pre-flight checklist (read-only — establish state; change NOTHING)

Run on the box; record each result.

```bash
ssh -i ~/.ssh/astre-aramo-prod ubuntu@astre.aramo.ai
cd /opt/aramo   # the compose project dir (confirm)

# P-1  RUNNING postgres image (NOT the compose declaration) — expect to find whether it is still postgres:17.
docker inspect aramo-prod-postgres --format '{{.Config.Image}}'

# P-2  the data volume exists + is the one mounted (must be preserved).
docker inspect aramo-prod-postgres --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
docker volume inspect aramo-prod-pgdata --format '{{.Mountpoint}}'

# P-3  DB health + PG major version (must be 17).
docker exec aramo-prod-postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker exec aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "show server_version"'

# P-4  is the vector extension already present / available? (do NOT create it here)
docker exec aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT default_version FROM pg_available_extensions WHERE name='\''vector'\''"'
docker exec aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT extversion FROM pg_extension WHERE extname='\''vector'\''"'

# P-5  pending migrations BEFORE this release (baseline) — expect the two vector migrations pending once TARGET_SHA is landed.
#      (run per RELEASE-box STEP 3 dry/status form; do not apply yet)

# P-6  flag wiring present in the landed compose (PRE-1)?
grep -n 'EMBEDDING_PROCESSING_ENABLED' docker-compose.prod.yml   # must appear in the api service environment

# P-7  baseline relational row counts (for the §6 "data intact" comparison)
docker exec aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT (SELECT count(*) FROM talent_record.\"TalentRecord\"), (SELECT count(*) FROM requisition.\"Requisition\")"'
```

**Pre-flight GATE:** PG major = 17 ✓ · volume `aramo-prod-pgdata` mounted ✓ · PRE-1 flag wiring present ✓ · baseline counts recorded ✓. If any fails → **STOP** (see §7 stop conditions).

---

## 4. ⛔ HUMAN APPROVAL GATE — before ANY PROD mutation

Everything above is read-only. **STEP 1 onward mutates PROD.** Do not proceed past this line without
explicit operator approval in the deploy channel, recording: TARGET_SHA, the verified pre-migration
backup path (§5 STEP 2), the pre-flight results (§3), and the chosen maintenance window.

---

## 5. The exact ordered runbook (on the box)

> Ordering note (RELEASE-box v2.4): for a migrate-bearing release the flow is
> **backup → migrate → build → (seed if any) → recreate**. The pgvector delta inserts the **DB
> runtime swap** between backup and migrate.

**STEP 1 — Land TARGET_SHA on the box** (per RELEASE-box STEP 1): `git fetch` + checkout the authorized SHA; new migration files + the PRE-1 compose change are now on disk. Record the current api image tag as the rollback floor (PRE-5).

**STEP 2 — DB backup + restore point** (RELEASE-box STEP 2; migrate-prod.sh does NOT self-dump):
```bash
docker exec aramo-prod-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  > /opt/aramo/pre-pgvector-backup-$(date +%Y%m%d-%H%M%S).sql
ls -l /opt/aramo/pre-pgvector-backup-*.sql | tail -1          # NON-ZERO size (hundreds of KB+)
tail -1 /opt/aramo/pre-pgvector-backup-*.sql                  # "-- PostgreSQL database dump complete"
```
**GATE:** a verified, complete, non-zero backup with the completion marker MUST exist before STEP 3.

**STEP 3 — Upgrade the PostgreSQL 17 runtime to pgvector-capable PG17 (preserve the volume)** — the ONLY new DB-runtime step. Recreate just the postgres container onto the already-pinned pgvector image; the named volume is NOT touched:
```bash
# Pull first (fail before mutating if the image is unavailable):
docker pull pgvector/pgvector:pg17
# Recreate ONLY postgres, on the compose-pinned image, keeping aramo-prod-pgdata:
docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate postgres
```
⛔ **NEVER** `docker compose down -v`, `docker volume rm aramo-prod-pgdata`, or any flag that removes
volumes. This is a container swap on the same data directory, not a data migration.

**STEP 4 — Verify PostgreSQL health + data integrity BEFORE any app migration:**
```bash
docker inspect aramo-prod-postgres --format '{{.Config.Image}}'   # now pgvector/pgvector:pg17
docker exec aramo-prod-postgres sh -c 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker exec aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "show server_version"'  # still 17.x
# relational data intact — compare to P-7 baseline:
docker exec aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT (SELECT count(*) FROM talent_record.\"TalentRecord\"), (SELECT count(*) FROM requisition.\"Requisition\")"'
```
**GATE:** image = pgvector/pgvector:pg17 · PG still 17.x · counts == P-7 baseline. Mismatch → §7.

**STEP 5 — Verify the vector extension is AVAILABLE (do not create it yet; the migration does):**
```bash
docker exec aramo-prod-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT default_version FROM pg_available_extensions WHERE name='\''vector'\''"'
```
**GATE:** returns a version (e.g. `0.8.x`). Empty → the image is not pgvector-capable → **STOP** (§7),
roll the postgres container back to the prior image (§7 runtime rollback). Do NOT proceed to migrate.

**STEP 6 — Deploy the application version (GS-2A+GS-2B) with the flag OFF.** Build the governed api
image at TARGET_SHA (RELEASE-box STEP 5; `EMBEDDING_PROCESSING_ENABLED` defaults to `false`). Do NOT
recreate yet — migrate first (STEP 7–8) per the gate.

**STEP 7 — Apply the Talent vector migration** and **STEP 8 — the Requisition vector migration** via
the standard gated applier (it applies ALL pending; the two vector migrations are included):
```bash
bash deploy/migrate-prod.sh
```
`migrate-prod.sh` applies `20260930120000_init_talent_embedding` (Talent) then
`20260930130000_gs2b_requisition_embedding` (Requisition) in timestamp order and GATES on
zero-pending. **On ERROR → STOP; do NOT build/recreate on a half-migrated DB** (§7 migration-failure).
Then recreate `api` (RELEASE-box STEP 6; `SERVICES=api`, **not** nginx).

**STEP 9 — Post-migration verification** — run every query in §6. All must pass before STEP 10.

**STEP 10 — Enable semantic** (only after §6 all-green). Set `EMBEDDING_PROCESSING_ENABLED=true` in
the box `.env` (sourced into the api environment via PRE-1) and recreate **only** `api`:
```bash
# in /opt/aramo/.env (or the sourced env file): EMBEDDING_PROCESSING_ENABLED=true
docker compose -f docker-compose.prod.yml up -d --no-deps --force-recreate api
docker exec aramo-prod-api sh -c 'echo "$EMBEDDING_PROCESSING_ENABLED"'   # → true
```

**STEP 11 — Verify scheduler / reconcile / worker health:** confirm the `talent-embedding` BullMQ tick
registered (Redis configured) and no `*_worker_unregistered` warnings in `docker logs aramo-prod-api`.

**STEP 12 — Verify embeddings begin populating** (over the first few 300s ticks):
```sql
SELECT status, count(*) FROM talent_embedding."TalentEmbedding" GROUP BY status;
SELECT status, count(*) FROM requisition."RequisitionEmbedding" GROUP BY status;
-- expect pending → ready as the worker drains; failed should stay ~0 (a nonzero failed count = investigate tenant LLM key).
```

**STEP 13 — Verify `/v1/search` ordering + fail-soft** (authenticated smoke): a query that matches by
name/number returns exact→lexical first; a semantic-only query returns `semantic` hits AFTER
exact/lexical; with a tenant that has no embeddings yet, results equal GS-1 (fail-soft, no error). No
similarity number/badge is surfaced.

**STEP 14 — Verify visibility** holds through the semantic leg: Talent pool-open (tenant+site);
Requisition OR-union (company-visible OR assigned; hidden-company/unassigned absent; terminal
eligible); cross-tenant structurally absent (spot-check with two tenants).

---

## 6. Post-migration verification queries (STEP 9 — all must pass)

```sql
-- a) extension installed (not just available)
SELECT extversion FROM pg_extension WHERE extname = 'vector';                       -- 1 row, a version

-- b) both embedding tables exist
SELECT table_schema, table_name FROM information_schema.tables
 WHERE (table_schema,table_name) IN (('talent_embedding','TalentEmbedding'),('requisition','RequisitionEmbedding'));  -- 2 rows

-- c) vector columns are 1536-dim (format_type encodes the typmod)
SELECT n.nspname, c.relname, format_type(a.atttypid, a.atttypmod) AS coltype
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE a.attname='embedding'
   AND (n.nspname,c.relname) IN (('talent_embedding','TalentEmbedding'),('requisition','RequisitionEmbedding'));  -- both → vector(1536)

-- d) HNSW indexes exist
SELECT indexname FROM pg_indexes
 WHERE indexname IN ('TalentEmbedding_embedding_hnsw','RequisitionEmbedding_embedding_hnsw');  -- 2 rows

-- e) relational data intact — equals the P-7 baseline
SELECT (SELECT count(*) FROM talent_record."TalentRecord") AS talents,
       (SELECT count(*) FROM requisition."Requisition")   AS requisitions;

-- f) migrations recorded
SELECT name FROM public._local_migrations
 WHERE name LIKE '%init_talent_embedding' OR name LIKE '%gs2b_requisition_embedding';  -- 2 rows
```
Plus (API, flag still OFF at STEP 9): `/v1/search` behaves exactly as GS-1 — no `semantic` signal in
any hit; no error.

---

## 7. Rollback (three independent levers — prefer the least-destructive first)

- **Lever 1 — FLAG ROLLBACK (first resort, instant, non-destructive).** Set
  `EMBEDDING_PROCESSING_ENABLED=false`; recreate `api`. Semantic worker + reconcile stop; the search
  semantic leg is skipped; `/v1/search` reverts to GS-1 exactly. The vector tables/data remain
  (harmless, unread). **Use this for ANY post-enablement anomaly** (bad results, worker churn, LLM
  cost) — it needs no DB change.
- **Lever 2 — APP ROLLBACK.** Retag/redeploy the api image to the recorded rollback floor (PRE-5) and
  recreate `api` (RELEASE-box ROLLBACK). The vector migrations STAY applied (additive, unread by the
  old image). ⛔ Do NOT drop the vector migrations/tables on an app rollback — they are inert without
  the flag.
- **Lever 3 — MIGRATION / RUNTIME FAILURE.**
  - *Migration failed (STEP 7–8):* STOP before build/recreate (the old api keeps serving the old,
    consistent schema). Investigate; the DB is pgvector-capable so re-running `migrate-prod.sh` after a
    fix is safe (idempotent). Only if a migration left a genuinely broken partial object do you restore
    from the STEP 2 backup — do NOT blindly drop vector migrations unless the failure is specifically a
    vector-migration defect.
  - *Postgres runtime swap failed (STEP 3–5: unhealthy, or extension not available):* recreate the
    postgres container back onto the **prior image** (recorded at P-1) on the SAME volume
    (`docker compose up -d --no-deps --force-recreate postgres` after resetting the image), verify
    health + P-7 counts. If data integrity is in doubt, restore the STEP 2 backup into a healthy PG17.
    Never `down -v`.

---

## 8. Operator STOP conditions (halt + report; do not improvise)

- Running PG major ≠ 17 (this is an image swap, not a `pg_upgrade` — a major change is out of scope).
- `aramo-prod-pgdata` not the mounted volume, or any step would remove/replace a volume.
- Backup absent / 0-byte / missing completion marker.
- After STEP 3, PG unhealthy OR relational counts ≠ P-7 baseline.
- STEP 5: `vector` not in `pg_available_extensions` (image not pgvector-capable).
- `migrate-prod.sh` reports ERROR or non-zero pending after apply.
- §6 any query fails (missing extension/table/index, wrong dimension, count drift).
- PRE-1 flag wiring absent (step 10 would be a silent no-op).
- Any nginx recreate is proposed without esign-service (not needed here — reject it).

---

## 9. Report (after enablement)

Record: TARGET_SHA; running postgres image before/after; `vector` extversion; §6 results; the first
`TalentEmbedding`/`RequisitionEmbedding` status histograms (STEP 12); `/v1/search` smoke (STEP 13);
visibility spot-check (STEP 14); backup path; and the time the flag was set true. Keep the standing
note: **DEPLOY of the feature = semantic ON; this is DEPLOY=YES only when §1–§9 are green and the PO
authorizes.**
