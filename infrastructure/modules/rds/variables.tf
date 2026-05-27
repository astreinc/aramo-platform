variable "environment" {
  description = "Environment name (dev | staging | prod); used in identifier + tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "engine_version" {
  description = "Postgres engine version. Postgres 15.x LTS per ADR-0016 Decision 3 (LTS through 2027)."
  type        = string

  validation {
    condition     = can(regex("^15\\.[0-9]+$", var.engine_version))
    error_message = "engine_version must match the Postgres 15.x line (e.g., 15.7)."
  }
}

variable "instance_class" {
  description = "RDS instance class. Format db.<family>.<size> (e.g., db.t3.medium, db.t3.small) per ADR-0016 Decision 3."
  type        = string

  validation {
    condition     = can(regex("^db\\.[a-z0-9]+\\.[a-z0-9]+$", var.instance_class))
    error_message = "instance_class must match the AWS RDS pattern db.<family>.<size> (e.g., db.t3.medium)."
  }
}

variable "allocated_storage" {
  description = "Allocated storage in GiB. Must be ≥20 (AWS minimum for gp3)."
  type        = number
  default     = 20

  validation {
    condition     = var.allocated_storage >= 20
    error_message = "allocated_storage must be ≥20 (AWS RDS gp3 minimum)."
  }
}

variable "max_allocated_storage" {
  description = "Maximum allocated storage in GiB for storage autoscaling."
  type        = number
  default     = 100
}

variable "db_name" {
  description = "Initial database name to create on the instance."
  type        = string
}

variable "master_username" {
  description = "Master user name. Password is auto-managed via AWS Secrets Manager (manage_master_user_password = true)."
  type        = string
  default     = "aramo_admin"
}

variable "subnet_ids" {
  description = "List of subnet IDs for the DB subnet group; must be ≥2 in distinct AZs."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "subnet_ids must contain at least 2 entries (AWS RDS db_subnet_group requirement)."
  }
}

variable "vpc_security_group_ids" {
  description = "List of VPC security group IDs to attach to the RDS instance."
  type        = list(string)

  validation {
    condition     = length(var.vpc_security_group_ids) >= 1
    error_message = "vpc_security_group_ids must contain at least 1 entry."
  }
}

variable "backup_retention_period" {
  description = "Number of days to retain automated backups (0-35). Default 7; per-env override values land at PR-10b per ADR-0016 Decision 8."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_period >= 0 && var.backup_retention_period <= 35
    error_message = "backup_retention_period must be between 0 and 35 days (AWS RDS limit)."
  }
}

variable "backup_window" {
  description = "Preferred daily backup window (UTC, hh24:mi-hh24:mi). Null = AWS auto-assigns. Per-env override values land at PR-10b."
  type        = string
  default     = null
  validation {
    condition     = var.backup_window == null || can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$", var.backup_window))
    error_message = "backup_window must be null OR a UTC time range matching pattern hh24:mi-hh24:mi (e.g., \"03:00-04:00\")."
  }
}

variable "multi_az" {
  description = "Multi-AZ deployment. Prod = true (RPO 15min / RTO 1hr per Architecture §17.2); staging = false (cost). Per ADR-0016 Decision 4."
  type        = bool
}

variable "deletion_protection" {
  description = "Enable deletion protection. Default true (production safety)."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tag overlay applied in addition to provider default_tags."
  type        = map(string)
  default     = {}
}
