# Aramo M5 PR-10a — VPC module (first AWS data-plane PR; minimal networking
# substrate bundled with RDS module per Lead-Q-PR-10a-B1=(d2) disposition).
#
# Step-4 Directive 2 (compute IaC) — EXTENDED with the public + private-app
# subnet tiers, an internet gateway, a single NAT gateway, and the route
# tables the Fargate run layer needs. The original DB subnet tier + RDS
# security group are UNCHANGED (purely additive). Subnet CIDR layout (all
# /24 carved from the env /16, non-overlapping):
#   - public      : cidrsubnet(cidr, 8, 0..)        → 10.x.0.0/24, 10.x.1.0/24  (ALB + NAT)
#   - DB (orig)   : cidrsubnet(cidr, 8, 10+i)       → 10.x.10.0/24, 10.x.11.0/24 (RDS — unchanged)
#   - private-app : cidrsubnet(cidr, 8, 20+i)       → 10.x.20.0/24, 10.x.21.0/24 (Fargate + Redis)
#
# NAT posture: a SINGLE NAT gateway (modest first-deploy sizing per the
# directive — "don't over-engineer"). Private-app subnets in other AZs route
# cross-AZ to it; a per-AZ NAT is the scale-later option (noted, not built).
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

  # PR-10a established the SG resource only. Step-4 Directive 2 adds the
  # ingress rule (service-SG → 5432) at the COMPOSITION layer via the
  # app-security-groups module (it takes this SG id as an input), keeping
  # the rule out of this module to avoid a vpc↔compute module cycle.

  tags = merge(var.tags, { Name = "aramo-${var.environment}-rds-sg" })
}

# -----------------------------------------------------------------------------
# Step-4 Directive 2 — public + private-app tiers, IGW, NAT, route tables.
# All additive; the DB tier + RDS SG above are untouched.
# -----------------------------------------------------------------------------

# Public subnets — host the ALB and the NAT gateway. Auto-assign public IPs.
# These subnets are INTENTIONALLY public: they host only the internet-facing
# ALB + the NAT gateway. The app tasks + RDS + Redis live in the private tiers
# (no public IPs there).
#tfsec:ignore:aws-ec2-no-public-ip-subnet
resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = merge(var.tags, { Name = "aramo-${var.environment}-public-${count.index}" })
}

# Private-app subnets — host the Fargate tasks and ElastiCache Redis. No
# public IPs; egress (ECR / Secrets Manager / Cognito / S3) rides the NAT.
resource "aws_subnet" "private_app" {
  count = var.az_count

  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 20 + count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = merge(var.tags, { Name = "aramo-${var.environment}-private-app-${count.index}" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(var.tags, { Name = "aramo-${var.environment}-igw" })
}

# Single NAT gateway (modest first-deploy sizing) in the first public subnet.
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = merge(var.tags, { Name = "aramo-${var.environment}-nat-eip" })
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = merge(var.tags, { Name = "aramo-${var.environment}-nat" })

  depends_on = [aws_internet_gateway.this]
}

# Public route table — default route to the internet gateway.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(var.tags, { Name = "aramo-${var.environment}-public-rt" })
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private-app route table — default route to the NAT gateway (egress only).
resource "aws_route_table" "private_app" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }

  tags = merge(var.tags, { Name = "aramo-${var.environment}-private-app-rt" })
}

resource "aws_route_table_association" "private_app" {
  count = var.az_count

  subnet_id      = aws_subnet.private_app[count.index].id
  route_table_id = aws_route_table.private_app.id
}
