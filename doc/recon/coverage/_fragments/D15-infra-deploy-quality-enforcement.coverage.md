# D15 — Coverage (Infrastructure, Deployment, Persistence Ops & Quality/Contract Enforcement)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212

| surface | inspected | not_verified | method/command |
| --- | --- | --- | --- |
| Lightsail IaC (`infrastructure-lightsail/*.tf`) | 8 | 0 (all read: main, backend, provider, variables, outputs, doc4-esign, resume-bucket-cors, ses-mail-alignment) | `git ls-files 'infrastructure-lightsail/*.tf' \| wc -l` = 8; main.tf/doc4-esign.tf/resume-bucket-cors.tf read in full |
| Platform IaC (`infrastructure/**/*.tf`) | 62 | ~50 (prod `compute.tf`+`talent-intake.tf` read in full; dev/staging + the 14 `modules/*` internals not line-read) | `git ls-files 'infrastructure/**/*.tf' \| wc -l` = 62 |
| Compose files | 3 | 2 partial (`docker-compose.prod.yml` read in full; `docker-compose.yml` + `docker-compose.images.yml` headers only) | `git ls-files \| grep -cE '^docker-compose.*\.yml$'` = 3 |
| nginx front door (`deploy/nginx/*`) | 4 | 3 (`templates/aramo.conf.template` read in full; `Dockerfile`, `nginx.conf`, `README.md` not line-read) | `git ls-files 'deploy/nginx/*' \| wc -l` = 4 |
| CI workflows (`.github/workflows/*`) | 2 | 1 (`ci.yml` read in full; `deploy-public-staging.yml` inventoried, not deep-read) | `git ls-files '.github/workflows/*' \| wc -l` = 2 |
| CI guard scripts (`ci/scripts/*.ts`) | 26 | ~18 (symbol-level inspected: run-integration, check-integration-roots, verify-env-passthrough, verify-api-contract-parity, ci-integration.sh, prepush, verify-vocabulary; others name-level only) | `git ls-files 'ci/scripts/*.ts' \| wc -l` = 26 |
| Integration-root registry + guard | 1 registry (+1 guard) | 0 (registry read in full; 47 roots, 1 coverageAlias, 0 exemptions) | `python3 -c "import json;d=json.load(open('ci/integration-roots.json'));print(len(d['roots']))"` = 47 |
| deployment-gate merge-blocking members | 18 | 0 (needs list enumerated) | `sed -n '881,899p' .github/workflows/ci.yml \| grep -cE '^\s+- '` = 18 |
| Pact contracts | 10 consumer projects / 109 tracked files | contract bodies (only `package.json` consumer/provider wiring + dir inventory read) | `git ls-files 'pact/consumers/' \| awk -F/ 'NF>2{print $3}' \| grep -v gitkeep \| sort -u \| wc -l` = 10; `git ls-files pact/ \| wc -l` = 109 |
| ADRs (AS-DESIGNED anchors) | 8 heads (0012,0013,0014,0016,0017,0018,0023,0033) | 27 (remaining ADRs not read for D15) | `git ls-files 'doc/adr/*.md' \| wc -l` = 35 |
| Persistence-ops deploy scripts (`deploy/*.sh`) | 10 inventoried; 2 read (migrate-prod, seed-prod headers) | internals of build-images/singlebox-compose/pg-backup/pg-restore | `git ls-files 'deploy/*.sh' \| wc -l` = 10 |
| Vocabulary gate (`scripts/verify-vocabulary.sh`) | 1 (read in full, 628 lines) | 0 | `Read` full file; Tier-2 terms at `:491` |
| nx boundary wall (`eslint.config.mjs`) | 1 (dep-constraints + enforce-module-boundaries section read) | import-x/order + prettier rule blocks not fully read | `grep -nE 'SCOPE_DEP_CONSTRAINTS\|enforce-module-boundaries' eslint.config.mjs` |
| Tracked Prisma persistence footprint | counts re-derived (context only; not D15-owned) | per-model review (other domains own these) | `git ls-files '**/schema.prisma' \| wc -l`=53; `... \| xargs grep -hE '^\s*model ' \| wc -l`=209; `git ls-files '**/migrations/*/migration.sql' \| wc -l`=253 |
