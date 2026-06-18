# ADR-0017 — RDS Disaster Recovery Strategy

- **Status:** ACCEPTED
- **In-tree path:** `doc/adr/0017-rds-disaster-recovery-strategy.md`
- **Original ratification:** M5 (PR-10b; binds Architecture §17.2)
- **Anchor authored:** 2026-06-16 (consolidation of the decisions specified in the M5 PR-10b directive §4.3 and recorded in `aramo-handoff-m5-close.md` §0)

> **Anchor scope.** Records the RDS disaster-recovery decisions ratified at M5 PR-10b. The decisions with explicit values (1–3) and the deferral/coverage decisions are reproduced faithfully below; the full operational specifics (restore playbook detail, the complete 8-decision enumeration) are in the PR-10b directive, which remains the authoritative source for execution detail. This anchor is the citable record of the DR posture.

## Context

Plan v1.5 §M5 Track A item 5 binds Architecture §17.2 (disaster recovery). PR-10a closed the substrate prerequisite (the RDS module + VPC); PR-10b ships the configuration half (backup/retention/PITR parameters on the existing `module "rds"` blocks). Of the five §17.2 DR mechanisms, M5 covers two; the other three are deferred.

## Decisions

1. **RPO 15min / RTO 1hr bound to PITR.** AWS RDS point-in-time recovery provides 5-minute granularity inside the retention window, satisfying the RPO 15-minute target. RTO 1hr is operational; the restore playbook documents the path.
2. **Retention period per environment.** prod **35 days** (AWS RDS PITR maximum; operational margin beyond targets); staging **7 days** (cost-conservative; supports M5-era change-validation rollback); dev **N/A** (excluded from RDS provisioning per ADR-0016 Decision 10).
3. **Backup window.** `03:00–04:00` UTC (low-traffic) in both prod and staging.
4. **Mechanism coverage / deferral.** Two of the five Architecture §17.2 DR mechanisms are covered at M5 — **RDS automated backups** and **PITR**. The remaining three — **cross-region replication**, **S3 versioning**, and a **recovery-test cadence** — are **deferred to M7**.
5. **Configuration-correctness, not deployed-apply.** The DR configuration is shipped as Terraform correctness; the deployed-substrate `apply` is deferred post-M5 (DR Decision 9 / ADR-0016 alignment). The parameters are validated by plan, not by a live restore, at M5.

## Consequence

A real DR drill (live restore + the recovery-test cadence) is **not** exercised at M5; it is part of the M7 PROD-readiness work alongside cross-region replication and S3 versioning. Until then, the DR posture is configuration-correct but not operationally proven.

## Relationship to other ADRs

- **ADR-0016** (RDS Substrate Conventions) is the module this DR strategy parameterizes.
- **ADR-0012** (IaC Conventions) is the parent IaC ADR.
