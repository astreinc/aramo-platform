# vpc

Aramo Terraform module — provisions a minimal VPC + ≥2 DB subnets across
distinct AZs + a dedicated RDS security group.

Second module populated under `infrastructure/modules/` per ADR-0012
Decision 7 + ADR-0016 Decision 9 (VPC substrate bundled with RDS in
PR-10a per Lead-Q-PR-10a-B1=(d2) disposition; first M5 AWS data-plane
PR).

## Purpose

Thin wrapper around `aws_vpc` + `aws_subnet` + `aws_security_group` that
codifies the Aramo convention for the data-plane network substrate:

- Caller supplies a /16 VPC CIDR (per ADR-0016 Decision 11: prod
  `10.0.0.0/16`; staging `10.1.0.0/16`).
- Caller supplies the environment name (used in resource Name tags).
- DB subnets are auto-derived as /24 carve-outs at offsets 10 + AZ index
  (`10.0.10.0/24`, `10.0.11.0/24` for prod; `10.1.10.0/24`, `10.1.11.0/24`
  for staging).
- A dedicated RDS security group is created; ingress rules left empty at
  PR-10a (added when application layer wires through per ADR-0016
  Decision 12 / M5-close OR M6 binding).
- Tag overlay layered on top of provider `default_tags`
  (`Project = "Aramo"`, `Environment = var.environment`,
  `ManagedBy = "Terraform"`).

## Inputs

| Name          | Type          | Default | Description                                                                                              |
| ------------- | ------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `vpc_cidr`    | `string`      | n/a     | VPC IPv4 CIDR block (must be /16 per ADR-0016 Decision 11).                                              |
| `az_count`    | `number`      | `2`     | Number of AZs for DB subnets (≥2 required by AWS RDS db_subnet_group).                                   |
| `environment` | `string`      | n/a     | Environment name (`dev` / `staging` / `prod`); used in resource Name tags.                               |
| `tags`        | `map(string)` | `{}`    | Tag overlay applied in addition to the provider `default_tags` block.                                    |

## Outputs

| Name                    | Description                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `vpc_id`                | ID of the created VPC.                                                                     |
| `db_subnet_ids`         | List of DB subnet IDs (≥2 across distinct AZs); pass to RDS module's `subnet_ids` input.   |
| `rds_security_group_id` | ID of the RDS security group; pass as single-element list to RDS module's SG IDs input.    |

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
  subnet_ids             = module.vpc.db_subnet_ids
  vpc_security_group_ids = [module.vpc.rds_security_group_id]
  # ...other RDS variables
}
```

## Convention notes

The DB security group has NO ingress rules at PR-10a creation time. This
is deliberate: PR-10a's scope is substrate-creation only; application-
layer access patterns (which CIDR blocks / security groups need to reach
the RDS endpoint) are not in scope until the application is wired
through to Secrets Manager + an AWS deployment target (M5-close OR M6).
The egress default (allow-all to anywhere) is preserved.

See ADR-0016 (RDS Substrate Conventions) Decisions 9 + 11 + 12 for the
workspace-wide VPC + CIDR + access-pattern conventions.
