# Aramo Single-Box Directive 4 — the Lightsail go-live-#1 box, as code.
#
# This is a COMPLETELY SEPARATE Terraform root from the platform IaC in
# infrastructure/. It mirrors that root's provider STYLE (hashicorp/aws ~> 5.0,
# us-east-1, default_tags) but shares NOTHING with it — no modules, no state,
# no remote-state reads. See README.md §Separation and backend.tf.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  # Cost-attribution overlay applied to every taggable resource in this root
  # (the Lightsail instance, the optional backup IAM user). Mirrors the
  # platform provider's default_tags; Component distinguishes the single-box
  # spend line from the platform ECS/RDS stack.
  default_tags {
    tags = {
      Project   = "Aramo"
      Component = "single-box-prod"
      ManagedBy = "Terraform"
    }
  }
}
