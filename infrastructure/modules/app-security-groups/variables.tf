variable "environment" {
  description = "Environment name (dev | staging | prod); used in SG names + tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "vpc_id" {
  description = "VPC the security groups belong to (module.vpc.vpc_id)."
  type        = string
}

variable "rds_security_group_id" {
  description = "The EXISTING RDS security group id (module.vpc.rds_security_group_id). This module adds the ingress rule that lets the services reach Postgres."
  type        = string
}

variable "api_port" {
  description = "Container port the api service listens on (D1 default 3000)."
  type        = number
  default     = 3000
}

variable "auth_port" {
  description = "Container port the auth-service listens on (D1 default 3001)."
  type        = number
  default     = 3001
}

variable "tags" {
  description = "Tag overlay applied in addition to the provider default_tags."
  type        = map(string)
  default     = {}
}
