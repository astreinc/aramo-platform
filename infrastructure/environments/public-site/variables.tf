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
  description = "Lightsail bundle (instance size). micro_3_0 (1 GB RAM). CHANGING THIS REBUILDS THE INSTANCE — host state is wiped, static IP + DNS survive; follow the bring-up runbook after apply."
  type        = string
  default     = "micro_3_0"
}

# D-PUB-SSH-1 — required, no default (apply fails loudly if unset rather than
# silently leaving SSH unmanaged). Set to the operator's current IP /32.
variable "ssh_cidr" {
  description = "CIDR allowed to reach SSH (22/tcp), e.g. \"203.0.113.4/32\". Required — no default. Lightsail browser SSH still works regardless (fallback)."
  type        = string
}

variable "ses_identity_domain" {
  description = "The verified SES identity (domain) the intake-mailer IAM user may send from. Its ARN is scoped in the least-privilege policy."
  type        = string
  default     = "aramo.ai"
}
