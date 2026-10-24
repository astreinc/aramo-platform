# D15 — Infrastructure, Deployment, Persistence Ops & Quality/Contract Enforcement (AS-DESIGNED)
> Baseline SHA 680907fc06620845944794e0a529918c980f5124 · category AS-DESIGNED
> Sourced ONLY from ratified ADRs / LOCKED specs under `doc/adr/*` and LOCKED directives in the canonical `Aramo/locked/` folder (cited by file name and section). Not synthesized from code.

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
- **Lightsail root separation:** `Aramo-Single-Box-Directive-4-Lightsail-Terraform-v1_0-LOCKED.md`
  §B (lines 21–27): `infrastructure-lightsail/` is "a new, separate root … Its own
  state … ZERO references to the platform"; §F lists Cognito config, `.env`
  secrets and app deploy/seed as explicitly OUT of Terraform.
- **Terraform vocabulary exemption:** `Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED.md`
  §3.8 (N-9): the provider's KMS key-spec attribute is a "strictly file- and
  field-specific" exemption.

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
- **Single-box backups (the box-era substitute):**
  `Aramo-Single-Box-Directive-3-Ops-Production-Readiness-v1_0-LOCKED.md` §B
  (lines 17–21): "A scheduled `pg_dump` … of the box Postgres → S3 … Restore
  drill — REQUIRED, not optional". No RPO/RTO figure is set for the box.
- **Talent Intelligence database:** `doc/adr/0036-talent-intelligence-service.md`
  Decision 2 (`:67`–`75`): `aramo_intelligence` on the existing Postgres server
  with its own role; "migrations … applied by a per-database runner
  (`tools/db-sync-intelligence.sh`) with its own ledger table
  `public._intelligence_migrations` … `deploy/migrate-prod.sh` invokes it after
  ensuring the database and role exist (idempotent; the PROD volume is not
  fresh, so `initdb` scripts cannot be relied on)." ATI-SEP-1 ruling G3
  (`Aramo-ATS-TI-Separation-Program-Directive-v1_0-LOCKED.md` §4) states the
  same.

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
  e-sign `aws_sns_topic` authored-but-never-applied with no subscription.
  (`doc/adr/0033-cross-service-durable-event-foundation.md`, Context.)
- ATI-SEP-1 §3 item 6 / ruling E-1 reuse the ADR-0033 envelope for the ATS → TI
  `talent.*` events with an explicit `event_version`.

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
- **Fourth host class (Sign):**
  `Aramo-Sign-Unified-Product-Permission-Contract-Platform-API-Directive-v1_0-LOCKED.md`
  §4.1.3: one host, three authentication zones, "a Content-Security-Policy and
  standard security headers on the Sign host; rate limiting on guest-signing and
  signup routes … the front-door verifier updated; one base-URL setting".
  `Aramo-Sign-Unified-Product-D1-Host-Retirement-Addendum-v1_0-LOCKED.md`
  "Final host topology": `esign.aramo.ai` retired with no redirect (**overrides
  parent §4.1.1**, which had specified a compatibility redirect); Directions §1
  reconcile nginx, env vars, Cognito callbacks and deployment documentation.
  `Aramo-Domain-Enforcement-P3-One-Organization-Per-Domain-Directive-v1_0-LOCKED.md`
  §4 (line 100): the narrow sign-host exception to apps/api for the two
  domain-verification prefixes.

## Pipeline⊥ATS boundary wall — ADR-0029 (LOCKED)

- The modular-monolith boundary: Pipeline libs never hard-import ATS libs; cross
  the L3 boundary by UUID ref + versioned Pact-tested connector contract only;
  nx boundary tags CI-enforce this.
  (`doc/adr/0029-pipeline-boundary-modular-monolith.md` /
  `doc/adr/Aramo-ADR-0029-Pipeline-Boundary-Modular-Monolith-v1_0-LOCKED.md`.)
- **ATS⊥TI wall (ADR-0036 Decision 1, `:50`–`54`):** "`scope:ats` must not
  depend on `scope:intelligence`. `scope:intelligence` must not depend on
  `scope:ats` or `scope:cip`" — "CI-enforced in `eslint.config.mjs`". ATI-SEP-1
  §5 executor discipline: "Pact registration for every new contract."

## Quality / contract-enforcement governance (CI)

- **Deployment-gate as the single required check**, override-label discipline,
  and the fast/full/nightly lane model derive from the CI-Velocity LOCKED
  directive family referenced in `.github/workflows/ci.yml:1-29` (PR-M0R-3 §4.1
  VARIANT B aggregator; CI-Velocity-2 §PR-2).
  `Aramo-CI-Velocity-Directive-v1_0-LOCKED.md` §PR-2 (lines 32–38): PR lane on
  `nx affected`; "**Merge queue** (`merge_group` trigger): the FULL current suite
  … runs on the queued merge result before it lands on main. `deployment-gate`
  requires the merge-group full set"; "Nightly full-serial run on `main` … never
  block PRs retroactively." `Aramo-CI-Velocity-2-Governed-Aggregate-Equivalence-Amendment-v1_0-LOCKED.md`
  (LOCKED) governs the consolidated aggregate. No in-repo ADR restates this.
- The **vocabulary two-tier discipline** (Tier-1 R7, Tier-2 locked vocabulary)
  is codified by PR-1 precedent and recorded in `doc/adr/0001-pr1-precedent-decisions.md`
  + `doc/adr/0011-r7-allowlist-extension-for-openapi-prohibited-values.md`.
- **Migration-ledger re-key discipline:** `Aramo-Sign-Naming-Unification-Directive-v1_0-LOCKED.md`
  §3.1: the ledger re-key from the old lib path "must be a **guarded
  reconciliation**, not a blind path rewrite … On partial state, it refuses and
  makes no change … Running it again after success is a no-op."

## Explicit anchor gaps (no ratified AS-DESIGNED source found)

- **Single-box Lightsail deployment topology** (`infrastructure-lightsail/`,
  `docker-compose.prod.yml`): anchored out-of-repo by
  `Aramo-Astre-Single-Box-Go-Live-Spec-v1_0-LOCKED.md` (§1 architecture, §8
  platform deferred to go-live #2) and Single-Box Directives 1–4 (referenced in
  `docker-compose.prod.yml:1`). There is still **no numbered in-repo ADR**
  specifying the single-box compose stack as the canonical production
  topology; ADR-0023 governs only the front-door slice.
- **Persistence-ops migrate/seed gating** (`deploy/migrate-prod.sh`,
  `deploy/seed-prod.sh`): no ADR ratifies the migrate-then-gate deploy sequence;
  the scripts cite operational incidents (`singlebox-ops.md`) rather than a
  ratified design spec. The bounded `--until` mode cites a "Lead Architect
  ruling 2026-10-14" (`deploy/migrate-prod.sh:46`–`47`); no LOCKED file carrying
  that ruling was found in `Aramo/locked/`. ADR-0036 Decision 2 anchors only the
  TI-DB step. **No AS-DESIGNED anchor for the shared-DB sequence.**
- **Image build gate** (`deploy/build-images.sh`, authorized-SHA + clean-tree,
  6 images): sourced to "T2-F1-H2" in its header; no LOCKED file found. **No
  anchor.**
- **Integration-root registry** (`ci/integration-roots.json`): sourced to "Dev
  Execution Model v1.4 §12 / PR-B" per the file's own `$comment`, a LOCKED
  directive not present as an in-repo ADR. **No in-repo ADR anchor.**
- **Separate GeoIP updater compose project** (`deploy/geoip/docker-compose.geoip.yml`):
  cites an "Architect ruling 2026-10-21" (`:6`) for GeoLite2 as a risk signal
  only; the Sign Personal (Free) Launch directive v1.1 is LOCKED but the
  separate-project deployment shape was not found stated in it. **Not
  verified as anchored.**
