variable "name" {
  description = "CloudWatch log group name (e.g. /aramo/api/dev)"
  type        = string
}

variable "retention_in_days" {
  description = "Number of days to retain log events. Must be one of the AWS-valid retention values."
  type        = number
  default     = 30
  validation {
    condition = contains(
      [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 2192, 2557, 2922, 3288, 3653],
      var.retention_in_days,
    )
    error_message = "retention_in_days must be one of the AWS-valid CloudWatch Logs retention values: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 2192, 2557, 2922, 3288, 3653."
  }
}

variable "tags" {
  description = "Tag overlay applied in addition to provider default_tags."
  type        = map(string)
  default     = {}
}
