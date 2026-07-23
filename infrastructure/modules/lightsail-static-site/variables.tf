variable "instance_name" {
  description = "Lightsail instance name (e.g. aramo-public-site). The static IP is <name>-ip."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9._-]{1,253}$", var.instance_name))
    error_message = "instance_name must be a valid Lightsail resource name."
  }
}

variable "availability_zone" {
  description = "Lightsail availability zone (must be in the provider region)."
  type        = string
  default     = "us-east-1a"
}

variable "blueprint_id" {
  description = "Lightsail OS blueprint. Ubuntu 24.04 LTS."
  type        = string
  default     = "ubuntu_24_04"
}

variable "bundle_id" {
  description = "Lightsail bundle (instance size). nano_3_0 is the smallest current-generation bundle (0.5 GB RAM, 2 vCPU, 20 GB SSD) — adequate for the static nginx site."
  type        = string
  default     = "nano_3_0"
}

variable "tags" {
  description = "Tag overlay applied in addition to the provider default_tags."
  type        = map(string)
  default     = {}
}
