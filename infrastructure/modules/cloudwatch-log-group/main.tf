# Aramo M4 PR-9 — CloudWatch Logs module.
#
# Provisions a single aws_cloudwatch_log_group resource with a caller-
# specified name + retention + tag overlay. First module populated under
# infrastructure/modules/ (PR-8 left modules/ empty per Ruling 4 / option γ).
#
# Per-env composition consumes this module twice: once for the API log
# stream (/aramo/api/<env>) and once for the auth log stream
# (/aramo/auth/<env>). Retention is per-env (dev 7d, staging 30d, prod 90d)
# per ADR-0013 Decision 4.
#
# Tagging: the AWS provider's default_tags block (set in
# infrastructure/environments/<env>/provider.tf per ADR-0012 Decision 1)
# already applies Project / Environment / ManagedBy to every resource;
# the optional `tags` input on this module is for caller-supplied
# overlays beyond the default set.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = var.name
  retention_in_days = var.retention_in_days
  tags              = var.tags
}
