# PUB-1a PLACEHOLDER — replaced in PR-1b by the real multi-stage build.
#
# PR-1b (PUB-1 §3.1 / PUB-0 R-PUB-3) will make this a multi-stage image: a node
# stage that runs the workspace `public-web` build, then `nginx:alpine` serving
# apps/public-web/dist behind the hardened nginx.conf (TLS/HSTS/CSP, www→apex
# redirect, ACME webroot). This minimal image exists ONLY so the ci.yml
# docker-build matrix leg { name: public-web } builds GREEN on PR-1a — PR-1a
# touches apps/public-web, which fires the `public-web` path filter, so the leg
# runs and would otherwise fail on a missing Dockerfile. NOT a deployable image.
#
# Build context is the repo root (ci.yml docker-build uses `context: .`).
FROM nginx:alpine
COPY deploy/public/index.html /usr/share/nginx/html/index.html
