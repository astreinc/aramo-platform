# D03 — Backend API Surface (REST + OpenAPI) (AS-DESIGNED)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED
> Sourced ONLY from ratified ADRs under doc/adr/*. Not synthesized from code.

## Scope of available anchors

No single ratified ADR defines the *whole* backend API surface or the OpenAPI
publication contract end-to-end. The governing documents that do exist speak to
**REST endpoint conventions**, **error/observability conventions**, and the
**OpenAPI machine-readable refusal annotations**. The method+path contract-parity
wall itself (GLH-1-C, "ATS Go-Live Hardening Charter v1.5") is cited *by* the code
(ci/scripts/verify-api-contract-parity.ts:1) but its ratified text is a LOCKED
directive held in OneDrive, **not present under doc/adr/** at this SHA — so its
design intent cannot be quoted here. See NO ANCHOR section.

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
  intent (API Contracts v1.0 Phase 4 "Four-Layer LinkedIn Refusal Enforcement") places
  machine-readable constraints into the spec: `x-prohibited-values` extensions (Layer 2) and
  schema-level `const` constraints such as `linkedin_automation_allowed: {type: boolean,
  const: false}` (Layer 4) "so any response saying 'true' fails OpenAPI validation."
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
  route recognized by the parity wall (ci/scripts/verify-api-contract-parity.ts:45).

## NO ANCHOR (explicit gaps in ratified design coverage)

- **The contract-parity taxonomy itself** (XP/AP/SS/AD/PZ/IZ classes, the
  `transitionalUndocumented` ratchet, method+path-only parity) is defined by GLH-1-C
  Charter v1.5 — a LOCKED directive NOT present under doc/adr/* at this SHA. Its intent is
  only paraphrased inside the code header (ci/scripts/verify-api-contract-parity.ts:1-25);
  there is **no ratified ADR anchor** to cite for it here.
- **Global guard/pipe posture** (no `APP_GUARD`; per-controller `@UseGuards`; global
  `ValidationPipe whitelist+forbidNonWhitelisted`) has **no ADR anchor**; it is an
  implementation convention only.
- **Scope-key catalog authority & bijection rule** has no doc/adr anchor; it is governed by
  seed guards (D-SEED-SCOPES-1) referenced in engineering memory, not a ratified ADR.
- **Multi-app split (4 backend deployables) and port assignments** — no ADR anchor; stated
  only in app bootstrap comments (apps/platform-admin/src/main.ts:11 "Option-1 structural
  separation of D1").
