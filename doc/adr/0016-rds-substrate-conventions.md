# ADR-0016: RDS Substrate Conventions (VPC + RDS Modules, Per-Env Scope, Secrets Manager Master Password)

**Status:** Accepted

**Date:** 2026-05-27

---

## Context

Plan v1.5 §M5 Track A item 5 commits the Aramo program to "RDS automated
backups and point-in-time recovery configuration per Architecture §17.2,
on the M4 infrastructure-as-code track" (anchored at
`doc/01-locked-baselines.md` §11 verbatim). Architecture §17.2 (anchored
at `doc/01-locked-baselines.md` §12 verbatim) names RPO 15 minutes / RTO
1 hour targets and five DR mechanisms; PR-10b ships two of them (RDS
automated backups + point-in-time recovery), and PR-10a (this ADR's
home) creates the RDS substrate that PR-10b configures.

The M5 PR-10 Substrate Audit (HEAD `1cedcb9`) surfaced a substrate gap:
the M4 IaC track had zero RDS resources and zero networking resources
(per ADR-0012 Decision 9 greenfield posture). Lead disposed the audit
findings into a PR-10a/PR-10b split — PR-10a creates the RDS substrate
(with a minimal bundled VPC module per Lead-Q-PR-10a-B1 disposition
(d2)), and PR-10b ships the backup/PITR configuration + ADR-0017 (RDS
DR Strategy).

PR-10a is the **first M5 AWS data-plane PR**, the **first
Secrets-Manager-Terraform-managed sensitive resource** in the workspace,
and the **first Terraform `sensitive = true` outputs** in the workspace.
The conventions below lock the substrate decisions so that PR-10b and
future M5+ / M6 / M7 PRs touching the RDS substrate (cross-region
replication, dedicated KMS, application Secrets Manager retrieval,
ElastiCache / SNS / SQS / IAM modules) do not re-decide the substrate
shape.

The seven M5 PR-10a Substrate Audit Lead-Q items (B1, B2, C1, C2, C3,
E1, F1) and the inherited PR-10 audit Lead-Q items (A1, A2, B1, B2, D2,
F1, H1, J1) all map into the twelve decisions below.

---

## Decision

### Decision 1 — Module file structure (matches `cloudwatch-log-group` convention)

Each module under `infrastructure/modules/` is four files: `main.tf`
(terraform required_providers block + resources), `variables.tf` (input
variables with `description` + `type` + optional `default` + optional
`validation` block), `outputs.tf` (computed outputs; `sensitive = true`
flag set where appropriate), `README.md` (Purpose → Inputs (table) →
Outputs (table) → Usage (hcl block) → Convention notes).

**Why.** The `cloudwatch-log-group` module (M4 PR-9) established this
file structure; the PR-10a Substrate Audit Axis A confirmed it as the
template pattern. Diverging would introduce module-layout drift.

**Constraint preserved.** Every module declares its own `terraform {
required_version = ">= 1.6.0"; required_providers = { aws = { source =
"hashicorp/aws", version = "~> 5.0" } } }` block in `main.tf` (mirrors
`cloudwatch-log-group/main.tf:18-27`). This is duplicated by design.

---

### Decision 2 — Per-environment scope: prod + staging only

PR-10a provisions RDS substrate (VPC + RDS) in `prod` and `staging`
environments only. The `dev` environment is excluded from PR-10a scope.

**Why.** Per Lead-Q-PR-10-A2 disposition (c). The dev environment is
"rarely deployed; minimal AWS resources" per `infrastructure/README.md`
ADR-0012 Decision 5; running an RDS instance in dev would incur ~$15-25/
month minimum without proportionate engineering benefit (developers use
Testcontainers locally per ADR-0012 Decision 9). Dev RDS provisioning is
deferred indefinitely.

**Constraint preserved.** `dev` environment retains its CloudWatch log
groups (M4 PR-9 scope) but receives no VPC + RDS modules at PR-10a.

---

### Decision 3 — Instance class + engine version per environment

- **prod**: `db.t3.medium` (4 GB RAM; 2 vCPU; burstable T-class).
- **staging**: `db.t3.small` (2 GB RAM; 2 vCPU; burstable T-class).
- **engine_version**: `15.7` (Postgres 15 LTS through 2027; matches the
  workspace's per-module Prisma schemas which use
  `provider = "postgresql"`).

**Why.** Per Lead-Q-PR-10a-C1 + C2 dispositions. T-class burstable
instances are cost-conservative for M5 baseline workloads with unknown
runtime characteristics; right-sizing to memory-optimized (R-class) or
dedicated (M-class) families is operational tuning post-M5. Postgres
15.7 specifically locks AWS RDS to a known-stable minor version (AWS
auto-applies minor upgrades via `auto_minor_version_upgrade = true`).

**Constraint preserved.** `allocated_storage = 20` GiB minimum (AWS gp3
floor); `max_allocated_storage = 100` GiB autoscaling cap. Both are M5
defaults; right-size at operational tuning time.

---

### Decision 4 — Multi-AZ posture per environment

- **prod**: `multi_az = true`. Mandatory for Architecture §17.2 RPO 15
  minutes / RTO 1 hour targets (anchored at `doc/01-locked-baselines.md`
  §12). Without multi-AZ, RTO 1hr is unachievable: a single-AZ failure
  requires PITR restore, which takes >1 hour for non-trivial datasets.
- **staging**: `multi_az = false`. Staging is for change validation, not
  DR rehearsal. Recovery test cadence (twice/year per Architecture
  §17.2) covers DR rehearsal separately.

**Why.** Per Lead-Q-PR-10a-C3 disposition. Multi-AZ doubles instance
cost; staging does not need DR posture; prod requires it to meet RTO.

---

### Decision 5 — Security group access pattern (PR-10a establishes; ingress rules deferred)

The `vpc` module creates a dedicated `aws_security_group.rds` per
environment with no ingress rules. Egress retains AWS default (allow-
all). The RDS module attaches this SG via `vpc_security_group_ids`.

**Why.** PR-10a's scope is substrate-creation only; application-layer
access patterns (which CIDR blocks / security groups need to reach the
RDS endpoint) are not knowable until the application is wired through
to Secrets Manager + an AWS deployment target. Ingress rules are added
in a sequenced PR (M5-close OR M6 binding per Decision 12).

**Trade-off acknowledged.** The empty-ingress-rules state at PR-10a
creation time means the RDS instance is unreachable until the
sequenced ingress PR lands. This is correct: the application is not yet
deployed, so unreachability is a feature, not a defect.

---

### Decision 6 — Master password strategy: AWS Secrets Manager auto-managed

The `aws_db_instance` resource sets `manage_master_user_password = true`,
which directs AWS RDS to auto-generate the master password, store it in
AWS Secrets Manager, and rotate it on a schedule managed by RDS itself.

**Why.** Per Lead-Q-PR-10a-E1 disposition. Three independent benefits:

- **Zero operator burden.** No manual `terraform.tfvars` sensitive
  variable; no password copy/paste; no out-of-band secret rotation
  workflow.
- **AWS-native rotation.** RDS handles password rotation directly; no
  custom Lambda or operator-driven rotation cycle.
- **Cleaner gitignore posture.** Bypasses the `*.tfvars` operator-
  secrets workflow established by ADR-0012; the workspace never needs
  to hold the master password in any form.

**Side effect.** PR-10a is the **first
Secrets-Manager-Terraform-managed sensitive resource** in the workspace.
The RDS module's `outputs.tf` exposes `master_user_secret_arn` (marked
`sensitive = true`), pointing to the auto-created secret. Application-
layer retrieval of the password from this secret is deferred per
Decision 12.

---

### Decision 7 — Account-default KMS posture (dedicated KMS module deferred to M7)

The `aws_db_instance` resource sets `storage_encrypted = true` but does
NOT set `kms_key_id`; AWS RDS uses the account-default RDS KMS key.

**Why.** Per Lead-Q-PR-10-F1 disposition (a). Storage encryption is
mandatory (tfsec AWS017; Architecture §14.3 implied), but a dedicated
RDS KMS key with custom rotation policy is M7 scope (when AWS Secrets
Manager signing-key rotation also lands per ADR-0012 Decision 1
Architecture §12.2 references). PR-10a does not provision a `modules/
kms/` module.

**Forward consideration.** Cross-region snapshot replication (Architecture
§17.2 third mechanism) requires a KMS key that exists in BOTH regions;
the dedicated KMS module is a prerequisite for that work (M7).

---

### Decision 8 — Backup variables declared at PR-10a; values set at PR-10b

The RDS module declares two backup-related variables with safe defaults:

- `backup_retention_period` (number; default `7`; validation 0-35).
- `backup_window` (string; default `null` = AWS auto-assigns).

Per-environment `terraform.tfvars.example` files do NOT override these
defaults at PR-10a. PR-10b overrides per-env values to:

- prod: `backup_retention_period = 35` (AWS RDS maximum; provides
  operational margin beyond Architecture §17.2 RPO 15min target).
- staging: `backup_retention_period = 7` (AWS-default; minimal cost).
- dev: N/A (excluded from PR-10a).

**Why.** PR-10a/10b split discipline (per Lead-Q-PR-10-A1 disposition
(c)). PR-10a creates the substrate; PR-10b configures the DR posture.
The split keeps each PR cleanly scoped + reviewable + revertible. PR-10b
also ships ADR-0017 (RDS DR Strategy) capturing retention-period
rationale.

**Substrate-truth.** The AWS RDS modern default
`backup_retention_period = 7` aligns with PR-9 audit precedent of using
stable AWS defaults at substrate-creation time. Note: AWS historical
default was 1 day; PR-10a uses 7 in the module-default to match the
modern AWS Console behavior.

---

### Decision 9 — VPC substrate strategy: minimal VPC module bundled per environment

PR-10a bundles a minimal `modules/vpc/` module (VPC + ≥2 DB subnets
across distinct AZs + RDS security group) in the same PR as the RDS
module. Each environment instantiates its own VPC.

**Why.** Per Lead-Q-PR-10a-B1 disposition (d2). Audit Axis B confirmed
zero VPC + networking substrate in the M4 IaC track (ADR-0012 Decision 9
greenfield posture). AWS RDS requires a `db_subnet_group` referencing
≥2 subnets in distinct AZs; without a VPC + subnets, the RDS module
cannot apply. Three alternatives were considered:

- **(d1) Default VPC + default subnets.** Short-term simplicity; long-
  term debt (production should not run on default VPC). Rejected.
- **(d2) Bundle minimal VPC module in PR-10a.** Keeps M5 networking
  inside Plan v1.5 §M5 verbatim scope ("RDS + …networking"). **Chosen.**
- **(d3) Three-PR split (PR-10a-pre VPC + PR-10a RDS + PR-10b backups).**
  Cleanest scope but adds a directive cycle without substrate benefit.
  Rejected.

**Constraint preserved.** The VPC module ships with only the minimum
resources required by RDS: VPC, ≥2 private DB subnets, 1 RDS security
group. NO public subnets, NO internet gateway, NO NAT gateway, NO route
tables (DB subnets are private-only at PR-10a). Public-facing networking
ships when the application layer wires through (M5-close OR M6).

---

### Decision 10 — Dev environment exclusion rationale

Per Decision 2; rationale repeated for clarity: dev environment retains
the M4 PR-9 CloudWatch log groups but receives no VPC + RDS modules at
PR-10a. Developers use Testcontainers locally per ADR-0012 Decision 9.

**Why.** Cost. A dev RDS instance + dev VPC would add ~$25-40/month
minimum (RDS t3.micro + Secrets Manager secret + storage) without
proportionate engineering benefit. Right answer: continue Testcontainers
for local development; deploy RDS only to staging + prod.

**Reversibility.** If a future M-cycle needs a dev RDS instance (e.g.,
for shared dev integration testing), the dev environment can adopt the
same module pattern with no changes to the module itself.

---

### Decision 11 — CIDR conventions per environment

Each environment's VPC uses a non-overlapping /16 IPv4 CIDR:

- **prod**: `10.0.0.0/16` (DB subnets at `10.0.10.0/24`, `10.0.11.0/24`).
- **staging**: `10.1.0.0/16` (DB subnets at `10.1.10.0/24`, `10.1.11.0/24`).
- **dev**: N/A (excluded from PR-10a per Decision 10).

**Why.** Per Lead-Q-PR-10a-B2 disposition (b). Non-overlapping CIDRs
preserve future VPC-peering optionality (e.g., for cross-env shared
services, recovery test environments, or M7 cross-region replication
linkage). The /16 prefix gives 65k IPs per env (well above any
foreseeable Aramo need); /24 DB subnets give 256 IPs each (well above
RDS instance count needs).

**Subnet derivation.** The VPC module uses
`cidrsubnet(var.vpc_cidr, 8, 10 + count.index)` to carve /24 subnets at
offsets 10, 11, ... within the /16 VPC. The "10+" offset reserves
`10.x.0.0/24` through `10.x.9.0/24` for future public/private subnet
expansion when the application layer wires through.

---

### Decision 12 — Application-layer Secrets Manager retrieval deferred post-M5

PR-10a creates the RDS substrate + master password in AWS Secrets
Manager (per Decision 6). The application-layer retrieval of the
password from Secrets Manager (NestJS app → AWS SDK → Secrets Manager
API → `DATABASE_URL` composition at app startup) is **OUT of PR-10a
scope**.

**Current state (M0-M5 to date).** `DATABASE_URL` is hardcoded via env
vars (testcontainers in CI; manual configuration in any deployed env).
No AWS SDK runtime dependency exists in `libs/*`.

**Post-M5 follow-up (M5-close handoff candidate OR M6 binding).**
- `libs/database` service for Secrets Manager bootstrap.
- `DATABASE_URL` composition from Secrets Manager values at app startup.
- Per-env service discovery integration (which Secrets Manager ARN
  belongs to which deployed environment).
- VPC ingress rules for application-to-RDS connectivity (per Decision 5
  deferral).

**Why deferred.** Application-layer retrieval requires (a) a deployed
application environment (no AWS deployment target exists at PR-10a),
(b) ingress rules connecting the application's SG to the RDS SG, and
(c) operational decisions about Secrets Manager ARN service discovery.
None of these blockers can be resolved within PR-10a's substrate-
creation scope.

---

## Consequences

### Positive

- Plan v1.5 §M5 Track A item 5 substrate-prerequisite half is materially
  satisfied by PR-10a; PR-10b ships backup/PITR config against this
  substrate without re-debating module shape.
- First M5 AWS data-plane PR establishes the convention pattern for
  future M5+ / M6 / M7 modules (ElastiCache, SNS, SQS, IAM, Secrets
  Manager rotation policies).
- First Secrets-Manager-Terraform-managed resource in the workspace;
  validates the AWS-native rotation pattern as a workspace primitive.
- First Terraform `sensitive = true` outputs in the workspace;
  establishes the convention for plan/apply log hygiene around
  sensitive substrate values.
- Module file structure (per Decision 1) keeps onboarding ramp minimal:
  any future module follows the same 4-file pattern.
- Per-env VPC CIDR convention (per Decision 11) preserves VPC-peering
  optionality without requiring future CIDR migration.
- The PR-10a/PR-10b split (per Decision 8) lets PR-10b focus purely on
  DR posture decisions (retention period, backup window) without
  re-debating substrate shape.

### Negative

- The RDS instance is unreachable at PR-10a apply time (no ingress
  rules on the security group). This is correct per Decision 5 but means
  PR-10a alone produces no end-user-observable value beyond "a database
  exists in AWS"; PR-10b adds DR posture but still no end-user value;
  end-user value lands when the application layer is wired through.
- The application-layer retrieval deferral (per Decision 12) creates a
  carry-forward obligation: the M5-close handoff record must surface
  this deferral so M6 (or later) implementers know to land it.
- Dev environment exclusion (per Decision 10) means dev developers
  cannot exercise the RDS substrate locally. Testcontainers remains the
  dev pattern; this is consistent with ADR-0012 Decision 9 but worth
  noting for new contributors.
- Account-default KMS posture (per Decision 7) means cross-region
  snapshot replication (Architecture §17.2 third mechanism) is blocked
  until M7 ships the dedicated KMS module. This is intentional but
  worth surfacing.

### Neutral

- The bundled VPC module (per Decision 9) means PR-10a has materially
  larger scope than a hypothetical "RDS-only" PR. The audit captured
  this scope expansion (Axis B RED verdict); the directive disposed it
  via option (d2). Trade-off is documented in this ADR's Context section.
- The choice to declare `backup_retention_period` + `backup_window` as
  variables at PR-10a (per Decision 8) rather than literal values inside
  the module means PR-10b's surface area is per-env tfvars overrides
  only — no module changes. This minimizes PR-10b's blast radius.
- The CIDR convention (per Decision 11) reserves `10.x.0.0/24` through
  `10.x.9.0/24` for future public/private subnet expansion. If a future
  M-cycle needs >10 additional subnets per env, the `+10` offset in
  `cidrsubnet()` will need revisiting; this is a documented future
  consideration, not a blocker.

---

## Authority

- `doc/01-locked-baselines.md` §11 (Plan v1.5 §M5 Track A item 5 verbatim).
- `doc/01-locked-baselines.md` §12 (Architecture §17.2 verbatim; RPO 15min
  / RTO 1hr targets; 5 DR mechanisms).
- ADR-0012 (IaC Conventions): Decision 1 (AWS provider), Decision 5
  (per-env directory + blast-radius isolation), Decision 7 (`modules/`
  + `environments/<env>/` separation), Decision 9 (greenfield posture).
- ADR-0013 (Observability Conventions): mirror template pattern + per-
  env retention pattern (here: per-env multi-AZ posture per Decision 4).
- M5 PR-10 Substrate Audit Report v1.0 (HEAD `1cedcb9`): scope-expansion
  finding (no RDS in IaC) + 8 Lead-Q dispositions inherited at PR-10a
  directive draft.
- M5 PR-10a Substrate Audit Report v1.0 (HEAD `f9e547d`): YELLOW overall
  with RED Axis B (VPC substrate gap) disposed via Lead-Q-PR-10a-B1=(d2);
  7 Lead-Q-PR-10a-N items disposed per audit-recommended options.
