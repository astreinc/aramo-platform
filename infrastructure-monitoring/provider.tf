# Mirrors infrastructure-backups/ (hashicorp/aws ~> 5.0, archive ~> 2.4, us-east-1,
# default_tags). No modules, no remote-state reads.

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
      Component = "monitoring"
      ManagedBy = "Terraform"
    }
  }
}
