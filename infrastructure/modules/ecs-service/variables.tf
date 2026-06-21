variable "name" {
  description = "Fully-qualified resource name / task family (e.g. aramo-prod-api). Used for the roles, task def family, and Name tags."
  type        = string
}

variable "service_name" {
  description = "Short service/container name (e.g. api, auth-service). Used as the container name + awslogs stream prefix."
  type        = string
}

variable "cluster_id" {
  description = "ECS cluster id the service runs in (module.ecs_cluster.cluster_id)."
  type        = string
}

variable "image" {
  description = "Full container image reference, including tag (e.g. <ecr_url>:<tag>)."
  type        = string
}

variable "container_port" {
  description = "Port the container listens on (api 3000 / auth-service 3001)."
  type        = number
}

variable "cpu" {
  description = "Task CPU units (256 = 0.25 vCPU). Modest first-deploy default."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Task memory (MiB). Must be a valid Fargate CPU/memory pair."
  type        = number
  default     = 1024
}

variable "cpu_architecture" {
  description = "Fargate CPU architecture (X86_64 | ARM64). Must match the pushed image's arch."
  type        = string
  default     = "X86_64"

  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "desired_count" {
  description = "Number of task replicas. ≥1 for go-live; scale later."
  type        = number
  default     = 1
}

variable "deployment_minimum_healthy_percent" {
  description = "ECS rolling-deploy minimum healthy percent."
  type        = number
  default     = 100
}

variable "deployment_maximum_percent" {
  description = "ECS rolling-deploy maximum percent (200 = one extra task during deploy)."
  type        = number
  default     = 200
}

variable "subnet_ids" {
  description = "Private-app subnet IDs the tasks run in (module.vpc.private_app_subnet_ids)."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security groups for the tasks (the shared service SG)."
  type        = list(string)
}

variable "target_group_arn" {
  description = "ALB target group ARN the service registers behind."
  type        = string
}

variable "aws_region" {
  description = "AWS region (for the awslogs driver)."
  type        = string
}

variable "log_group_name" {
  description = "Existing CloudWatch log group name for awslogs (e.g. /aramo/api/<env>)."
  type        = string
}

variable "environment_variables" {
  description = "Plaintext (non-secret) env vars injected into the container as `environment`. NEVER put secret material here."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Map of ENV_VAR_NAME → Secrets Manager secret ARN, injected via the task-def `secrets` block (the execution role reads them at task start; values never enter image or state)."
  type        = map(string)
  default     = {}
}

variable "task_role_inline_policy_json" {
  description = "Optional IAM policy JSON attached to the TASK role (the app's runtime AWS perms, e.g. the résumé-bucket least-privilege doc). Null for services with no AWS perms."
  type        = string
  default     = null
}

variable "task_role_secret_arns" {
  description = "Secret ARNs the app reads via the AWS SDK at runtime (task-role GetSecretValue), e.g. the Anthropic key libs/ai-draft fetches directly."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tag overlay applied in addition to the provider default_tags."
  type        = map(string)
  default     = {}
}
