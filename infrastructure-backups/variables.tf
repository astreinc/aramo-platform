variable "aws_region" {
  description = "Region of the backup bucket, its KMS key and the freshness check."
  type        = string
  default     = "us-east-1"
}

variable "bucket_name" {
  description = "The backup bucket (BACKUP_S3_URI=s3://<this> on the box)."
  type        = string
  default     = "aramo-prod-db-backups-use1"
}

variable "kms_alias" {
  description = "Alias of the bucket's SSE-KMS key."
  type        = string
  default     = "alias/aramo-prod-db-backups"
}

variable "writer_user_name" {
  description = "IAM user the box uses to upload backups and heartbeats (put + list only)."
  type        = string
  default     = "aramo-prod-backup-writer"
}

variable "restorer_user_name" {
  description = "IAM user the operator Mac uses for restore tests (read + restore-checks/ reports)."
  type        = string
  default     = "aramo-prod-backup-restorer"
}

variable "backup_retention_days" {
  description = "Days before routine/ and historic/ objects expire (M-A8 §1.1.6: 30)."
  type        = number
  default     = 30

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 30
    error_message = "M-A8 §1.1.6 fixes the routine/historic window at 30 days or less."
  }
}

variable "report_retention_days" {
  description = "Days before heartbeat/ and restore-checks/ objects expire (M-A8 §1.1.6: 400)."
  type        = number
  default     = 400
}

variable "alert_email" {
  description = "Address subscribed to the backup-freshness SNS topic. No default: the PO confirms it at apply (M-A8 §1.1.7). AWS sends a confirmation mail that must be accepted."
  type        = string

  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.alert_email))
    error_message = "alert_email must be an email address."
  }
}

variable "freshness_schedule" {
  description = "EventBridge schedule of the daily backup-freshness check (UTC). The box timer runs at 03:30 UTC."
  type        = string
  default     = "cron(0 8 * * ? *)"
}

variable "routine_max_age_hours" {
  description = "Alert when the newest routine/ manifest is older than this (M-A8 §1.1.7: 26)."
  type        = number
  default     = 26
}

variable "restore_check_max_age_days" {
  description = "Alert when the newest PASS report in restore-checks/ is older than this (M-A8 §1.1.7: 35)."
  type        = number
  default     = 35
}
