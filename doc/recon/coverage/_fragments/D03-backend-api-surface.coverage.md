| surface | inspected | not_verified | method/command |
|---|---|---|---|
| Backend NestJS HTTP apps | 5 | 0 | `git ls-tree --name-only 680907fc apps/` then read each `src/main.ts` (api:3000, auth-service:3001, platform-admin:3002, sign-service:3003, talent-intelligence-service:3004) |
| Controller files (non-spec) | 131 | 0 | `grep -rl "^@Controller(" apps libs --include="*.ts" \| grep -v spec \| wc -l` (old 97; 38 added, 4 removed/renamed) |
| `@Controller(...)` decorators | 137 | 0 | `grep -rn "^@Controller(" apps libs --include="*.ts" \| grep -v spec \| grep -v ".d.ts" \| wc -l` |
| HTTP handler decorators (Get/Post/Put/Patch/Delete) | 667 | 0 | per-verb `grep -cE "^\s*@<Verb>\("` over the 131 controller files: Get 281, Post 310, Put 16, Patch 31, Delete 29 (+1 `@Sse`) |
| Handlers per host app | 6 groups | 0 | same per-file count grouped by path: apps/api 239 (64 files); lib-authored into api 273 (40 files); sign-service 79 (10); platform-admin 38 (5); talent-intelligence-service 28 (9); auth-service via libs/auth-core 10 (3) |
| `@RequireScopes(` text matches | 533 | 0 | `grep -rn "@RequireScopes(" apps libs --include="*.ts" \| grep -v spec \| wc -l` (recorded command; includes comments) |
| `@RequireScopes(` decorator lines | 496 | 0 | `grep -rnE "^\s*@RequireScopes\(" apps libs --include="*.ts" \| grep -v spec \| wc -l` |
| `@RequireSiteMatch` text matches / decorator lines | 188 / 143 | 0 | `grep -rn "@RequireSiteMatch" … \| grep -v spec \| wc -l`; decorator lines with `^\s*@RequireSiteMatch` |
| Composite boundary decorator applications (sign-service) | 61 | 0 | `grep -rhoE "^\s*@[A-Z][A-Za-z]*Boundary\(" apps libs --include="*.ts" \| sort \| uniq -c`: EsignSenderBoundary 39, SignApiBoundary 9, RecipientInboxBoundary 5, BillingBoundary 4, AccountBoundary 2, LegalBoundary 2 |
| Distinct scope keys referenced by `@RequireScopes(` text | 122 | — | `grep -rnoE "@RequireScopes\([^)]*\)" apps libs --include="*.ts" \| grep -vE 'spec\|test' \| grep -oE "'[a-z_]+:[a-z_:]+'" \| sort -u \| wc -l` |
| Distinct scope keys on live decorator lines | 120 | 0 | same extraction over `^\s*@RequireScopes\(` lines only; the 2 comment-only keys are `requisition:edit` and `sign:envelope:send` |
| Seeded scope-catalog cardinality (single number) | 0 | 1 | grown additively across libs/identity/prisma/seed.ts (5316 lines; oldest block :26) — NOT a single derivable count; 257 distinct quoted colon-literals is a text count only |
| `@UseGuards(` text matches / decorator lines | 141 / 106 | 0 | `grep -rn "@UseGuards(" apps libs --include="*.ts" \| grep -v spec \| wc -l`; decorator lines with `^\s*@UseGuards\(` |
| Controller files with no `@UseGuards` decorator line | 29 | 0 | `comm -23 <controller list> <(grep -rlE "^\s*@UseGuards" apps libs --include="*.ts" \| grep -v spec \| sort)`; 10 sign-service files use composite boundaries |
| OpenAPI specs | 9 | 0 | `ls openapi/` (ats, auth, common, documents, ingestion, intelligence, platform, portal, sign); esign.yaml renamed to sign.yaml |
| OpenAPI path-items (total) | 435 | 0 | per-spec `awk` on `^  /` under `paths:`: ats 205, sign 71, platform 68, documents 35, intelligence 25, portal 16, auth 7, common 6, ingestion 2 |
| OpenAPI specs with a `servers:` block | 3 of 9 | 0 | `for f in openapi/*.yaml; do grep -cE "^servers:" $f; done` → auth, common, platform = 1; others = 0 |
| api-surface-manifest classified controllers | 131 | 0 | `python3 -c "import json;print(len(json.load(open('ci/config/api-surface-manifest.json'))['controllers']))"` |
| manifest class distribution | AP 100 / SS 16 / PZ 7 / XP 5 / IZ 2 / AD 1 | 0 | `Counter(d['controllers'].values())` over api-surface-manifest.json |
| manifest routeOverrides | 10 | 0 | `len(d['routeOverrides'])` — 9 are `/v1/sign/signing/*` → PZ, 1 is `POST /v1/sign/billing/webhook/stripe` → XP |
| manifest transitionalUndocumented ratchet | 185 | 0 | `len(d['transitionalUndocumented'])` on api-surface-manifest.json (old 191) |
| Contract-parity enforcement dimensions (method+path / schema / scope / security) | 1 of 4 (method+path) | 3 | ci/scripts/verify-api-contract-parity.ts:11 "GA scope = method + normalized path ONLY" |
| Global request pipe | 1 per app (ValidationPipe) | 0 | apps/api/src/main.ts:93; apps/sign-service/src/main.ts:21; apps/talent-intelligence-service/src/main.ts:23; apps/auth-service/src/main.ts:19; apps/platform-admin/src/main.ts:25 |
| Global auth guard (APP_GUARD) | 0 | 0 | `grep -rn "provide: APP_GUARD" apps libs` → none (per-controller `@UseGuards` / composite boundaries only) |
| apps/api AppModule `imports:` / `controllers:` top-level entries | 114 / 11 | 0 | count of 4-space-indented identifier lines in apps/api/src/app.module.ts between :184–:677 and :678–:732 |
| Error-codes registry | 199 lines | 0 | `grep -cE "=\|:" libs/common/src/lib/errors/error-codes.ts` (file 1054 lines) |
| FE `ats-web` per-domain `*-api.ts` modules | 63 | 0 | `find apps/ats-web/src -name "*-api.ts" \| grep -v spec \| wc -l` (all route through `@aramo/fe-foundation` apiClient) |
| Other FE API modules | 18 | 0 | `find <pkg>/src -name '*-api.ts' -o -name 'api.ts'`: sign-web 4, platform-web 4, portal-web 1, org-admin-web 8, document-templates-web 1 (home-web 0) |
| nginx host routing (tenant / admin / portal / sign) | 4 server blocks | 0 | `grep -nE "server_name\|location\|proxy_pass" deploy/nginx/templates/aramo.conf.template` |
| Per-route → OpenAPI-spec file mapping | 0 | 667 | spec association stated at app granularity only; per-handler mapping NOT cross-walked |
| Lib-authored controller → host app composition | 3 (auth-core) | 37 | module imports not traced per lib controller file |
| Runtime verification (app booted) | 0 | n/a | static read at frozen SHA; no app launched |
