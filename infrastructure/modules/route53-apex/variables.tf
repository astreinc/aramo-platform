variable "zone_name" {
  description = "Public hosted-zone name to read (Ruling 4 — unmanaged, pre-existing)."
  type        = string
  default     = "aramo.ai"
}

variable "apex_ip" {
  description = "IPv4 address the apex A record resolves to (the box's Lightsail static IP). Supplied via real tfvars."
  type        = string

  validation {
    condition     = can(regex("^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(\\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$", var.apex_ip))
    error_message = "apex_ip must be a dotted-quad IPv4 address (e.g. 203.0.113.10)."
  }
}

variable "ttl" {
  description = "TTL in seconds for the apex A record."
  type        = number
  default     = 300
}
