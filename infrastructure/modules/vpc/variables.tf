variable "vpc_cidr" {
  description = "VPC IPv4 CIDR block. Must be a /16 prefix per ADR-0016 Decision 11 (prod 10.0.0.0/16; staging 10.1.0.0/16)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]+\\.[0-9]+\\.0\\.0/16$", var.vpc_cidr))
    error_message = "vpc_cidr must be an IPv4 /16 CIDR block (e.g., 10.0.0.0/16)."
  }
}

variable "az_count" {
  description = "Number of availability zones for DB subnets. AWS RDS db_subnet_group requires ≥2 subnets in distinct AZs."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2
    error_message = "az_count must be ≥2 (AWS RDS db_subnet_group requirement)."
  }
}

variable "environment" {
  description = "Environment name (dev | staging | prod). Used in resource Name tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "tags" {
  description = "Tag overlay applied in addition to provider default_tags."
  type        = map(string)
  default     = {}
}
