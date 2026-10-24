# D14 — Cross-Cutting Platform & External Integrations (AS-DESIGNED)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED
> Ratified intent ONLY, cited from `doc/adr/*`, `doc/directives/*-LOCKED.md`, and LOCKED directives in OneDrive `Aramo/locked` (cited by file name + line). Not synthesized from code.

## ADR-0033 — Cross-Service Durable Event Foundation

Source: `doc/adr/0033-cross-service-durable-event-foundation.md` (Status: Accepted; Date 2026-10-07).

- **Decision 1 — Canonical transport = Outbox → EventBridge → consumer-owned SQS**
  (`doc/adr/0033-cross-service-durable-event-foundation.md:48`). Postgres is the
  authoritative transactional SoR; a transactional outbox is written in the same transaction
  as business state and drained by an outbox publisher through an `OutboxPublisherPort` whose
  default adapter publishes to a custom Aramo EventBridge bus; rules route to consumer-owned
  SQS; each important queue carries a DLQ + redrive; delivery is at-least-once and every
  consumer is idempotent. Business/domain code **must not** call EventBridge/SQS/any AWS SDK
  directly (`:67`). BullMQ may remain for service-local jobs (e.g. the outbox-publisher's own
  poll tick) but is not the cross-service backbone (`:73`).
- **Decision 2 — Orchestration application-owned by default; Step Functions only where it earns it**
  (`:76`). The current résumé-extraction flow is one bounded idempotent operation, so it uses
  application-owned orchestration, not a state machine. A state machine may never hold
  authoritative Talent business state (`:88`).
- **Decision 3 — Lambda-first behind a runtime-neutral handler; Fargate as approved fallback**
  (`:93`). The SQS consumer logic lives in a runtime-neutral
  `TalentIntakeMessageHandler.handle(event)`; a thin SQS→Lambda adapter wraps it. A list of
  production-readiness bounds (max artifact size, bounded extraction duration, LLM-call timeout
  below the Lambda budget, explicit SDK retry, SQS visibility aligned to Lambda timeout,
  idempotency on retry, bounded concurrency, DLQ + CloudWatch alarms) must be met before
  production closure (`:109`).
- **Decision 4 — Canonical event envelope** (`:124`): `event_id`, `event_type`,
  `event_version`, `tenant_id`, `source`, `subject_type`, `subject_id`, `occurred_at`,
  `correlation_id`, `causation_id`, `payload`. `tenant_id` is routing/context metadata, not
  authorization authority; consumers revalidate ownership. Domain-local physical outbox tables
  are retained behind the common port; one global outbox table is not required; envelope columns
  are added additively (ADD-not-rename).
- **Decision 5 — Source-agnostic Talent Intake; single promotion authority** (`:137`). Many
  sources may create Talent Intake, but only the Talent domain authority may create or promote
  canonical `TalentRecord` state (`:147`).
- **Decision 6 — Preserved durable intake semantics** (`:151`): transport/platform refactor,
  not a product rewrite.
- **Consequences / Negative** (`:176`): new AWS surface to own (EventBridge/SQS/Lambda/IAM/
  CloudWatch + Terraform + a LocalStack local-test strategy); and explicitly, "**Two outbox
  dispatch concerns now coexist during migration** (the legacy structured-log publisher and the
  EventBridge adapter) until consumers cut over" (`:183`).
- The ADR does not name a single-box in-process transport; no reviewed ratified source
  authorises `singlebox` as a production transport (see "AS-DESIGNED anchors NOT found").

## ADR-0018 — Background Jobs Substrate (BullMQ)

Source: `doc/adr/0018-background-jobs-substrate.md` (Status: Accepted for the BullMQ
service-local decision; its deferred cross-service SNS→SQS half is superseded by ADR-0033).

- **Status pointer** (`doc/adr/0018-background-jobs-substrate.md:3`): the Decision 4 /
  Architecture §9.1 "Outbox → SNS → SQS" half was deferred and never implemented, and is now
  superseded by ADR-0033; the BullMQ service-local decision remains binding.
- **Decision 1 — BullMQ pattern convention** (`:48`): all Aramo Core BullMQ jobs mirror the
  `libs/matching` pattern — 5-layer no-network-at-boot config (`manualRegistration`,
  `skipWaitingForReady`, `skipVersionCheck`, `skipMetasUpdate`, lazy `connection`), processor
  extends `WorkerHost`, `onApplicationBootstrap` gates `BullRegistrar.register()` on
  `RedisConnectionConfig.isConfigured`, and a per-processor `AramoLogger` factory token.
- **Decision 2 — RedisConnectionConfig single source of truth** in `libs/common`, consumed
  cross-lib (`:86` region of the Decisions section).

### ADR-0036 — Talent Intelligence service channel

Source: `doc/adr/0036-talent-intelligence-service.md` (Status: Accepted, `:3`; Date
2026-10-23, `:5`), with the governing program directive
`Aramo-ATS-TI-Separation-Program-Directive-v1_0-LOCKED.md` (LOCKED, PO-ratified 2026-10-23, `:4`).

- ATS→TI uses outbox events on the ADR-0033 envelope; TI→ATS uses a change notification
  followed by an ATS read of the TI API (directive §3.6, `:71-72`). ATS Add Talent makes zero
  synchronous TI calls (§3.1, `:52`).
- Service-to-service API calls use a token-exchange client; webhooks use HMAC signing on the
  `aramo-sign-s2s-v1` pattern (directive §4 E-2, `:83`; ADR §3, `:96-99`; Service auth E-2,
  `:107-111` — `INTELLIGENCE_ATS_CLIENT_ID` / `_SECRET`, `INTELLIGENCE_WEBHOOK_SIGNING_SECRET`).
- TI keeps an inbox keyed by `event_id`; ingestion is idempotent (ADR `:113-116`). Pact
  registration for every new contract (directive §5, `:99`).
- **Addendum A2** (`Aramo-ATS-TI-Separation-Program-Directive-v1_0-Addendum-A2-PO-Rulings-LOCKED.md`,
  LOCKED 2026-10-23) overrides §3.6's event naming: `talent.created`, `talent.profile_updated`,
  `talent.erased`, `golden_talent.profile_updated`; E-2 is left unchanged.

### Sign billing (Stripe)

- `Aramo-Sign-Standalone-Product-Final-Implementation-Authorization-v1_0-LOCKED.md` (LOCKED,
  relayed 2026-10-18, `:4`): Stripe architecture approved, live charging separately authorized
  (`:7`, decisions `:25-32`); "Stripe is authoritative for payment events; Aramo's backend is
  authoritative for effective product entitlement… No frontend or webhook alone grants
  unrestricted access" (Safeguard 2, `:38`); secure Checkout, portal, verified webhooks and
  subscription-state reconciliation (§2, `:70`); tests cover forged and out-of-order webhook
  refusal (`:106`).
- `Aramo-Sign-Commercial-Plans-Legal-Framework-Amendment-A1-v1_0-LOCKED.md` (LOCKED, relayed
  2026-10-19, `:4`) **overrides** the Standalone single-plan allowance with a four-plan catalog
  (`:5`; §1 `:161-169`); Stripe test mode until live activation (§2, `:184`); provider vocabulary
  is confined to adapter/contract files and Aramo-owned fields keep `account_ref` (§4, `:199-202`).
- `Aramo-Sign-Signup-Federated-Owner-Directive-Amendment-A1-Organization-Details-US-Only-v1_0-LOCKED.md`
  (LOCKED 2026-10-21, `:4`; overrides v1.2 §3 R2/R3, §4, §5 at `:8-11`) §2.6 (`:114-123`):
  Aramo creates the provider billing record, address edits are disabled in Checkout, each
  sync re-reads the country and a non-US country raises a reconciliation flag.

### Signup risk and address integrations (Turnstile, GeoLite2, SMS, Geoapify)

- `Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED.md` (LOCKED, `:5`): Cloudflare
  Turnstile verified server-side on `start` (§6.1, `:119`); the SMS adapter is `disabled` as the
  production default, selected by `SIGN_SMS_PROVIDER` (§6.3, `:165`); Personal mode ships `off`
  (§10, `:287-289`); provider accounts are separately authorized (§12, `:313-314`).
- `Aramo-Sign-Personal-Free-Launch-Directive-v1_1-Amendment-A1-v1_0-LOCKED.md` (LOCKED
  2026-10-22, `:7`; takes precedence over v1.1, `:5`) A1-1 (`:39-63`) **overrides** v1.1 §6.6's
  hard network-country check: MaxMind GeoLite2 is a risk signal only, "Unknown is unknown" — a
  database failure never causes a refusal or error on its own (`:49`); the updater runs from
  `deploy/geoip/docker-compose.geoip.yml`. Provider accounts still need separate authorization
  (`:205-217`).
- Signup Amendment A1 §2.3 (`:87-97`): Geoapify autocomplete proxied server-side by
  platform-admin, key server-side only, token-gated and rate-limited, 404 while signup is off,
  and fails open to a manual form.

### External e-signature providers (DocuSign, Adobe Sign)

- `Aramo-E-Sign-Multi-Provider-Plan-Entitlements-Usage-Directive-v1_0-LOCKED.md` (APPROVED,
  relayed 2026-10-18, `:3-4`): one active provider per tenant (`:27-31`); provider identity is
  frozen per envelope and no provider is claimed connected until its OAuth/API/webhook
  integration is verified (§E, `:122-124`); DocuSign and Adobe adapters with OAuth + state/CSRF,
  token refresh/revocation, "signature verification of incoming callbacks" and idempotency,
  production activation separately approved (§G, `:133-136`).
- `Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED.md` P-3 (`:25`) keeps
  `/v1/webhooks/esignature/*` unchanged.

### Microsoft Graph — Outlook scheduling

- `doc/directives/Aramo-COMM-C2B-Amendment-A1-Outlook-Scheduling-v1_0-LOCKED.md` (LOCKED —
  Ratified 2026-10-10, `:10-11`; extends COMM-C2B, supersedes nothing, `:14`): tenant-owned
  Entra app, per-recruiter delegated OAuth with PKCE, tokens in AWS Secrets Manager and never in
  Postgres (§1, `:35-38`); a separate opt-in scheduling scope set adding `Calendars.ReadWrite`,
  baseline scopes unchanged (§2.1/R4, `:46-51`, `:90-95`); Outlook invites to talent pass the
  consent gate and fail closed (§2.3/R1, `:58-71`); idempotent Graph operations persisted
  before the Graph call (R3, `:80-88`); Outlook is the authority and Outlook-side change sync is
  deferred (R6, `:104-108`).

### Tenant LLM providers

- `Aramo-TENANT-LLM-2-Multi-Provider-BYO-Model-Directive-v1_0-LOCKED.md` (LOCKED v1.0, `:3`):
  Phase A = resolver/dispatcher, per-provider credential custody, per-provider model allowlists
  and an OpenAI adapter (`:8`); Azure OpenAI and Gemini are later phases and Bedrock needs a
  separate risk review (`:9`). Invariants (§4, `:63-74`): strict tenant + provider isolation; no
  fallback across any trust boundary (fail closed to `not_configured`); write-only credential
  custody; "No dead knobs" — a provider is selectable only when its adapter is wired; redaction
  unchanged before any provider call.

## AS-DESIGNED anchors NOT found

- **External email (SES), S3 object storage, Secrets Manager, Cognito, KMS** adapters: no
  dedicated ratified ADR under `doc/adr/*` was located for these port/adapter surfaces at this
  SHA. Their design intent is recorded in per-slice LOCKED directives (e.g. Email-S1,
  A8-3a/A8-3b object-storage) referenced in the code comments; none of the post-2026-10-09
  LOCKED directives reviewed for this domain restate SES, S3 or EventBridge intent.
- **The `singlebox` in-process Talent Intake transport and the dedicated worker container**:
  no ratified ADR or reviewed LOCKED directive anchors it; ADR-0033 names only the
  EventBridge path and the legacy structured-log coexistence.
- **The `outbox` local-file mailer mode**: no anchor; implementation convenience only.
- **The Sign SNS publisher** design is referenced only via DOC-4 slice comments in code;
  ADR-0033 Decision 1 explicitly keeps SNS approved where it earns its place but does not
  mandate the Sign topic. No standalone Sign-transport ADR anchor was located.
- **Google address lookup provider** (company/work-location): governed by
  `Aramo-Requisition-Work-Location-Autocomplete-Directive-v1_0-LOCKED.md` (dated before the
  prior baseline); not re-read for this refresh.
- **`AuditModule`**, **`EventsModule`** as empty shells: no ADR anchor defines them as
  no-ops; their emptiness is an AS-BUILT fact, not a ratified design position.
- **The 21-point AWS-path acceptance proofs** are, per ADR-0033 `:191`, tracked under the
  governing LOCKED directive (not in this ADR and not in the repo), so they cannot be quoted
  as in-repo anchors.
- **Not ratified:** `doc/directives/Aramo-E-Sign-Multi-Provider-Addendum-A1-Precedence-and-Traceability-v1_0.md`
  self-describes as a "program record" (`:7`), not a LOCKED directive; not cited as intent.
