# cloudwatch-log-group

Aramo Terraform module — provisions a single CloudWatch log group.

First module populated under `infrastructure/modules/` per ADR-0012
Decision 7 and ADR-0013 Decision 3.

## Purpose

Thin wrapper around `aws_cloudwatch_log_group` that codifies the Aramo
convention for log-group provisioning:

- Caller supplies the log group name (e.g. `/aramo/api/dev`,
  `/aramo/auth/prod`).
- Caller supplies per-environment retention (dev 7d, staging 30d,
  prod 90d per ADR-0013 Decision 4).
- Tag overlay layered on top of provider `default_tags`
  (`Project = "Aramo"`, `Environment = var.environment`,
  `ManagedBy = "Terraform"`).

## Inputs

| Name                | Type          | Default | Description                                                                                |
| ------------------- | ------------- | ------- | ------------------------------------------------------------------------------------------ |
| `name`              | `string`      | n/a     | CloudWatch log group name (e.g. `/aramo/api/dev`).                                         |
| `retention_in_days` | `number`      | `30`    | Retention period; must be an AWS-valid CloudWatch Logs retention value (see validation).   |
| `tags`              | `map(string)` | `{}`    | Tag overlay applied in addition to the provider `default_tags` block.                      |

Valid `retention_in_days` values (per AWS): `1, 3, 5, 7, 14, 30, 60, 90,
120, 150, 180, 365, 400, 545, 731, 1827, 2192, 2557, 2922, 3288, 3653`.

## Outputs

| Name   | Description                                |
| ------ | ------------------------------------------ |
| `arn`  | ARN of the created CloudWatch log group.   |
| `name` | Name of the created CloudWatch log group.  |

## Usage

```hcl
module "api_log_group" {
  source            = "../../modules/cloudwatch-log-group"
  name              = "/aramo/api/${var.environment}"
  retention_in_days = var.api_log_retention_days
}

module "auth_log_group" {
  source            = "../../modules/cloudwatch-log-group"
  name              = "/aramo/auth/${var.environment}"
  retention_in_days = var.auth_log_retention_days
}
```

Caller passes per-environment retention via `terraform.tfvars`:

- dev:     `api_log_retention_days = 7`,  `auth_log_retention_days = 7`
- staging: `api_log_retention_days = 30`, `auth_log_retention_days = 30`
- prod:    `api_log_retention_days = 90`, `auth_log_retention_days = 90`

## Convention notes

The corresponding Aramo log streams are emitted by the application
runtime via the `aramo-logger` factory in `libs/common/src/lib/logging/`
(structured JSON to stdout; AWS Logs ingests via the runtime's log
driver). See ADR-0013 Decisions 1 / 2 / 5 for the workspace-wide
observability conventions that govern when modules call into this
module.
