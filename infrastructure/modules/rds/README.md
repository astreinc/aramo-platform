# rds

Aramo Terraform module — provisions an `aws_db_instance` (Postgres 15.x)
+ `aws_db_subnet_group` per environment.

Third module populated under `infrastructure/modules/` per ADR-0012
Decision 7 + ADR-0016 (first M5 AWS data-plane PR; first
Secrets-Manager-Terraform-managed sensitive resource in the workspace).

## Purpose

Thin wrapper that codifies the Aramo convention for RDS Postgres
provisioning:

- Storage encryption mandatory (`storage_encrypted = true`; account-
  default KMS per Lead-Q-PR-10-F1=(a); dedicated KMS module deferred to
  M7).
- Master password auto-managed via AWS Secrets Manager
  (`manage_master_user_password = true` per ADR-0016 Decision 6); no
  operator-handled sensitive variables.
- Multi-AZ posture per environment (prod `true` / staging `false`) per
  ADR-0016 Decision 4 + Architecture §17.2 (doc/01 §12) RPO 15min /
  RTO 1hr targets.
- Deletion protection default `true`; final snapshot enforced
  (`skip_final_snapshot = false`).
- Performance Insights enabled at default 7-day retention.
- Backup configuration variables declared with safe defaults; per-env
  override values land at PR-10b per ADR-0016 Decision 8 + PR-10a/10b
  split discipline.

## Inputs

| Name                      | Type           | Default        | Description                                                                                                  |
| ------------------------- | -------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| `environment`             | `string`       | n/a            | Environment name (`dev` / `staging` / `prod`); used in identifier + tags.                                    |
| `engine_version`          | `string`       | n/a            | Postgres engine version (must match `15.x` per ADR-0016 Decision 3).                                         |
| `instance_class`          | `string`       | n/a            | RDS instance class (e.g., `db.t3.medium`, `db.t3.small`).                                                    |
| `allocated_storage`       | `number`       | `20`           | Allocated storage in GiB (≥20).                                                                              |
| `max_allocated_storage`   | `number`       | `100`          | Maximum allocated storage in GiB for autoscaling.                                                            |
| `db_name`                 | `string`       | n/a            | Initial database name.                                                                                       |
| `master_username`         | `string`       | `"aramo_admin"` | Master user name (password auto-managed via Secrets Manager).                                                |
| `subnet_ids`              | `list(string)` | n/a            | DB subnet IDs (≥2 in distinct AZs); typically from `module.vpc.db_subnet_ids`.                               |
| `vpc_security_group_ids`  | `list(string)` | n/a            | VPC security group IDs; typically `[module.vpc.rds_security_group_id]`.                                      |
| `backup_retention_period` | `number`       | `7`            | Backup retention in days (0-35). Per-env override at PR-10b per ADR-0016 Decision 8.                         |
| `backup_window`           | `string`       | `null`         | Preferred daily backup window (UTC); null = AWS auto-assigns. Per-env override at PR-10b.                    |
| `multi_az`                | `bool`         | n/a            | Multi-AZ posture (prod `true` / staging `false` per ADR-0016 Decision 4).                                    |
| `deletion_protection`     | `bool`         | `true`         | Deletion protection (default `true`; production safety).                                                     |
| `tags`                    | `map(string)`  | `{}`           | Tag overlay applied in addition to the provider `default_tags` block.                                        |

## Outputs

| Name                      | Sensitive | Description                                                                                                |
| ------------------------- | :-------: | ---------------------------------------------------------------------------------------------------------- |
| `endpoint`                | ✓         | Connection endpoint of the RDS instance (host:port).                                                       |
| `port`                    |           | Database port (typically 5432 for Postgres).                                                               |
| `arn`                     |           | ARN of the RDS instance.                                                                                   |
| `master_user_secret_arn`  | ✓         | ARN of the AWS Secrets Manager secret holding the auto-managed master password.                            |

## Usage

```hcl
module "vpc" {
  source      = "../../modules/vpc"
  environment = var.environment
  vpc_cidr    = "10.0.0.0/16"
  az_count    = 2
  tags        = local.common_tags
}

module "rds" {
  source                 = "../../modules/rds"
  environment            = var.environment
  engine_version         = "15.7"
  instance_class         = "db.t3.medium"
  allocated_storage      = 20
  max_allocated_storage  = 100
  db_name                = "aramo"
  subnet_ids             = module.vpc.db_subnet_ids
  vpc_security_group_ids = [module.vpc.rds_security_group_id]
  multi_az               = true
  deletion_protection    = true
  tags                   = local.common_tags
}
```

## Convention notes

PR-10a establishes the RDS substrate only:

- `backup_retention_period` + `backup_window` are declared as variables
  with module-default values (7 day / AWS-auto window). Per-environment
  override values (prod 35d / staging 7d per Architecture §17.2 RPO
  15min target) land at PR-10b per ADR-0016 Decision 8.
- The application-layer retrieval of the master password from AWS
  Secrets Manager (DATABASE_URL composition at app startup) is OUT of
  PR-10a scope per ADR-0016 Decision 12 (deferred to M5-close OR M6).

See ADR-0016 (RDS Substrate Conventions) for the full set of decisions
governing this module.
