# vpc

Aramo Terraform module — provisions a VPC with three subnet tiers
(public / DB / private-app) across distinct AZs, an internet gateway, a
single NAT gateway, the public + private-app route tables, and a
dedicated RDS security group.

Second module populated under `infrastructure/modules/` per ADR-0012
Decision 7 + ADR-0016 Decision 9 (VPC substrate bundled with RDS in
PR-10a per Lead-Q-PR-10a-B1=(d2) disposition; first M5 AWS data-plane
PR). **Step-4 Directive 2 (compute IaC)** extended it with the
public + private-app tiers + IGW + NAT + route tables the Fargate run
layer needs (the original DB tier + RDS SG are unchanged — purely
additive).

## Purpose

Thin wrapper around `aws_vpc` + `aws_subnet` + `aws_security_group` that
codifies the Aramo convention for the data-plane network substrate:

- Caller supplies a /16 VPC CIDR (per ADR-0016 Decision 11: prod
  `10.0.0.0/16`; staging `10.1.0.0/16`).
- Caller supplies the environment name (used in resource Name tags).
- Three /24 subnet tiers per AZ, auto-derived from the /16:
  - **public** at offsets `0 + i` (`10.x.0.0/24`, `10.x.1.0/24`) — host the
    ALB + NAT gateway; `map_public_ip_on_launch = true`.
  - **DB** at offsets `10 + i` (`10.x.10.0/24`, `10.x.11.0/24`) — RDS
    (unchanged from PR-10a).
  - **private-app** at offsets `20 + i` (`10.x.20.0/24`, `10.x.21.0/24`) —
    Fargate tasks + ElastiCache Redis; egress via NAT only.
- An internet gateway + a single NAT gateway (modest first-deploy sizing;
  per-AZ NAT is the scale-later option). Public route table → IGW;
  private-app route table → NAT.
- A dedicated RDS security group is created; its ingress rule
  (service-SG → 5432) is added at the composition layer by the
  `app-security-groups` module (kept out of this module to avoid a
  vpc↔compute cycle).
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

| Name                     | Description                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `vpc_id`                 | ID of the created VPC.                                                                            |
| `vpc_cidr`               | The VPC IPv4 CIDR block.                                                                          |
| `db_subnet_ids`          | List of DB subnet IDs (≥2 across distinct AZs); pass to RDS module's `subnet_ids` input.          |
| `public_subnet_ids`      | Public subnet IDs (≥2); pass to the ALB module.                                                   |
| `private_app_subnet_ids` | Private-app subnet IDs (≥2); pass to the ECS service + ElastiCache modules.                       |
| `rds_security_group_id`  | ID of the RDS security group; pass as single-element list to RDS module's SG IDs input.           |

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
