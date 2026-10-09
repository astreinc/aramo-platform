# D14 — Cross-Cutting Platform & External Integrations (AS-DESIGNED)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED
> Ratified intent ONLY, cited from `doc/adr/*`. Not synthesized from code.

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
- **Consequences / Negative** (`:177`): new AWS surface to own (EventBridge/SQS/Lambda/IAM/
  CloudWatch + Terraform + a LocalStack local-test strategy); and explicitly, "**Two outbox
  dispatch concerns now coexist during migration** (the legacy structured-log publisher and the
  EventBridge adapter) until consumers cut over" (`:183`).

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

## AS-DESIGNED anchors NOT found

- **External email (SES), S3 object storage, Microsoft Graph, Secrets Manager, Cognito KMS**
  adapters: no dedicated ratified ADR under `doc/adr/*` was located for these port/adapter
  surfaces at this SHA. Their design intent is recorded in the per-slice LOCKED directives
  (e.g. Email-S1, A8-3a/A8-3b object-storage, COMM-C2B Microsoft Graph) referenced in the code
  comments, which live in OneDrive `Aramo/locked`, not in the repo — so they are not quotable
  here. Treated as "no in-repo ADR anchor".
- **The esign SNS publisher** design is referenced only via DOC-4 slice comments in code;
  ADR-0033 Decision 1 explicitly keeps SNS approved where it earns its place but does not
  mandate the esign topic. No standalone esign-transport ADR anchor was located.
- **`AuditModule`**, **`EventsModule`** as empty shells: no ADR anchor defines them as
  no-ops; their emptiness is an AS-BUILT fact, not a ratified design position.
- **The 21-point AWS-path acceptance proofs** are, per ADR-0033 `:191`, tracked under the
  governing LOCKED directive (not in this ADR and not in the repo), so they cannot be quoted
  as in-repo anchors.
</content>
