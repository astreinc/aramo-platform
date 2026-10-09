# D15 — Infrastructure, Deployment, Persistence Ops & Quality/Contract Enforcement (AS-DESIGNED)
> Baseline SHA 12330b0f5049c97f01022df0b190035933345212 · category AS-DESIGNED
> Sourced ONLY from ratified ADRs / LOCKED specs under `doc/adr/*`. Not synthesized from code.

## IaC conventions — ADR-0012 (Accepted 2026-05-23)

- **Decision 1 — Cloud provider: AWS.** Terraform AWS provider pinned
  `version = "~> 5.0"`, `source = "hashicorp/aws"`; Terraform binary `>= 1.6.0`;
  region default `us-east-1`. (`doc/adr/0012-iac-conventions.md`, Decision 1.)
- **Decision 2 — State backend: S3 + DynamoDB lock.** Per-environment state
  buckets (`aramo-terraform-state-{dev,staging,prod}`) keyed by
  `<env>/terraform.tfstate`; shared lock table `aramo-terraform-locks`;
  `encrypt = true`, AES256, public-access-block, versioning.
  (`doc/adr/0012-iac-conventions.md`, Decision 2.)
- ADR-0012 also establishes per-environment directory layout, module population
  sequencing under `infrastructure/modules/` (Decision 7), and defers
  `tfsec`/`checkov` + `terraform plan` PR-comment integration to PR-10
  (Decision 6). (`doc/adr/0012-iac-conventions.md`, Context + Decisions 6/7.)

## Observability conventions — ADR-0013 (Accepted 2026-05-23)

- **Decision 1 — Log emission: structured JSON via `console.log`.** Runtimes
  emit single-line `console.log(JSON.stringify(record))`; the AWS log driver
  (ECS/Fargate task def or Lambda runtime) ingests to CloudWatch Logs.
  (`doc/adr/0013-observability-conventions.md`, Decision 1.)
- Eight observability conventions locked at PR-9 (log-group naming, per-env
  retention, factory logger, NestJS DI integration); the retroactive
  `new Logger(...)` sweep across M4 PR-1–PR-7 is deferred to M4 close (Ruling 8).
  (`doc/adr/0013-observability-conventions.md`, Context + Decision 8.)

## CVE-scanning conventions — ADR-0014 (Accepted 2026-05-24)

- Two scan surfaces: **tfsec** over `infrastructure/` IaC and **npm-audit** over
  the production-only dependency tree (devDependencies excluded, Decision 4).
  Both are **in-CI merge gates**, not out-of-band crons (Architecture §19.2).
  (`doc/adr/0014-cve-scanning-conventions.md`, Context.)
- **Allow-list mechanism (Decision 6):** a HIGH/CRITICAL advisory with no fix is
  triaged onto an explicit allow-list; exit 0 only when every HIGH/CRITICAL is
  allow-listed (or none present), exit 1 otherwise, exit 2 on environmental
  error. (`doc/adr/0014-cve-scanning-conventions.md`, Decision 6; implemented by
  `scripts/audit-check.sh`.)

## RDS substrate + DR — ADR-0016 / ADR-0017 (Accepted 2026-05-27)

- **ADR-0016:** VPC + RDS modules, per-env scope, RDS master password in Secrets
  Manager; PR-10a creates the RDS substrate (minimal bundled VPC module).
  (`doc/adr/0016-rds-substrate-conventions.md`, Context + Decisions.)
- **ADR-0017:** DR targets **RPO 15 minutes / RTO 1 hour** (Architecture §17.2);
  five DR mechanisms named — automated backups, PITR, cross-region snapshot
  replication, (+2). PR-10b ships RDS automated backups + PITR; the remaining
  mechanisms carry M7 deferrals. (`doc/adr/0017-rds-disaster-recovery-strategy.md`,
  Context.)

## Background-jobs substrate — ADR-0018 (Accepted; partly superseded)

- **BullMQ + Redis** is the standardized **service-local / background-job**
  substrate; the four Aramo Core jobs (stale-consent, outbox publisher,
  cross-schema consistency, skill canonicalization) are implemented explicitly.
  This part remains **Accepted and binding**.
  (`doc/adr/0018-background-jobs-substrate.md`, Status + Context.)
- The **cross-service cloud-transport** half (Decision 4 / Architecture §9.1
  "Outbox → SNS → SQS") was **deferred and never implemented**, and is
  **superseded by ADR-0033**. (`doc/adr/0018-background-jobs-substrate.md`,
  Status block.)

## Cross-service durable event foundation — ADR-0033 (Accepted 2026-10-07)

- Replaces the deferred SNS→SQS half with **Outbox → EventBridge →
  consumer-owned SQS; Lambda-first runtime; source-agnostic Talent Intake.**
  A single reusable cloud-native durable-event backbone chosen now rather than
  left deferred. (`doc/adr/0033-cross-service-durable-event-foundation.md`,
  title + Context + Decision.)
- Context records the grounded audit (`b36cd7a7`): `libs/outbox-publisher`
  drains 7 `OutboxEvent` tables emitting **structured logs only**; EventBridge/
  SQS/Lambda/Step Functions absent from code and both Terraform roots; the lone
  esign `aws_sns_topic` authored-but-never-applied with no subscription.
  (`doc/adr/0033-cross-service-durable-event-foundation.md`, Context.)

## Front door — ADR-0023 (Accepted 2026-07-24)

- Replace the retired front door with **nginx** terminating TLS on 80/443 and
  reverse-proxying three host classes with walls translated verbatim: tenant
  (`/v1/`, `/auth/`, exact `jwks`, Indeed webhook), admin (`/auth/`,
  `/platform/`, `jwks`, **no `/v1`** — R14), portal (`/v1/portal/` only).
  (`doc/adr/0023-frontdoor-nginx-wildcard-tls.md`, Decision 1.)
- **Single `*.aramo.ai` wildcard cert via certbot DNS-01/Route53** supersedes the
  retired on-demand per-host mint; the certbot principal is a least-privilege IAM
  user scoped to the `_acme-challenge.aramo.ai` TXT record only; the request-path
  ask-endpoint is retired. (`doc/adr/0023-frontdoor-nginx-wildcard-tls.md`,
  Decisions 2–3.)

## Pipeline⊥ATS boundary wall — ADR-0029 (LOCKED)

- The modular-monolith boundary: Pipeline libs never hard-import ATS libs; cross
  the L3 boundary by UUID ref + versioned Pact-tested connector contract only;
  nx boundary tags CI-enforce this.
  (`doc/adr/0029-pipeline-boundary-modular-monolith.md` /
  `doc/adr/Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md`.)

## Quality / contract-enforcement governance (CI)

- **Deployment-gate as the single required check**, override-label discipline,
  and the fast/full/nightly lane model derive from the CI-Velocity LOCKED
  directive family referenced in `.github/workflows/ci.yml:1-29` (PR-M0R-3 §4.1
  VARIANT B aggregator; CI-Velocity-2 §PR-2). The directives themselves are
  canonical LOCKED artifacts held outside the repo (OneDrive Aramo/locked) —
  **no in-repo ADR anchor fully specifies the CI lane topology**; the workflow
  header comment is the nearest in-tree ratified reference.
- The **vocabulary two-tier discipline** (Tier-1 R7, Tier-2 locked vocabulary)
  is codified by PR-1 precedent and recorded in `doc/adr/0001-pr1-precedent-decisions.md`
  + `doc/adr/0011-r7-allowlist-extension-for-openapi-prohibited-values.md`.

## Explicit anchor gaps (no ratified AS-DESIGNED source found)

- **Single-box Lightsail deployment topology** (`infrastructure-lightsail/`,
  `docker-compose.prod.yml`): there is **no numbered ADR** specifying the
  single-box compose stack as the canonical production topology. ADR-0023 governs
  only the front-door slice. The single-box design is driven by LOCKED directives
  ("Single-Box Directive 1", referenced in `docker-compose.prod.yml:1`) that are
  **not present as in-repo ADR files** at this SHA — AS-DESIGNED for the overall
  box topology has **no in-repo anchor**.
- **Persistence-ops migrate/seed gating** (`deploy/migrate-prod.sh`,
  `deploy/seed-prod.sh`): no ADR ratifies the migrate-then-gate deploy sequence;
  the scripts cite operational incidents (`singlebox-ops.md`) rather than a
  ratified design spec. **No AS-DESIGNED anchor.**
- **Integration-root registry** (`ci/integration-roots.json`): sourced to "Dev
  Execution Model v1.4 §12 / PR-B" per the file's own `$comment`, a LOCKED
  directive not present as an in-repo ADR. **No in-repo ADR anchor.**
