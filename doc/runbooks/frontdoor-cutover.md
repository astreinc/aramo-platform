# Front-Door cutover runbook v2 — the RE-CUT (Caddy → nginx, ADR-0023)

The operator procedure that flips the single-box front door from Caddy to nginx +
certbot wildcard TLS. **Run from the box, inside a scheduled window.** Merging any
PR changes NOTHING on the box — this runbook is the cutover.

**Why v2 (the RE-CUT):** the 2026-07-26 window rolled back on four runtime defects
(E17 project-name collision · E18 entrypoint-bypass empty-conf · E19 unset-var
crash · E20 under-scoped rollback), all now made structurally impossible by
D-FRONTDOOR-CUTOVER-1 (compose `name:` pin + `${VAR:-default}` + entrypoint-chained
command + image-level ENV defaults + the CI boot smoke). The wildcard cert issued
in that window is **still valid** (to 2026-10-24) — this re-cut is **verify-only**
on the cert. The portal host that had no working TLS under the old front door is
covered by the wildcard and comes up on the flip (called out in step 6).

**Box-ops laws (in force throughout the window and the 7-day soak):**
- Builds run **sequentially**, joined with `&&`; verify each exit 0 before recreate.
- `docker builder prune` is the **only** permitted prune. **NEVER** `docker system
  prune` and **NEVER** `docker compose down -v` during the window or the soak —
  they would delete the named volumes (Postgres data, the cert store, and — until
  soak ends — the rollback capital).
- Every ad-hoc `docker run -v` names the volume with its real **`aramo-singlebox_`**
  project prefix (E16b) — the compose project is pinned to `aramo-singlebox`.

Each step is gated on the previous. **HALT** means stop and report — never improvise.

---

## 1. Preconditions (hard gates — do not proceed until ALL hold)

- **Cert EXISTS — verify only, no re-issuance.** A valid `*.aramo.ai` wildcard is
  already in the volume from the 2026-07-26 window. Confirm (SAN + dates) against
  its **real** volume name `aramo-singlebox_aramo-prod-letsencrypt`:
  ```
  docker run --rm -v aramo-singlebox_aramo-prod-letsencrypt:/etc/letsencrypt alpine/openssl \
    x509 -in /etc/letsencrypt/live/aramo.ai/fullchain.pem -noout -text \
    | grep -A1 'Subject Alternative Name'
  docker run --rm -v aramo-singlebox_aramo-prod-letsencrypt:/etc/letsencrypt alpine/openssl \
    x509 -in /etc/letsencrypt/live/aramo.ai/fullchain.pem -noout -dates
  ```
  **HALT** unless the SAN is exactly `DNS:*.aramo.ai` (no apex SAN) and `notAfter`
  is comfortably in the future. If the cert were ever missing/expired, issue it
  with the step-4 command **before** the flip.
- **Box `.env` staged** (already true from the last window): `CERTBOT_AWS_*`,
  the four `NGINX_*` (box values; the cert-dir default `/etc/letsencrypt/live/aramo.ai`
  stands), and `COMPOSE_PROJECT_NAME`. The four `NGINX_*` are now belt-only — the
  image and compose both default them — but keep them set to the box values.
- **This PR merged and pulled on the box** (`git pull` on main).

## 2. Rollback capital FIRST — FULL SCOPE (E20; before any build)

The 2026-07-26 rollback was under-scoped to caddy alone — but PR-3 retired the ask
endpoint the old front door mints against, so a caddy rollback also needs the
**api** image that still carries that endpoint. Preserve **all four** currently
running images, and back up the `CADDY_*` env block:

```
ROLLBACK=rollback-$(date +%Y%m%d)
# ALL FOUR running-state images — NOT caddy alone (E20):
for svc in api auth-service platform-admin caddy; do
  docker tag "aramo/${svc}:local" "aramo/${svc}:${ROLLBACK}"
done
# Back up the CADDY_* env block the rollback restores (a .window-backup file):
grep -E '^CADDY_' .env > .env.caddy.window-backup-$(date +%Y%m%d) || true
```

## 3. Build the new-stack images SEQUENTIALLY (own gated step — never collapsed with recreate)

Rebuild all four **new-stack** images. This returns `aramo/api:local` to **current
code** (it presently carries the rollback tag's content — api ran on a rollback tag
in the last window); every layer is cached, so this is fast:

```
docker build -f apps/api/Dockerfile             -t aramo/api:local             . \
 && docker build -f apps/auth-service/Dockerfile    -t aramo/auth-service:local    . \
 && docker build -f apps/platform-admin/Dockerfile  -t aramo/platform-admin:local  . \
 && docker build -f deploy/nginx/Dockerfile         -t aramo/nginx:local           .
```

Verify the command exited 0. **HALT** on any non-zero — do not proceed to recreate.

## 4. Cert — VERIFY ONLY (the HALT gate already ran in step 1)

No issuance this re-cut: step 1 proved a valid wildcard exists. **Do not** re-issue
a working cert.

**Retained for a FUTURE first-issuance only** (corrected with `--entrypoint certbot`
and the real prefixed volume name) — **not needed while a valid cert exists:**

```
# NOT NEEDED WHILE THE STEP-1 CERT IS VALID. First-issuance / disaster-recovery only:
# set -a && source .env && set +a
# docker compose --env-file /dev/null -f docker-compose.prod.yml \
#   run --rm --entrypoint certbot certbot \
#   certonly --dns-route53 -d '*.aramo.ai' --agree-tos -m admin@aramo.ai --non-interactive
# (Then re-run the step-1 SAN/date verify against aramo-singlebox_aramo-prod-letsencrypt
#  and HALT on any mismatch before the flip.)
```

## 5. The flip (explicit two-step — seconds of downtime, inside the window)

The compose project name is now pinned in-file (`name: aramo-singlebox`) — no `-p`
needed, and no directory-name collision possible (E17):

```
docker stop aramo-prod-caddy
docker compose --env-file /dev/null -f docker-compose.prod.yml up -d --remove-orphans
```

Never rely on orphan handling alone to sequence the 80/443 handover — stop the old
front door first, then bring the new stack up.

## 6. Verify battery (the seven checks + browser logins)

- **Tenant login** (astre): `https://astre.aramo.ai` → recruiter login round-trip OK.
- **Admin login:** `https://admin.aramo.ai` → platform-admin login OK.
- **Portal host — EXPECTED 200 (the finding's fix):** the portal host — the box's
  `NGINX_PORTAL_SERVER_NAME` (its `.env.prod.example` value) — now serves valid TLS
  for the **first time ever**. Under the old front door its block had no
  `force_automate` and no env hook, so the store held no cert for it; the wildcard
  covers it now. `POST https://<NGINX_PORTAL_SERVER_NAME>/auth/portal/request-link`
  → **200** neutral. (This is the E-finding's fix — a browser visit must show a
  valid padlock, no cert warning.)
- **JWKS ×3 hosts:** `GET /.well-known/jwks.json` on the tenant, admin, and portal
  hosts → 200.
- **Webhook:** `POST https://astre.aramo.ai/v1/webhooks/indeed/apply` with the secret
  unset → **503** (or its configured behavior).
- **Per-client budget spot-check:** hit a budgeted endpoint from **two distinct
  source IPs** (box-local `curl` vs an external client) — they must **not** share a
  bucket (distinct `X-Forwarded-For` → distinct budget keys).
- **Access-log X-Forwarded-For sanity:** `docker logs aramo-prod-nginx` shows the
  real client IP forwarded, not the proxy peer.

## 7. Standing release smokes (this deploy ships app code — PR-1 goes live here)

- **D-PROXY-IP-1 closure** — confirmed by step 6's per-client budget check (the two
  source IPs get distinct budgets; `trust proxy = 1` now resolves the real client).
- **R13.6** — a live `putIngestionObject` S3 smoke (the first server-side PutObject
  exercising the box S3 IAM).
- **body-parser smoke** — an ordinary authenticated JSON `POST` **and** the webhook
  path both parse correctly (the `main.ts` `bodyParser:false` + route-scoped raw
  rewiring only runs in the prod bootstrap).
- **R8** — report the cold-ingest first-tick backlog count in the deploy note.

## 8. Soak (7 days) → rollback → post-soak cleanup

The caddy container is stopped; **all four rollback images are retained**
(`aramo/{api,auth-service,platform-admin,caddy}:${ROLLBACK}`) and **volumes are
PRESERVED** (the cert store + the rollback capital). Prune prohibitions in force
(see header).

**Rollback (FULL SCOPE — if the new front door misbehaves during soak):**

```
# 1) Restore the pre-flip (caddy-era) compose — the last commit carrying the
#    caddy service was 9202ce80c822f0ca4db3e2b99c758bc3bd1bc04c:
git checkout 9202ce80c822f0ca4db3e2b99c758bc3bd1bc04c -- docker-compose.prod.yml
# 2) Restore ALL FOUR :local tags from the rollback capital (E20 — never caddy alone;
#    the caddy front door needs the api image that still carries the ask endpoint):
for svc in api auth-service platform-admin caddy; do
  docker tag "aramo/${svc}:${ROLLBACK}" "aramo/${svc}:local"
done
# 3) Restore the CADDY_* env block from the step-2 backup:
grep -E '^CADDY_' .env.caddy.window-backup-* >> .env   # (or hand-merge the retained block)
# 4) Stop the new front door + certbot, bring the old stack back up:
docker stop aramo-prod-nginx aramo-prod-certbot
set -a && source .env && set +a
docker compose --env-file /dev/null -f docker-compose.prod.yml up -d --remove-orphans
```

**Post-soak cleanup (only after 7 clean days — a PO-gated cleanup pass):**

- Remove the retired caddy volumes (e.g. `aramo-singlebox_aramo-prod-caddy-data`,
  `aramo-singlebox_aramo-prod-caddy-config` if present).
- Remove the **spare** `aramo_aramo-prod-letsencrypt` volume — the empty cert
  volume an unpinned-project-name run created before the E17 fix (verify it is not
  the live `aramo-singlebox_`-prefixed one first).
- Drop the four rollback tags (`aramo/*:${ROLLBACK}`).
- Dedupe/remove the `CADDY_*` lines from the box `.env` (they were harmless
  duplicates; no consumer remains).
- Delete the `.env.caddy.window-backup-*` and any other `.window-backup` files.
