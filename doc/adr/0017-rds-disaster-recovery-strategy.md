# ADR-0017: RDS Disaster Recovery Strategy (Backup Retention + PITR Configuration, Per-Env Backup Window, M7 Deferrals)

**Status:** Accepted

**Date:** 2026-05-27

---

## Context

Plan v1.5 §M5 Track A item 5 commits the Aramo program to "RDS automated
backups and point-in-time recovery configuration per Architecture §17.2,
on the M4 infrastructure-as-code track" (anchored verbatim at
`doc/01-locked-baselines.md` §11). Architecture §17.2 (anchored verbatim
at `doc/01-locked-baselines.md` §12) names RPO 15 minutes / RTO 1 hour
targets and five disaster-recovery mechanisms:

1. RDS automated backups.
2. Point-in-time recovery (PITR).
3. Cross-region snapshot replication.
4. S3 versioning.
5. Recovery test cadence (twice per year).

PR-10a (`doc/adr/0016-rds-substrate-conventions.md`; merge `60225de`)
shipped the substrate-prerequisite half of Track A item 5: the RDS
Terraform module (Postgres 15.7 + multi-AZ + Secrets-Manager-managed
master password + storage_encrypted + performance_insights_enabled) was
provisioned end-to-end in prod + staging, with `backup_retention_period`
and `backup_window` declared as module variables holding safe defaults
(retention `7`; window `null` = AWS auto-assigns) per ADR-0016 Decision
8. PR-10b ships the configuration half: per-environment tfvars overrides
that satisfy mechanisms #1 (automated backups) and #2 (PITR), plus this
ADR capturing the DR strategy.

The M5 PR-10b Substrate Audit (HEAD `60225de`; eight-axis inspection;
GREEN overall with one YELLOW axis on ADR-0015 numbering gap surfaced
and Lead-disposed) confirmed the substrate-readiness preconditions and
surfaced five Lead-Q items (A1, B1, D1, D2, G1) that were all disposed
at audit-review time. PR-10b is the **first M5 in-place Terraform
modification PR** (versus PR-10a's all-creation pattern); the
verification cascade therefore expects `~` (in-place) on
`aws_db_instance.this`, never `-/+` (replacement).

The remaining three §17.2 mechanisms — cross-region snapshot replication
(#3), S3 versioning (#4), and recovery test cadence (#5) — are out of
M5 scope and DEFERRED to M7 per Lead-Q-PR-10-B1 disposition; the
decisions below capture each deferral so M7 implementers inherit the
binding directly.

---

## Decision

### Decision 1 — RPO 15min / RTO 1hr binding to AWS RDS PITR

The Architecture §17.2 RPO 15-minute target is satisfied by AWS RDS
point-in-time recovery, which provides 5-minute granularity inside the
retention window (well below the 15-minute target). The RTO 1-hour
target is an operational target, not a Terraform-configurable attribute;
the restore-playbook reference in Decision 4 captures how RTO 1hr is
achieved.

**Why.** PITR is the AWS-native mechanism that materializes RPO at the
configured retention window. `backup_retention_period > 0` is the toggle
that enables PITR (retention = 0 disables it).

**Substrate.** ADR-0016 Decision 8 declared `backup_retention_period` as
a module variable at PR-10a; PR-10b sets per-env values that exceed the
target with operational margin.

---

### Decision 2 — Retention period per environment

- **prod**: `backup_retention_period = 35` days. AWS RDS PITR maximum.
  Operational margin beyond the Architecture §17.2 RPO 15min target.
- **staging**: `backup_retention_period = 7` days. Cost-conservative;
  supports M5-era change-validation rollback.
- **dev**: N/A (excluded from RDS provisioning per ADR-0016 Decision 10).

**Why.** Inherited Lead-Q-PR-10-B2 disposition: prod 35d / staging 7d.
The prod value buys operational headroom for late-discovered
data-corruption incidents; the staging value tracks AWS-modern-default
behavior at minimal storage cost.

**Trade-off.** PITR storage is proportional to retention × write-volume;
prod 35d is the cost-dominant DR storage line item. The trade-off is
accepted as the lowest-friction posture that exceeds the §17.2 RPO
target without operator action.

---

### Decision 3 — Backup window per environment: UTC 03:00-04:00 (both envs)

Per Lead-Q-PR-10b-B1 disposition. Both prod and staging use
`backup_window = "03:00-04:00"` UTC.

**Why.**

- Low-traffic window for both US-Eastern (23:00-00:00 EST) and EU
  (04:00-05:00 CET) operating regions.
- Conventional AWS RDS off-peak pattern; matches a typical default
  starting point.
- Same value both envs simplifies the operational mental model: one
  window to remember; consistent rehearsal posture.

**Substrate.** PR-10b adds a regex validation block to the module's
`backup_window` variable (per Decision 8) enforcing the
`hh24:mi-hh24:mi` UTC format; tfvars typos at override time are caught
at `terraform plan`.

**Note.** AWS RDS automatically extends the backup window if needed to
allow PITR snapshot completion; the configured value is the START, not
a bounded duration. AWS-default minimum 30-minute window applies.

---

### Decision 4 — Restore-playbook reference (M5-close OR M6 binding)

The Architecture §17.2 RTO 1-hour target is achieved operationally via a
restore-playbook. The playbook is anticipated at
`doc/ops/rds-restore-playbook.md` and covers: identifying the recovery
target time, initiating PITR via AWS Console or CLI, validating restored
instance, redirecting application connection strings, and post-restore
validation.

PR-10b does NOT author the playbook; ADR-0017 binds the future playbook
to the §17.2 RTO target. The authoring carry-forward is logged in the
follow-up registry as M5-close handoff OR M6 operational work.

**Why.** The playbook requires (a) a deployed application target to
redirect connection strings to, and (b) operational decisions
(Secrets Manager ARN service discovery; ingress rule provisioning) that
are themselves carry-forwards from ADR-0016 Decision 12. Authoring the
playbook before those substrate decisions land would produce a stale
artifact.

---

### Decision 5 — Cross-region snapshot replication DEFERRED to M7

Architecture §17.2 mechanism #3 is DEFERRED to M7 per inherited
Lead-Q-PR-10-B1 disposition.

**Why.** Cross-region snapshot replication requires (a) a dedicated KMS
key replicated to both regions (M7 scope per ADR-0016 Decision 7), and
(b) an explicit secondary region selection. Both are M7 prerequisites;
M5 ships the in-region DR posture only.

**Carry-forward.** M7 binding logged in §9 follow-up registry; the
dedicated KMS module and the secondary-region selection precede the
replication configuration.

---

### Decision 6 — Recovery test cadence DEFERRED to M7 operational track

Architecture §17.2 specifies "twice per year" recovery test cadence.
This is operational, not Terraform-configurable; it lives in an
operational runbook + calendar, not in IaC.

**Why.** Recovery test rehearsals exercise the restore-playbook
(Decision 4) and validate that RTO 1hr remains achievable under realistic
data-volume conditions. M7 binds the operational track that produces the
rehearsal cadence + tracks rehearsal outcomes.

**Carry-forward.** M7 binding logged in §9 follow-up registry.

---

### Decision 7 — Final snapshot policy: default AWS timestamp-based naming

`skip_final_snapshot = false` (PR-10a setting at
`infrastructure/modules/rds/main.tf:69`) remains in effect at PR-10b.
PR-10b does NOT set `final_snapshot_identifier` per env; AWS auto-
generates timestamp-based identifiers when the instance is destroyed.

**Why.** Per Lead-Q-PR-10b-D1 disposition. Explicit identifier patterns
add complexity (e.g., a `${var.environment}-final-${TIMESTAMP}` pattern
requires either Terraform `formatdate()` plumbing or a CI-time
substitution) without M5 rationale. Default AWS naming is operationally
sufficient for the rare destroy event; `deletion_protection = true`
already gates destroy at the resource level.

**Trade-off.** Default AWS naming uses an opaque identifier (e.g.,
`rds:aramo-prod-2026-05-27-03-00`); an explicit pattern would be more
discoverable. The trade-off is accepted given the low-frequency destroy
path and the protective `deletion_protection` guard.

---

### Decision 8 — backup_window regex validation at module variable

Per Lead-Q-PR-10b-A1 disposition. The RDS module's `backup_window`
variable declaration at `infrastructure/modules/rds/variables.tf`
includes a validation block:

```hcl
validation {
  condition     = var.backup_window == null || can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$", var.backup_window))
  error_message = "backup_window must be null OR a UTC time range matching pattern hh24:mi-hh24:mi (e.g., \"03:00-04:00\")."
}
```

**Why.** Defends against operator typos at tfvars override time. Cheap
(five-line addition); module-touch surface stays within PR-10b's
tfvars-override-only scope (refinement to a variable declared at PR-10a,
not a new variable). The `null` allowance preserves the AWS-auto-assign
default for any future environment that opts out of explicit windowing.

**Trade-off.** AWS provider itself rejects invalid timing strings at
`apply` time; the module-level validation catches the error one step
earlier (at `plan` time) and produces a clearer error message. The
trade-off is one-way: validation strictness rises, validation
permissiveness does not regress.

---

### Decision 9 — Configuration-correctness vs deployed-substrate closure distinction (PL-84 candidate)

PR-10a + PR-10b ship the **configuration-correctness closure** of Plan
v1.5 §M5 Track A item 5 (Architecture §17.2 mechanisms #1 + #2 — RDS
automated backups + PITR). The **deployed-substrate closure** —
`terraform apply` against real AWS that materializes the RDS instance
and activates the in-place backup-window/retention modification
semantics — is operational-track work post-M5; anticipated as M7
binding or an external operational PR alongside the
ingress-rules + application-Secrets-Manager-retrieval carry-forwards
documented at ADR-0016 Decision 12.

**Why.** Greenfield-state Gate 5 verification (per the PR-10a Ruling 7
inherited file-based local-backend plan capture pattern) confirms
configuration semantic correctness: attribute values flow through the
module to the resource block as designed; `terraform validate` +
`tflint` + `tfsec` + module-variable regex validation all green. The
in-place modification semantics (`~` diff on `aws_db_instance.this`)
activate only post-apply: with no prior applied state, `terraform plan`
necessarily computes against an empty base, producing an 8-resource
creation plan (the same shape as PR-10a Gate 5).

The PR-10b Gate 5 surface therefore verifies the directive-mandated
configuration correctness; the deployed-substrate behavioral
verification (PITR restore exercise; backup-window-attribute change as
in-place modification; recovery-test rehearsal cadence per Decision 6)
happens operationally after first apply.

**Substrate posture at PR-10b Gate 5** (HEAD `60225de` + branch
`feature/m5-pr-10b-backup-pitr-config`):

- Zero AWS resources actually deployed against the configuration; no
  `terraform apply` has run against real AWS in this milestone.
- Eight Terraform-resident resources designed per env (1 VPC + 2 DB
  subnets + 1 RDS security group + 1 db_subnet_group + 1
  aws_db_instance + performance-insights KMS data source pinning + tag
  overlay flows).
- `aws_db_instance.this` configured with Track A item 5 substrate-truth
  values: `backup_retention_period` per env (35d prod / 7d staging);
  `backup_window = "03:00-04:00"`; `multi_az` per env; storage_encrypted;
  PITR enabled via retention > 0.

**Carry-forward.** Deployed-substrate closure is tracked in §9
follow-up registry alongside the other ADR-0016 Decision 12
carry-forwards (application Secrets Manager retrieval; ingress rules;
service-discovery wiring). All four converge on the post-M5 / M6 / M7
operational deployment track.

**Convention (PL-84 candidate).** For Terraform PRs against undeployed
substrate, Gate 5 verification accepts greenfield-state all-creation
plan shape (matching the substrate-creation PR's plan shape) as
evidence of configuration correctness when:

- (a) attribute values flow through correctly per directive disposition,
- (b) zero `-/+` replacement appears in the plan,
- (c) zero destroy appears in the plan,
- (d) `terraform fmt` + `validate` + `tflint` + `tfsec` +
  module-variable validation all green.

In-place modification semantics defer to deployed-substrate closure.
Future post-apply tuning PRs (e.g., retention change) will inherit the
`~` diff expectation that PR-10b's directive narrative originally
anticipated.

---

## Consequences

### Positive

- Plan v1.5 §M5 Track A item 5 closes FULLY on PR-10b merge; the
  substrate-prerequisite + configuration halves both land in M5.
- Architecture §17.2 mechanisms #1 (automated backups) and #2 (PITR)
  are materialized; the §17.2 RPO 15-minute target is exceeded with
  operational margin (prod 35d / staging 7d both >> 15-minute window).
- First M5 in-place Terraform modification PR; second use of Process
  Lesson 66 Category 4 (terraform plan dry-run) establishes the
  in-place verification idiom for future M5+ IaC tuning PRs.
- backup_window regex validation (Decision 8) catches operator typos
  one step earlier than the AWS provider would, producing a clearer
  error message at plan time.
- Same backup window value across envs (Decision 3) simplifies the
  operational rehearsal posture.
- ADR-0017 binds future M7 work to the §17.2 mechanisms #3, #4, #5
  deferrals so M7 implementers inherit the targets directly.

### Negative

- Cross-region snapshot replication (Decision 5) and recovery test
  cadence (Decision 6) remain unsatisfied at M5 close; the §17.2
  posture is partial until M7 lands those mechanisms.
- The restore-playbook (Decision 4) is a carry-forward; the §17.2 RTO
  1-hour target depends on it but the artifact does not yet exist. M5
  close-out must surface this so M6 (or later) authors the playbook.
- PITR storage cost is proportional to retention × write-volume;
  prod 35d (Decision 2) is the cost-dominant DR storage line item.
  This is accepted as the lowest-friction posture that exceeds the RPO
  target without operator action.
- Default AWS final-snapshot naming (Decision 7) produces an opaque
  identifier on the rare destroy path; discoverability is reduced
  compared to an explicit pattern.

### Neutral

- The `backup_window` regex validation (Decision 8) is one-way strict:
  the validation can only become more permissive in future ADRs, not
  less. Future formats (e.g., named windows) would require revisiting
  the regex.
- ADR-0015 numbering gap (Lead-Q-PR-10b-D2 disposition) is preserved;
  ADR-0017 follows ADR-0016 sequentially per the "Numbers are never
  reused" discipline. The gap is reserved for a future in-tree anchor
  of the OneDrive AI Substrate Posture content.
- The `dev` environment remains excluded from RDS provisioning per
  ADR-0016 Decision 10; PR-10b does NOT change the dev posture.

---

## Authority

- `doc/01-locked-baselines.md` §11 (Plan v1.5 §M5 Track A item 5
  verbatim).
- `doc/01-locked-baselines.md` §12 (Architecture §17.2 verbatim; RPO
  15min / RTO 1hr targets; five DR mechanisms).
- ADR-0016 (RDS Substrate Conventions): Decision 8 (backup variables
  declared at PR-10a; values set at PR-10b), Decision 7 (account-default
  KMS posture; dedicated KMS module deferred to M7), Decision 10 (dev
  exclusion).
- ADR-0013 (Observability Conventions): per-env retention pattern
  (mirrored here for per-env backup retention per Decision 2).
- M5 PR-10 Substrate Audit Report v1.0 (HEAD `1cedcb9`): scope-expansion
  finding + inherited Lead-Q dispositions.
- M5 PR-10a Substrate Audit Report v1.0 (HEAD `f9e547d`): YELLOW Axis B
  disposed via Lead-Q-PR-10a-B1=(d2); seven Lead-Q items disposed.
- M5 PR-10b Substrate Audit Report v1.0 (HEAD `60225de`): GREEN overall
  with one YELLOW on ADR-0015 numbering gap; five Lead-Q items
  (A1, B1, D1, D2, G1) all disposed at audit-review time.
