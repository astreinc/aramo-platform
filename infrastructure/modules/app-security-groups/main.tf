# Aramo Step-4 Directive 2 (compute IaC) — compute-tier security groups.
#
# Owns the least-privilege SG mesh for the run layer, in ONE place so the
# composition stays clean and there is no vpc↔compute module cycle (this
# module takes the pre-existing RDS SG id as an input and adds the one
# ingress rule that lets the services reach it):
#
#   alb_sg      ── ingress 80/443 from the internet ──> (the ALB)
#   service_sg  ── ingress api_port + auth_port FROM alb_sg only ──> (Fargate tasks)
#               ── egress 443 to anywhere (ECR / Secrets Manager / Cognito / S3 via NAT)
#               ── egress 5432 to the RDS SG, 6379 to redis_sg
#   redis_sg    ── ingress 6379 FROM service_sg only ──> (ElastiCache)
#   rds_sg      ── (existing, from the vpc module) gains ingress 5432 FROM service_sg
#
# No broad 0.0.0.0/0 ingress reaches the services or Redis — only the ALB is
# internet-facing, and only it can reach the services.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# -----------------------------------------------------------------------------
# ALB security group — the only internet-facing SG.
# -----------------------------------------------------------------------------
resource "aws_security_group" "alb" {
  name        = "aramo-${var.environment}-alb-sg"
  description = "ALB ingress (HTTP/HTTPS from the internet) for ${var.environment}"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "aramo-${var.environment}-alb-sg" })
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from the internet (first-deploy listener; HTTPS is the edge directive)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet (ready for the edge directive's ACM cert)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# ALB egress → services only (the two app ports), not the whole VPC.
resource "aws_vpc_security_group_egress_rule" "alb_to_service_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "ALB → api task port"
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  referenced_security_group_id = aws_security_group.service.id
}

resource "aws_vpc_security_group_egress_rule" "alb_to_service_auth" {
  security_group_id            = aws_security_group.alb.id
  description                  = "ALB → auth-service task port"
  ip_protocol                  = "tcp"
  from_port                    = var.auth_port
  to_port                      = var.auth_port
  referenced_security_group_id = aws_security_group.service.id
}

# -----------------------------------------------------------------------------
# Service security group — shared by both Fargate services (identical posture).
# -----------------------------------------------------------------------------
resource "aws_security_group" "service" {
  name        = "aramo-${var.environment}-service-sg"
  description = "Fargate services: ingress from ALB only; egress to RDS/Redis/AWS+IdP (443)"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "aramo-${var.environment}-service-sg" })
}

resource "aws_vpc_security_group_ingress_rule" "service_from_alb_api" {
  security_group_id            = aws_security_group.service.id
  description                  = "api port from the ALB only"
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_ingress_rule" "service_from_alb_auth" {
  security_group_id            = aws_security_group.service.id
  description                  = "auth-service port from the ALB only"
  ip_protocol                  = "tcp"
  from_port                    = var.auth_port
  to_port                      = var.auth_port
  referenced_security_group_id = aws_security_group.alb.id
}

# Egress 443 to anywhere — ECR pull, Secrets Manager, S3, and the external
# Cognito IdP all sit behind HTTPS endpoints reached via the NAT gateway.
resource "aws_vpc_security_group_egress_rule" "service_https" {
  security_group_id = aws_security_group.service.id
  description       = "HTTPS egress (ECR / Secrets Manager / S3 / Cognito IdP via NAT)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "service_to_rds" {
  security_group_id            = aws_security_group.service.id
  description                  = "Postgres egress to RDS"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.rds_security_group_id
}

resource "aws_vpc_security_group_egress_rule" "service_to_redis" {
  security_group_id            = aws_security_group.service.id
  description                  = "Redis egress to ElastiCache"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.redis.id
}

# -----------------------------------------------------------------------------
# Redis security group — ingress from the services only.
# -----------------------------------------------------------------------------
resource "aws_security_group" "redis" {
  name        = "aramo-${var.environment}-redis-sg"
  description = "ElastiCache Redis: ingress 6379 from the services' SG only"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, { Name = "aramo-${var.environment}-redis-sg" })
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_service" {
  security_group_id            = aws_security_group.redis.id
  description                  = "Redis from the services' SG only"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.service.id
}

# -----------------------------------------------------------------------------
# The missing piece on the EXISTING RDS SG (created by the vpc module with no
# ingress): allow the services to reach Postgres. Added here (not in the vpc
# module) to avoid a vpc↔compute cycle.
# -----------------------------------------------------------------------------
resource "aws_vpc_security_group_ingress_rule" "rds_from_service" {
  security_group_id            = var.rds_security_group_id
  description                  = "Postgres from the Fargate services' SG (Step-4 Directive 2)"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.service.id
}
