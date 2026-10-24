| surface | inspected | not_verified | method/command |
|---------|-----------|--------------|----------------|
| apps | 10 | 0 | `git ls-tree --name-only 680907fc apps/` → api, ats-web, auth-service, home-web, platform-admin, platform-web, portal-web, sign-service, sign-web, talent-intelligence-service (was 8 at 12330b0f) |
| libs | 80 | 0 | `git ls-tree -d --name-only 680907fc libs/ \| wc -l` (was 76; +7 added: `document-templates-web`, `intelligence-contracts`, `intelligence-core`, `intelligence-integration`, `org-admin-web`, `signature-routing`, `technical-screening`; −3 retired: `identity-index`, `talent-trust`, `talent-reconcile-signal`; and 3 `git diff -M` rename pairs on project.json: `esign`→`sign`, `platform-trust`→`subscription`, `talent-reconcile`→`talent-intelligence`) |
| backend service ports | 5 | 0 | `git grep -n "PORT" 680907fc -- 'apps/{api,auth-service,platform-admin,sign-service,talent-intelligence-service}/src/main.ts'` → 3000/3001/3002/3003/3004 |
| FE SPA dev ports | 5 | 0 | `git grep -n "port:" 680907fc -- 'apps/*-web/vite.config.ts'` → 4201/4202/4203/4205/4206 (first `port:` per file; preview ports 4301–4306 excluded) |
| git-tracked project.json | 106 | 0 | `git ls-tree -r --name-only 680907fc \| grep -c 'project.json$'` (90 under apps+libs; 13 under pact/; 3 under tools/intelligence-boundary-probes/) |
| nx scope tags (apps+libs projects tagged) | 85 | 0 | per-tag `grep -l '"scope:X"' libs/*/project.json apps/*/project.json` (multi-line tag arrays included); libs ats41+cip8+shared20+boundary9+auth1+intelligence1=80; apps platform2+portal1+sign1+intelligence1=5; 5 apps untagged; +3 probe projects under tools/ (ats1, cip1, intelligence1) not counted |
| @Controller files | 137 | 0 | `git grep -l "@Controller" 680907fc -- 'apps/*.ts' 'libs/*.ts' \| wc -l` (was 101) |
| @Module files | 172 | 0 | `git grep -l "@Module" 680907fc -- 'apps/*.ts' 'libs/*.ts' \| wc -l` (was 147) |
| @Injectable files | 580 | 0 | `git grep -l "@Injectable" 680907fc -- 'apps/*.ts' 'libs/*.ts' \| wc -l` (466 at 12330b0f by the same command; the old fragment's 465 came from an on-disk grep) |
| git-tracked schema.prisma | 54 | 0 | `git ls-tree -r --name-only 680907fc \| grep -c 'schema.prisma$'` (was 53); `package.json:25` enumerates 49 |
| git-tracked migration.sql | 314 | 0 | `git ls-tree -r --name-only 680907fc \| grep -cE '/migrations/[^/]+/migration.sql$'` (was 253; 4 are TI-DB migrations under libs/intelligence-core) |
| @aramo/* path mappings | 84 | 0 | `git show 680907fc:tsconfig.base.json \| grep -c '@aramo/'`; cross-check `repo-map.projects.json:2` `aliasTotals.total: 84` (was 79) |
| OpenAPI specs | 9 | 0 | `git ls-tree --name-only 680907fc openapi/` → ats, auth, common, documents, ingestion, intelligence, platform, portal, sign (`esign.yaml` renamed `sign.yaml`; `intelligence.yaml` added) |
| ADR files | 36 | 0 | `git ls-tree --name-only 680907fc doc/adr/ \| grep -c '\.md$'` (+`0036-talent-intelligence-service.md`) |
| docker-compose files | 4 | 0 | root: `git ls-tree --name-only 680907fc \| grep -E '^docker-compose.*\.yml$'` → docker-compose.yml, .images.yml, .prod.yml; plus `deploy/geoip/docker-compose.geoip.yml` (separate project) |
| prod compose services | 10 | 0 | `grep -nE '^  [a-z][a-z0-9_-]*:$' docker-compose.prod.yml` between `services:` (`:57`) and `volumes:` (`:708`) → nginx, certbot, api, talent-intake-worker, auth-service, sign-service, talent-intelligence-service, platform-admin, postgres, redis |
| nginx host classes (prod template) | 4 | 0 | `grep -n "server_name" deploy/nginx/templates/aramo.conf.template` → tenant/admin/portal/sign (+ catch-all `_`) |
| nginx baked SPA roots | 5 | 0 | `grep -n "COPY --from=web-builder" deploy/nginx/Dockerfile` → /srv/home, /srv/ats, /srv/admin, /srv/portal, /srv/sign |
| backend Dockerfiles | 5 | 0 | `git ls-tree -r --name-only 680907fc apps \| grep -E '^apps/[^/]+/Dockerfile$'` → api, auth-service, platform-admin, sign-service, talent-intelligence-service |
| infra terraform tracks | 2 | 0 | `git ls-tree -d --name-only 680907fc \| grep '^infrastructure'` → infrastructure/ (environments+modules+cognito-triggers), infrastructure-lightsail/ |
| infrastructure/ modules | 14 | 0 | `git ls-tree -d --name-only 680907fc infrastructure/modules/ \| wc -l` (the old fragment's 17 was an on-disk `ls`; git at 12330b0f also gives 14 dirs + README) |
| running-prod runtime selection | 0 | 1 | out of tree — which compose/IaC track is live, and whether TI is running, are runtime facts, not derivable at this SHA |
| env-var runtime values | 0 | 1 | compose enumerates names only; `.env` values out of tree |
| per-lib tag-to-cluster correctness vs ADR-0029 D5 / ADR-0036 | 1 | 79 | tag counts re-derived; only `libs/skills-taxonomy` checked against ATI-SEP-1 A-c (gap D01-G5); the remaining 79 assignments are beyond D01 topology scope |
