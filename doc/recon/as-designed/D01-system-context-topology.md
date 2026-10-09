# D01 — System Context, Topology & Monorepo Map (AS-DESIGNED)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED
> Sourced ONLY from ratified ADRs under `doc/adr/*`. No intent synthesized from code.

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
multi-schema topology.

`:65` (§5 Invariants): "consistent with I1 (UUID-only cross-schema, no FK)" — the
intended cross-schema reference discipline.

## Front door — nginx + wildcard TLS

`doc/adr/0023-frontdoor-nginx-wildcard-tls.md:25` (§Decision): adopt
**nginx** as the front door (replacing the prior reverse-proxy named in that ADR), and replace on-demand per-host issuance with a single
`*.aramo.ai` wildcard certificate obtained by a certbot DNS-01 sidecar via
Route53."

`:29`–`:34` (Decision 1): nginx "terminates TLS on 80/443 and reverse-proxies the
same three host classes… tenant (`/v1/`, `/auth/`, exact `jwks`, the Indeed
webhook), admin (`/auth/`, `/platform/`, `jwks`, **no `/v1`** — R14), portal
(`/v1/portal/` only). Upstreams are the compose service names." This is the
intent behind the as-built routing map; the sign host (`/v1/esign/signing/`) is a
later DOC-4 addition layered on the same three-class design.

`:45`–`:49` (Decision 4): the explicit proxy-header contract + `trust proxy = 1`
intent.

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

## No-anchor areas (explicit)

- **Vite SPA dev-port assignments (4201–4204)** have no ratified ADR anchor; they
  are an as-built convention recorded in the app `vite.config.ts` comments, not a
  ratified design decision. No AS-DESIGNED source exists.
- **The split between `infrastructure/` (ECS/ALB/VPC environments) and
  `infrastructure-lightsail/` (single box)** — ADR-0023 and ADR-0012 cover front
  door + IaC conventions, but no single ratified ADR at this SHA declares the
  two-track infra topology (ECS environment set vs the deployed Lightsail box) as
  the intended end-state. Treated as a gap (see gap fragment), not an anchor.
- **Exact 8-app / 76-lib count** is not fixed by any ADR; the ADRs rule *posture*
  (modular monolith, hard boundary), not a specific project count.
