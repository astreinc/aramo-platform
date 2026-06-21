# Aramo Step-4 Directive 2 (compute IaC) — ElastiCache Redis module.
#
# The recon found NO Redis in IaC; BullMQ needs a real Redis in prod (it
# degrades gracefully without one only locally). This provisions a modest
# single-node Redis in the VPC's private-app subnets, reachable only from
# the services' security group.
#
# Sizing: single node (num_cache_clusters = 1, automatic_failover disabled)
# on a small node type — modest first-deploy per the directive. Multi-AZ /
# replica + automatic failover is the scale-later option (a var flip).
#
# Encryption: at-rest enabled. Transit encryption (TLS) is DISABLED for the
# first deploy — enabling it forces `rediss://` + an auth token, which the
# app's plain `REDIS_URL` (redis://host:6379) does not yet carry. Flipping
# transit encryption on is a coordinated hardening follow-up (REDIS_URL →
# rediss:// + auth token in Secrets Manager). Noted, not built.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "aramo-${var.environment}-redis"
  subnet_ids = var.subnet_ids

  tags = merge(var.tags, { Name = "aramo-${var.environment}-redis-subnet-group" })
}

# Transit encryption is OFF for the first deploy (see header): enabling it
# forces rediss:// + an auth token, which the app's plain REDIS_URL does not
# yet carry. At-rest encryption IS on. Flipping TLS on is a coordinated
# hardening follow-up (REDIS_URL → rediss:// + auth token in Secrets Manager).
#tfsec:ignore:aws-elasticache-enable-in-transit-encryption
resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "aramo-${var.environment}-redis"
  description          = "Aramo ${var.environment} BullMQ Redis (Step-4 Directive 2; modest single-node first deploy)."

  engine         = "redis"
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = 6379

  num_cache_clusters         = 1
  automatic_failover_enabled = false
  multi_az_enabled           = false

  subnet_group_name  = aws_elasticache_subnet_group.this.name
  security_group_ids = var.security_group_ids

  at_rest_encryption_enabled = true
  transit_encryption_enabled = false # see header — hardening follow-up

  # Apply maintenance/version changes in the maintenance window, not live.
  apply_immediately        = false
  maintenance_window       = var.maintenance_window
  snapshot_retention_limit = var.snapshot_retention_limit

  tags = merge(var.tags, { Name = "aramo-${var.environment}-redis" })
}
