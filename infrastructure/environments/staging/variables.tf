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
