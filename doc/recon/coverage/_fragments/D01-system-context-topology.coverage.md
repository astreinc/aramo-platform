| surface | inspected | not_verified | method/command |
|---------|-----------|--------------|----------------|
| apps | 8 | 0 | `ls apps/` → api, auth-service, esign-service, platform-admin, ats-web, platform-web, portal-web, sign-web |
| libs | 76 | 0 | `ls -d libs/*/ \| wc -l` |
| backend service ports | 4 | 0 | `grep -rn "PORT" apps/{api,auth-service,esign-service,platform-admin}/src/main.ts` → 3000/3001/3003/3002 |
| FE SPA dev ports | 4 | 0 | `grep -n "port" apps/{ats,platform,portal,sign}-web/vite.config.ts` → 4201/4202/4203/4204 |
| git-tracked project.json | 94 | 0 | `git ls-files '*project.json' \| wc -l` (84 under apps+libs; 10 under pact/) |
| nx scope tags (projects tagged) | 80 | 0 | per-tag `grep -rl '"scope:X"' libs/*/project.json apps/*/project.json \| wc -l`; sums ats36+cip14+shared16+boundary9+platform2+portal1+sign1+auth1 |
| @Controller files | 101 | 0 | `grep -rl --include="*.ts" "@Controller" apps libs \| wc -l` |
| @Module files | 147 | 0 | `grep -rl --include="*.ts" "@Module" apps libs \| wc -l` |
| @Injectable files | 465 | 0 | `grep -rl --include="*.ts" "@Injectable" apps libs \| wc -l` |
| git-tracked schema.prisma | 53 | 0 | `git ls-files '*schema.prisma' \| wc -l` (disk count differs: node_modules copies excluded by git) |
| git-tracked migration.sql | 253 | 0 | `git ls-files '*/migrations/*/migration.sql' \| wc -l` |
| @aramo/* path mappings | 79 | 0 | `grep -c '@aramo/' tsconfig.base.json`; cross-check `repo-map.projects.json:2` `aliasTotals.total: 79` |
| OpenAPI specs | 8 | 0 | `ls openapi/` → ats, auth, common, documents, esign, ingestion, platform, portal |
| ADR files | 35 | 0 | `ls doc/adr/*.md \| wc -l` |
| docker-compose files | 3 | 0 | `ls docker-compose*.yml` → docker-compose.yml, .images.yml, .prod.yml |
| nginx host classes (prod template) | 4 | 0 | `grep -n "server_name" deploy/nginx/templates/aramo.conf.template` → tenant/admin/portal/sign (+ catch-all `_`) |
| backend Dockerfiles | 4 | 0 | `find apps -maxdepth 2 -name Dockerfile` → api, auth-service, esign-service, platform-admin |
| infra terraform tracks | 2 | 0 | `ls -d infrastructure*/` → infrastructure/ (environments+modules), infrastructure-lightsail/ |
| infrastructure/ modules | 17 | 0 | `ls infrastructure/modules/ \| wc -l` |
| running-prod runtime selection | 0 | 1 | out of tree — which compose/IaC track is live is a runtime fact, not derivable at this SHA |
| env-var runtime values | 0 | 1 | compose enumerates names only; `.env` values out of tree |
| per-lib tag-to-cluster correctness vs ADR-0029 D5 | 0 | 76 | tag counts re-derived; individual assignment correctness beyond D01 topology scope |
