| surface | inspected | not_verified | method/command |
|---------|-----------|--------------|----------------|
| ats-web source files (`.tsx`) | 15 | 393 | `git ls-files 'apps/ats-web/src/**/*.tsx' \| wc -l` → 408 total; opened: main/App/RecruiterShell/ui-index + specs not read |
| ats-web source files (`.ts`) | 6 | 235 | `git ls-files 'apps/ats-web/src/**/*.ts' \| wc -l` → 241 total; opened: talent-intake-api, scopes, client, funnel-css-drift.spec, stage-map (grep) |
| ats-web routes in `App.tsx` | 69 | 0 | `grep -oE 'path="[^"]+"' apps/ats-web/src/App.tsx \| grep -v 'path="/\*"' \| sort -u \| wc -l` → 69 (full file read) |
| ats-web screen components (`*View.tsx`/`*Section.tsx`) | 0 | 61 | `git ls-files 'apps/ats-web/src/**/*View.tsx' 'apps/ats-web/src/**/*Section.tsx' \| grep -vcE '\.spec\.'` → 61; enumerated via route map, bodies not opened |
| ats-web FE→BE wiring modules (`*-api.ts`) | 1 | 64 | `git ls-files 'apps/ats-web/src/**/*-api.ts' \| grep -vcE '\.spec\.'` → 65; opened: talent-intake-api.ts |
| ats-web distinct `/v1` endpoint strings | 7 | 229 | `grep -rohE "/v1/[a-zA-Z0-9/_:-]+" apps/ats-web/src --include='*.ts' --include='*.tsx' \| sort -u \| wc -l` → 236; verified: 7 talent-intake routes |
| platform-web source files (non-spec) | 3 | 19 | `git ls-files 'apps/platform-web/src/**/*.{tsx,ts}' \| grep -vcE '\.spec\.'` → 22; opened: main.tsx, App.tsx (routes), + route enumeration |
| portal-web source files (non-spec) | 3 | 7 | `git ls-files 'apps/portal-web/src/**/*.{tsx,ts}' \| grep -vcE '\.spec\.'` → 10; opened: main.tsx, App.tsx (routes + guard) |
| sign-web source files (non-spec) | 2 | 2 | `git ls-files 'apps/sign-web/src/*' \| grep -E '\.tsx?$' \| grep -vcE '\.spec\.'` → 4; opened: App.tsx (full), sign-api.ts (header) |
| platform-admin (backend, not FE) | confirmed-backend | — | `git ls-files 'apps/platform-admin/src/**/*.tsx' \| wc -l` → 0; `main.ts`/`app.module.ts` read |
| `@aramo/fe-foundation` source files | 7 | 31 | `git ls-files 'libs/fe-foundation/src/**/*.{ts,tsx}' \| grep -vcE '\.spec\.'` → 38; opened: index.ts, api/client.ts, auth/{RouteGuard,scopes}.ts, ui/{AppShell,index}.ts (+barrel tree listed) |
| FE build config (eslint G1/R2 guard) | 1 | 0 | `grep -n "no-restricted-syntax" eslint.config.mjs` → RAW_ELEMENT_RESTRICTED at `:47`,`:241` (read) |
| FE-relevant ADR anchors | 2 | 0 | `grep -rilE "ats|admin|portal|frontend|react" doc/adr/` → ADR-0023 (front door) + ADR-0029 (import wall) read for FE relevance |
