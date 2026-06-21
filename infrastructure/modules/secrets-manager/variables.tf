variable "environment" {
  description = "Environment name (dev | staging | prod); the secret path is aramo/<env>/<name>."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "secret_names" {
  description = "Map of logical secret name (the <name> in aramo/<env>/<name>) → human description. One Secrets Manager container is created per entry; values are provisioned out-of-band."
  type        = map(string)
}

variable "recovery_window_in_days" {
  description = "Soft-delete recovery window (0 = immediate delete). Keep low in non-prod rehearsals; AWS allows 0 or 7–30."
  type        = number
  default     = 7
}

variable "tags" {
  description = "Tag overlay applied in addition to the provider default_tags."
  type        = map(string)
  default     = {}
}
