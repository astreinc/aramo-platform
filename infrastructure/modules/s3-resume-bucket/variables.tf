variable "environment" {
  description = "Environment name (dev | staging | prod); used in bucket name + KMS alias + tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "cors_allowed_origins" {
  description = "Origins permitted to PUT/GET résumé objects directly via presigned URLs (the direct-browser pattern). NEVER \"*\" — the PII floor rejects open CORS."
  type        = list(string)

  validation {
    condition     = length(var.cors_allowed_origins) > 0 && !contains(var.cors_allowed_origins, "*")
    error_message = "cors_allowed_origins must be non-empty and must NOT contain \"*\" (PII-floor: open CORS is rejected)."
  }
}

variable "kms_deletion_window_in_days" {
  description = "KMS key deletion window (7-30). Default 30 (max — gives a full month to recover from accidental deletion of the bucket's encryption key)."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30
    error_message = "kms_deletion_window_in_days must be between 7 and 30 (AWS KMS limit)."
  }
}

variable "retention_days_default" {
  description = "Days after which `retention_policy = default` objects are expired (TalentDocumentRetentionPolicy.default). Default 365 (1 year)."
  type        = number
  default     = 365

  validation {
    condition     = var.retention_days_default >= 30
    error_message = "retention_days_default must be ≥ 30 (operational floor)."
  }
}

variable "retention_days_extended" {
  description = "Days after which `retention_policy = extended` objects are expired (TalentDocumentRetentionPolicy.extended). Default 2555 (7 years — compliance tier)."
  type        = number
  default     = 2555

  validation {
    condition     = var.retention_days_extended >= 365
    error_message = "retention_days_extended must be ≥ 365 (compliance-tier minimum)."
  }
}

variable "retention_days_delete_after_x_floor" {
  description = "Bucket-level FLOOR for `retention_policy = delete_after_X_days` objects (TalentDocumentRetentionPolicy.delete_after_X_days). The app sets per-object expiration explicitly; this is the safety-net upper bound when no app-level expiry is set. Default 90."
  type        = number
  default     = 90

  validation {
    condition     = var.retention_days_delete_after_x_floor >= 7
    error_message = "retention_days_delete_after_x_floor must be ≥ 7 (operational floor)."
  }
}

variable "noncurrent_version_retention_days" {
  description = "Days after which noncurrent (overwritten / deleted) object versions expire. Default 90 (recoverability window for accidental deletion)."
  type        = number
  default     = 90

  validation {
    condition     = var.noncurrent_version_retention_days >= 7
    error_message = "noncurrent_version_retention_days must be ≥ 7 (operational floor)."
  }
}

variable "orphan_retention_days" {
  description = "Days after which `lifecycle = orphan-pending` objects are expired. A8-3b Option A correctness depends on this sweep: a recruiter who initiates a résumé upload (E1 presigned PUT) but never completes the create+attach flow (E3) leaves an orphan PII-dense object in the bucket. The presigned PUT bakes the tag into the URL; AttachmentService clears the tag on successful is_resume=true attach. Default 1 (24h)."
  type        = number
  default     = 1

  validation {
    condition     = var.orphan_retention_days >= 1
    error_message = "orphan_retention_days must be ≥ 1 (single-day floor; a sub-day sweep cadence is achievable only via S3 Object Lifecycle Management API, which the bucket lifecycle does not support)."
  }
}

variable "access_log_retention_days" {
  description = "Days after which the S3 server access logs expire in the resumes-logs bucket. Default 365 (1 year — audit-trail retention)."
  type        = number
  default     = 365

  validation {
    condition     = var.access_log_retention_days >= 30
    error_message = "access_log_retention_days must be ≥ 30 (audit-trail floor)."
  }
}

variable "tags" {
  description = "Tag overlay applied in addition to provider default_tags."
  type        = map(string)
  default     = {}
}
