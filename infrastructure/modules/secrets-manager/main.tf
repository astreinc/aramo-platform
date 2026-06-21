# Aramo Step-4 Directive 2 (compute IaC) — Secrets Manager containers.
#
# Defines the secret RESOURCES the Fargate tasks consume, following the
# existing `aramo/<env>/<name>` convention (the same path
# create-anthropic-secret.sh and libs/ai-draft's secret-cache already use).
#
# ★ VALUES ARE OUT-OF-BAND. This module creates the secret CONTAINERS only —
# it deliberately creates NO `aws_secretsmanager_secret_version`, so no secret
# value is ever written into Terraform state. The PO populates each value at
# account setup with, e.g.:
#
#   aws secretsmanager put-secret-value \
#     --secret-id aramo/<env>/database-url --secret-string '<value>'
#
# The task definitions reference these by ARN (execution-role-injected env
# via the `secrets` block, or task-role GetSecretValue for SDK-read secrets
# like the Anthropic key) — never baked into an image or into state.
#
# NOTE on the legacy bootstrap path: infrastructure/bootstrap/
# create-anthropic-secret.sh creates `aramo/<env>/anthropic-api-key` out of
# band. For a GREENFIELD account where this module manages that container,
# Terraform owns it — do NOT also run the bootstrap script there (it would be
# a name collision). The script remains the path for envs not yet under
# Terraform secret management (e.g. the pre-existing dev secret).

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_secretsmanager_secret" "this" {
  for_each = var.secret_names

  name        = "aramo/${var.environment}/${each.key}"
  description = "Aramo ${var.environment} — ${each.value} (Step-4 Directive 2; value provisioned out-of-band)."

  # Short recovery window so a destroy/recreate in a non-prod rehearsal isn't
  # blocked by the default 30-day soft-delete retention.
  recovery_window_in_days = var.recovery_window_in_days

  tags = merge(var.tags, {
    Name = "aramo-${var.environment}-${each.key}"
  })
}
