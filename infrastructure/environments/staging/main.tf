# Aramo M4 PR-9 — first module consumption (staging composition).
# Aramo M5 PR-10a — VPC + RDS modules appended (first M5 AWS data-plane PR;
# CIDR 10.1.0.0/16 per ADR-0016 Decision 11 (non-overlapping with prod
# 10.0.0.0/16); db.t3.small / Postgres 15.7; multi-AZ false per
# ADR-0016 Decision 4 cost rationale).
#
# Replaces PR-8's empty-foundation placeholder with the api + auth
# CloudWatch log groups defined by the cloudwatch-log-group module
# (infrastructure/modules/cloudwatch-log-group). Retention values come
# from terraform.tfvars (per-env: dev 7/7, staging 30/30, prod 90/90 per
# ADR-0013 Decision 4).

locals {
  # PR-10a tag overlay; empty at creation time (provider default_tags
  # already applies Project / Environment / ManagedBy per ADR-0012
  # Decision 1). Reserved for future caller-supplied overlays.
  common_tags = {}
}

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

module "vpc" {
  source      = "../../modules/vpc"
  environment = var.environment
  vpc_cidr    = "10.1.0.0/16"
  az_count    = 2
  tags        = local.common_tags
}

module "rds" {
  source                  = "../../modules/rds"
  environment             = var.environment
  engine_version          = "15.7"
  instance_class          = "db.t3.small"
  allocated_storage       = 20
  max_allocated_storage   = 100
  db_name                 = "aramo"
  subnet_ids              = module.vpc.db_subnet_ids
  vpc_security_group_ids  = [module.vpc.rds_security_group_id]
  multi_az                = false
  deletion_protection     = true
  backup_retention_period = 7             # PR-10b: staging 7d per ADR-0017 Decision 2 (cost-conservative)
  backup_window           = "03:00-04:00" # PR-10b: UTC low-traffic per ADR-0017 Decision 3 (same as prod)
  tags                    = local.common_tags
}
