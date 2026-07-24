variable "aws_region" {
  description = "AWS region for the public-site resources (Lightsail + the Route 53 records target)."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment label for default_tags. This root is the standalone public-site (isolated from dev/staging/prod)."
  type        = string
  default     = "public-site"
}

variable "availability_zone" {
  description = "Lightsail availability zone (must be in aws_region)."
  type        = string
  default     = "us-east-1a"
}

variable "blueprint_id" {
  description = "Lightsail OS blueprint. Ubuntu 24.04 LTS."
  type        = string
  default     = "ubuntu_24_04"
}

variable "bundle_id" {
  description = "Lightsail bundle (instance size). nano_3_0 is the smallest current-generation bundle."
  type        = string
  default     = "nano_3_0"
}

variable "ses_identity_domain" {
  description = "The verified SES identity (domain) the intake-mailer IAM user may send from. Its ARN is scoped in the least-privilege policy."
  type        = string
  default     = "aramo.ai"
}
