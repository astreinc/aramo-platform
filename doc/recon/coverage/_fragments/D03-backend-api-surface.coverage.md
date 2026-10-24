| surface | inspected | not_verified | method/command |
|---|---|---|---|
| Backend NestJS HTTP apps | 4 | 0 | `ls apps` then read each `src/main.ts` (api:3000, auth-service:3001, platform-admin:3002, esign-service:3003) |
| Controller files (non-spec) | 97 | 0 | `grep -rl "^@Controller(" apps libs --include="*.ts" \| grep -v spec \| wc -l` |
| `@Controller(...)` decorators | 101 | 0 | `grep -rn "^@Controller(" apps libs --include="*.ts" \| grep -v spec \| grep -v ".d.ts" \| wc -l` |
| HTTP handler decorators (Get/Post/Put/Patch/Delete) | 466 | 0 | per-verb `grep -hE "^\s*@<Verb>\("` over the 97 controller files: Get 209, Post 208, Put 9, Patch 19, Delete 21 |
| `@RequireScopes(...)` applications | 443 | 0 | `grep -rn "@RequireScopes(" apps libs --include="*.ts" \| grep -v spec \| wc -l` |
| `@RequireSiteMatch` applications | 177 | 0 | `grep -rn "@RequireSiteMatch" apps libs --include="*.ts" \| grep -v spec \| wc -l` |
| Distinct scope keys referenced by controllers | 106 | — | `grep -rhoE "@RequireScopes\([^)]*\)" ... \| grep -oE "'[a-z_]+:[a-z_:]+'" \| sort -u \| wc -l` |
| Seeded scope-catalog cardinality (single number) | 0 | 1 | grown additively across libs/identity/prisma/seed.ts blocks (:26,:562,:572,:601,:632,:638,:651) — NOT a single derivable count |
| `@UseGuards(...)` application sites | 118 | 0 | `grep -rn "@UseGuards(" apps libs --include="*.ts" \| grep -v spec \| wc -l` |
| OpenAPI specs | 8 | 0 | `ls openapi/` (ats, auth, common, documents, esign, ingestion, platform, portal) |
| OpenAPI path-items (total) | 243 | 0 | per-spec `awk` on `^  /` under `paths:`: ats 154, platform 28, documents 22, portal 14, esign 11, auth 6, common 6, ingestion 2 |
| OpenAPI specs with a `servers:` block | 3 of 8 | 0 | `for f in openapi/*.yaml; do grep -cE "^servers:" $f; done` → auth, common, platform = 1; others = 0 |
| api-surface-manifest classified controllers | 97 | 0 | `python3 -c "import json;print(len(json.load(open('ci/config/api-surface-manifest.json'))['controllers']))"` |
| manifest class distribution | AP 84 / SS 6 / PZ 3 / XP 2 / AD 1 / IZ 1 | 0 | `Counter(d['controllers'].values())` over api-surface-manifest.json |
| manifest routeOverrides | 5 | 0 | `len(d['routeOverrides'])` — all 5 are `/v1/esign/signing/*` → PZ |
| manifest transitionalUndocumented ratchet | 191 | 0 | `len(d['transitionalUndocumented'])` on api-surface-manifest.json |
| Contract-parity enforcement dimensions (method+path / schema / scope / security) | 1 of 4 (method+path) | 3 | ci/scripts/verify-api-contract-parity.ts:11 "GA scope = method + normalized path ONLY" |
| Global request pipe | 1 (ValidationPipe) | 0 | apps/api/src/main.ts:73 `useGlobalPipes` |
| Global auth guard (APP_GUARD) | 0 | 0 | `grep -rn "provide: APP_GUARD" apps libs` → none (per-controller `@UseGuards` only) |
| Error-codes registry | 185 lines | 0 | `grep -cE "=\|:" libs/common/src/lib/errors/error-codes.ts` |
| FE `ats-web` per-domain `*-api.ts` modules | 65 | 0 | `find apps/ats-web/src -name "*-api.ts" \| grep -v spec \| wc -l` (all route through `@aramo/fe-foundation` apiClient) |
| Per-route → OpenAPI-spec file mapping | 0 | 466 | spec association stated at app granularity only; per-handler mapping NOT cross-walked |
| Runtime verification (app booted) | 0 | n/a | static read at frozen SHA; no app launched |
