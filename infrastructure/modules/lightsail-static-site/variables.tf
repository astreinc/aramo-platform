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
  description = "Lightsail bundle (instance size). micro_3_0 (1 GB RAM, 2 vCPU, 40 GB SSD) — the two baked images + a build-free pull run comfortably in 1 GB; nano_3_0's 0.5 GB was too tight once the intake handler joined nginx. CHANGING THIS REBUILDS THE INSTANCE (see the module + env README)."
  type        = string
  default     = "micro_3_0"
}

# Source CIDR permitted to reach SSH (22). NO default — an unset value fails the
# apply loudly rather than silently opening 22 to the world. Set it to the
# operator's current IP as a /32 in terraform.tfvars (D-PUB-SSH-1).
variable "ssh_cidr" {
  description = "CIDR allowed to reach SSH (22/tcp), e.g. \"203.0.113.4/32\". Required — no default."
  type        = string

  validation {
    condition     = can(cidrhost(var.ssh_cidr, 0))
    error_message = "ssh_cidr must be a valid CIDR, e.g. 203.0.113.4/32."
  }
}

variable "tags" {
  description = "Tag overlay applied in addition to the provider default_tags."
  type        = map(string)
  default     = {}
}
