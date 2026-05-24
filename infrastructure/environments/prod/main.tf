# Aramo M4 PR-9 — first module consumption (prod composition).
#
# Replaces PR-8's empty-foundation placeholder with the api + auth
# CloudWatch log groups defined by the cloudwatch-log-group module
# (infrastructure/modules/cloudwatch-log-group). Retention values come
# from terraform.tfvars (per-env: dev 7/7, staging 30/30, prod 90/90 per
# ADR-0013 Decision 4).

module "api_log_group" {
  source            = "../../modules/cloudwatch-log-group"
  name              = "/aramo/api/${var.environment}"
  retention_in_days = var.api_log_retention_days
}

module "auth_log_group" {
  source            = "../../modules/cloudwatch-log-group"
  name              = "/aramo/auth/${var.environment}"
  retention_in_days = var.auth_log_retention_days
}
