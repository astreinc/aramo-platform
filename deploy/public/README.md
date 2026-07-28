# Aramo public-site — host deploy runbook (PUB-1 PR-1b)

This directory is the **deploy path** for the Aramo public marketing site until
Terraform user-data automates it (PUB-1 §3.1, defect-class 9: every artifact
here is invoked by a step below). The site ships as **one baked image**
(`ghcr.io/astreinc/aramo-public-web`) served by nginx.

## What each artifact is

| Artifact | Role | Invoked by |
| --- | --- | --- |
| `Dockerfile` | Multi-stage build: Astro dist + holding page + `nginx.conf` baked | CI (`.github/workflows/deploy-public-staging.yml`) → GHCR |
| `nginx.conf` | Hardened front-door (TLS/HSTS/CSP; :80 ACME+redirect; :443 apex holding / www redirect / staging site) | **baked into the image** |
| `holding/` | Apex holding page (`index.html` + `style.css`) | **baked into the image** |
| `docker-compose.public.yml` | The nginx service **+ the `public-intake` service** (both pin `:staging`; json-file log caps) | the `docker compose up` step below |
| `verify-csp-hashes.mjs` | CSP-hash drift gate + **attribute ratchet** (no inline `style=`/`on*=`/`javascript:` in built HTML) | a `RUN` step in `Dockerfile` — the image build IS the gate |
| `logrotate-aramo` | 30-day host log-rotation policy for the container json logs (privacy-policy retention) | copied to `/etc/logrotate.d/` during bring-up |
| `README.md` | This runbook | you are here |

The intake handler ships as a **second baked image**
(`ghcr.io/astreinc/aramo-public-intake`); nginx proxies `POST /intake/` to it on
the compose network (no published ports).

**BAKED CONFIG:** `nginx.conf`, the holding page, and the Astro dist are part of
the image. Changing any of them requires an image **rebuild + container
recreate** — not a live edit (the `deploy/caddy` image precedent). The only
runtime inputs are the mounted TLS certs and the staging htpasswd.

## Serving posture (G0-R3 + PUB-6 flip)

- `aramo.ai` → the **full Astro site**, PUBLIC (no basic-auth) — PUB-6 R-PUB6-1
  flip (was the holding page). Custom 404; the holding page is retained only as
  the 50x maintenance fallback (R-PUB6-7).
- `www.aramo.ai` → 301 to the apex (R-PUB6-2; apex is canonical everywhere).
- `staging.aramo.ai` → the **same full Astro site** behind HTTP basic-auth —
  UNCHANGED at launch and kept as the auth-gated preview **forever** (R-PUB6-1).
- One baked image serves both apex and staging; the nginx server block
  differentiates (R-PUB6-3 — tag scheme unchanged at launch).

## FRESH-BOX CHECKLIST (full rebuild, start to finish)

Run top-to-bottom on a brand-new **or rebuilt** instance (a `bundle_id` change,
blueprint change, or manual rebuild wipes the box). **DNS + the static IP survive
a rebuild** — they live in Terraform, not on the box; everything below is what
the box itself loses. **Nothing is built on the box** — images come from GHCR.

0. **SSH in.** The operator's IP is allow-listed by TF `ssh_cidr`; Lightsail
   **browser SSH** always works as a fallback if that IP is stale.
1. **Swap FIRST — MANDATORY, before any `docker pull`.** → *Step 0: swap.*
2. **`apt update && apt upgrade`**, then **install Docker + the compose plugin.**
   → *Base packages.*
3. **Runtime dirs** `/srv/aramo-public/{certbot,auth}`. → *One-time host bring-up.*
4. **Staging htpasswd.** → *One-time host bring-up.*
5. **Host `.env`** — all **7** intake vars + the manually-minted SES key. → *Intake handler.*
6. **Initial cert** — certbot **standalone, before nginx starts.** → *Initial TLS certificate.*
7. **GHCR login (under `sudo`)**, then **pull `:staging`.** → *Start the site.*
8. **`docker compose up -d`.** → *Start the site.*
9. **Install `logrotate-aramo`** → `/etc/logrotate.d/`. → *Log rotation.*
10. **Renewal cron/timer.** → *Renewal.*
11. **Landed-proof.** → *Landed-proof assertion.*

## Step 0: swap (MANDATORY, before any docker pull)

The `micro_3_0` box has **1 GB RAM**. A `docker pull`/`up` of the two images
without swap can OOM-kill mid-operation and leave a half-broken host — create
swap **first**, and persist it so it survives a reboot:

```sh
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # survive reboot
free -h   # confirm Swap: 1.0Gi
```

## Base packages

```sh
sudo apt update && sudo apt -y upgrade        # patch the base image on bring-up
sudo apt -y install docker.io docker-compose-v2 apache2-utils certbot
sudo systemctl enable --now docker
```

**Builds on the box are FORBIDDEN** — the box only ever `pull`s pre-built images
from GHCR (CI builds them). Never run `docker build` / `nx build` on the
instance; a 1 GB box can't build the site and it defeats the baked-image model.

## One-time host bring-up

1. **Provision the host** (Terraform, PR-1b `infrastructure/environments/public-site`)
   and point DNS at its static IP (the Terraform records do this).
2. **Swap + base packages** — the two sections above (do these first).
3. **Create the runtime directories** the compose mounts expect:

   ```sh
   sudo mkdir -p /srv/aramo-public/certbot /srv/aramo-public/auth
   ```

4. **Create the staging basic-auth credential** (mounted, never baked):

   ```sh
   # htpasswd from apache2-utils; `staging` is the username, you are prompted for the secret
   sudo htpasswd -c /srv/aramo-public/auth/.htpasswd staging
   ```

## Initial TLS certificate (BEFORE the first nginx start)

nginx will not serve `:443` without a real cert, and the compose publishes `:80`
— so issue the first cert with certbot **standalone** while nginx is **not**
running (standalone binds `:80` itself):

```sh
sudo certbot certonly --standalone \
  -d aramo.ai -d www.aramo.ai -d staging.aramo.ai \
  --agree-tos -m hello@aramo.ai --no-eff-email
```

This writes the cert to `/etc/letsencrypt/live/aramo.ai/` (one cert, three SANs)
— the path `nginx.conf` and the compose mount expect.

## Start the site

The compose runs under `sudo` (root), so **GHCR login must be under the same
`sudo`** — a login as the normal user leaves root unauthenticated and the pull
of the private images fails:

```sh
# GHCR PAT with read:packages; log in AS ROOT (same context the compose runs in)
echo "$GHCR_PAT" | sudo docker login ghcr.io -u <github-user> --password-stdin

cd deploy/public
sudo docker compose -f docker-compose.public.yml pull   # pulls :staging (see below)
sudo docker compose -f docker-compose.public.yml up -d
```

**Image tag:** the compose pins **`:staging`** for both images (the staging
workflow publishes `:staging` + a per-SHA tag on every build). `:latest` is
reserved for the future production-release flip — PUB-6 decides the tag scheme
at launch (D-PUB-TAG-1).

## Intake handler (PUB-5)

The `public-intake` service turns the request-a-workspace and contact forms into
SES email (the email is the record — no database). nginx proxies `POST /intake/`
on the apex + staging blocks to `public-intake:3000`; `GET /intake/healthz` is
compose-internal only.

### Environment (host `.env` next to the compose file)

Every var is passed to the container **by name** in the compose file, so each one
**must** also exist in the host `.env` — a compose line without a matching `.env`
entry silently ships an empty value.

| Variable | Example | Where it lives |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | `AKIA…` | host `.env` (from the manual key below) |
| `AWS_SECRET_ACCESS_KEY` | `…` | host `.env` — **secret**, never committed |
| `AWS_REGION` | `us-east-1` | host `.env` |
| `INTAKE_FROM_ADDRESS` | `no-reply@aramo.ai` | host `.env` |
| `INTAKE_TO_ADDRESS` | `hello@aramo.ai` | host `.env` |
| `PUBLIC_SITE_BASE_URL` | `https://aramo.ai` | host `.env` (the 303 redirect target) |
| `INTAKE_RATE_LIMIT_PER_HOUR` | `5` | host `.env` (per-IP cap) |

### Credential creation (manual — R-PUB5-3)

Terraform creates the IAM user + least-privilege SES-send policy but **not** an
access key (the secret must never enter TF state). Create it manually and copy
it into the host `.env`:

```sh
aws iam create-access-key --user-name aramo-public-intake-mailer
# → put AccessKeyId / SecretAccessKey into /srv/aramo-public/.env
```

### Baked config + CSP hashes

`nginx.conf` is **baked** — the `/intake/` proxy and the CSP live in the image, so
a change needs an image **rebuild + recreate**. Rather than `'unsafe-inline'`, the
CSP allow-lists inline content by sha256 hash on two directives: `script-src`
(the **two** Astro `client:visible` hydration bootstraps) and `style-src` (the
**one** inline `astro-island{display:contents}` reset — all authored/scoped CSS
is externalised via `astro.config` `build.inlineStylesheets:'never'`, so nothing
else is inline). Both sets are **Astro-version-coupled**, and the two script
hashes are additionally **build-platform-coupled** (the runtime minifies
differently on linux vs macOS), so `nginx.conf` carries the **linux (deploy/CI)**
hashes. `deploy/public/verify-csp-hashes.mjs` runs inside the image build and
**fails the build** on any drift for either directive. A local macOS
`node verify-csp-hashes.mjs` mismatches on `script-src` **by design** — the image
build is authoritative. RETEST after any `astro`/`@astrojs/react` upgrade.

### Landed-proof (run after `up`)

```sh
# staging is behind basic-auth; POST a contact message and confirm 303 → /thanks
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  -u staging:<password> \
  -H 'Accept: text/html' \
  -X POST https://staging.aramo.ai/intake/contact \
  --data 'name=Deploy Check&email=you@example.com&message=landed-proof'
#   expect: 303 https://aramo.ai/thanks   → and an email arrives at hello@aramo.ai

# GET /intake/ is refused (POST-only — limit_except POST { deny all; })
curl -s -o /dev/null -w '%{http_code}\n' -u staging:<password> https://staging.aramo.ai/intake/contact
#   expect: 403
```

Also confirm the **no-JS path** in a browser with JavaScript disabled: load
`https://staging.aramo.ai/contact`, submit the form → the browser posts the real
`<form>` and lands on `/thanks` (the island is enhancement only — R-PUB5-4).

## Renewal (through the running nginx, via webroot)

After the standalone bootstrap, renew **without stopping nginx** — the running
container serves `/.well-known/acme-challenge/` from the shared webroot
(`/srv/aramo-public/certbot`). Run daily (systemd timer or cron):

```sh
sudo certbot renew \
  --webroot --webroot-path /srv/aramo-public/certbot \
  --deploy-hook "docker exec aramo-public-web nginx -s reload"
```

The deploy-hook reloads nginx so the renewed cert is picked up.

## Log rotation (30-day retention)

The published **Website Privacy Policy** commits to keeping server logs for
**30 days**, then deleting them — policy, config, and practice must agree.
nginx and the intake handler log to stdout/stderr, which Docker captures as
json-file logs on the host. Install the rotation policy during bring-up:

```sh
sudo cp deploy/public/logrotate-aramo /etc/logrotate.d/aramo
sudo chown root:root /etc/logrotate.d/aramo && sudo chmod 644 /etc/logrotate.d/aramo
sudo logrotate --debug /etc/logrotate.d/aramo   # dry-run: confirm it parses
```

This rotates daily and keeps **30 days** (deleting older) via `copytruncate`
(Docker holds the log fd open). The compose `logging` caps (`max-size: 20m`,
`max-file: 7`) are a **separate, size-based** disk-fill backstop — belt and
suspenders: logrotate is the *time*-based 30-day guarantee the policy requires;
the compose caps are the hard *disk* ceiling.

## Changing the instance size (bundle)

`bundle_id` is `micro_3_0` (1 GB RAM). **Changing the bundle REBUILDS the
instance** — host state (Docker, images, certs, `.env`, swap) is **wiped**. The
**static IP + DNS survive** (they're Terraform-managed, not on the box). After a
bundle change `terraform apply`, re-run the **FRESH-BOX CHECKLIST** above from
step 0 to bring the box back.

## Landed-proof assertion (run after `up`)

```sh
# apex — 200 + HSTS, serving the full site (PUB-6 flip)
curl -sI https://aramo.ai | grep -E '^HTTP/|[Ss]trict-[Tt]ransport-[Ss]ecurity'
#   expect: HTTP/2 200
#           strict-transport-security: max-age=31536000
curl -s https://aramo.ai | grep -o 'system of record'   # expect: system of record

# staging — gated by basic-auth
curl -sI https://staging.aramo.ai | grep -E '^HTTP/'
#   expect: HTTP/2 401
```

If the apex returns 200 with the HSTS header AND serves the v2.0 hero, and
staging returns 401, the deploy is live and correctly gated.

## Launch runbook — production release (PUB-6 §3)

Launch is a **deliberate PO act**, not an automatic deploy. Because one baked
image serves both apex and staging (R-PUB6-3), there is **nothing extra to
deploy for the apex** — the flip config ships in the image, so the moment the
box runs the launch build the apex serves the full site. Sequence:

1. **Dispatch the build** off the merged `public-site` HEAD:
   `deploy-public-staging` (GitHub Actions) → publishes `:staging` + per-SHA
   tags to GHCR → wait for BUILD-GREEN.
2. **On the box** (see *Start the site* for GHCR-login-under-sudo):
   ```sh
   cd deploy/public
   sudo docker compose -f docker-compose.public.yml pull   # :staging
   sudo docker compose -f docker-compose.public.yml up -d
   ```
3. **PO GO/NO-GO — the release act.** On GO the apex is already live (step 2's
   `up -d`). Run the launch proof set:
   ```sh
   curl -s  https://aramo.ai | grep -o 'system of record'        # 200 hero
   curl -sI https://www.aramo.ai | grep -i location               # 301 → https://aramo.ai/
   curl -sI https://aramo.ai/legal/privacy                        # 200 (public)
   curl -s  https://aramo.ai/legal/privacy | grep -ci 'DRAFT'     # 0
   curl -sI https://aramo.ai/sitemap-index.xml                    # 200
   curl -sI https://aramo.ai/nope-404                             # 404 (custom page)
   curl -si -X POST https://aramo.ai/intake/contact -d '…'        # 303 → /thanks + mail lands
   ```
4. **Post-launch same-day:** submit `https://aramo.ai/sitemap-index.xml` to
   Google Search Console; file the Indeed partner application with the now-public
   `https://aramo.ai/legal/privacy`; enable the uptime checks below.

## Uptime monitoring (R-PUB6-8)

Operator task (not repo code). Configure any free-tier external monitor
(UptimeRobot, Better Stack, etc.) with two HTTP(S) checks — alerts to
**hello@aramo.ai**:

- `https://aramo.ai` — expect **200** (the public site).
- `https://staging.aramo.ai` — expect **401** (basic-auth challenge proves the
  gate is up; a 200 or 5xx here is the alert condition).

A 5xx on the apex surfaces the 50x holding fallback; the monitor still flags it.
