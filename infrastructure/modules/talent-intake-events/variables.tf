# ADR-0033 — Talent Intake durable-event foundation (EventBridge → SQS → Lambda).
# Instantiates the contract proven in code: OutboxPublisherPort → EventBridge
# adapter → custom bus → rule → Talent Intake SQS → DLQ / Lambda consumer.

variable "environment" {
  type        = string
  description = "Deployment environment (dev|staging|prod)."
  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of dev, staging, prod."
  }
}

variable "tags" {
  type        = map(string)
  description = "Base tags merged onto every resource."
  default     = {}
}

# --- Event routing (canonical envelope fields actually published, ADR-0033) ---

variable "event_source" {
  type        = string
  description = "EventBridge 'source' the publisher emits (sourcePrefix.source), e.g. aramo.talent-intake. Stable + version-aware so future event versions do not misroute."
  default     = "aramo.talent-intake"
}

variable "event_detail_type" {
  type        = string
  description = "EventBridge 'detail-type' = the canonical event_type, version-pinned. A new event version is a new detail-type / new rule, never an accidental re-route."
  default     = "talent_intake.resume_extraction_requested.v1"
}

# --- Compute runtime (Lambda; ADR-0033 Decision 3) ---

variable "lambda_image_uri" {
  type        = string
  description = "ECR image URI for the Talent Intake consumer (container-image Lambda, reusing the NestJS/Prisma runtime). Required to deploy; a placeholder is fine for terraform validate."
}

variable "lambda_timeout_seconds" {
  type        = number
  description = "Lambda execution budget. Must exceed the in-app LLM client timeout; SQS visibility must in turn exceed this with margin."
  default     = 300
}

variable "llm_client_timeout_seconds" {
  type        = number
  description = "In-app governed-LLM client timeout, passed to the Lambda as env. Guardrail: strictly LESS than lambda_timeout_seconds so the model call cannot outlive the invocation."
  default     = 240
  validation {
    condition     = var.llm_client_timeout_seconds < var.lambda_timeout_seconds
    error_message = "llm_client_timeout_seconds must be < lambda_timeout_seconds (the LLM call must finish before the Lambda budget)."
  }
}

variable "visibility_timeout_seconds" {
  type        = number
  description = "SQS visibility timeout. AWS guidance: >= 6x the Lambda timeout so a slow invocation is not redelivered mid-flight."
  default     = 1800
  validation {
    condition     = var.visibility_timeout_seconds >= var.lambda_timeout_seconds * 6
    error_message = "visibility_timeout_seconds must be >= 6 * lambda_timeout_seconds (SQS/Lambda redrive guardrail)."
  }
}

variable "reserved_concurrency" {
  type        = number
  description = "Lambda reserved concurrency — bounded from DOWNSTREAM limits (PostgreSQL connections, LLM provider quota, tenant fairness), NOT just expected traffic. Caps parallel extractions."
  default     = 5
}

variable "event_source_batch_size" {
  type        = number
  description = "SQS->Lambda event source batch size (bounded). Small, because each record triggers a long governed-LLM call."
  default     = 1
  validation {
    condition     = var.event_source_batch_size >= 1 && var.event_source_batch_size <= 10
    error_message = "event_source_batch_size must be between 1 and 10."
  }
}

variable "event_source_max_concurrency" {
  type        = number
  description = "SQS event-source-mapping maximum_concurrency (>=2). Works with reserved_concurrency to bound fan-out."
  default     = 5
  validation {
    condition     = var.event_source_max_concurrency >= 2 && var.event_source_max_concurrency <= 1000
    error_message = "event_source_max_concurrency must be between 2 and 1000 (SQS scaling-config limit)."
  }
}

# --- Durability / retention (deliberate, not defaulted accidentally) ---

variable "max_receive_count" {
  type        = number
  description = "Redrive maxReceiveCount: deliveries before a message moves to the consumer (Plane B) DLQ."
  default     = 5
}

variable "source_queue_retention_seconds" {
  type        = number
  description = "Source queue message retention (deliberate). Default 4 days."
  default     = 345600
}

variable "dlq_retention_seconds" {
  type        = number
  description = "DLQ retention — long enough for operational investigation/replay. Default 14 days (max)."
  default     = 1209600
}

# --- Least-privilege scoping for the consumer (scoped ARNs, not wildcards) ---

variable "resume_bucket_arn" {
  type        = string
  description = "Résumé S3 bucket ARN the consumer may read artifacts from (artifact-backed sources). Scoped; empty disables S3 access."
  default     = ""
}

variable "resume_kms_key_arn" {
  type        = string
  description = "KMS key ARN for résumé-bucket SSE-KMS decrypt. Scoped; empty disables."
  default     = ""
}

variable "tenant_llm_secret_arn_prefix" {
  type        = string
  description = "Secrets Manager ARN prefix for per-tenant LLM keys the consumer may read (e.g. aramo/<env>/tenant-llm/*). Scoped; empty disables."
  default     = ""
}

variable "lambda_environment" {
  type        = map(string)
  description = "Additional environment for the consumer Lambda (DB URL ref, provider config). Secrets by reference, never literal secret values."
  default     = {}
}

# --- Networking (honest boundary) ---

variable "vpc_subnet_ids" {
  type        = list(string)
  description = "Private subnet ids if the consumer needs VPC access to PostgreSQL. EMPTY = no VPC config (Lambda runs outside the VPC; it then reaches PostgreSQL only via a public/duplicated path). Wiring live VPC networking is an explicit, separate step."
  default     = []
}

variable "vpc_security_group_ids" {
  type        = list(string)
  description = "Security groups for the consumer Lambda ENIs when vpc_subnet_ids is set. Must permit egress to PostgreSQL, S3 (gateway/interface endpoint), Secrets Manager, and the LLM endpoint."
  default     = []
}

# --- Observability ---

variable "alarm_actions" {
  type        = list(string)
  description = "SNS topic ARNs notified when any alarm fires. Empty = alarms created but no notification action."
  default     = []
}

variable "oldest_message_age_alarm_seconds" {
  type        = number
  description = "Plane B backlog alarm threshold on the source queue's oldest-message age."
  default     = 900
}
