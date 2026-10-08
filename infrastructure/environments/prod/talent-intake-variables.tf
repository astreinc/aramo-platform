# ADR-0033 — Talent Intake instantiation inputs (set at apply via tfvars).

variable "talent_intake_lambda_image_uri" {
  type        = string
  description = "ECR image URI for the Talent Intake consumer Lambda (container image)."
  default     = ""
}

variable "talent_intake_tenant_llm_secret_arn_prefix" {
  type        = string
  description = "Secrets Manager ARN prefix the consumer Lambda may read for per-tenant LLM keys (e.g. arn:aws:secretsmanager:<region>:<acct>:secret:aramo/<env>/tenant-llm/*). Empty disables secret access."
  default     = ""
}

variable "talent_intake_alarm_actions" {
  type        = list(string)
  description = "SNS topic ARNs notified when a Talent Intake failure-plane alarm fires."
  default     = []
}
