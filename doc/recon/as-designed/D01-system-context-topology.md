# D01 — System Context, Topology & Monorepo Map (AS-DESIGNED)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED
> Sourced ONLY from ratified ADRs under `doc/adr/*` and LOCKED directives in the canonical `Aramo/locked/` folder (cited by file name and section). No intent synthesized from code.

## Monorepo posture — modular monolith, extract when forced

`doc/adr/0029-pipeline-boundary-modular-monolith.md:26` (§2 D1): the Pipeline
"stays in the monorepo, with the boundary made HARD… Portability is guaranteed
not by physical separation but by continuously-verified extractability."

`:28` (D2): "the Pipeline intelligence libs MUST NOT directly import the ATS
libs… Enforced via **nx boundary tags**; the build FAILS on a violating import."
This is the intent behind the `SCOPE_DEP_CONSTRAINTS` wall observed as-built.

`:30` (D3): cross-boundary calls go "only through a first-class, versioned,
Pact-tested connector contract, even in-process."

`:63` (§5): "The Pipeline and ATS share a repo and a database instance (separate
schemas) until a forcing function arrives" — the intended single-DB,
multi-schema topology. **Superseded for Talent Intelligence only** by ADR-0036
(see next sub-section); it still governs the Pipeline/ATS relationship.

`:65` (§5 Invariants): "consistent with I1 (UUID-only cross-schema, no FK)" — the
intended cross-schema reference discipline.

### Talent Intelligence as an independent service — ADR-0036 + ATI-SEP-1

`doc/adr/0036-talent-intelligence-service.md:3`–`5`: Status Accepted,
2026-10-23. `:12`–`16`: supersedes ADR-0029 `:63` for Talent Intelligence only —
"The forcing function is named in Decision 2."

`:40`–`48` (Decision 1, "Two products, one contract"): ATS (`apps/api`,
`apps/ats-web`, `scope:ats`, shared Aramo DB) and TI
(`apps/talent-intelligence-service`, `scope:intelligence`, "own database
`aramo_intelligence`, own role (`INTELLIGENCE_DATABASE_URL`)").
`:50`–`54`: "`scope:ats` must not depend on `scope:intelligence`.
`scope:intelligence` must not depend on `scope:ats` or `scope:cip`. Both may
depend on `scope:shared`." `:56`–`57`: "The only shared code is
`libs/intelligence-contracts` (`scope:shared`)".

`:67`–`75` (Decision 2): database `aramo_intelligence` "on the existing Postgres
server … can later be lifted to its own host by changing only the URL";
migrations in `libs/intelligence-core/prisma/migrations` applied by a
per-database runner with its own ledger, invoked from `deploy/migrate-prod.sh`.

Governing directive `Aramo-ATS-TI-Separation-Program-Directive-v1_0-LOCKED.md`
(Status LOCKED, PO-ratified 2026-10-23) §3 item 1: "ATS Add Talent is ATS-local.
There is no runtime or build dependency on Talent Intelligence"; §3 item 2: TI
"runs as `apps/talent-intelligence-service` with its own database and role on
the existing Postgres server, its own migration ledger, and its own capability
`intelligence` (default OFF)"; §4 ruling A-c: "Skills taxonomy becomes
`scope:shared` reference data. Embedding and matching remain ATS-local."
Addendum `…-Addendum-A2-PO-Rulings-LOCKED.md` (LOCKED 2026-10-23) row A-c adds:
"Governance (curation, aliases, publish; matching configuration) is exposed in
`apps/platform-admin` behind platform-operator authorization … ATS matching
execution stays ATS-side." A2 does not restate the `scope:shared` re-tag; per
the amendment rule the parent text stands where A2 is silent.

## Front door — nginx + wildcard TLS

`doc/adr/0023-frontdoor-nginx-wildcard-tls.md:25` (§Decision): adopt
**nginx** as the front door (replacing the prior reverse-proxy named in that ADR), and replace on-demand per-host issuance with a single
`*.aramo.ai` wildcard certificate obtained by a certbot DNS-01 sidecar via
Route53."

`:29`–`:34` (Decision 1): nginx "terminates TLS on 80/443 and reverse-proxies the
same three host classes… tenant (`/v1/`, `/auth/`, exact `jwks`, the Indeed
webhook), admin (`/auth/`, `/platform/`, `jwks`, **no `/v1`** — R14), portal
(`/v1/portal/` only). Upstreams are the compose service names." This is the
intent behind the as-built routing map; the sign host is a later addition
layered on the same design (next sub-section).

`:45`–`:49` (Decision 4): the explicit proxy-header contract + `trust proxy = 1`
intent.

### Sign host — one Aramo Sign application

`Aramo-Sign-Unified-Product-Permission-Contract-Platform-API-Directive-v1_0-LOCKED.md`
(LOCKED, relayed 2026-10-19) §4.1.2 (line 54): "One supported front-end
application and Nx project, tagged `scope:sign`. `apps/esign-web` and
`apps/sign-web` are consolidated; there is no second Sign front end." §4.1.3
(line 56 ff.): three authentication zones on the one host — guest signing
(`/s/:token`, `/d/:token`, capability token only), public entry (`/login`,
`/signed-out`, `/signup`), workspace (everything else, Aramo SSO session); with
security headers and rate limiting on guest-signing and signup routes.

`Aramo-Sign-Unified-Product-D1-Host-Retirement-Addendum-v1_0-LOCKED.md`
(LOCKED, 2026-10-19) "Final host topology" (lines 8–18): canonical host
`sign.aramo.ai`; `esign.aramo.ai` "**Retired entirely — no redirect**"; "Back end
— Independent modular services preserved". **This addendum overrides parent
§4.1.1**, which had made `esign.aramo.ai` a compatibility redirect.

`Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED.md` (LOCKED 2026-10-20)
§1: internal identifiers move from `esign` to `sign` across "the backend service
and nx projects; the database schema; the API contracts; the authentication
consumer" — "an identifier migration only", preserving `ESIGN_*` error codes
(P-1) and `/v1/webhooks/esignature/*` (P-3).

`Aramo-Domain-Enforcement-P3-One-Organization-Per-Domain-Directive-v1_0-LOCKED.md`
(LOCKED) §4 (line 100): "the sign host gets a **narrow nginx exception**:
`/v1/tenant/domain-verification` and `/v1/domain-verification/delegate/*` are
proxied to apps/api. Nothing else of apps/api is exposed."

### Tenant host — App Home + ATS on one host

`Aramo-D-ORG-Amendment-A1-IC-0-F2-Rules-3-4-Org-Consumer-v1_0-LOCKED.md` §1
(line 13, rule 7): "Because the App Home (`org`) and the ATS (`recruiter`) now
share ONE tenant host (topology T1), each consumer's session is held in a
consumer-suffixed, host-only cookie". Its header (line 3) still carries the
pre-filing text "RATIFICATION PENDING … to be filed LOCKED, unchanged, on
ratification"; the file is filed in `locked/` under a `-LOCKED` name, which by
that text is its ratification. `Aramo-ORG-UX-1-App-Home-and-Organization-Redesign-Implementation-Directive-v1_0-LOCKED.md`
(LOCKED 2026-10-21) builds on that topology (home-web App Home + org-admin-web).

## Cross-service event substrate

`doc/adr/0033-cross-service-durable-event-foundation.md:50`–`57` (§Decision 1):
"PostgreSQL remains the authoritative transactional system of record… Durable
cross-service publication uses a transactional outbox… drained by an outbox
publisher that dispatches through an `OutboxPublisherPort` whose default adapter
publishes to a custom Aramo EventBridge bus. EventBridge rules route each domain
event to one or more consumer-owned SQS queues; each important queue carries a
DLQ + redrive policy."

`:59` (§Decision 1): "**EventBridge is the default Aramo cross-service domain-event
router**, replacing the ADR-0018-deferred SNS router."

`:67`–`:70`: "Business/domain code must not call EventBridge, SQS, or any AWS SDK
directly; all AWS transport/runtime concerns sit behind explicit infrastructure
ports/adapters." (Intent behind the `talent-intake-events` IaC module +
LocalStack local runtime observed as-built.)

`:72`–`:74`: "BullMQ may remain for purely service-local jobs… but is not the
canonical cross-service event backbone."

ATI-SEP-1 §3 item 6 and ruling E-1 reuse this envelope for ATS → TI
(`talent.created`, `talent.profile_changed`, "using the ADR-0033 envelope with
`event_version: 'v1'`"); ruling E-2: service-to-service calls use a
token-exchange client, webhooks use HMAC signing.

## Governing principle — build for tenant #50

`doc/adr/0020-build-for-tenant-50-governing-principle.md:35` (§Decision): "Aramo is
built for tenant #50, not for Astre. Astre is the test harness."

`:49`–`:53` (rule 2): "A new tenant must be a DATA operation, not an
INFRA/ENGINEERING operation… never a human hand-touching DNS, the prior front-door proxy, IAM, or
code." — the intent that the single front door + wildcard cert topology must
support onboarding without per-tenant infra.

## Infrastructure / build conventions

`doc/adr/0003-infrastructure-conventions-prisma7-build-ci.md:19` (Decision 1):
workspace-root `prisma.config.ts` Prisma 7 model. `:65` (Decision 5): generator
output `./generated/client`. `:73` (Decision 6): multi-schema usage within one
Prisma client. `:85` (Decision 7): cross-lib TypeScript resolution via dist
`.d.ts` path overrides — the intent behind the per-lib schema + `@aramo/*` path
topology.

`doc/adr/0018-background-jobs-substrate.md:49` (Decision 1): BullMQ pattern
convention; `:93` (Decision 3): job-to-lib ownership + dedicated job-module rule —
the intended placement of background jobs relative to the lib graph.

### Single-box go-live topology (LOCKED, out-of-repo)

`Aramo-Astre-Single-Box-Go-Live-Spec-v1_0-LOCKED.md` (ratified by PO
2026-06-21) §1 (lines 21–51): "One Lightsail instance running a small Docker
stack" with the D1 containers, Postgres on a persisted volume and Redis; §0
(lines 14–19): "platform Terraform held in reserve"; §8 (lines 103–109): "The
D2 Terraform apply (Fargate/ALB/Redis/Secrets/VPC) — reserved, untouched" until
go-live #2, with "The box→platform migration (dump/restore + apply + DNS flip)"
as a discrete step. `Aramo-Single-Box-Directive-4-Lightsail-Terraform-v1_0-LOCKED.md`
§B (lines 21–27): `infrastructure-lightsail/` is "a new, separate root … ZERO
references to the platform". The Go-Live Spec §1 names an auto-HTTPS proxy as
the recommended front door; ADR-0023 (Accepted 2026-07-24) later superseded that
choice with nginx + certbot.

## No-anchor areas (explicit)

- **Vite SPA dev-port assignments (4201–4206)** have no ratified ADR anchor; they
  are an as-built convention recorded in the app `vite.config.ts` comments, not a
  ratified design decision. No AS-DESIGNED source exists.
- **The split between `infrastructure/` (ECS/ALB/VPC environments) and
  `infrastructure-lightsail/` (single box)** — now anchored out-of-repo by the
  Single-Box Go-Live Spec §0/§8 and Single-Box Directive 4 §B (box now, platform
  held in reserve for go-live #2). No in-repo ADR at this SHA records that
  two-track intent; see gap D01-G1.
- **Exact 10-app / 80-lib count** is not fixed by any ADR; the ADRs rule *posture*
  (modular monolith, hard boundary, TI as its own service), not a specific
  project count.
- **`talent-intake-worker` as a separate compose service** (same image,
  different command) has no ratified anchor found beyond ADR-0033's
  transport-port posture; the single-box transport choice is recorded only in
  code comments (`docker-compose.prod.yml:290`–`296`).
