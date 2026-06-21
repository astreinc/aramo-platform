# Aramo Step-4 Directive 2 — compute-layer variables (staging).
# All defaulted so `terraform validate` is clean without a tfvars; per-env
# overrides (sizing, image tags, app config) land in terraform.tfvars.

variable "api_container_port" {
  description = "Port the api container listens on (D1 default 3000)."
  type        = number
  default     = 3000
}

variable "auth_container_port" {
  description = "Port the auth-service container listens on (D1 default 3001)."
  type        = number
  default     = 3001
}

variable "api_image_tag" {
  description = "ECR image tag for the api service (e.g. a git SHA or 'staging'). Defaults to 'latest' for the rolling-tag first deploy."
  type        = string
  default     = "latest"
}

variable "auth_image_tag" {
  description = "ECR image tag for the auth-service."
  type        = string
  default     = "latest"
}

variable "api_cpu" {
  description = "Fargate CPU units for the api task (modest first-deploy)."
  type        = number
  default     = 512
}

variable "api_memory" {
  description = "Fargate memory (MiB) for the api task."
  type        = number
  default     = 1024
}

variable "auth_cpu" {
  description = "Fargate CPU units for the auth-service task."
  type        = number
  default     = 256
}

variable "auth_memory" {
  description = "Fargate memory (MiB) for the auth-service task."
  type        = number
  default     = 512
}

variable "redis_node_type" {
  description = "ElastiCache node type for the BullMQ Redis (modest first-deploy)."
  type        = string
  default     = "cache.t4g.micro"
}

variable "api_extra_env" {
  description = "Operator-supplied plaintext env for the api container, merged over the Terraform-derived base (e.g. AUTH_AUDIENCE, AUTH_COGNITO_* URLs, AUTH_COGNITO_TENANT_USER_POOL_ID, ADDRESS_AUTOCOMPLETE_*). NEVER secret material. Account/DNS-dependent values land here at account setup."
  type        = map(string)
  default     = {}
}

variable "auth_extra_env" {
  description = "Operator-supplied plaintext env for the auth-service container (e.g. AUTH_AUDIENCE, AUTH_COGNITO_DOMAIN/CLIENT_ID/ISSUER/REDIRECT_URI, AUTH_POST_LOGIN_REDIRECT, AUTH_COGNITO_SIGNOUT_REDIRECT, AUTH_TRUSTED_IDP_NAMES). NEVER secret material."
  type        = map(string)
  default     = {}
}
