variable "environment" {
  description = "Environment name (dev | staging | prod); used in ALB + target-group names + tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "vpc_id" {
  description = "VPC the target groups belong to (module.vpc.vpc_id)."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnet IDs the ALB spans (module.vpc.public_subnet_ids)."
  type        = list(string)
}

variable "alb_security_group_id" {
  description = "ALB security group (module.app_security_groups.alb_security_group_id)."
  type        = string
}

variable "api_port" {
  description = "api container port (D1 default 3000)."
  type        = number
  default     = 3000
}

variable "auth_port" {
  description = "auth-service container port (D1 default 3001)."
  type        = number
  default     = 3001
}

variable "api_health_check_path" {
  description = "ALB health-check path for the api target group. Default '/' (no /health route ships; any HTTP response = serving)."
  type        = string
  default     = "/"
}

variable "api_health_check_matcher" {
  description = "ALB health-check matcher for api. Default '200-499' — any HTTP response proves the listener is up (L7 analogue of D1's TCP probe)."
  type        = string
  default     = "200-499"
}

variable "auth_health_check_path" {
  description = "ALB health-check path for the auth-service target group. Default the JWKS endpoint (a real readiness signal that ships)."
  type        = string
  default     = "/.well-known/jwks.json"
}

variable "auth_health_check_matcher" {
  description = "ALB health-check matcher for auth-service. Default '200' (JWKS returns 200)."
  type        = string
  default     = "200"
}

variable "tags" {
  description = "Tag overlay applied in addition to the provider default_tags."
  type        = map(string)
  default     = {}
}
