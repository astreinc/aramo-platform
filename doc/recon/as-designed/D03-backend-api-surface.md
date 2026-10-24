# D03 — Backend API Surface (REST + OpenAPI) (AS-DESIGNED)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED
> Sourced ONLY from ratified ADRs under doc/adr/* and LOCKED directives (OneDrive `Aramo/locked`, cited by file name + line). Not synthesized from code.

## Scope of available anchors

No single ratified ADR defines the *whole* backend API surface or the OpenAPI
publication contract end-to-end. The governing documents that do exist speak to
**REST endpoint conventions**, **error/observability conventions**, the
**OpenAPI machine-readable refusal annotations**, and — since 2026-10-15 — a family of
LOCKED Sign directives plus ADR-0036 that fix **which service hosts which route family,
the auth zones, and the OpenAPI/manifest upkeep obligation** for the Sign and Talent
Intelligence surfaces (ADR-0036 and the Anchor 7–10 sub-sections under Anchor 6). The method+path contract-parity wall itself
(GLH-1-C, "ATS Go-Live Hardening Charter v1.5") is cited *by* the code
(ci/scripts/verify-api-contract-parity.ts:1) but its ratified text is a LOCKED directive
held in OneDrive, **not present under doc/adr/** at this SHA — so its design intent cannot
be quoted here. See NO ANCHOR section.

## Anchor 1 — Read-endpoint response & scoping conventions (ADR-0007)

doc/adr/0007-consent-state-read-endpoint-and-read-endpoint-conventions.md §3:
- **Decision A — Wrapped response shape.** Read endpoints return a wrapped object,
  never a bare array; the wrapper is the home of envelope-level metadata. "Bare-array
  responses are a known forward-compatibility trap."
- **Decision B — Single-tenant scoping derived from JWT.** The endpoint accepts only
  the resource id as a path parameter; `tenant_id` is derived from `authContext.tenant_id`
  and "never accepted from the URL, query string, or body." Design rationale: eliminates
  the tenant-confusion bug class.
- **Decision D — Deterministic shape.** Always return the full deterministic set of
  entries (one per catalog constant), so clients never defensively check for missing items.
- **Decision E — Read vs. enforcement boundary.** Read endpoints must not compute or
  expose enforcement metadata (e.g. staleness); enforcement logic lives only on the
  check/enforcement endpoint. "The boundary between informational (read) and enforcement
  (check) is load-bearing."
- **Decision F — Schema-now-detection-later.** Establish a schema field now (even if a
  constant literal) so detection logic can ship later "without a breaking API change."
- **Decision H — Reads do not write decision-log entries.** Read observability belongs to
  standard request logging, not the audit/decision log.

## Anchor 2 — Read-endpoint maturation & query-param validation (ADR-0008)

doc/adr/0008-read-endpoint-maturation-and-handoff-conventions.md §2–3:
- Read-endpoint conventions from ADR-0007 are ratified as **durable across endpoints**
  (inherited cleanly by the second read endpoint without re-derivation).
- **Enumerated query-parameter validation for read endpoints** is a codified standing item
  (§2 item 4) — query params with closed value sets are validated against the enum.
- Cursor opacity (opaque pagination cursors) is promoted to a program-wide standard.

## Anchor 3 — Consent check/revoke contract conventions (ADR-0005, ADR-0006)

- doc/adr/0006-consent-check-contract-and-resolver-path-conventions.md — the check-endpoint
  contract and resolver path conventions that ADR-0007/0008 extend.
- doc/adr/0005-consent-revoke-contract-and-audit-semantics.md — state-changing (write)
  endpoints DO record audit/decision-log semantics (the counterpart to ADR-0007 Decision H).

## Anchor 4 — OpenAPI machine-readable refusal annotations (ADR-0011)

doc/adr/0011-r7-allowlist-extension-for-openapi-prohibited-values.md:
- OpenAPI specs are a **refusal-enforcement surface**, not merely documentation. The design
  intent (API Contracts v1.0 Phase 4, the four-layer R7 social-network refusal-enforcement design) places
  machine-readable constraints into the spec: `x-prohibited-values` extensions (Layer 2) and
  schema-level `const: false` boolean constraints on the R7-sealed integration's automation flag
  (Layer 4) "so any response saying 'true' fails OpenAPI validation."
- OpenAPI nullable is expressed per the redocly-lint contract as `type: [T,'null']`
  (not `nullable: true`) — the lint target `openapi:lint` is the ratified enforcement.

## Anchor 5 — Observability conventions (ADR-0013)

doc/adr/0013-observability-conventions.md — request-id propagation and structured logging
conventions that the API surface honors (the `request_id` field on the error envelope and the
`RequestIdMiddleware` applied to all routes are the surface of this intent).

## Anchor 6 — Service/boundary topology (ADR-0029, ADR-0030, ADR-0033)

- doc/adr/0029-pipeline-boundary-modular-monolith.md (LOCKED variant
  Aramo-ADR-0029-...-LOCKED.md) — the Pipeline⊥ATS boundary: cross-L3 only by UUID ref +
  versioned connector contract; nx boundary tags enforce it. Constrains how controllers in
  pipeline libs may depend on ATS libs.
- doc/adr/0030-external-lifecycle-authority.md — external lifecycle authority / connector
  mapping-admin route conventions (the `v1/integrations/:connectionId/...-mappings` surface).
- doc/adr/0033-cross-service-durable-event-foundation.md — durable async intake transport
  (Outbox → EventBridge → SQS → Lambda); the SSE notification stream is the first `@Sse`
  route recognized by the parity wall (ci/scripts/verify-api-contract-parity.ts:44-46).
- doc/adr/0036-talent-intelligence-service.md (Status: Accepted, :3; Date 2026-10-23, :5) —
  Talent Intelligence is a separate service with its own HTTP API: the ATS publisher calls
  `POST /v1/ingest/talent` with a service token (:86-90); TI notifies ATS by an HMAC webhook
  to `POST /v1/integrations/intelligence/events` and ATS then reads
  `GET /v1/references/{tenant}/{talent}/profile` (:96-99); TI issues client-credentials
  tokens and signs webhooks with a shared secret (Service auth E-2, :107-111). The ADR is
  silent on OpenAPI coverage and nginx exposure for TI.

### Anchor 7 — Sign route family, auth zones and API surface (Sign LOCKED directives)

- **Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED.md** (LOCKED 2026-10-20, :3) §3.6
  (:121-133): `/v1/esign/*` → `/v1/sign/*`; `/v1/integrations/esign/events` →
  `/v1/integrations/sign/events`; headers `x-aramo-esign-*` → `x-aramo-sign-*`; S2S scheme
  `aramo-esign-s2s-v1` → `aramo-sign-s2s-v1`. P-3 (:25) keeps `/v1/webhooks/esignature/*`
  (DocuSign, Adobe) unchanged; P-1 (:23) keeps `ESIGN_*` error codes. §4 (:163) requires
  "API, OpenAPI, Pact, route-manifest and webhook contract updates."
- **Aramo-Sign-Unified-Product-Permission-Contract-Platform-API-Directive-v1_0-LOCKED.md**
  (LOCKED, PO relay 2026-10-19, :4):
  - §4.1.3 (:58-62) three zones — guest signing (capability token only), public entry
    (signup "stays dark unless separately authorized"), workspace (SSO session with
    server-side capability/permission/ownership checks "on every API call").
  - §4.2 (:70) rate limiting on all public signer routes and adding the signer operations
    missing from the Sign OpenAPI spec.
  - §4.4.3 (:119) credentials are short-lived, audience-bound, tenant-scoped, hashed at rest;
    location on a private network is never the sole identity signal.
  - §4.4.5 (:123) one versioned Sign API "using the existing OpenAPI and Pact
    infrastructure"; external exposure is first-party first, third-party public activation
    separately approved (also D-13, :176).
  - §4.5 (:127) and S-6 (:147) — ATS's unauthenticated internal call path is eliminated
    **only after** the authenticated replacement is validated and fully migrated.
  - §9 (:186) production DNS/nginx/Cognito changes, public third-party API activation, live
    billing and public signup each need separate authorization.
- **Aramo-Sign-Unified-Product-S6-ATS-Migration-Addendum-v1_0-LOCKED.md** (LOCKED,
  2026-10-19, :4) — S-6 Option A approved with authenticated installation binding (:11);
  internal transport fallback is retained (:34); switching production ATS transport to `api`
  and destructive removal of internal compatibility paths are **not authorized** (:38).
- **Aramo-E-Sign-Host-and-Workspace-Architecture-Ruling-v1_0-LOCKED.md** (RATIFIED,
  2026-10-18) — tenant/kind/entitlement come from backend context, never the URL (:34);
  three auth zones preserved (:38). Its host topology (sender host at the retired e-sign host,
  :10-18) is **superseded** first by the Permission-Contract directive and then by
  **Aramo-Sign-Unified-Product-D1-Host-Retirement-Addendum-v1_0-LOCKED.md** (LOCKED
  2026-10-19, :4), which overrides Permission-Contract D-1/§4.1.1 (:5-6): sign.aramo.ai is the
  only Sign host and the old host is retired with no redirect (:12-18).
- **Aramo-Sign-Personal-Free-Launch-Directive-v1_1-Amendment-A1-v1_0-LOCKED.md** (LOCKED
  2026-10-22, :7; takes precedence over v1.1, :5) A1-10 (:163-176) — adds
  `GET /v1/sign/account/status`, `POST /v1/sign/account/close`, `GET /v1/sign/legal/status`,
  `POST /v1/sign/legal/accept`, enrolled in `ci/config/api-surface-manifest.json` as AP; there
  is no public unauthenticated legal-acceptance authority.
- **Aramo-Sign-Standalone-Product-Final-Implementation-Authorization-v1_0-LOCKED.md**
  (LOCKED, 2026-10-18, :4) §2 (:70) — verified billing webhooks; tests must cover refusal of
  forged and out-of-order webhooks (:106).

### Anchor 8 — Public signup surface (platform-admin)

- **Aramo-Sign-Signup-Federated-Owner-Directive-v1_2-LOCKED.md** (LOCKED, filed 2026-10-20,
  :4) — public signup disabled (:27); §6 (:126-127) public signup and live charging not
  authorized. **Amendment A1 Organization-Details-US-Only** (LOCKED 2026-10-21, :4) overrides
  v1.2 §3 R2/R3, §4, §5 (:8-11) and adds `POST /v1/signup/sign/address/suggest` proxied by
  platform-admin, token-gated, rate-limited, 404 while signup is off (§2.3, :87-97).
- **Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED.md** (LOCKED, :5) §10 (:287-289)
  — Personal mode ships `off`, so Personal signup answers 404.

### Anchor 9 — Host exposure exceptions

- **Aramo-Domain-Enforcement-P3-One-Organization-Per-Domain-Directive-v1_0-LOCKED.md**
  (LOCKED, 2026-10-21, :5) §4 (:100) — the Sign host gets a narrow nginx exception proxying
  only `/v1/tenant/domain-verification` and `/v1/domain-verification/delegate/*` to apps/api;
  "Nothing else of apps/api is exposed." §5 (:117) the delegate routes are session-less and
  rate-limited with the token never in the path.

### Anchor 10 — Auth surface documentation (AUTH-SIGNIN-1)

- **Aramo-AUTH-SIGNIN-1-Unified-Branded-Sign-In-Directive-v1_0-LOCKED.md** (LOCKED, filed
  2026-10-20, :4) §3.1 (:34-41) — optional `idp` query on `GET /auth/{consumer}/login` (tenant
  pin wins) and a new unauthenticated `GET /auth/{consumer}/login-options`; §3.1.4 (:44)
  "document `idp`, `return_to` … and `login-options` in `openapi/auth.yaml`."

## NO ANCHOR (explicit gaps in ratified design coverage)

- **The contract-parity taxonomy itself** (XP/AP/SS/AD/PZ/IZ classes, the
  `transitionalUndocumented` ratchet, method+path-only parity) is defined by GLH-1-C
  Charter v1.5 — a LOCKED directive NOT present under doc/adr/* at this SHA. Its intent is
  only paraphrased inside the code header (ci/scripts/verify-api-contract-parity.ts:1-25);
  there is **no ratified ADR anchor** to cite for it here.
- **Global guard/pipe posture** (no `APP_GUARD`; per-controller `@UseGuards` or composite
  boundary decorators; global `ValidationPipe whitelist+forbidNonWhitelisted`) has **no ADR
  anchor**; it is an implementation convention only. The Sign Permission-Contract directive
  requires server-side checks "on every API call" (§4.1.3, :58-62) but does not mandate a
  default-deny guard mechanism.
- **Scope-key catalog authority & bijection rule** has no doc/adr anchor; it is governed by
  seed guards (D-SEED-SCOPES-1) referenced in engineering memory, not a ratified ADR.
- **Multi-app split (5 backend deployables) and port assignments** — no ADR anchor for the
  full split; ADR-0036 anchors the TI service's existence but not its port, and the port list
  is stated only in bootstrap comments (apps/talent-intelligence-service/src/main.ts:10;
  apps/platform-admin/src/main.ts:11 "Option-1 structural separation of D1").
- **OpenAPI `servers:` block convention** — no anchor in any reviewed source.
- **Not ratified:** doc/directives/Aramo-E-Sign-Multi-Provider-Addendum-A1-Precedence-and-Traceability-v1_0.md
  self-describes as a "program record" authored by the executor (:6-7), not a LOCKED
  directive, and is not cited as intent.
