# ADR-0013: Observability Conventions (Structured Logging, Log-Group Provisioning, Per-Env Retention)

**Status:** Accepted

**Date:** 2026-05-23

---

## Context

Plan v1.5 §M4 Track A item 6 commits the Aramo program to a baseline
observability substrate covering structured logging, log-group
provisioning, and per-environment retention policy. Architecture §15.1
names the canonical observability stack — CloudWatch Logs for log
ingestion + retention, structured JSON emission from application
runtimes, and per-class context discipline at the emit-site.

ADR-0012 Decision 7 sequences module population under
`infrastructure/modules/`: PR-9 (observability) is the first module-
populating PR, consuming PR-8's empty foundation. Without explicit
doctrine, PR-9+ implementers — and the M4 Track A item 6 retroactive
sweep deferred to M4 close (Ruling 8) — would face concrete questions
("which log-group naming convention?", "what retention per env?",
"factory function or class-based logger?", "how does it integrate with
NestJS DI?") and would answer them by guessing or blocking on the Lead.

This ADR locks the eight observability conventions decided at PR-9. The
conventions are forward-going standard only; the retroactive sweep
across M4 PR-1–PR-7 libraries (where the existing `new Logger(...)`
pattern persists) is explicitly deferred to M4 close per Ruling 8.

---

## Decision

### Decision 1 — Log emission: structured JSON via `console.log`

Application runtimes emit log records as single-line JSON to stdout via
`console.log(JSON.stringify(record))`. The AWS runtime's log driver
(ECS/Fargate task definition, Lambda runtime, or equivalent) ingests
stdout into CloudWatch Logs without an in-process AWS SDK dependency.

**Why.** Stdout-to-log-driver is the AWS-canonical pattern for
containerized workloads and avoids application-level coupling to the
CloudWatch Logs SDK. Single-line JSON is the canonical structured-log
shape — both human-readable in tail mode and machine-parseable by
CloudWatch Logs Insights without custom log parsers.

**Constraint preserved.** The emit path is synchronous (`console.log`);
backpressure / batching / buffering are runtime concerns, not
application concerns. If runtime backpressure becomes a measured
problem, mitigation lives in the log driver configuration, not the
application code.

---

### Decision 2 — Log record envelope: `{ timestamp, level, context, event, ...payload }`

Every Aramo log record is a JSON object with exactly the following
fields in this order:

- `timestamp` — ISO-8601 string via `new Date().toISOString()` at
  emit time.
- `level` — one of `'log' | 'warn' | 'error' | 'debug'` (matches
  NestJS `LoggerService` levels).
- `context` — symbolic emit-site identifier; defaults to the
  factory-level context (typically `<ClassName>.name`), overridable
  per-call via the second arg to `.log/.warn/.error/.debug`.
- `event` — discriminator string (mandatory; member of
  `AramoLogPayload`). Examples: `submittal_create_started`,
  `submittal_revoked`, `submittal_revoke_refused`.
- Additional payload fields spread from the `AramoLogPayload` (e.g.
  `tenant_id`, `submittal_id`, `latency_ms`, `code`, etc.).

**Why.** Locking the envelope at PR-9 ensures every future emit site
(F41 event-taxonomy registry, F40 health endpoints, F46 trace context
propagation — all M5+) extends a known shape rather than redefining
one. The `event` discriminator is mandatory to make CloudWatch Logs
Insights queries reliable (`fields @timestamp, level, context, event
| filter event = 'submittal_revoked'`).

---

### Decision 3 — Logger factory: `createAramoLogger(context: string)`

The canonical entrypoint is `createAramoLogger(context: string):
AramoLogger`, exported from `@aramo/common`
(`libs/common/src/lib/logging/aramo-logger.ts`). The returned
`AramoLogger` extends NestJS's `LoggerService` so DI containers can
accept it where a `LoggerService` is expected.

**Why.** Factory function (not class constructor) is the substrate-
natural pattern given the implementation extends NestJS's `Logger`
internally. The `AramoLogger` interface is the public surface; the
concrete `AramoLoggerImpl` class is implementation-private and not
exported. Callers compose into NestJS DI via providers with `useFactory:
() => createAramoLogger(ClassName.name)`.

**API surface (locked).**
- `createAramoLogger(context: string): AramoLogger`
- `AramoLogger.log(payload: AramoLogPayload, contextOverride?: string): void`
- `AramoLogger.warn(payload: AramoLogPayload, contextOverride?: string): void`
- `AramoLogger.error(payload: AramoLogPayload, contextOverride?: string): void`
- `AramoLogger.debug(payload: AramoLogPayload, contextOverride?: string): void`
- `AramoLogPayload { event: string; [key: string]: unknown }`

---

### Decision 4 — Per-environment retention: dev 7d, staging 30d, prod 90d

The `cloudwatch-log-group` Terraform module
(`infrastructure/modules/cloudwatch-log-group/`) takes a
`retention_in_days` input with no default at the per-env composition
layer (callers must explicitly choose). Per-env defaults in
`terraform.tfvars.example`:

- dev: `api_log_retention_days = 7`, `auth_log_retention_days = 7`.
- staging: `api_log_retention_days = 30`, `auth_log_retention_days = 30`.
- prod: `api_log_retention_days = 90`, `auth_log_retention_days = 90`.

**Why.** Dev environments are ephemeral and rarely deployed (per ADR-
0012 Decision 5); 7d retention covers the typical iteration window
without inflating cost. Staging is the canary surface where 30d
retention covers extended bake periods. Prod 90d retention satisfies
the operational debugging window for incident retrospectives without
committing to long-term retention (which is out of M4 scope).

**Constraint preserved.** The module's `retention_in_days` variable
validates against the AWS-valid retention values (1, 3, 5, 7, 14, 30,
60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 2192, 2557, 2922,
3288, 3653). Invalid values fail `terraform validate`.

---

### Decision 5 — Log-group naming convention: `/aramo/<surface>/<env>`

CloudWatch log group names follow the literal pattern
`/aramo/<surface>/<env>` where `<surface>` is the application surface
(`api`, `auth`, future: `worker`, `ingestion`) and `<env>` is the
deploy environment (`dev`, `staging`, `prod`).

**Why.** The leading-`/` slash-separated namespace is the AWS-canonical
log-group naming pattern (mirrors `/aws/lambda/<fn>`, `/aws/ecs/<svc>`)
and groups Aramo log groups cleanly in CloudWatch Logs Console. The
`<surface>` segment matches the deployable application name (apps/api,
apps/auth-service) so log-group-to-deployable mapping is mechanical.

**At PR-9.** Two log groups are provisioned per environment: `api` +
`auth`. Future deployables (workers, ingestion) extend this pattern
without re-debating naming.

---

### Decision 6 — Per-class DI context (substrate-natural for libs/submittal PoC)

PR-9's PoC adoption in `libs/submittal` uses TWO `AramoLogger`
providers (one keyed by `'SubmittalControllerLogger'` with factory
context `SubmittalController.name`, one keyed by
`'SubmittalRepositoryLogger'` with factory context
`SubmittalRepository.name`). Each class injects the logger via
`@Inject('<Token>')`.

**Why.** Per-class factory context preserves the pre-PR-9
`SubmittalRepository.name` emit-site context discipline (formerly via
`private readonly logger = new Logger(SubmittalRepository.name)`)
without requiring callers to pass `contextOverride` on every emit.
The directive's primary option (TWO providers) is substrate-natural
for libs where multiple classes need distinct contexts; the alternative
(single shared provider with `contextOverride` on every call) is
acceptable where a single class owns all emit sites.

**Convention.** Module-population PRs that adopt `AramoLogger` choose:

- TWO providers per class when both controller and repository (or other
  multi-class compositions) emit.
- Single shared provider when only one class emits.

The choice is documented in the consuming module's `@Module` comment.

---

### Decision 7 — Scope at PR-9: PoC adoption, not retroactive sweep

PR-9 establishes the convention forward-going only. The retroactive
sweep across M4 PR-1–PR-7 libraries (where the existing
`new Logger(...)` pattern persists) is deferred to M4 close per the
directive's Ruling 8.

**Why.** Single-change discipline (directive Ruling 2, option δ
Hybrid): PR-9 ships the substrate (Terraform module + factory + ADR +
CI extension) and proves it works end-to-end via a single-lib PoC
(libs/submittal). Sweeping the rest of M4 PR-1–PR-7 in the same PR
would inflate diff scope and conflate substrate-correctness signal
with adoption-correctness signal. The forward-going posture is the
mirror of ADR-0012 Decision 4's PR-8 minimum-viable-foundation
posture.

**Out of scope at PR-9.** CloudWatch Metrics emission; CloudWatch
Alarms + dashboards; X-Ray distributed tracing; OpenTelemetry;
W3C Trace Context propagation; PagerDuty integration; F41 event-
taxonomy registry; F40 health endpoints; F46 trace context plumbing;
tfsec/checkov; `terraform plan` PR-comment integration; `terraform
apply`; the retroactive logger sweep across M4 PR-1–PR-7 libs.

---

### Decision 8 — CI integration at PR-9: add `tflint` (deferred from PR-8 per ADR-0012:92)

A new CI job `terraform-lint` is added at PR-9, wired into the
`deployment-gate` aggregator's `needs:` list (extending from 15 to 16
dependencies; CI workflow grows from 21 jobs to 22).

- **`terraform-lint`** — runs `terraform-linters/setup-tflint@v4`,
  then `tflint --init` followed by `tflint --recursive
  --minimum-failure-severity=warning` in `infrastructure/`. No AWS
  credentials required.

**Why.** `tflint` catches the next class of Terraform errors above
`terraform fmt`/`terraform validate` (which only verify formatting +
syntax + provider-schema). Common findings: unused variables,
deprecated syntax, AWS-provider-specific naming/lifecycle anti-
patterns. ADR-0012 Decision 6 explicitly deferred `tflint` from PR-8
to PR-9 ("Deeper gates (`tflint`, `tfsec` / `checkov`, `terraform
plan` PR-comment integration) require either credentials or
substantive scope and are deferred to PR-9 / PR-10").

**Constraint preserved.** `tfsec` / `checkov` (security scanning) and
`terraform plan` PR-comment integration remain deferred to PR-10
(CVE / security scanning sequencing). `terraform apply` (state
mutation) is M5+ scope.

---

## Consequences

### Positive

- Plan v1.5 §M4 Track A item 6 ("observability baseline: logging +
  retention + log-group provisioning") is materially satisfied in
  foundation form; future PRs extend it without re-debating
  conventions.
- Workspace-wide structured-log envelope locks the shape that
  CloudWatch Logs Insights queries assume; future emit sites extend a
  known shape rather than redefining one.
- Per-env retention (7/30/90) balances operational debugging window
  against cost without committing to long-term retention.
- The `cloudwatch-log-group` module is the first module populated
  under `infrastructure/modules/` (PR-8 left it empty per ADR-0012
  Decision 7); the module-population pattern is now proven and
  reusable for PR-10 / M5 modules.
- `tflint` integration closes the deferred CI gate identified at
  ADR-0012:92; PR-9's CI extension follows the deferred-from-PR-8
  sequencing exactly.
- PoC adoption in `libs/submittal` proves the factory + DI integration
  end-to-end before the retroactive sweep (M4 close) commits the
  pattern across all libs.
- Forward-going posture preserves single-change discipline (directive
  Ruling 2, option δ Hybrid); substrate-correctness signal stays
  isolated from adoption-correctness signal.

### Negative

- `console.log`-based emission cannot batch or compress in-process;
  high-cardinality emit sites that exceed runtime log-driver
  throughput need either reduced emission volume or downstream
  buffering. PR-9 ships no runtime throughput measurement; the first
  staging deployment (M5+) is the first signal point.
- The `AramoLogger` factory creates per-emit `Date.toISOString()`
  calls. At very high emit rates (>10k/s per process) this becomes
  measurable overhead. Mitigation (deferred): switch to monotonic-
  timestamp emission or batch the timestamp work in the runtime
  layer.
- The forward-going posture means M4 PR-1–PR-7 libraries continue
  using the pre-PR-9 `new Logger(...)` pattern until the M4-close
  retroactive sweep. CloudWatch Logs Insights queries that depend on
  the locked envelope will not return PR-1–PR-7 records until that
  sweep lands. The Ruling 8 deferral is explicit; this is an accepted
  carry-forward.
- The two-provider DI pattern (per Decision 6) is more verbose than a
  single-shared-provider alternative; modules with many classes will
  have multiple `useFactory` blocks. The substrate-natural reading
  outweighs the verbosity at the lib-scale Aramo operates at.

### Neutral

- The choice to extend NestJS's `Logger` (rather than reimplement
  from scratch) couples the implementation to NestJS's logger
  lifecycle. If a future Aramo deployable is non-NestJS (e.g. a CLI
  tool), the implementation could be refactored to drop the NestJS
  dependency. PR-9 does not commit against this future refactor.
- The `contextOverride` second arg to emit methods is rarely needed
  in practice — the factory-level context is the right default for
  most emit sites. PR-9 documents the override but expects most
  callers to omit it.
- ADR-0012 covered IaC conventions (provider, backend, environment
  topology, CI integration); ADR-0013 covers observability conventions
  (logging emission, retention, log-group naming, factory shape). The
  two ADRs occupy the same "deployed-cloud infrastructure" namespace
  at different scopes; they are complementary and non-overlapping.
