variable "aws_region" {
  description = "AWS region for resources in this environment"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name (dev | staging | prod)"
  type        = string
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod."
  }
}

variable "api_log_retention_days" {
  description = "CloudWatch retention for /aramo/api/<env> (per ADR-0013 Decision 4: dev 7, staging 30, prod 90)."
  type        = number
}

variable "auth_log_retention_days" {
  description = "CloudWatch retention for /aramo/auth/<env> (per ADR-0013 Decision 4: dev 7, staging 30, prod 90)."
  type        = number
}

# A8-3a — résumé-bucket vars (the first live object-storage backing for
# the A4 Attachment.storage_key + M2 RawPayloadReference.storage_ref
# patterns). The bucket is provisioned by infrastructure/modules/s3-resume-
# bucket; the lib that consumes it is libs/object-storage.

variable "resume_bucket_cors_allowed_origins" {
  description = "Origins permitted to PUT/GET résumé objects directly via presigned URLs. NEVER \"*\" (PII floor)."
  type        = list(string)
}

variable "resume_bucket_retention_days_default" {
  description = "Days after which `retention_policy = default` résumé objects expire (TalentDocumentRetentionPolicy.default)."
  type        = number
  default     = 365
}

variable "resume_bucket_retention_days_extended" {
  description = "Days after which `retention_policy = extended` résumé objects expire (TalentDocumentRetentionPolicy.extended)."
  type        = number
  default     = 2555
}
