# 10 — Multi-product App Home, the `org` consumer and consumer-isolated sessions (D-ORG)

**Governing instruments:** "Aramo Multi-Product Architecture — Lead/Architect Disposition" (R1–R10) and
"D-ORG — FULL IMPLEMENTATION AUTHORIZATION" (§1–§7), both relayed by the PO 2026-10-16/17; grounded on
`ARAMO-App-Home-Multi-Product-Architecture-Recon-v1_0.md` (SHA-256 `63b4483a3567efb138623ce2dddf8379ee4ee6d69e3512ea3c1eb18c96a090b8`,
baseline `82c63063`). Pending amendments (ratification pending; see §6) reconcile the earlier LOCKED clauses this
increment supersedes. Branch `feat/d-org-multiproduct-app-home` off `aa9741655b60f155fd8e3df705d4d0d76517cc4f`.

## 1. The tenant host is the App Home, not the ATS (§3.A/§3.B — topology T1)

`<slug>.aramo.ai` is the permanent, product-neutral entry for an organization. Three things live on it, served
by nginx from two SPAs:

| Path | SPA | Built by | Purpose |
|---|---|---|---|
| `/` | `apps/home-web` (`aramo-home-web`, port 4205) | `dist/apps/home-web` → `/srv/home` | App Home — product tiles |
| `/org/*` | `apps/home-web` + `libs/org-admin-web` | same bundle | Organization Administration |
| `/ats/*` | `apps/ats-web` (Vite `base: '/ats/'`, router `basename`) | `dist/apps/ats-web` → `/srv/ats` | the existing ATS app, unchanged in substance |
| `/login`, `/signed-out` | each SPA has its own | — | session-less landings (login error pages; Cognito sign-out return) |

nginx (`deploy/nginx/templates/aramo.conf.template`, tenant block): `location /ats/ { alias /srv/ats/; try_files $uri $uri/ /ats/index.html; }`,
`location = /ats { return 301 /ats/; }`, `location / { root /srv/home; try_files $uri /index.html; }`. The front-door
verifier rule (j) (`ci/scripts/verify-frontdoor-conf.ts`) fails the build if the tenant catch-all ever roots `/srv/ats`
again. Deep links and refreshes work in both apps because each SPA falls back to its own `index.html`.

**Bookmark compatibility.** A pre-T1 ATS link (`/talent/<id>?tab=…`) reaches home-web's catch-all route, which forwards
it to `/ats<path><search><hash>` with a full navigation before any session probe (`apps/home-web/src/home/LegacyAtsRedirect.tsx`).
The ATS app then authenticates it as before.

**Modularity.** home-web depends on `@aramo/fe-foundation` and `@aramo/org-admin-web` only; `libs/org-admin-web` depends on
`@aramo/fe-foundation` only (`scope:shared`). No ATS code is imported by either. The ATS app does not import the
organization library; its three links into Organization Administration are host-level anchors (`/org/`, `/org/users`,
`/org/sites`), never router links (the ATS router basename would otherwise prefix them with `/ats`).

## 2. The `org` consumer — the sixth auth-service consumer (§3.C)

`CONSUMER_TYPES = ['recruiter', 'portal', 'ingestion', 'platform', 'esign', 'org']` (`libs/auth/src/lib/auth-context.types.ts`;
the hand-copied twin in `libs/auth-core/src/lib/cookie-verifier.service.ts`; `openapi/auth.yaml` enum at 7 sites).

| Rule | `org` |
|---|---|
| IC-0 §F.2 rule 3 — consumer → capability at mint/refresh | `core` (the tenant must BE an Aramo organization). A Sign-only, ATS-only, ATS+Sign or PERSONAL tenant all mint it. `core` is NOT a product and NOT `org_admin`. |
| IC-0 §F.2 rule 4 — scope namespaces a consumer may carry | `ORG_ADMIN_SCOPE_KEYS` ∩ held (8 keys: `tenant:admin:profile`, `tenant:admin:domain`, `tenant:admin:sites`, `tenant:admin:user-manage`, `tenant:admin:settings`, `tenant:user:read:directory`, `audit:read`, `auth:session:read`). Never product (`ats`/`esign:*`) or `platform:*` scopes. |
| Host binding | the TENANT host class (consumer-agnostic); never PLATFORM, PORTAL or PRODUCT. No new host class. |
| Who may mint | any active member of an active tenant (so every member can open the App Home). Only organization permissions (the `tenant:admin:*` family) open `/org/*` sections — the FE gate `hasOrgAdminScope` is UX; every section API is `@RequireScopes`-gated. |
| Post-login landing | `/` (App Home). `recruiter` lands at `/ats/` (`CONSUMER_APP_BASE`, `libs/auth-core/src/lib/redirect-uri.ts`). |

Policy code: `libs/identity/src/lib/authorization/consumer-scope-policy.ts` (`requiredCapabilityForConsumer`, `filterScopesForConsumer`).

## 3. Backend-authoritative product availability (§3.D)

`GET /v1/me/products` (core-gated, no scope; `apps/api/src/controllers/me.controller.ts` → `ProductAvailabilityService`,
`libs/identity/src/lib/authorization/product-availability.service.ts`) returns, per product (`ats`, `esign`, `org`):
`subscribed` (the tenant holds the capability), `authorized` (the caller holds a scope/role that can use it), `available`
(subscribed ∧ authorized ∧ activated), `entry_path`, `reason` (`not_subscribed` | `not_authorized` | `not_activated`).
The FE renders these booleans and never derives entitlement; no role is granted automatically. `authorized` is read the way a session mint reads scopes (the membership's site selects the tenant-wide or the site-aware reader — PR-4 §2.4 invariant 6), so App Home never marks a product unavailable for someone the product session would authorize (Gate-6 V1, proven on a real site-scoped membership). Sign's entry is reported
`not_activated` until `ARAMO_SIGN_ENTRY_ENABLED=true` — the Sign PRODUCT host stays dark (§3.H). Amended by
`Aramo-E-Sign-Host-and-Workspace-Architecture-Ruling-v1_0-LOCKED` (2026-10-18): Sign is NOT served under `/sign/` on
the tenant host. Its single sender application is `apps/esign-web` on `esign.aramo.ai` (business accounts at `/sign/`,
personal accounts at `/personal/`, chosen from the backend context), so the activated entry is the absolute URL
`https://esign.aramo.ai/` (`ARAMO_SIGN_ENTRY_URL` overrides it) and App Home opens it directly. See
`doc/runbooks/RELEASE-esign-sender.md`.

A product tile enters the product through that product's consumer login with the entry path sealed as `return_to`
(`/auth/recruiter/login?return_to=%2Fats%2F`), so a product session is minted by its own consumer — the `org` session is
never a product token (§3.G).

## 4. Organization Administration owns shared user management (§3.E/§3.F)

Relocated from ATS Settings into `libs/org-admin-web` (git history preserved), served at `/org/*`:

| `/org/…` | Module | API (scope) |
|---|---|---|
| `profile` | `profile/TenantProfileForm` | `/v1/tenant/profile` (`tenant:admin:profile`) |
| `sites` | `sites/SitesPanel` | `/v1/tenant/sites` (`tenant:admin:sites`) |
| `domain` | `domain/DomainVerificationPanel` | `/v1/tenant/domain-verification` (`tenant:admin:domain`) |
| `users` | `users/UsersListView` (+ invite, roles, lifecycle dialogs) | `/v1/tenant/users*`, `/v1/tenant/roles-catalog` (`tenant:admin:user-manage`), settings probe (`tenant:admin:settings`) |
| `roles` | `roles/RolesMatrixView` | `/v1/tenant/roles-catalog` |
| `audit` | `audit/AuditLogView` | `/v1/tenant/audit-events` (`audit:read`) |
| `localization`, `security`, `billing` | honest seams (no substrate) | — |

Stayed ATS-owned (`/ats/admin/*`): teams and the reporting hierarchy, career portal / apply flow seams, email templates,
engagement policy, recruiting settings (compensation display + the financials grant), document templates, import,
data & compliance (ATS-entity export, RTBF status), custom fields, integrations, the admin tools landing and the
per-record assignment/consent editors. The ATS settings rail's first group links out to Organization administration.
The ATS keeps a product-owned READ client of the roster and roles catalog for its assignment enrichment
(`apps/ats-web/src/users/users-api.ts`); nothing there mutates.

**ATS role assignment is entitlement-gated** (§3.F): `ATS_PRODUCT_ROLE_KEYS` (12 roles incl. `tenant_owner` /
`tenant_admin`; excludes `org_admin`, `super_admin`, `esign_*` and the portal persona) refuse with
`VALIDATION_ERROR` reason `ats_role_not_entitled` in a tenant without `ats`, on every tenant-side assignment path. The
provisioning saga passes the capabilities it is about to grant (`provisioning_capabilities`) so the owner is created
before the entitlement rows are written; no bulk grant exists.

Shared presentational atoms moved to `@aramo/fe-foundation` (move-not-fork): `SurfaceCard`/`SurfaceCardHead`,
`StatusPill`/`Tag`/`TagList`, `safeErrorMessage`, `formatDate`/`formatInstant`, the settings primitives and
`ui/settings.css`. ats-web re-exports them from its `ui/` and `settings/components.tsx` barrels (call-sites unchanged).

## 5. Consumer-isolated sessions (D-ORG-4, §3.G)

Before D-ORG every consumer wrote the same host-only cookies, so a second consumer's login on one host overwrote the
first. Now each consumer owns its own jar on the host:

| Cookie | Path | Notes |
|---|---|---|
| `aramo_access_token_<consumer>` | `/` | JWT; `consumer_type` claim must equal the suffix |
| `aramo_refresh_token_<consumer>` | `/auth` | rotation / family / revocation unchanged |
| `aramo_pkce_state_<consumer>` | `/auth` | sealed state now also carries `return_to` |

Unchanged: HttpOnly, Secure (outside `AUTH_ALLOW_INSECURE_COOKIES`), SameSite, host-only (no apex cookie — IC-0 §F.2
rule 7), PKCE, host binding (IC-2 PR-4/PR-5), refresh rotation and revocation, the authz-version check, the Cognito
logout redirect (HF3 R1–R7). Legacy unsuffixed names are still READ as a fallback (a session minted before the deploy
keeps working until it expires), are retired by the first `/refresh` that migrates them, and are cleared on every logout.

Selection (`libs/auth/src/lib/session-cookie-names.ts`, `JwtAuthGuard`): the FE sends `X-Aramo-Consumer`
(`libs/fe-foundation/src/api/client.ts`); the guard reads that consumer's cookie and refuses 401 `INVALID_TOKEN` on
`consumer_header_mismatch` (token minted for another consumer), `invalid_consumer_header`, or
`ambiguous_consumer_cookie` (no header and more than one consumer cookie present). A cookie minted for one consumer is
never accepted under another consumer's `/auth/<c>/*` routes (existing consumer-mismatch refusal preserved).

Logout: `POST /auth/<c>/logout` revokes and clears that consumer only; `GET /auth/<c>/logout` (the browser sign-out) is
a **global sign-out** — every consumer refresh token present is revoked (`identity.session.revoked`, reason
`logout_all`), every consumer cookie and the legacy names are cleared, then the Cognito sign-out redirect runs. With no
Aramo cookies present it is an idempotent no-op before the redirect.

`return_to` (D-ORG-2): `?return_to=` on `/auth/<c>/login` is accepted only as a same-host RELATIVE path (no scheme,
authority or `//`, ≤ 2000 chars) inside that consumer's own app base (`sanitizeReturnTo`), sealed in the PKCE state,
and applied at the callback (`derivePostLoginRedirect`). Anything else silently falls back to the consumer's default
landing. Landing precedence (Gate-6 V4): `AUTH_POST_LOGIN_PATH_<CONSUMER>` → the consumer's built-in base → the legacy global `AUTH_POST_LOGIN_PATH` only for a consumer without a built-in base.

## 6. Governance reconciliation (§4) — amendments RATIFIED and LOCKED

Ratified by the Lead Architect (2026-10-17, "D-ORG — Final Governance Ratification") and filed byte-for-byte to
`OneDrive/Aramo/locked/` (filename-only transition from `-RATIFICATION-PENDING` to `-LOCKED`; SHA-256 unchanged;
`.sha256` sidecars beside each; filing record `Aramo/documents/ARAMO-D-ORG-Amendments-Filing-Record-20261017.md`):

| LOCKED instrument | SHA-256 | Reconciles |
|---|---|---|
| `Aramo-D-ORG-Amendment-A1-IC-0-F2-Rules-3-4-Org-Consumer-v1_0-LOCKED.md` | `67c2f27ba8bca58a1506c1260e0e7d6fa6cea8b72dd836f8aafd78e642870440` | IC-0 Gate-0 Report §F.2 rules 3, 4 and 7: `org` → `core`; the organization scope subset; host-only, consumer-suffixed cookies; availability parity (V1) |
| `Aramo-Auth-Decoupling-PR-4-Directive-Amendment-A3-Consumer-Isolated-Sessions-and-Return-To-v1_0-LOCKED.md` | `01deac383845a1eafb365898e41e9769f9bd307bac222a2b2fd1c6e1d905f7d7` | PR-4 §2.4 invariant 5, A2 §1 row 2, A2 §2 item 3: consumer-suffixed cookies, the consumer header, global GET sign-out, legacy-cookie retirement, `return_to`, governed landing precedence |
| `Aramo-AUTHZ-2-Platform-Tier-Directive-Amendment-A1-Sixth-Consumer-Org-v1_0-LOCKED.md` | `b943a357a9945550b3da3c68c6d2419c4cb760b57b89b8e471b68faa1099d2ab` | AUTHZ-2 §1: six consumers; the DDR §13.1 both-direction tripwire unchanged; `org` never carries `platform:*` |

No security invariant beyond the rulings was changed; no HALT condition was met.

## 7. Release status

Merged to `main` 2026-10-18 (PR #957, merge commit `e478e7ac`). Not deployed, Sign PRODUCT-host login not activated, no Cognito/DNS/nginx production change. The external
activation steps are in `doc/runbooks/RELEASE-app-home-org.md`.
