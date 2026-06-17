variable "name" {
  description = "IAM user name for the app principal (e.g. aramo-staging-api)."
  type        = string

  validation {
    condition     = length(var.name) > 0 && length(var.name) <= 64
    error_message = "name must be 1–64 characters (IAM user name limit)."
  }
}

variable "resume_bucket_policy_json" {
  description = "Least-privilege IAM policy JSON from the s3-resume-bucket module (app_iam_policy_json). Bucket + KMS ARNs are already resolved inside it."
  type        = string
}

variable "tags" {
  description = "Tags merged onto the IAM user (provider default_tags already apply Project/Environment/ManagedBy)."
  type        = map(string)
  default     = {}
}
