# D13 — Frontend Architecture & Screen Inventory (AS-DESIGNED)

> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED
> Ratified intent ONLY, cited from `doc/adr/*`, in-repo LOCKED specs, and LOCKED directives in the canonical `OneDrive/Aramo/locked/` folder (cited by filename + section). NOT synthesized from code.
> Where no ratified anchor exists for a frontend concern, this is stated explicitly.

## Scope of ratified anchors

There is still **no dedicated frontend-architecture ADR** in `doc/adr/*` at this baseline (no ADR titles the console set, SPA composition, routing or the design system; the only ADR added since the prior baseline is `0036-talent-intelligence-service.md`). Ratified frontend intent now comes from three places:

1. In-repo ADRs for the **front-door host topology** (ADR-0023), the **cross-cluster import walls** (ADR-0029) and the **ATS / Talent Intelligence split** (ADR-0036).
2. Canonical LOCKED directives dated after 2026-10-09 that govern the **App Home / Organization** surface (D-ORG amendments, ORG-UX-1), the **one Aramo Sign application** (Sign Unified Product + addenda, Sign Naming Unification, Sign Personal (Free) Launch), the **shared sign-in page** (AUTH-SIGNIN-1), the **shared document-template library** (ADR-0034, DOC-TEMPLATE-LIB-1) and the **organization role model** (ADR-0035) that drives `org_access`.
3. The in-repo implementation record `doc/10-multi-product-app-home-and-org-consumer.md`, which names the LOCKED instruments it implements (§6) — cited here only where it restates those instruments.

ADR-0034 and ADR-0035 state a repository copy at `doc/adr/0034-shared-document-template-library.md` / `doc/adr/0035-organization-and-product-role-model.md` on a feature branch (`Aramo-ADR-0034-Shared-Document-Template-Library-v1_0-LOCKED.md:3`; `Aramo-ADR-0035-Organization-and-Product-Role-Model-v1_0-LOCKED.md:3`); neither file is in `doc/adr/` at 680907fc.

## A. Front-door host topology (RATIFIED — ADR-0023)

`doc/adr/0023-frontdoor-nginx-wildcard-tls.md` ratifies the host classes the SPAs are served behind and the path walls between them:

- **§Decision item 1** (`doc/adr/0023-frontdoor-nginx-wildcard-tls.md:29`): nginx terminates TLS and reverse-proxies **three host classes** with per-host path walls —
  - **tenant** host → `/v1/`, `/auth/`, exact `jwks`, the Indeed webhook;
  - **admin** host (`admin.aramo.ai`) → `/auth/`, `/platform/`, `jwks`, **no `/v1` (R14)** (the platform console = `platform-web` / `platform-admin`);
  - **portal** host → `/v1/portal/` **only** (`portal-web`).
- **§Context** (`doc/adr/0023-frontdoor-nginx-wildcard-tls.md:12`, `:16`): the tenant wildcard host `*.aramo.ai`, the platform console host `admin.aramo.ai`, and the portal host are the three distinct front-door surfaces.
- **§Decision item 2** (`doc/adr/0023-frontdoor-nginx-wildcard-tls.md:35`): one `*.aramo.ai` wildcard cert covers every `<slug>.aramo.ai`.

Later LOCKED instruments add to this topology:

- **Tenant host = App Home (topology T1).** The tenant host root is the product-neutral App Home (`apps/home-web`), Organization Administration is at `/org/*` in the same bundle, and the ATS is a sibling SPA at `/ats/*` with Vite `base: '/ats/'` and router `basename` (`doc/10-multi-product-app-home-and-org-consumer.md` §1, implementing the D-ORG authorization and the amendments listed in its §6; that file is not itself LOCKED — the LOCKED anchor for serving `org` on the tenant host class is `Aramo-D-ORG-Amendment-A1-IC-0-F2-Rules-3-4-Org-Consumer-v1_0-LOCKED.md` §2 term 3, with per-host session minting under the extended IC-0 §F.2 rule 7, §1). ORG-UX-1 keeps the production `/org/*` paths (`Aramo-ORG-UX-1-App-Home-and-Organization-Redesign-Implementation-Directive-v1_0-LOCKED.md` §3).
- **A fourth host class, the Sign host.** `sign.aramo.ai` is the only Sign address, serving the authenticated sender/administrator/inbox experiences plus guest signing `/s/:token` and signed-copy download `/d/:token` (`Aramo-Sign-Unified-Product-Permission-Contract-Platform-API-Directive-v1_0-LOCKED.md` §4.1.1). **Amendment D-1** overrides §4.1.1's compatibility redirect: the separate e-signature host is retired outright with no redirect (`Aramo-Sign-Unified-Product-D1-Host-Retirement-Addendum-v1_0-LOCKED.md` §Final host topology), which also supersedes ruling 3 of the S6 ATS Migration Addendum. These amend the earlier `Aramo-E-Sign-Host-and-Workspace-Architecture-Ruling-v1_0-LOCKED.md` §Routing ruling (BUSINESS → `/sign/`, PERSONAL → `/personal/`), whose workspace prefixes carry forward onto `sign.aramo.ai`.

**Design intent → as-built correspondence**: the five SPAs map onto these host classes (home-web + ats-web → tenant, platform-web → admin, portal-web → portal, sign-web → Sign). The admin-host "**no `/v1`**" wall (R14) is the ratified reason `platform-web` authenticates as the `platform` consumer and talks to `/platform/*`, never tenant `/v1/*`.

## B. Cross-cluster import walls (RATIFIED — ADR-0029, extended by riders)

`doc/adr/0029-pipeline-boundary-modular-monolith.md` ratifies the compiler-checked import wall that the FE cluster tags extend:

- **§2 D2 / I15** (`doc/adr/0029-pipeline-boundary-modular-monolith.md:28`): the Pipeline⊥ATS import wall, **enforced via nx boundary tags**; the build FAILS on a violating import. This is the ratified mechanism (nx project-scope tags) that the frontend tiers reuse.

The **frontend-tier extensions** of this wall (`scope:platform` for `platform-admin`/`platform-web`, `scope:portal` for `portal-web`, each forbidden from importing `scope:ats`/`scope:cip`) are specified as **riders referenced in build config** rather than in a committed ADR body: `eslint.config.mjs:57` cites "Platform-Console Increment-1 (ADR-0029 R-TAGS)" and `eslint.config.mjs:64` cites "Portal P1 PR-3 (§PR-3.1 boundary-tag rider)". The rider documents themselves are not present under `doc/adr/*`.

Newly ratified tiers:

- **`scope:sign`** — one front-end application and Nx project tagged `scope:sign`; there is no second Sign front end (`Aramo-Sign-Unified-Product-Permission-Contract-Platform-API-Directive-v1_0-LOCKED.md` §4.1.2).
- **`scope:intelligence`** — ADR-0036 §1 assigns `scope:ats` to the ATS (`apps/api`, `apps/ats-web`) and `scope:intelligence` to `apps/talent-intelligence-service`; `scope:ats` must not depend on `scope:intelligence` (`doc/adr/0036-talent-intelligence-service.md:42`, `:48`, `:52`).

The ratified intent is: **each FE cluster (platform, portal, sign) operates on its own substrate only and must not reach a tenant's ATS/Pipeline workflow**, `portal-web` is HTTP-only against `/v1/portal` with no backend-lib import, and the ATS reaches Talent Intelligence only over HTTP.

## C. Scopes-only FE authorization mirror (RATIFIED mechanism, no FE-specific ADR)

The backend authorization model (scopes-only, `@RequireScopes` per route) is the ratified contract that the FE mirrors via `hasScope` + `RouteGuard requireScope`. This mirror is a **documented code convention** (`libs/fe-foundation/src/auth/scopes.ts:1` header) rather than a ratified ADR clause.

Two newer LOCKED rules decide access from a **server projection** rather than from scopes held in the browser:

- **Organization workspace (ORG-UX-1 §4.3, Lead Correction A).** Organization-administration authority derives from the ADR-0035 role model — holding `tenant_owner` or `tenant_admin`, evaluated server-side; holding some `tenant:admin:*` scope is **not** sufficient. `GET /v1/me/products` carries `org_access = admin | templates | none`: `admin` = full ORGANIZATION and SHARED SETUP groups; `templates` = Our templates + Template gallery only; `none` = App Home only, every `/org/*` page returns to App Home with the denial message (`Aramo-ORG-UX-1-App-Home-and-Organization-Redesign-Implementation-Directive-v1_0-LOCKED.md` §4.3).
- **Sign workspace.** The route prefix never authorizes; tenant identity, kind, entitlement and authority come from the backend-authenticated context, never the URL (`Aramo-Sign-Unified-Product-Permission-Contract-Platform-API-Directive-v1_0-LOCKED.md` §4.1, "Carried-forward invariants"). A BUSINESS tenant without Sign entitlement gets "product unavailable" and login success alone never grants access (`Aramo-E-Sign-Host-and-Workspace-Architecture-Ruling-v1_0-LOCKED.md` §Login routing).

## D. Raw-element design-system guard (LOCKED directive referenced, NOT committed)

The G1/R2 raw-interactive-element ban in `apps/**` (`eslint.config.mjs:32`, block at `:285`) cites its authority as **`Aramo-UI-HotFix-Console-Defect-Register-v1_0-LOCKED`**. That directive exists in the canonical locked folder with amendments A1–A3 (A3 = G1 inventory/primitive correction). Its **R2** clause bans raw `button`, `input`, `textarea`, `select`, `dialog` in `apps/**/src/**`, **"allowed only under `libs/fe-foundation/**`"**, via the built-in `no-restricted-syntax` rule as a required CI target (`Aramo-UI-HotFix-Console-Defect-Register-v1_0-LOCKED.md` §R2). In the repository only a DRAFT is present (`doc/backlog/ui-hotfix-fe-foundation-standard-gaps-DRAFT.md`).

## E. Concerns with NO ratified anchor (explicit)

The following frontend concerns are **AS-BUILT only** — no `doc/adr/*` or LOCKED spec ratifies them:

- The **unified recruiter console** decision (merging recruiter surface and admin/settings into one `ats-web` SPA, retiring `tenant-console`) — attributed in code to "FE Consolidation (Directive 5)" (`libs/fe-foundation/src/index.ts:3`). Canonical `Aramo-FE-Consolidation-*` LOCKED files exist but are dated before 2026-10-09 and were not opened in this pass.
- The **`RecruiterShell` rail IA** (PRIMARY/WORK/ADMIN nav grouping, per-item scope gating).
- The **Confident Blue design system** layering (`ui/index.ts` frozen-primitive re-export + new atoms; `theme.css`/`ui.css` token load-order).
- The **per-screen ats-web routing map** (72 distinct ats-web paths, the public-vs-guarded split, the `admin/settings/integrations` out-ranking rule).
- The **talent-intake durable-draft FE flow** (SSE notification-only + authoritative GET refetch) — the backend side has ADR-0033; the FE client contract itself has no FE-specific ADR.

Concerns that **now have** a ratified anchor (moved out of this list):

- **Sign app zones and the guest signer surface.** Three zones in one app — guest signing (`/s/:token`, `/d/:token`; capability token only, no session fetch, no workspace chrome, no sign-in redirect, never reaches workspace APIs), public entry (`/login`, `/signed-out`, `/signup`, `/signup/verify`; signup dark unless authorized), and workspace (everything else, Aramo SSO session) (`Aramo-Sign-Unified-Product-Permission-Contract-Platform-API-Directive-v1_0-LOCKED.md` §4.1.3). §4.1.3 names the workspace consumer `esign`; **`Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED.md` N-4** overrides it to `sign` (route `/auth/sign/*`, cookies `aramo_*_sign`) — the amendment governs. Additional session-less public pages are governed by `Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED.md` §3 (Personal signup) and §6.4 (abuse reports). Its Amendment A1 overrides §11/§12 where they differ: the three legal documents are APPROVED as v1.0 (A1-4) and publication at `sign.aramo.ai/legal` is authorized (A1-5), and it adds self-service account close and in-app legal re-acceptance as new surfaces (A1-10) (`Aramo-Sign-Personal-Free-Launch-Directive-v1_1-Amendment-A1-v1_0-LOCKED.md` table rows A1-4, A1-5, A1-10). The domain-delegate page and the Sign-host narrow nginx exception for the domain-verification routes are governed by `Aramo-Domain-Enforcement-P3-One-Organization-Per-Domain-Directive-v1_0-LOCKED.md` §4 and §5.
- **App Home / Organization routes, nav and shell.** ORG-UX-1 §3 (routes: `/`, `/org`, `/org/overview` default, `/org/{profile,users,roles,sites,domain,settings,audit}`, `/org/document-templates` + `/gallery` + `{new, aramo/:templateId, :templateId, :templateId/draft}`, `security`/`localization`/`billing` redirects), §7.1 (`AramoRail` in `libs/fe-foundation`: 236px expanded, 64px collapsed, auto-collapse below 900px), §7.2 (return context: `from=sign` absolute URL accepted only for the trusted Sign entry origin and Sign settings path prefix; used only as a Back link), §7.3 (status pill tones), all under `Aramo-ORG-UX-1-Conforming-Amendments-v1_0-LOCKED.md`.
- **The `org` consumer and consumer-isolated sessions.** `Aramo-D-ORG-Amendment-A1-IC-0-F2-Rules-3-4-Org-Consumer-v1_0-LOCKED.md`, `Aramo-AUTHZ-2-Platform-Tier-Directive-Amendment-A1-Sixth-Consumer-Org-v1_0-LOCKED.md` (six consumers; `org` never carries `platform:*`) and `Aramo-Auth-Decoupling-PR-4-Directive-Amendment-A3-Consumer-Isolated-Sessions-and-Return-To-v1_0-LOCKED.md` (consumer-suffixed cookies, the consumer header, `return_to`) — recorded as ratified 2026-10-17 in `doc/10-multi-product-app-home-and-org-consumer.md` §6. The D-ORG A1 file header still reads "RATIFICATION PENDING"; §6 records a filename-only transition to `-LOCKED` with the SHA-256 unchanged.
- **Shared sign-in page.** One Aramo-branded `SignInPage` in `libs/fe-foundation/src/auth/`; `redirectToLogin()` sends unauthenticated users to the app's own sign-in page (`/ats/login` for the base-path-aware ATS); the four app `LoginPage.tsx` files become thin wrappers so all render the identical screen (`Aramo-AUTH-SIGNIN-1-Unified-Branded-Sign-In-Directive-v1_0-LOCKED.md` §3.2, §3.3; §R refinements override §1–§6).
- **Template administration home.** Tenant template administration moves out of the ATS to Org / App Home behind a product-neutral permission; ATS and Sign keep only the "use" side and link to Org Home; the ATS Settings document-templates section is retired (`Aramo-ADR-0034-Shared-Document-Template-Library-v1_0-LOCKED.md` D11), implemented under `Aramo-DOC-TEMPLATE-LIB-1-Shared-Document-Template-Library-Implementation-Directive-v1_0-LOCKED.md` and its Conforming Amendments.
- **Talent × Requisition 360 as a second host of the technical-screening flow**, next to Talent-360 and the `talent/:talentId/screening` entry point (`ARAMO-TIP-E2E-INC-3-A1-Note-1-TR360-Second-Host-v1.0-LOCKED.md` §1, parent `ARAMO-TIP-E2E-INC-3-A1-v1.0-LOCKED.md`).

These surface in the gap fragment as `as_built_vs_as_designed` only where a code-vs-ratified-spec contradiction exists; absence of a ratifying ADR is recorded here as an anchor gap, not a contradiction.
