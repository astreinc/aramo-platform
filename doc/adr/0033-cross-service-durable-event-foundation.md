# ADR-0033: Cross-Service Durable Event Foundation (Outbox → EventBridge → SQS; Lambda-first runtime; source-agnostic Talent Intake)

**Status:** Accepted

**Date:** 2026-10-07

**Supersedes:** the *deferred cross-service cloud-transport decision only* of
[ADR-0018](0018-background-jobs-substrate.md) (its Decision 4 /
Architecture §9.1 "Outbox → SNS → SQS" half). ADR-0018 remains **Accepted and
binding** for BullMQ as Aramo's service-local / background-job substrate. This
ADR does not touch that part.

---

## Context

ADR-0018 standardised BullMQ + Redis as Aramo's in-process background-job
substrate and, for the *cross-service* case, committed the program to a
transactional-outbox pattern whose cloud dispatch half (`Outbox → SNS → SQS`)
was explicitly **deferred** to M6/M7 and never implemented. A read-only
substrate audit at `b36cd7a7` confirms the deferral never landed:

- the shared `libs/outbox-publisher` drains 7 domain `OutboxEvent` tables but
  emits **structured logs only** — no SNS, no SQS, no EventBridge dispatch;
- EventBridge, SQS, Lambda, and Step Functions are **entirely absent** from
  code and both Terraform roots;
- the single `aws_sns_topic` (esign) is **authored-but-never-applied** with no
  subscription.

Separately, the Durable Async Résumé-First Talent Intake slice (local work on
`feat/durable-async-talent-intake`) stood up a BullMQ-specific transport
(outbox → `talent-intake-relay` BullMQ queue → in-process worker). That transport
couples résumé-extraction latency to a Redis-backed in-process worker and does
not generalise to independently deployed, multi-tenant producers and consumers.

Aramo is being designed for many independently deployed services that both
**produce** and **consume** durable business events (recruiter upload, job
boards, sourcing, agent runtimes, referrals, bulk import, partner integrations,
external APIs). That requires a single, reusable, cloud-native durable-event
backbone — chosen now, on grounded evidence, rather than left deferred.

This ADR records the forces as evaluated and the decisions taken. Three
concerns are deliberately decided **independently**: event transport, workflow
orchestration, and compute runtime.

## Decision

### 1. Canonical cross-service transport — Outbox → EventBridge → consumer-owned SQS

PostgreSQL remains the **authoritative transactional system of record**. Durable
cross-service publication uses a **transactional outbox** written in the same DB
transaction as the authoritative business state. The outbox is drained by an
**outbox publisher** that dispatches through an **`OutboxPublisherPort`** whose
default adapter publishes to a **custom Aramo EventBridge bus**. EventBridge
rules route each domain event to one or more **consumer-owned SQS queues**; each
important queue carries a **DLQ + redrive policy**. Cross-service delivery is
**at-least-once**; every consumer is **idempotent**.

**EventBridge is the default Aramo cross-service domain-event router**, replacing
the ADR-0018-deferred SNS router. **SNS remains approved** where its specialised
semantics (simple pub/sub fan-out, FIFO/topic ordering, direct endpoint
delivery, or clear economic advantage) materially improve a design — but it is
**no longer a mandatory hop**: `EventBridge → SQS` is built directly where it
satisfies the requirement, and `EventBridge → SNS → SQS` is used only when SNS
earns its place.

Business/domain code **must not** call EventBridge, SQS, or any AWS SDK
directly; all AWS transport/runtime concerns sit behind explicit infrastructure
ports/adapters, consistent with the existing S3/Secrets/SES/Cognito/KMS port
precedent.

**BullMQ may remain for purely service-local jobs** (e.g. the outbox-publisher's
own scheduled poll tick) but is **not** the canonical cross-service event
backbone. No broad BullMQ removal is undertaken.

### 2. Orchestration — application-owned by default; Step Functions only where orchestration earns it

The current résumé-extraction flow is **one bounded idempotent operation**
(CAS-claim intake → establish extraction child → one governed LLM call → persist
child → persist parent), with no durable waits, no in-execution human pause, and
no multi-service saga; promotion is a separate recruiter-triggered command.
Therefore the current Talent Intake extraction uses **application-owned
orchestration**, not a state machine.

**Step Functions remains an approved first-class Aramo orchestration
technology** for future workflows that genuinely require durable branching,
timed/external waits, callbacks, parallelism, compensation, or heterogeneous
multi-service coordination. Invariant: a state machine may own
execution/orchestration state but **never** authoritative Talent business state,
which always lives in PostgreSQL (`TalentIntakeDraft`, `ResumeExtractionDraft`,
`TalentRecord`).

### 3. Compute runtime — Lambda-first behind a runtime-neutral handler; Fargate as approved fallback

The Talent Intake SQS consumer's initial production runtime is **AWS Lambda**.
The workload is event-driven, bursty, a single bounded extraction op, uses
pure-JS PDF/DOCX dependencies, holds **no DB transaction across the long LLM
call**, and is idempotent through persisted state + CAS — a Lambda-shaped
profile.

The SQS consumer's application logic lives in a **runtime-neutral
`TalentIntakeMessageHandler.handle(event)`** that knows nothing of Lambda or
Fargate. A thin `SQS → Lambda` adapter wraps it. **ECS/Fargate remains an
approved alternate runtime reachable with no domain redesign** — the chosen
fallback if measured constraints (worst-case model-call duration, artifact
size/memory, sustained economics, or DB-connection pressure) show Lambda
unsuitable.

**Lambda is not production-ready by merely wrapping today's processor.** Before
production closure the following must be explicitly bounded/tested, not left to
unknown SDK defaults:

- a maximum accepted résumé artifact size, with proven memory fit;
- a measured/bounded realistic extraction duration;
- an explicit LLM-call timeout set **below** the Lambda execution budget;
- explicit Anthropic SDK retry behaviour (the current client sets neither
  `timeout` nor `maxRetries`);
- SQS visibility timeout aligned to the Lambda execution timeout;
- idempotency preserved if Lambda is retried after persistence;
- bounded Lambda/SQS concurrency so PostgreSQL, LLM-provider quotas, and tenant
  workloads cannot be overwhelmed;
- DLQ + CloudWatch alarms.

### 4. Canonical event envelope

Cross-service events carry a reusable, versioned envelope: `event_id`,
`event_type`, `event_version`, `tenant_id`, `source`, `subject_type`,
`subject_id`, `occurred_at`, `correlation_id`, `causation_id`, `payload`.
`tenant_id` on an event is **routing/context metadata, not authorization
authority** — every consumer revalidates authoritative tenant/resource ownership
where applicable. Domain-local physical outbox tables are retained behind the
common `OutboxPublisherPort` contract; one global physical outbox table is **not**
required. Envelope columns absent from an existing outbox table are added
**additively (ADD-not-rename)**, never by destructive churn.

### 5. Source-agnostic Talent Intake; single promotion authority

Talent Intake is **behaviorally source-agnostic**, not merely holding a
free-form `source_type`. Resume upload is one source among many. Job boards,
sourcing, agents, integrations, bulk import, and external APIs must enter the
**same** governed Talent Intake authority **without fabricating an S3 upload** —
via a stable `source_ref` / `source_event_id` identity + idempotency seam and an
**optional** artifact. The artifact-backed `RESUME_UPLOAD` behaviour (presigned
PUT, `headObject` commit, `(tenant_id, storage_key)` uniqueness) is preserved for
upload sources. The invariant across all sources:

> Many sources may create Talent Intake; **only the Talent domain authority may
> create or promote canonical `TalentRecord` state.** A job-board, sourcing,
> agent, or import service must never independently write `TalentRecord`.

### 6. Preserved durable intake semantics

This is a transport/platform refactor, not a Talent Intake product rewrite. All
already-delivered semantics are preserved: `TalentIntakeDraft` and its
processing/review lifecycle, `ResumeExtractionDraft` as the governed
extraction/evidence child, persisted recruiter review with recruiter-edits-win,
S3 artifact authority + hash, CAS/versioning, retry-without-reupload, idempotent
exactly-one-`TalentRecord` promotion, Draft-Talents recovery, SSE
notification-only with authoritative GET, admission rules, tenant isolation, and
the retired synchronous `draft-from-resume` path.

## Consequences

### Positive

- One reusable cloud-native durable-event backbone for all independently
  deployed Aramo services; résumé-extraction latency is fully decoupled from the
  browser/nginx/API request lifetime and from Redis availability.
- A failing consumer cannot block another (per-consumer SQS + DLQ isolation).
- Runtime neutrality lets the compute decision (Lambda ↔ Fargate) change without
  a domain rewrite; orchestration can later adopt Step Functions where it earns
  its place.
- Source-agnostic intake admits future producers without a schema rewrite while
  keeping a single governed promotion authority.

### Negative

- New AWS surface to own: EventBridge bus/rules, SQS + DLQ, Lambda, IAM,
  CloudWatch alarms, and the Terraform to define them — plus a local AWS test
  strategy (LocalStack) so developer tests never require live AWS credentials.
- Lambda introduces cold-start, execution-budget, and connection-management
  concerns that must be bounded (see Decision 3) rather than assumed.
- Two outbox dispatch concerns now coexist during migration (the legacy
  structured-log publisher and the EventBridge adapter) until consumers cut over.

### Neutral

- ADR-0018's BullMQ service-local decision is untouched and remains binding.
- No deployed architecture is invalidated: the superseded SNS→SQS half never
  landed. This ADR changes a deferred paper decision, not a running system.
- Implementation, migration sequencing, and the 21-point AWS-path acceptance
  proofs are tracked under the governing LOCKED directive, not this ADR.
