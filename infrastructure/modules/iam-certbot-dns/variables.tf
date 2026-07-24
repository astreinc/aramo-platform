variable "name" {
  description = "IAM user name for the certbot DNS-01 principal."
  type        = string
  default     = "aramo-certbot-dns"

  validation {
    condition     = length(var.name) > 0 && length(var.name) <= 64
    error_message = "name must be 1–64 characters (IAM user name limit)."
  }
}

variable "zone_name" {
  description = "The public hosted-zone name to read (PR-0b R2 — the module discovers the zone internally via a data source). Scopes the ChangeResourceRecordSets statement to this zone's ARN."
  type        = string
  default     = "aramo.ai"
}

variable "record_name" {
  description = "The one record name the principal may write — the ACME DNS-01 challenge TXT. The wildcard SAN and the apex share this name."
  type        = string
  default     = "_acme-challenge.aramo.ai"
}

variable "tags" {
  description = "Tags merged onto the IAM user (provider default_tags already apply Project/Environment/ManagedBy)."
  type        = map(string)
  default     = {}
}
