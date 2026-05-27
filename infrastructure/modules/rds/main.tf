# Aramo M5 PR-10a — RDS Postgres module (first M5 AWS data-plane PR;
# first AWS-Secrets-Manager-Terraform-managed sensitive resource in the
# workspace; first Terraform `sensitive = true` outputs in the workspace).
#
# Provisions an aws_db_instance + aws_db_subnet_group per environment.
# Storage encryption mandatory (storage_encrypted = true; account-default
# KMS per Lead-Q-PR-10-F1=(a); dedicated KMS module deferred to M7).
# Master password managed by AWS Secrets Manager via
# `manage_master_user_password = true` per ADR-0016 Decision 6 / Ruling 6.
# Multi-AZ posture per environment (prod true / staging false) per
# ADR-0016 Decision 4 + Architecture §17.2 RPO 15min / RTO 1hr targets
# (anchored at doc/01 §12).
#
# Backup configuration: `backup_retention_period` + `backup_window`
# declared as variables with safe defaults (retention 7 day; window null
# = AWS-auto); per-env override values land at PR-10b per ADR-0016
# Decision 8 + PR-10a/10b split discipline.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Account-default RDS KMS key (alias/aws/rds; auto-created by AWS in every
# account; account-default KMS posture per ADR-0016 Decision 7; no dedicated
# KMS module required). Resolved at plan time to the full key ARN required
# by aws_db_instance.performance_insights_kms_key_id.
data "aws_kms_alias" "rds_default" {
  name = "alias/aws/rds"
}

resource "aws_db_subnet_group" "this" {
  name       = "aramo-${var.environment}-db-subnet-group"
  subnet_ids = var.subnet_ids

  tags = merge(var.tags, { Name = "aramo-${var.environment}-db-subnet-group" })
}

resource "aws_db_instance" "this" {
  identifier = "aramo-${var.environment}"

  engine                = "postgres"
  engine_version        = var.engine_version
  instance_class        = var.instance_class
  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name                     = var.db_name
  username                    = var.master_username
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = var.vpc_security_group_ids
  publicly_accessible    = false

  backup_retention_period = var.backup_retention_period
  backup_window           = var.backup_window

  multi_az            = var.multi_az
  deletion_protection = var.deletion_protection
  skip_final_snapshot = false

  performance_insights_enabled          = true
  performance_insights_retention_period = 7
  performance_insights_kms_key_id       = data.aws_kms_alias.rds_default.target_key_arn
  auto_minor_version_upgrade            = true
  apply_immediately                     = false

  tags = merge(var.tags, { Name = "aramo-${var.environment}-db" })
}
