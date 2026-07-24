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
| `docker-compose.public.yml` | The nginx service **+ the `public-intake` service** | the `docker compose up` step below |
| `verify-csp-hashes.mjs` | CSP-hash drift gate (asserts the built inline-script hashes equal the nginx CSP allow-list) | a `RUN` step in `Dockerfile` — the image build IS the gate |
| `README.md` | This runbook | you are here |

The intake handler ships as a **second baked image**
(`ghcr.io/astreinc/aramo-public-intake`); nginx proxies `POST /intake/` to it on
the compose network (no published ports).

**BAKED CONFIG:** `nginx.conf`, the holding page, and the Astro dist are part of
the image. Changing any of them requires an image **rebuild + container
recreate** — not a live edit (the `deploy/caddy` image precedent). The only
runtime inputs are the mounted TLS certs and the staging htpasswd.

## Serving posture (G0-R3)

- `aramo.ai` + `www.aramo.ai` → public **holding page** (apex serves it; www
  301s to the apex).
- `staging.aramo.ai` → the **full Astro site** behind HTTP basic-auth.
- The PUB-6 launch flip = route the apex to the full site, drop basic-auth,
  retire `staging` — an nginx.conf change, i.e. an image rebuild.

## One-time host bring-up

1. **Provision the host** (Terraform, PR-1b `infrastructure/environments/public-site`)
   and point DNS at its static IP (the Terraform records do this).
2. **Install Docker + compose plugin** on the host.
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

```sh
cd deploy/public
sudo docker compose -f docker-compose.public.yml pull
sudo docker compose -f docker-compose.public.yml up -d
```

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

## Landed-proof assertion (run after `up`)

```sh
# apex holding page — 200 + HSTS
curl -sI https://aramo.ai | grep -E '^HTTP/|[Ss]trict-[Tt]ransport-[Ss]ecurity'
#   expect: HTTP/2 200
#           strict-transport-security: max-age=31536000

# staging — gated by basic-auth
curl -sI https://staging.aramo.ai | grep -E '^HTTP/'
#   expect: HTTP/2 401
```

If the apex returns 200 with the HSTS header and staging returns 401, the deploy
is live and correctly gated.
