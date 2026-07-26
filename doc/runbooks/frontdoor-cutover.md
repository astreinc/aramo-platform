# Front-Door cutover runbook — Caddy → nginx (ADR-0023)

The operator procedure that flips the single-box front door from Caddy to nginx +
certbot wildcard TLS. **Run from the box, inside a scheduled window.** Merging the
PR changed nothing on the box — this runbook is the cutover.

**Box-ops laws (in force throughout the window and the 7-day soak):**
- Builds run **sequentially**, joined with `&&`; verify each exit 0 before recreate.
- `docker builder prune` is the **only** permitted prune. **NEVER** `docker system
  prune` and **NEVER** `docker compose down -v` during the window or the soak —
  they would delete the named volumes (Postgres data, the cert store, and — until
  soak ends — the rollback capital).

Each step is gated on the previous. **HALT** means stop and report — never improvise.

---

## 1. Preconditions (hard gates — do not proceed until ALL hold)

- **On the Mac, PR-0 applied:** `aws iam get-user --user-name aramo-certbot-dns`
  returns 0 (the certbot principal exists). The held PR-0 Terraform apply is done.
- **Box `.env` has the certbot creds:** `CERTBOT_AWS_ACCESS_KEY_ID` +
  `CERTBOT_AWS_SECRET_ACCESS_KEY` staged (per `doc/runbooks/frontdoor-pr0-apply.md`).
- **Box `.env` has the four `NGINX_*` vars set to their box values** — the wildcard
  tenant host, the admin host, and the portal host (the exact values are documented
  in `.env.prod.example`); the cert-dir default stands (`/etc/letsencrypt/live/aramo.ai`).
- **Window scheduled**; this PR **merged and pulled on the box** (`git pull` on main).

## 2. Rollback capital FIRST (before any build)

Tag the running images with a dated rollback tag, and back up the retiring env:

```
ROLLBACK=rollback-$(date +%Y%m%d)
for svc in caddy api auth-service platform-admin; do
  docker tag "aramo/${svc}:local" "aramo/${svc}:${ROLLBACK}"
done
# Retain the retiring CADDY_* env (the rollback block in step 8 restores it):
grep -E '^CADDY_' .env > .env.caddy-backup-$(date +%Y%m%d) || true
```

## 3. Build the new images SEQUENTIALLY (own gated step — never collapsed with recreate)

```
docker build -f apps/api/Dockerfile          -t aramo/api:local          . \
 && docker build -f apps/auth-service/Dockerfile -t aramo/auth-service:local . \
 && docker build -f apps/platform-admin/Dockerfile -t aramo/platform-admin:local . \
 && docker build -f deploy/nginx/Dockerfile   -t aramo/nginx:local        .
```

Verify the command exited 0. **HALT** on any non-zero — do not proceed to recreate.

## 4. Issue the wildcard cert BEFORE the flip · **HALT gate**

With Caddy still serving (no ports needed by a one-shot certbot run):

```
set -a && source .env && set +a
docker compose --env-file /dev/null -f docker-compose.prod.yml run --rm certbot \
  certonly --dns-route53 -d '*.aramo.ai' --agree-tos -m admin@aramo.ai --non-interactive
```

**Verify the issued cert in the volume** (SAN is exactly `*.aramo.ai`, dates sane):

```
docker run --rm -v aramo-prod-letsencrypt:/etc/letsencrypt alpine/openssl \
  x509 -in /etc/letsencrypt/live/aramo.ai/fullchain.pem -noout -text \
  | grep -A1 'Subject Alternative Name'
docker run --rm -v aramo-prod-letsencrypt:/etc/letsencrypt alpine/openssl \
  x509 -in /etc/letsencrypt/live/aramo.ai/fullchain.pem -noout -dates
```

**HALT** on any mismatch (a SAN other than exactly `DNS:*.aramo.ai`, a bare apex
SAN, or nonsensical dates) — quote the `openssl` output verbatim and stop.

## 5. The flip (explicit two-step — seconds of downtime, inside the window)

```
docker stop aramo-prod-caddy
docker compose --env-file /dev/null -f docker-compose.prod.yml up -d --remove-orphans
```

Never rely on orphan handling alone to sequence the 80/443 handover — stop the old
front door first, then bring the new stack up.

## 6. Verify per host class

- **Tenant login** (astre): `https://astre.aramo.ai` → recruiter login round-trip OK.
- **Admin login:** `https://admin.aramo.ai` → platform-admin login OK.
- **Portal magic-link request:** `POST https://<portal-host>/auth/portal/request-link`
  (the portal host = `$NGINX_PORTAL_SERVER_NAME`) → 200 neutral.
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

## 8. Soak (7 days) + rollback

The Caddy container is stopped/removed and its image is retained (`:${ROLLBACK}`);
**volumes are PRESERVED** (the retiring cert store + the rollback capital). Prune
prohibitions in force (see header). Post-soak volume deletion is a **separate PO
decision**, out of this runbook.

**Rollback (verbatim procedure — if the new front door misbehaves during soak):**

```
# 1) Restore the pre-flip compose (the flip diff's parent):
git checkout 9202ce80c822f0ca4db3e2b99c758bc3bd1bc04c -- docker-compose.prod.yml
# 2) Restore the retiring CADDY_* env from the step-2 backup:
grep -E '^CADDY_' .env.caddy-backup-* >> .env   # (or hand-merge the retained block)
# 3) Stop the new front door + certbot:
docker stop aramo-prod-nginx aramo-prod-certbot
# 4) Bring the old stack back up with the tagged rollback image:
docker tag aramo/caddy:rollback-<DATE> aramo/caddy:local
set -a && source .env && set +a
docker compose --env-file /dev/null -f docker-compose.prod.yml up -d --remove-orphans
```
