# Aramo permanent encrypted database backups (M-A8 §1). Mirrors the provider style of
# infrastructure-lightsail/ (hashicorp/aws ~> 5.0, us-east-1, default_tags) and shares
# nothing else with it: no modules, no remote-state reads.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "Aramo"
      Component = "db-backups"
      ManagedBy = "Terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
