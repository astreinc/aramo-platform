variable "environment" {
  description = "Environment name (dev | staging | prod); used in resource names + tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "subnet_ids" {
  description = "Private-app subnet IDs the Redis subnet group spans (module.vpc.private_app_subnet_ids)."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security groups attached to Redis — the redis SG that only permits ingress from the services' SG on 6379 (module.app_security_groups.redis_security_group_id)."
  type        = list(string)
}

variable "node_type" {
  description = "ElastiCache node type. Modest first-deploy default; scale up later."
  type        = string
  default     = "cache.t4g.micro"
}

variable "engine_version" {
  description = "Redis engine version."
  type        = string
  default     = "7.1"
}

variable "maintenance_window" {
  description = "Weekly maintenance window (UTC); low-traffic, mirrors RDS posture."
  type        = string
  default     = "sun:04:00-sun:05:00"
}

variable "snapshot_retention_limit" {
  description = "Days of automatic snapshots to retain (0 = disabled; modest default for BullMQ queue state)."
  type        = number
  default     = 1
}

variable "tags" {
  description = "Tag overlay applied in addition to the provider default_tags."
  type        = map(string)
  default     = {}
}
