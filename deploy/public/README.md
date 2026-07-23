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
| `docker-compose.public.yml` | The nginx service + host mounts | the `docker compose up` step below |
| `README.md` | This runbook | you are here |

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
