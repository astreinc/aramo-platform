variable "aws_region" {
  description = "AWS region of the existing Cognito user pool."
  type        = string
  default     = "us-east-1"
}

variable "user_pool_id" {
  description = "The EXISTING production Cognito user pool (aramo-platform). Read through a data source only; this root never manages it."
  type        = string
  default     = "us-east-1_4fKlnGfaW"
}
