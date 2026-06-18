# ADR-0016 — RDS Substrate Conventions

- **Status:** ACCEPTED
- **In-tree path:** `doc/adr/0016-rds-substrate-conventions.md`
- **Original ratification:** M5 (first AWS data-plane substrate; PR-10a/10b)
- **Anchor authored:** 2026-06-16 (consolidation of the decision recorded in `aramo-handoff-m5-close.md` §0 and the M5 PR-10a/10b directives)

> **Anchor scope.** Consolidates the RDS module conventions ratified during M5 as the platform's first managed-database substrate. The per-environment Terraform values that follow these conventions live in `infrastructure/environments/{prod,staging}/main.tf` (authored in PR-10b); this ADR records the conventions those values implement.

## Context

M5 shipped the first AWS data-plane substrate (RDS + VPC) as configuration-correctness closure (deployed-substrate apply deferred post-M5 per ADR-0017 Decision 9). A shared `modules/rds` Terraform module is consumed by the prod and staging environments. Conventions were needed so the environments stay consistent and the dev tier is handled deliberately.

## Decisions

1. **Shared module.** RDS is provisioned through a single reusable `modules/rds` Terraform module; environments differ only by their input variables.
2. **Engine.** PostgreSQL `15.7` across environments (matches the local-dev Postgres major line).
3. **Instance class per environment.** prod `db.t3.medium`; staging `db.t3.small`.
4. **Storage.** `allocated_storage = 20`, `max_allocated_storage = 100` (autoscaling headroom) across environments.
5. **High availability per environment.** prod `multi_az = true`; staging `multi_az = false` (cost-conservative).
6. **Deletion protection.** `deletion_protection = true` in both prod and staging.
7. **Network.** Subnets and security group sourced from the VPC module outputs (`db_subnet_ids`, `rds_security_group_id`) — no hardcoded network identifiers.
8. **Database name.** `aramo`.
9. **Tagging.** `local.common_tags` applied to every RDS resource.
10. **Dev tier excluded from RDS provisioning.** The dev environment runs against local Postgres and is intentionally excluded from managed-RDS provisioning. (Referenced by ADR-0017 Decision 2, which sets retention as N/A for dev.)

## Relationship to other ADRs

- **ADR-0017** (RDS Disaster Recovery Strategy) adds the backup/retention/PITR decisions layered onto this module.
- **ADR-0012** (IaC Conventions) is the parent IaC ADR; this ADR specializes it for the RDS substrate.
