# Aramo M5 PR-10a — VPC module (first AWS data-plane PR; minimal networking
# substrate bundled with RDS module per Lead-Q-PR-10a-B1=(d2) disposition).
#
# Provisions a non-default VPC + ≥2 private DB subnets across distinct AZs
# (AWS RDS db_subnet_group requirement) + a dedicated RDS security group.
# CIDR conventions per ADR-0016 Decision 11 (prod 10.0.0.0/16; staging
# 10.1.0.0/16). Separate VPC per environment per ADR-0012 Decision 5
# blast-radius isolation + ADR-0016 Decision 9.
#
# Tagging: the AWS provider's default_tags block (Project / Environment /
# ManagedBy per ADR-0012 Decision 1) applies to every resource; the
# optional `tags` input on this module is for caller-supplied overlays.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = merge(var.tags, { Name = "aramo-${var.environment}-vpc" })
}

resource "aws_subnet" "db" {
  count = var.az_count

  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 10 + count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = merge(var.tags, { Name = "aramo-${var.environment}-db-${count.index}" })
}

resource "aws_security_group" "rds" {
  name        = "aramo-${var.environment}-rds-sg"
  description = "RDS access security group for ${var.environment}"
  vpc_id      = aws_vpc.this.id

  # PR-10a establishes the SG resource only; ingress rules will be added
  # when the application layer wires through (M5-close OR M6 binding per
  # ADR-0016 Decision 12 / directive §5 out-of-scope item).

  tags = merge(var.tags, { Name = "aramo-${var.environment}-rds-sg" })
}
