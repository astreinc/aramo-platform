# Aramo Sign Mobile P-5 — the native Cognito app client, as code.
#
# A separate Terraform root from infrastructure/environments/* and
# infrastructure-lightsail/. It shares no modules, no state and no remote-state
# reads with them. Provider style mirrors those roots (hashicorp/aws ~> 5.0, us-east-1).

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

  # Cognito app clients are not taggable; this overlay only keeps the root
  # consistent with the others if a taggable resource is ever added.
  default_tags {
    tags = {
      Project   = "Aramo"
      Component = "sign-mobile-auth"
      ManagedBy = "Terraform"
    }
  }
}
