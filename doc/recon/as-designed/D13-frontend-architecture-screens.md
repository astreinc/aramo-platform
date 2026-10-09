# D13 — Frontend Architecture & Screen Inventory (AS-DESIGNED)

> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED
> Ratified intent ONLY, cited from `doc/adr/*` and in-repo LOCKED specs. NOT synthesized from code.
> Where no ratified anchor exists for a frontend concern, this is stated explicitly.

## Scope of ratified anchors

There is **no dedicated frontend-architecture ADR** in `doc/adr/*` at this baseline (no ADR titles the console, SPA composition, routing, or the design system). The frontend concerns that DO carry ratified intent are the **host/front-door topology** and the **cross-cluster import walls**; the screen inventory and shell/design-system structure are governed by implementation directives referenced by name in build config rather than by committed ADRs.

## A. Front-door host topology (RATIFIED — ADR-0023)

`doc/adr/0023-frontdoor-nginx-wildcard-tls.md` ratifies the host classes the SPAs are served behind and the path walls between them:

- **§Decision item 1** (`doc/adr/0023-frontdoor-nginx-wildcard-tls.md:28`): nginx terminates TLS and reverse-proxies **three host classes** with per-host path walls —
  - **tenant** host → `/v1/`, `/auth/`, exact `jwks`, the Indeed webhook (the recruiter console = `ats-web`);
  - **admin** host (`admin.aramo.ai`) → `/auth/`, `/platform/`, `jwks`, **no `/v1` (R14)** (the platform console = `platform-web` / `platform-admin`);
  - **portal** host → `/v1/portal/` **only** (`portal-web`).
- **§Context** (`doc/adr/0023-frontdoor-nginx-wildcard-tls.md:12`,`:16`): the tenant wildcard host `*.aramo.ai`, the platform console host `admin.aramo.ai`, and the portal host are the three distinct front-door surfaces.
- **§Decision item 2** (`doc/adr/0023-frontdoor-nginx-wildcard-tls.md:35`): one `*.aramo.ai` wildcard cert covers every `<slug>.aramo.ai`.

**Design intent → as-built correspondence**: the four SPAs map onto these ratified host classes (recruiter→tenant, platform→admin, portal→portal; `sign-web` is the signer surface, not separately enumerated in ADR-0023). The admin-host "**no `/v1`**" wall (R14) is the ratified reason `platform-web` authenticates as the `platform` consumer and talks to `/platform/*`, never tenant `/v1/*`.

## B. Cross-cluster import walls (RATIFIED — ADR-0029, extended by riders)

`doc/adr/0029-pipeline-boundary-modular-monolith.md` ratifies the compiler-checked import wall that the FE cluster tags extend:

- **§2 D2 / I15** (`doc/adr/0029-pipeline-boundary-modular-monolith.md:28`): the Pipeline⊥ATS import wall, **enforced via nx boundary tags**; the build FAILS on a violating import. This is the ratified mechanism (nx project-scope tags) that the frontend tiers reuse.

The **frontend-tier extensions** of this wall (`scope:platform` for `platform-admin`/`platform-web`, `scope:portal` for `portal-web`, each forbidden from importing `scope:ats`/`scope:cip`) are specified as **riders referenced in build config** rather than in a committed ADR body: `eslint.config.mjs:53` cites "Platform-Console Increment-1 (ADR-0029 R-TAGS)" and "Portal P1 PR-3 (§PR-3.1 boundary-tag rider)" as their authority. The ratified intent is: **each FE cluster (platform, portal) operates on its own substrate only and must not reach a tenant's ATS/Pipeline workflow**, and `portal-web` is HTTP-only against `/v1/portal` with no backend-lib import. The rider documents themselves are not present under `doc/adr/*`.

## C. Scopes-only FE authorization mirror (RATIFIED mechanism, no FE-specific ADR)

The backend authorization model (scopes-only, `@RequireScopes` per route) is the ratified contract that the FE mirrors via `hasScope` + `RouteGuard requireScope`. This mirror is a **documented code convention** (`libs/fe-foundation/src/auth/scopes.ts:1` header states the backend is scopes-only and the FE mirrors it at the routing/nav boundary) rather than a ratified ADR clause. No `doc/adr/*` file ratifies the FE route-guard pattern specifically.

## D. Raw-element design-system guard (LOCKED directive referenced, NOT committed)

The G1/R2 raw-interactive-element ban in `apps/**` (`eslint.config.mjs:230`) cites its authority as **`Aramo-UI-HotFix-Console-Defect-Register-v1_0-LOCKED`**. That LOCKED directive is **not committed to the repository** — only a DRAFT exists (`doc/backlog/ui-hotfix-fe-foundation-standard-gaps-DRAFT.md`). The ratified intent (fail-closed: app code uses `@aramo/fe-foundation` primitives, not raw `<button>/<input>/<select>/<textarea>/<dialog>`) is thus enforced in CI but its canonical specification is not auditable from the repo at this baseline.

## E. Concerns with NO ratified anchor (explicit)

The following frontend concerns are **AS-BUILT only** — no `doc/adr/*` or committed LOCKED spec ratifies them:

- The **unified recruiter console** decision (merging the recruiter surface and the admin/settings section into a single `ats-web` SPA, retiring `tenant-console`) — attributed in code to "FE Consolidation (Directive 5)" (`libs/fe-foundation/src/index.ts:3`) but that directive is not in `doc/adr/*`.
- The **`RecruiterShell` rail IA** (PRIMARY/WORK/ADMIN nav grouping, per-item scope gating).
- The **Confident Blue design system** layering (`ui/index.ts` frozen-primitive re-export + new atoms; `theme.css`/`ui.css` token load-order).
- The **per-screen routing map** (69 ats-web routes, the public-vs-guarded split, the `admin/settings/integrations` out-ranking rule).
- The **talent-intake durable-draft FE flow** (SSE notification-only + authoritative GET refetch) — the backend side has ADR-0033; the FE client contract itself has no FE-specific ADR.
- The **`sign-web` signer state machine** and its no-design-system posture (justified inline in code as the isolated external-signer SPA, not in an ADR).

These surface in the gap fragment as `as_built_vs_as_designed` only where a code-vs-ratified-spec contradiction exists; absence of a ratifying ADR is recorded here as an anchor gap, not a contradiction.
