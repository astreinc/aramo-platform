# Aramo Step-4 Directive 2 (compute IaC) — ECS cluster module.
#
# A single Fargate cluster per environment that the api + auth-service
# services run in. Container Insights on for first-deploy observability;
# FARGATE + FARGATE_SPOT capacity providers wired (services default to
# on-demand FARGATE — SPOT is available for later cost tuning).

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_ecs_cluster" "this" {
  name = "aramo-${var.environment}"

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enabled" : "disabled"
  }

  tags = merge(var.tags, { Name = "aramo-${var.environment}-ecs" })
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}
