# ADR-0018: Background Jobs Substrate (BullMQ Pattern Standardization, 4 Aramo Core Jobs, PL-66 Category 5 Ratification, Deferrals)

**Status:** Accepted

**Date:** 2026-05-27

---

## Context

Plan v1.5 §M5 Track A item 6 commits the Aramo program to "Architecture
§9 background jobs scheduled (added v1.4 — D-ENT-READY-1): the four
Aramo Core BullMQ jobs (stale-consent, outbox publisher, cross-schema
consistency check, skill canonicalization) implemented explicitly, each
in the milestone owning its domain; not left implicit" (anchored
verbatim at [doc/01-locked-baselines.md §11:346](../01-locked-baselines.md#L346)).
Architecture §9 (anchored verbatim at
[doc/01-locked-baselines.md §13:418](../01-locked-baselines.md#L418) per
PR-#113 — PL-68 6th instance) names 8 Aramo Core BullMQ jobs in §9.2
and a 3-category event-flow model in §9.1.

`libs/matching` shipped the M3-era BullMQ substrate (matching worker
processor pattern with manualRegistration + lazy-validation
RedisConnectionConfig + BullRegistrar gating on REDIS_URL). The M5 PR-11
Substrate Audit v1.1 confirmed `libs/matching` is the program-level
template; PR-11 extends that template to 4 new jobs (NOT a greenfield
BullMQ adoption per PL-78 v1.1 substrate-claim correction). The audit
disposed 10 Lead-Q items, including Axis F (skill canonicalization)
RED-disposition via no-op framework, Axis B Lead-Q-B1 LIGHT outbox
scope, and Axis E Lead-Q-E1 critical-pair cross-schema scope. The
substrate is consolidated here so future Aramo Core job PRs inherit the
binding directly.

This ADR codifies the program-level standard for Aramo Core BullMQ
jobs, the 4 PR-11 target jobs' implementation rules, the cross-lib
RedisConnectionConfig sharing pattern, and the PL-66 Category 5
ratification (BullMQ + Redis testcontainer integration test as a
canonical verification category).

---

## Decisions

### Decision 1 — BullMQ pattern convention (program-level standard)

All Aramo Core BullMQ jobs MUST mirror `libs/matching` pattern:

1. **5-layer no-network-at-boot configuration** at the owning module's
   `BullModule.forRootAsync` factory:
   - `extraOptions.manualRegistration: true` (defers Worker
     construction).
   - `skipWaitingForReady: true` (skips eager Redis init).
   - `skipVersionCheck: true` (skips eager `client.info()`).
   - `skipMetasUpdate: true` (skips eager `client.hmset()`).
   - `connection: { ...cfg.connection, lazyConnect: true }` (defers
     ioredis TCP attempt to first command).
2. **Processor extends `WorkerHost`** with `@Processor(QUEUE_NAME, {
   skipWaitingForReady: true, skipVersionCheck: true })` decorator.
3. **`onApplicationBootstrap` hook gates `BullRegistrar.register()`**
   on `RedisConnectionConfig.isConfigured` — REDIS_URL-less boot stays
   silent; the processor stays unregistered until REDIS_URL is set.
4. **Per-processor AramoLogger factory provider** keyed by
   `'<JobName>ProcessorLogger'` (mirrors PR-9 HK-PR-4 Style A pattern).

The Gate-5 "Only an actual queue push/pop may surface a missing/
unreachable Redis" property holds program-wide.

### Decision 2 — RedisConnectionConfig cross-lib reuse via libs/common

`RedisConnectionConfig` is the single source of truth for REDIS_URL
parsing across the workspace. Moved from `libs/matching/src/lib/redis/`
to `libs/common/src/lib/redis/` at PR-11 §4.1; exported from the
`@aramo/common` barrel. Consumed by `libs/matching`, `libs/consent`,
`libs/common` (cross-schema processor), and `libs/skills-taxonomy`.

PR-11 added an `isConfigured: boolean` getter so processor
`onApplicationBootstrap` hooks can short-circuit Worker registration
without provoking the lazy `connection` getter's
`"REDIS_URL is not configured"` throw.

The class is registered as a provider via each owning module's
`BullModule.forRootAsync({ inject: [RedisConnectionConfig],
extraProviders: [RedisConnectionConfig] })` — duplicate providers across
the app tree are tolerated by Nest DI (all instances resolve to the
same lazy-validation contract; no per-instance state is shared except
`cached` memoization).

### Decision 3 — Job-to-lib ownership + dedicated job-module rule (PL-88)

Each Aramo Core BullMQ job lives in a **dedicated job-module within** its
domain-owning lib (no central `libs/jobs` project; no shared placement in
broadly-imported universal-utility modules like `CommonModule`):

| Job | Owning module | Domain rationale |
|---|---|---|
| matching worker | `libs/matching/src/lib/matching.module.ts` (MatchingModule) | M3-era; domain-owns talent matching |
| stale consent daily | `libs/consent/src/lib/consent.module.ts` (ConsentModule) | Domain-owns TalentConsentEvent + R6 staleness substrate |
| outbox publisher | `libs/consent/src/lib/consent.module.ts` (ConsentModule) | Light-scope publishes consent schema outbox only at PR-11 |
| cross-schema consistency | `libs/common/src/lib/cross-schema-consistency/cross-schema-consistency.module.ts` (CrossSchemaConsistencyModule) | Multi-schema reconciliation has no single domain owner; the dedicated job-module sits inside libs/common because Common is the lib best-positioned for cross-schema utilities, but it is NOT registered through `CommonModule` (see PL-88 below) |
| skill canonicalization | `libs/skills-taxonomy/src/lib/skills-taxonomy.module.ts` (SkillsTaxonomyModule) | Domain-owns Skills Taxonomy workstream (currently scaffold-only) |

Adapter BullMQ jobs (Indeed search batches + 4 others per Architecture
§9.2) follow the same convention in their respective adapter libs at
M6/M7.

**PL-88 (RATIFIED at Gate 5-redux; first instance PR-11)** —
**BullMQ processors MUST live in dedicated job-modules within their
owning lib; NEVER in `CommonModule` or other broadly-imported
universal-utility modules.**

*Why this matters*: `@nestjs/bullmq` `BullExplorer.registerWorkers` fires
at `onModuleInit` (NOT `onApplicationBootstrap`). The `manualRegistration:
true` suppression is configured at `BullModule.forRootAsync.extraOptions`;
without a `forRootAsync` in scope, `BullExplorer` falls back to
auto-registration and the Worker constructor demands a live Redis
connection. Placing a processor in `CommonModule` (which is transitively
imported by `AuthServiceModule`, `IngestionModule`, `AiDraftModule`, and
every other lib) leaks Worker instantiation into every consumer graph,
including non-job contexts (the apps/auth-service pact provider, future
narrow apps) where no `REDIS_URL` is configured.

The PR-11 Gate-6 CI failure (run 26581705701; "Worker requires a
connection" at `BullRegistrar.onModuleInit` → `BullExplorer.registerWorkers`
→ `new Worker`) was caused exactly by this anti-pattern: PR-11 §4.4
originally registered `CrossSchemaConsistencyProcessor` in `CommonModule`,
which `AuthServiceModule` transitively imports; the pact-provider boot
had no `forRootAsync` in scope, so `BullExplorer` auto-registered the
Worker and the constructor threw.

*Resolution at Gate 5-redux*: extracted to dedicated
`CrossSchemaConsistencyModule` at
`libs/common/src/lib/cross-schema-consistency/cross-schema-consistency.module.ts`.
`CommonModule` reverted to BullMQ-Worker-free — it still provides
`RedisConnectionConfig` (config-only, no Worker; safe in any consumer
graph). `AppModule` imports `CrossSchemaConsistencyModule` directly
alongside `MatchingModule` + `ConsentModule` + `SkillsTaxonomyModule`.
`AuthServiceModule` continues to import `CommonModule` but gets no
BullMQ surface area.

*Future binding*: any new BullMQ processor in `libs/common` (or any
other lib whose `<lib>Module` is broadly imported) ships through a
dedicated job-module — never through the universal-utility module
itself. Adapter-lib jobs at M6/M7 inherit this rule directly.

### Decision 4 — Outbox publisher LIGHT-SCOPE at PR-11; multi-schema deferred to M6

PR-11 outbox publisher polls **only `libs/consent.OutboxEvent`** rows
(the only outbox table in the workspace at PR-11; substrate-confirmed
by PR-11 audit Axis B). Other domain schemas (engagement, submittal,
examination, talent, ingestion) do NOT have outbox tables at PR-11 and
are NOT polled by this publisher.

PR-11 emits via structured log only; **SNS dispatch is M6/M7 binding**
per Architecture §9.1 "Aramo Core → Extracted Services" pattern (Outbox
→ SNS → SQS). The publisher half (Outbox → published_at = now) ships
at PR-11; the SNS half is deferred.

**M6 binding**: M6 PR-N adds outbox tables to other write-path schemas
(engagement + submittal + examination at minimum) + extends the
publisher to multi-schema scope + adds SNS dispatch.

### Decision 5 — Stale-consent action='expired' insertion

Per PR-11 audit Axis D Lead-Q-D1=(a) (substrate-confirmed via PR-2's
TalentConsentEvent.action enum reservation at
`libs/consent/prisma/schema.prisma:38-40` + the 12-month staleness
window encoded at `consent.repository.ts:134-136`):

The stale-consent job inserts a new `TalentConsentEvent` row with
`action='expired'` for each (tenant_id, talent_id, scope='contacting')
tuple whose latest contacting-scope grant is older than 12 calendar
months. The write is transactional: TalentConsentEvent + ConsentAuditEvent
(event_type='consent.expired.recorded') + OutboxEvent
(event_type='consent.expired') in one transaction (mirrors PR-2
grant/revoke transaction boundary; precedent #6).

R6 staleness window remains 12 months (Decision F substrate at
`libs/consent/src/lib/consent.repository.ts:136`); a future change must
keep the resolver-side `STALENESS_WINDOW_MONTHS` constant and the
job-side `STALE_CONSENT_WINDOW_MONTHS` constant in sync (or extract a
shared module-level constant).

### Decision 6 — BullMQ-repeat over @nestjs/schedule

All 4 PR-11 jobs use BullMQ's native `repeat` option on `queue.add`
(no `@nestjs/schedule` dependency). Schedules:

| Job | Schedule | Rationale |
|---|---|---|
| stale consent | `0 3 * * *` UTC (daily 03:00 UTC) | Low-traffic window; precedes outbox tick |
| outbox publisher | `every: 30_000` ms (every 30s) | Near-real-time event propagation |
| cross-schema consistency | `0 4 * * *` UTC (daily 04:00 UTC) | After stale-consent so any new expired rows are caught |
| skill canonicalization | `0 5 * * *` UTC (daily 05:00 UTC) | No-op at PR-11; placeholder slot |

**Idempotent jobId** per `queue.add({ jobId: '<job>-<schedule>' })`
prevents duplicate scheduling across pod restarts (BullMQ deduplicates
repeat jobs by jobId).

### Decision 7 — Cross-schema consistency check critical-pair scope

Per PR-11 audit Axis E Lead-Q-E1=(b): PR-11 scans **5 critical pairs**
only:

1. `consent."TalentConsentEvent".talent_id` ↔ `talent."Talent".id`
2. `engagement."TalentJobEngagement".talent_id` ↔ `talent."Talent".id`
3. `examination."TalentJobExamination".talent_id` ↔ `talent."Talent".id`
4. `examination."TalentJobExamination".job_id` ↔ `job_domain."Job".id`
5. `examination."TalentJobExamination".golden_profile_id` ↔ `job_domain."GoldenProfile".id`

**Deferred to M6/M7**:
- evidence + talent_evidence pairs (cross-schema talent + job refs).
- talent_evidence.skill_id ↔ skills_taxonomy (target schema currently
  empty; deferred until Skills Taxonomy workstream M6/M7).
- tenant references (consent.tenant_id ↔ identity.Tenant.id, etc.).
- submittal cross-references.

**Remediation logic DEFERRED to M6/M7 ops-track**: PR-11 logs orphan
counts + samples only. No auto-fix; that's an ops decision and benefits
from a runbook (Architecture §15.6 "stale consent job failure" runbook
precedent).

Implementation uses `pg` directly (vs. a per-module Prisma client)
because no single Prisma client owns 5 schemas; cross-schema queries
via fully-qualified table names (`"consent"."TalentConsentEvent"`) are
straightforward in raw SQL.

### Decision 8 — Skill canonicalization NO-OP framework at PR-11

Per PR-11 audit Axis F Lead-Q-F1=(c) (substrate-blocked RED axis):

PR-11 ships a **NO-OP processor**: handler logs invocation + returns.

**Rationale**:
- `libs/skills-taxonomy/prisma/schema.prisma:1-18` is PR-1 scaffold
  only (zero models).
- SkillTaxonomy schema target is unbuilt; surface forms stored opaquely
  in `libs/job-domain.GoldenProfile.skills` (Json) +
  `libs/ingestion.IngestionRecord.skill_surface_forms` (Json).
- Meaningful canonicalization requires multi-PR Skills Taxonomy
  workstream (M6/M7): SkillTaxonomy model + synonym dictionary + seed
  scripts.

**Why ship anyway**: D-ENT-READY-1 G7's verbatim binding names "the
four Aramo Core BullMQ jobs ... implemented explicitly, each in the
milestone owning its domain; not left implicit". Full deferral would
close Track A item 6 WITHOUT all 4 jobs structurally present, violating
the binding.

**M6/M7 binding**: Future Skills Taxonomy workstream PR replaces the
no-op handler with real canonicalization once SkillTaxonomy schema +
synonym dictionary exist.

### Decision 9 — PL-66 Category 5 ratification (BullMQ + Redis testcontainer)

PR-11 ratifies a fifth Process Lesson 66 verification category:

> **Category 5**: BullMQ + Redis testcontainer integration test
> verification. Mandatory local-execution check that spins up Redis
> testcontainer + Postgres testcontainer (when domain writes are
> involved), boots the owning module under Nest DI, enqueues a job,
> and asserts `queue.add → worker.process` round-trip + domain
> assertions.

Pattern parallels Category 1 (Postgres testcontainer integration test
verification) and is enabled program-wide via the existing
`@testcontainers/redis` (~11.14.0) + `@testcontainers/postgresql`
(~12.0.0) devDependencies.

Local execution command (PR-11 §6.24 — Gate 5 mandatory):

```bash
ARAMO_RUN_INTEGRATION=1 npx vitest run \
  libs/consent/src/tests/stale-consent.integration.spec.ts \
  libs/consent/src/tests/outbox-publisher.integration.spec.ts \
  libs/common/src/tests/cross-schema-consistency.integration.spec.ts \
  libs/skills-taxonomy/src/tests/skill-canonicalization.integration.spec.ts \
  --testTimeout=120000
```

PR-11 is the **first PL-66 Category 5 ratification PR**. Future PRs
that ship new BullMQ jobs MUST include a corresponding Category 5
integration spec.

### Decision 10 — Job failure surfacing via logging + observability

PR-11 does NOT introduce new error codes (parity-quad stays at 26):

- Job-handler exceptions surface via BullMQ's failed-job counter +
  structured log emit from each processor's logger.
- Repository-level exceptions propagate via `throw` and are captured
  by BullMQ's worker error handler.
- HTTP-error-code semantics (the parity-quad subject) do NOT apply to
  background jobs (no synchronous request path).

**Deferred to M5-close OR M6 instrumentation PR**:
- Queue-depth metrics (Architecture §15 observability).
- Outbox-publisher tick lag metric.
- Per-job duration histograms.
- Architecture §15.6 "stale consent job failure" runbook.

---

## Consequences

### Operational

- 4 new jobs run on prod schedule (UTC 03:00 / 30s / UTC 04:00 / UTC
  05:00). Redis runtime is required in prod; ElastiCache substrate
  is deferred per ADR-0016 carry-forwards (M6/M7 operational track).
- REDIS_URL-less environments boot silently; processors stay
  unregistered. Production environments must set REDIS_URL to activate
  the schedules.
- The outbox publisher polls every 30 seconds and emits one log line
  per published row. Log volume scales linearly with consent grant +
  revoke + expired event rate.

### Substrate

- TIER2_EXCLUDES expands from 82 → 86 entries (one per integration
  spec).
- ESLint exemption file-pattern list expands by 4 entries (mirrors
  TIER2 pattern).
- ADRs in-tree expands from 16 → 17 (ADR-0018; gap at ADR-0015
  persists per PR-#112 closure record).
- No new Prisma migration; no new endpoint URL; no new error code; no
  new Nx project.

### Deferred work

- **Multi-schema outbox expansion (M6)**: outbox tables added to
  engagement, submittal, examination; publisher extended to scan all
  outbox tables. Decision 4.
- **SNS dispatch (M6/M7)**: outbox publisher emits → SNS → extracted
  services per Architecture §9.1. Decision 4.
- **Cross-schema consistency remediation (M6/M7)**: auto-fix logic for
  orphan references; coordinated with ops-track runbook. Decision 7.
- **Skill canonicalization meaningful logic (M6/M7)**: Skills Taxonomy
  workstream provides SkillTaxonomy schema + synonym dictionary;
  no-op processor replaced. Decision 8.
- **§9.2 jobs #2-#4 (M6/M7)**: examination computation + derived
  snapshot recomputation + evidence package generation — substrate-state
  TBD; possible synchronous-only at PR-11. Audit Axis A noted these
  are likely synchronous today.
- **§9.2 Adapter BullMQ jobs (M6/M7)**: 5 adapter jobs ship with their
  respective adapter PRs.
- **§9.3 SNS/SQS Topics (M6/M7)**: 5 required topics + extracted
  service subscription configuration.
- **Observability instrumentation (M5-close OR M6)**: queue-depth +
  outbox-lag metrics; per-job duration histograms. Decision 10.
- **Stale-consent runbook (M5-close ops OR M6)**: §15.6 runbook for
  job failure recovery.
- **Production ElastiCache substrate (M6/M7)**: per ADR-0016
  carry-forwards.
- **Matching production enqueue trigger (M6/M7)**: "Talent updated →
  matching scheduled" path; M3-era test-only enqueue stays.

---

## Authority

- Plan v1.5 §M5 Track A item 6
  ([doc/01-locked-baselines.md §11:346](../01-locked-baselines.md#L346)).
- Architecture v2.1 §9 Event and Job Architecture
  ([doc/01-locked-baselines.md §13:418](../01-locked-baselines.md#L418);
  PR-#113 PL-68 6th instance anchor).
- D-ENT-READY-1 G7 4-job binding (`Aramo-Defect-D-ENT-READY-1.md`).
- M5 PR-11 Substrate Audit v1.1 (10 Lead-Q-PR-11-N dispositions).
- M5 PR-11 Directive v1.0
  (`Aramo-M5-PR-11-Directive-v1_0-LOCKED.md`).
- libs/matching M3-era BullMQ pattern
  ([libs/matching/src/lib/matching.module.ts](../../libs/matching/src/lib/matching.module.ts);
  [libs/matching/src/lib/matching.processor.ts](../../libs/matching/src/lib/matching.processor.ts);
  [libs/matching/src/lib/redis/redis-connection.config.ts](../../libs/common/src/lib/redis/redis-connection.config.ts)
  — moved to libs/common at PR-11 §4.1).
- PL-66 (verification category framework; PR-8b2 Categories 1-3
  ratification; PR-10a Category 4 ratification; PR-11 Category 5 first
  ratification).
- PL-78 (audit-prompt premise verification; v1.0 → v1.1 revision based
  on BullMQ substrate-claim correction).
- PL-86 candidate (substrate pre-states future-PR design markers;
  PR-2's TalentConsentEvent action='expired' enum reservation +
  STALENESS_WINDOW_MONTHS encoding cited at Ruling 4).
